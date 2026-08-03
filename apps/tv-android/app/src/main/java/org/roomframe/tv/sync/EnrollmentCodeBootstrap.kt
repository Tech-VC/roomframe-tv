package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import org.json.JSONObject

data class EnrollmentCodeBootstrapPayload(
    val version: Int,
    val algorithm: String,
    val keyDerivation: String,
    val context: String,
    val salt: String,
    val iv: String,
    val ciphertext: String,
    val tag: String,
)

data class ResolvedEnrollment(
    val deviceId: String,
    val enrollmentKey: String,
    val certificatePem: String,
    val certificateFingerprintSha256: String,
)

object EnrollmentCodePolicy {
    private const val ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

    fun normalize(value: String): String {
        val normalized = value
            .uppercase()
            .filterNot { it == '-' || it.isWhitespace() }
        require(
            normalized.length == 16 && normalized.all(ALPHABET::contains),
        ) { "Code d’installation invalide" }
        return normalized
    }

    fun format(value: String): String = normalize(value).chunked(4).joinToString("-")

    fun manualServerUrl(value: String): String {
        val trimmed = value.trim()
        require(trimmed.isNotEmpty()) { "Adresse du serveur absente" }
        return if ("://" in trimmed) trimmed else "https://$trimmed"
    }
}

object EnrollmentCodeBootstrapCrypto {
    fun lookupId(enrollmentCode: String): String = MessageDigest
        .getInstance("SHA-256")
        .digest(
            "$CONTEXT\u0000${EnrollmentCodePolicy.normalize(enrollmentCode)}"
                .toByteArray(StandardCharsets.UTF_8),
        )
        .joinToString("") { "%02x".format(it) }

    fun decrypt(
        payload: EnrollmentCodeBootstrapPayload,
        enrollmentCode: String,
    ): ResolvedEnrollment {
        require(payload.version == 1) { "Version de code d’installation inconnue" }
        require(payload.algorithm == "AES-256-GCM") {
            "Chiffrement de code d’installation inconnu"
        }
        require(payload.keyDerivation == "HKDF-SHA256") {
            "Dérivation de code d’installation inconnue"
        }
        require(payload.context == CONTEXT) { "Contexte de code d’installation invalide" }
        val normalizedCode = EnrollmentCodePolicy.normalize(enrollmentCode)
        val salt = decodeCanonical(payload.salt, 32, 32, "sel d’installation")
        val iv = decodeCanonical(payload.iv, 12, 12, "IV d’installation")
        val ciphertext = decodeCanonical(
            payload.ciphertext,
            500,
            32_768,
            "paquet d’installation chiffré",
        )
        val tag = decodeCanonical(payload.tag, 16, 16, "tag d’installation")
        val info = CONTEXT.toByteArray(StandardCharsets.UTF_8)
        val inputKeyMaterial = MessageDigest.getInstance("SHA-256").digest(
            "$CONTEXT\u0000$normalizedCode".toByteArray(StandardCharsets.UTF_8),
        )
        val key = hkdfSha256(inputKeyMaterial, salt, info, 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, iv),
            )
            updateAAD(info)
        }
        val plaintext = cipher.doFinal(ciphertext + tag)
        require(plaintext.size in 500..32_768) { "Paquet d’installation hors limites" }
        val document = JSONObject(plaintext.toString(StandardCharsets.UTF_8))
        require(document.getInt("version") == 1) { "Paquet d’installation inconnu" }
        val resolved = ResolvedEnrollment(
            deviceId = DeviceCredentialStore.validateDeviceId(document.getString("deviceId")),
            enrollmentKey = document.getString("enrollmentKey").also(
                DeviceCredentialStore::validateDeviceKey,
            ),
            certificatePem = document.getString("certificatePem"),
            certificateFingerprintSha256 = document.getString(
                "certificateFingerprintSha256",
            ),
        )
        require(resolved.certificatePem.length in 500..16_384) {
            "Autorité HTTPS d’installation hors limites"
        }
        require(resolved.certificateFingerprintSha256.matches(Regex("^[a-f0-9]{64}$"))) {
            "Empreinte HTTPS d’installation invalide"
        }
        return resolved
    }

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
            java.util.Base64.getUrlDecoder().decode(value)
        }.getOrElse {
            throw IllegalArgumentException("$label invalide")
        }
        require(decoded.size in minimum..maximum) { "$label hors limites" }
        require(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == value) {
            "$label non canonique"
        }
        return decoded
    }

    const val CONTEXT = "roomframe-enrollment-code-bootstrap-v1"
}

class EnrollmentCodeBootstrapClient(
    private val trustStore: RoomFrameServerTrust = RoomFrameServerTrust(),
) {
    fun bootstrap(
        serverUrl: String,
        enrollmentCode: String,
        expectedServerCaFingerprintSha256: String? = null,
    ): ResolvedEnrollment {
        val normalizedUrl = DeviceCredentialStore.validateServerUrl(serverUrl)
        val normalizedCode = EnrollmentCodePolicy.normalize(enrollmentCode)
        expectedServerCaFingerprintSha256?.let {
            require(it.matches(Regex("^[0-9a-f]{64}$"))) {
                "Empreinte de CA HTTPS attendue invalide"
            }
        }
        val target = URL("$normalizedUrl/api/v1/tv/enrollment-bootstrap")
        val connection = openBootstrapConnection(target)
        try {
            val body = JSONObject()
                .put(
                    "enrollmentCodeId",
                    EnrollmentCodeBootstrapCrypto.lookupId(normalizedCode),
                )
                .toString()
                .toByteArray(StandardCharsets.UTF_8)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setFixedLengthStreamingMode(body.size)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val source = if (status == 200) connection.inputStream else connection.errorStream
            val bytes = source?.use { readBounded(it, MAX_RESPONSE_BYTES) } ?: ByteArray(0)
            require(status == 200) { "Code d’installation refusé (HTTP $status)" }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") {
                "Réponse de code d’installation invalide"
            }
            val json = JSONObject(bytes.toString(StandardCharsets.UTF_8))
            val resolved = EnrollmentCodeBootstrapCrypto.decrypt(
                EnrollmentCodeBootstrapPayload(
                    version = json.getInt("version"),
                    algorithm = json.getString("algorithm"),
                    keyDerivation = json.getString("keyDerivation"),
                    context = json.getString("context"),
                    salt = json.getString("salt"),
                    iv = json.getString("iv"),
                    ciphertext = json.getString("ciphertext"),
                    tag = json.getString("tag"),
                ),
                normalizedCode,
            )
            require(
                expectedServerCaFingerprintSha256 == null ||
                    resolved.certificateFingerprintSha256 == expectedServerCaFingerprintSha256,
            ) { "La CA HTTPS ne correspond pas au manifeste de découverte" }
            val installedFingerprint = trustStore.installVerified(
                resolved.certificatePem,
                connection.serverCertificates,
            )
            require(installedFingerprint == resolved.certificateFingerprintSha256) {
                "L’autorité HTTPS installée ne correspond pas au code"
            }
            return resolved
        } finally {
            connection.disconnect()
        }
    }

    private fun openBootstrapConnection(url: URL): HttpsURLConnection {
        val bootstrapOnlyTrust = object : X509TrustManager {
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
            init(null, arrayOf<TrustManager>(bootstrapOnlyTrust), SecureRandom())
        }.socketFactory
        return (url.openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = socketFactory
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "POST"
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
            require(total <= maximum) { "Réponse d’installation trop grande" }
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
