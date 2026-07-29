package org.roomframe.tv.sync

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertPathValidator
import java.security.cert.CertificateFactory
import java.security.cert.PKIXParameters
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import org.json.JSONObject

data class ServerTrustBootstrapPayload(
    val version: Int,
    val algorithm: String,
    val keyDerivation: String,
    val context: String,
    val salt: String,
    val iv: String,
    val ciphertext: String,
    val tag: String,
)

object ServerTrustBootstrapCrypto {
    fun decrypt(
        payload: ServerTrustBootstrapPayload,
        deviceId: String,
        enrollmentKey: String,
    ): String {
        require(payload.version == 1) { "Version d’appairage HTTPS inconnue" }
        require(payload.algorithm == "AES-256-GCM") {
            "Chiffrement d’appairage HTTPS inconnu"
        }
        require(payload.keyDerivation == "HKDF-SHA256") {
            "Dérivation d’appairage HTTPS inconnue"
        }
        require(payload.context == CONTEXT) { "Contexte d’appairage HTTPS invalide" }
        val normalizedId = DeviceCredentialStore.validateDeviceId(deviceId)
        DeviceCredentialStore.validateDeviceKey(enrollmentKey)
        val keyMaterial = decodeCanonical(enrollmentKey, 32, 32, "clé d’enrôlement")
        val salt = decodeCanonical(payload.salt, 32, 32, "sel d’appairage")
        val iv = decodeCanonical(payload.iv, 12, 12, "IV d’appairage")
        val ciphertext = decodeCanonical(
            payload.ciphertext,
            500,
            16_384,
            "CA HTTPS chiffrée",
        )
        val tag = decodeCanonical(payload.tag, 16, 16, "tag d’appairage")
        val info = info(normalizedId)
        val key = hkdfSha256(keyMaterial, salt, info, 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, iv),
            )
            updateAAD(info)
        }
        val plaintext = cipher.doFinal(ciphertext + tag)
        require(plaintext.size in 500..16_384) { "CA HTTPS déchiffrée hors limites" }
        return plaintext.toString(StandardCharsets.US_ASCII)
    }

    fun info(deviceId: String): ByteArray =
        "$CONTEXT\n$deviceId".toByteArray(StandardCharsets.UTF_8)

    private fun hkdfSha256(
        inputKeyMaterial: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        length: Int,
    ): ByteArray {
        require(length in 1..32)
        val extract = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(inputKeyMaterial)
        }
        return Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(extract, "HmacSHA256"))
            update(info)
            update(1)
            doFinal().copyOf(length)
        }
    }

    private fun decodeCanonical(
        value: String,
        minimum: Int,
        maximum: Int,
        label: String,
    ): ByteArray {
        val decoded = runCatching {
            Base64.getUrlDecoder().decode(value)
        }.getOrElse {
            throw IllegalArgumentException("$label invalide")
        }
        require(decoded.size in minimum..maximum) { "$label hors limites" }
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == value) {
            "$label non canonique"
        }
        return decoded
    }

    const val CONTEXT = "roomframe-server-ca-bootstrap-v1"
}

class RoomFrameServerTrust {
    fun installVerified(
        certificatePem: String,
        peerCertificates: Array<out java.security.cert.Certificate>,
    ): String {
        val certificate = parseCa(certificatePem)
        verifyPeerChain(certificate, peerCertificates)
        androidKeyStore().setCertificateEntry(KEY_ALIAS, certificate)
        val installed = requireNotNull(currentCertificate()) {
            "La CA HTTPS n’a pas été conservée"
        }
        require(installed.encoded.contentEquals(certificate.encoded)) {
            "La CA HTTPS conservée est incohérente"
        }
        return certificate.encoded.sha256()
    }

    fun currentFingerprintSha256(): String? = currentCertificate()?.encoded?.sha256()

