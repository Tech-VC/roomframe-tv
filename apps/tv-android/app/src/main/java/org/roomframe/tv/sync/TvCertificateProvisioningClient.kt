package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import org.json.JSONObject

sealed interface TvCertificateProvisioningResult {
    data object NotRequested : TvCertificateProvisioningResult
    data class Pending(val status: String) : TvCertificateProvisioningResult
    data class Active(val fingerprintSha256: String) : TvCertificateProvisioningResult
    data class Failed(val reason: String) : TvCertificateProvisioningResult
}

class TvCertificateProvisioningClient(
    private val certificateStore: TvClientCertificateStore = TvClientCertificateStore(),
) {
    fun synchronize(credentials: DeviceCredentials): TvCertificateProvisioningResult = runCatching {
        val status = request(credentials, "GET", "/api/v1/tv/certificate")
        when (status.optString("status")) {
            "not-requested" -> TvCertificateProvisioningResult.NotRequested
            "pending", "issuing" -> TvCertificateProvisioningResult.Pending(
                status.getString("status"),
            )
            "failed", "revoked" -> TvCertificateProvisioningResult.Failed(
                status.optString("error", status.getString("status")).take(120),
            )
            "issued" -> installAndActivate(credentials, status)
            else -> TvCertificateProvisioningResult.Failed("certificate-status-invalid")
        }
    }.getOrElse { error ->
        TvCertificateProvisioningResult.Failed(
            error.message?.take(120) ?: "certificate-network-error",
        )
    }

    private fun installAndActivate(
        credentials: DeviceCredentials,
        response: JSONObject,
    ): TvCertificateProvisioningResult {
        val fingerprint = response.getString("fingerprintSha256")
        if (certificateStore.currentFingerprintSha256() != fingerprint) {
            certificateStore.install(
                deviceId = credentials.deviceId,
                certificatePem = response.getString("certificatePem"),
                caCertificatePem = response.getString("caCertificatePem"),
                expectedFingerprintSha256 = fingerprint,
            )
            request(
                credentials,
                "POST",
                "/api/v1/tv/certificate/activate",
                JSONObject(),
            ).also {
                require(it.optBoolean("activated")) {
                    "Activation du certificat TV non confirmée"
                }
            }
        }
        val expiry = certificateStore.currentExpiryEpochMs()
        if (expiry != null && expiry - System.currentTimeMillis() <= RENEWAL_WINDOW_MS) {
            val renewal = request(
                credentials,
                "POST",
                "/api/v1/tv/certificate/renew",
                JSONObject(),
                acceptedStatuses = setOf(200, 201, 409),
            )
            if (renewal.optString("status") in setOf("pending", "issuing")) {
                return TvCertificateProvisioningResult.Pending("renewal")
            }
        }
        return TvCertificateProvisioningResult.Active(fingerprint)
    }

    private fun request(
        credentials: DeviceCredentials,
        method: String,
        path: String,
        body: JSONObject? = null,
        acceptedStatuses: Set<Int> = (200..299).toSet(),
    ): JSONObject {
        val base = URI(DeviceCredentialStore.validateServerUrl(credentials.serverUrl))
        val resolved = base.resolve(path)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine de certificat TV invalide" }
        val connection = RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = method
            setRequestProperty("Accept", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
            if (body != null) {
                val payload = body.toString().toByteArray(StandardCharsets.UTF_8)
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setFixedLengthStreamingMode(payload.size)
                outputStream.use { it.write(payload) }
            }
        }
        try {
            val status = connection.responseCode
            val source = if (status in acceptedStatuses) {
                connection.inputStream
            } else {
                connection.errorStream
            }
            val bytes = source?.use { readBounded(it, MAX_RESPONSE_BYTES) } ?: ByteArray(0)
            require(status in acceptedStatuses) { "Certificat TV refusé (HTTP $status)" }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") { "Réponse de certificat TV invalide" }
            return JSONObject(bytes.toString(StandardCharsets.UTF_8))
        } finally {
            connection.disconnect()
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
            require(total <= maximum) { "Réponse de certificat TV trop grande" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 256 * 1024
        const val RENEWAL_WINDOW_MS = 30L * 24 * 60 * 60 * 1000
    }
}
