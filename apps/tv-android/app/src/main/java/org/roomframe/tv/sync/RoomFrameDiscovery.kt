package org.roomframe.tv.sync

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import java.io.ByteArrayOutputStream
import java.net.Inet4Address
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

data class DiscoveryCandidate(
    val serviceName: String,
    val descriptor: SignedDiscoveryDescriptor,
)

@Suppress("DEPRECATION")
class RoomFrameDiscovery(context: Context) : AutoCloseable {
    private val applicationContext = context.applicationContext
    private val nsdManager = applicationContext.getSystemService(NsdManager::class.java)
    private val wifiManager = applicationContext.getSystemService(WifiManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val services = linkedMapOf<String, NsdServiceInfo>()
    private val candidates = linkedMapOf<String, DiscoveryCandidate>()
    private var listener: NsdManager.DiscoveryListener? = null
    private var callback: ((Result<List<DiscoveryCandidate>>) -> Unit)? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var active = false

    fun discover(
        timeoutMillis: Long = DEFAULT_TIMEOUT_MS,
        onComplete: (Result<List<DiscoveryCandidate>>) -> Unit,
    ) {
        require(timeoutMillis in 2_000..15_000) { "Délai de découverte invalide" }
        check(!active) { "Une découverte RoomFrame est déjà active" }
        active = true
        callback = onComplete
        services.clear()
        candidates.clear()
        multicastLock = runCatching {
            wifiManager?.createMulticastLock(MULTICAST_LOCK_TAG)?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (
                    serviceInfo.serviceType.equals(
                        DiscoveryDescriptorPolicy.NSD_SERVICE_TYPE,
                        ignoreCase = true,
                    )
                ) {
                    services.putIfAbsent(
                        "${serviceInfo.serviceName}\u0000${serviceInfo.serviceType}",
                        serviceInfo,
                    )
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                services.remove("${serviceInfo.serviceName}\u0000${serviceInfo.serviceType}")
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                finish(Result.failure(IllegalStateException("Découverte locale refusée ($errorCode)")))
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        listener = discoveryListener
        try {
            nsdManager.discoverServices(
                DiscoveryDescriptorPolicy.NSD_SERVICE_TYPE,
                NsdManager.PROTOCOL_DNS_SD,
                discoveryListener,
            )
            handler.postDelayed({ stopAndResolve() }, timeoutMillis)
        } catch (error: RuntimeException) {
            finish(Result.failure(error))
        }
    }

    private fun stopAndResolve() {
        if (!active) return
        listener?.let { runCatching { nsdManager.stopServiceDiscovery(it) } }
        resolveNext(ArrayDeque(services.values))
    }

    private fun resolveNext(queue: ArrayDeque<NsdServiceInfo>) {
        if (!active) return
        val service = queue.removeFirstOrNull()
        if (service == null) {
            finish(Result.success(candidates.values.sortedBy { it.descriptor.origin }))
            return
        }
        runCatching {
            nsdManager.resolveService(
                service,
                object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        handler.post { resolveNext(queue) }
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        executor.execute {
                            val candidate = runCatching {
                                DiscoveryDescriptorClient.fetch(serviceInfo)
                            }.getOrNull()
                            handler.post {
                                if (candidate != null) {
                                    val identity = candidate.descriptor.publicKeyFingerprintSha256
                                    candidates.putIfAbsent(identity, candidate)
                                }
                                resolveNext(queue)
                            }
                        }
                    }
                },
            )
        }.onFailure {
            handler.post { resolveNext(queue) }
        }
    }

    private fun finish(result: Result<List<DiscoveryCandidate>>) {
        if (!active) return
        active = false
        handler.removeCallbacksAndMessages(null)
        listener?.let { runCatching { nsdManager.stopServiceDiscovery(it) } }
        listener = null
        multicastLock?.let { lock ->
            if (lock.isHeld) runCatching { lock.release() }
        }
        multicastLock = null
        callback?.also { callback = null }?.invoke(result)
    }

    override fun close() {
        if (active) {
            finish(Result.failure(IllegalStateException("Découverte interrompue")))
        }
        executor.shutdownNow()
    }

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 5_000L
        const val MULTICAST_LOCK_TAG = "roomframe-local-discovery"
    }
}

@Suppress("DEPRECATION")
private object DiscoveryDescriptorClient {
    fun fetch(service: NsdServiceInfo): DiscoveryCandidate {
        require(service.port == 443) { "Port DNS-SD RoomFrame invalide" }
        val address = requireNotNull(service.host as? Inet4Address) {
            "La découverte RoomFrame exige une IPv4 résolue"
        }
        require(!address.isAnyLocalAddress && !address.isLoopbackAddress && !address.isMulticastAddress) {
            "Adresse de découverte locale invalide"
        }
        val target = URL(
            "https://${address.hostAddress}:${service.port}" +
                DiscoveryDescriptorPolicy.DISCOVERY_PATH,
        )
        val connection = openBootstrapOnlyConnection(target)
        try {
            val status = connection.responseCode
            val source = if (status == 200) connection.inputStream else connection.errorStream
            val bytes = source?.use { readBounded(it, MAX_RESPONSE_BYTES) } ?: ByteArray(0)
            require(status == 200) { "Manifeste de découverte refusé (HTTP $status)" }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") {
                "Type de manifeste de découverte invalide"
            }
            val descriptor = DiscoveryDescriptorPolicy.parseAndVerify(bytes)
            require(descriptor.ipv4 == address.hostAddress && descriptor.port == service.port) {
                "Le manifeste signé ne correspond pas à l'annonce DNS-SD"
            }
            DiscoveryDescriptorPolicy.verifyAdvertisement(service.attributes, descriptor)
            return DiscoveryCandidate(service.serviceName, descriptor)
        } finally {
            connection.disconnect()
        }
    }

    private fun openBootstrapOnlyConnection(url: URL): HttpsURLConnection {
        val observeCertificateWithoutTrust = object : X509TrustManager {
            override fun checkClientTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?,
            ) = Unit

            override fun checkServerTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?,
            ) {
                require(!chain.isNullOrEmpty()) { "Chaîne TLS de découverte absente" }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val socketFactory = SSLContext.getInstance("TLS").apply {
            init(
                null,
                arrayOf<TrustManager>(observeCertificateWithoutTrust),
                SecureRandom(),
            )
        }.socketFactory
        return (url.openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = socketFactory
            connectTimeout = 4_000
            readTimeout = 6_000
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "GET"
            setRequestProperty("Accept", "application/json")
        }
    }

    private fun readBounded(input: java.io.InputStream, maximum: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= maximum) { "Manifeste de découverte trop volumineux" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private const val MAX_RESPONSE_BYTES = 32 * 1024
}