    fun trustManagersOrNull(): Array<TrustManager>? {
        val certificate = currentCertificate() ?: return null
        val trustStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("roomframe-server-ca", certificate)
        }
        return TrustManagerFactory
            .getInstance(TrustManagerFactory.getDefaultAlgorithm())
            .apply { init(trustStore) }
            .trustManagers
    }

    fun clear() {
        val keyStore = androidKeyStore()
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
    }

    private fun currentCertificate(): X509Certificate? = runCatching {
        val keyStore = androidKeyStore()
        if (!keyStore.isCertificateEntry(KEY_ALIAS)) return null
        (keyStore.getCertificate(KEY_ALIAS) as? X509Certificate)
            ?.also { validateCa(it) }
    }.getOrNull()

    private fun parseCa(pem: String): X509Certificate {
        require(
            pem.length in 500..16_384 &&
                pem.startsWith("-----BEGIN CERTIFICATE-----") &&
                pem.trimEnd().endsWith("-----END CERTIFICATE-----"),
        ) { "CA HTTPS RoomFrame invalide" }
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(pem.toByteArray(StandardCharsets.US_ASCII)))
            as X509Certificate
        validateCa(certificate)
        return certificate
    }

    private fun validateCa(certificate: X509Certificate) {
        require(certificate.basicConstraints >= 0) { "Autorité HTTPS RoomFrame invalide" }
        certificate.checkValidity()
        certificate.verify(certificate.publicKey)
    }

    private fun verifyPeerChain(
        root: X509Certificate,
        peerCertificates: Array<out java.security.cert.Certificate>,
    ) {
        val chain = peerCertificates.map {
            requireNotNull(it as? X509Certificate) { "Chaîne TLS serveur invalide" }
        }
        require(chain.size in 1..6) { "Chaîne TLS serveur hors limites" }
        val leaf = chain.first()
        require(leaf.basicConstraints < 0) { "Certificat TLS serveur invalide" }
        leaf.checkValidity()
        val extendedUsage = leaf.extendedKeyUsage
        require(
            extendedUsage == null ||
                SERVER_AUTH_OID in extendedUsage ||
                ANY_EXTENDED_KEY_USAGE_OID in extendedUsage,
        ) { "Usage serveur TLS absent" }
        val pathCertificates = if (chain.last().encoded.contentEquals(root.encoded)) {
            chain.dropLast(1)
        } else {
            chain
        }
        require(pathCertificates.isNotEmpty()) { "Certificat TLS serveur absent" }
        val certificatePath = CertificateFactory.getInstance("X.509")
            .generateCertPath(pathCertificates)
        CertPathValidator.getInstance("PKIX").validate(
            certificatePath,
            PKIXParameters(setOf(TrustAnchor(root, null))).apply {
                isRevocationEnabled = false
            },
        )
    }

    private fun androidKeyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private fun ByteArray.sha256(): String =
        MessageDigest.getInstance("SHA-256").digest(this)
            .joinToString("") { "%02x".format(it) }

    private companion object {
        const val KEY_ALIAS = "roomframe-server-ca-v1"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1"
        const val ANY_EXTENDED_KEY_USAGE_OID = "2.5.29.37.0"
    }
}

class ServerTrustBootstrapClient(
    private val trustStore: RoomFrameServerTrust = RoomFrameServerTrust(),
) {
    fun bootstrap(serverUrl: String, deviceId: String, enrollmentKey: String): String {
        val normalizedUrl = DeviceCredentialStore.validateServerUrl(serverUrl)
        val normalizedId = DeviceCredentialStore.validateDeviceId(deviceId)
        DeviceCredentialStore.validateDeviceKey(enrollmentKey)
        val target = URL("$normalizedUrl/api/v1/tv/trust-bootstrap?deviceId=$normalizedId")
        val connection = openBootstrapConnection(target)
        try {
            val status = connection.responseCode
            val source = if (status == 200) connection.inputStream else connection.errorStream
            val bytes = source?.use { readBounded(it, MAX_RESPONSE_BYTES) } ?: ByteArray(0)
            require(status == 200) { "Appairage HTTPS refusé (HTTP $status)" }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") {
                "Réponse d’appairage HTTPS invalide"
            }
            val json = JSONObject(bytes.toString(StandardCharsets.UTF_8))
            val payload = ServerTrustBootstrapPayload(
                version = json.getInt("version"),
                algorithm = json.getString("algorithm"),
                keyDerivation = json.getString("keyDerivation"),
                context = json.getString("context"),
                salt = json.getString("salt"),
                iv = json.getString("iv"),
                ciphertext = json.getString("ciphertext"),
                tag = json.getString("tag"),
            )
            val certificatePem = ServerTrustBootstrapCrypto.decrypt(
                payload,
                normalizedId,
                enrollmentKey,
            )
            return trustStore.installVerified(
                certificatePem,
                connection.serverCertificates,
            )
        } finally {
            connection.disconnect()
        }
    }

    private fun openBootstrapConnection(url: URL): HttpsURLConnection {
        val permissiveOnlyForEncryptedBootstrap = object : X509TrustManager {
            override fun checkClientTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?,
            ) = Unit

            override fun checkServerTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?,
            ) {
                require(!chain.isNullOrEmpty()) { "Chaîne TLS serveur absente" }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val socketFactory = SSLContext.getInstance("TLS").apply {
            init(
                null,
                arrayOf<TrustManager>(permissiveOnlyForEncryptedBootstrap),
                SecureRandom(),
            )
        }.socketFactory
        return (url.openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = socketFactory
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
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
            require(total <= maximum) { "Réponse d’appairage HTTPS trop grande" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 64 * 1024
    }
}
