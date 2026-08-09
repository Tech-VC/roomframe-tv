package org.roomframe.tv.sync

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.KeyManager
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.security.auth.x500.X500Principal

data class TvCertificateEnrollmentProof(
    val publicKeySpki: String,
    val proofSignature: String,
)

class TvClientCertificateStore {
    fun enrollmentProof(deviceId: String, enrollmentKey: String): TvCertificateEnrollmentProof {
        val normalizedId = DeviceCredentialStore.validateDeviceId(deviceId)
        DeviceCredentialStore.validateDeviceKey(enrollmentKey)
        val keyStore = androidKeyStore()
        if (!keyStore.containsAlias(KEY_ALIAS)) generateKeyPair()
        val certificate = requireNotNull(androidKeyStore().getCertificate(KEY_ALIAS)) {
            "Clé TLS TV absente"
        }
        val privateKey = requireNotNull(androidKeyStore().getKey(KEY_ALIAS, null)) {
            "Clé privée TLS TV absente"
        }
        val payload = proofPayload(normalizedId, enrollmentKey)
        val signature = Signature.getInstance(SIGNATURE_ALGORITHM).run {
            initSign(privateKey as java.security.PrivateKey)
            update(payload)
            sign()
        }
        return TvCertificateEnrollmentProof(
            publicKeySpki = certificate.publicKey.encoded.base64Url(),
            proofSignature = signature.base64Url(),
        )
    }

    fun install(
        deviceId: String,
        certificatePem: String,
        caCertificatePem: String,
        expectedFingerprintSha256: String,
    ) {
        val normalizedId = DeviceCredentialStore.validateDeviceId(deviceId)
        require(expectedFingerprintSha256.matches(SHA256)) {
            "Empreinte de certificat TV invalide"
        }
        val keyStore = androidKeyStore()
        val privateKey = requireNotNull(
            keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey,
        ) { "Clé privée TLS TV absente" }
        val bootstrapPublicKey = requireNotNull(keyStore.getCertificate(KEY_ALIAS)).publicKey
        val certificate = parseCertificate(certificatePem)
        val caCertificate = parseCertificate(caCertificatePem)

        require(certificate.basicConstraints < 0) { "Le certificat TV ne doit pas être une CA" }
        require(caCertificate.basicConstraints >= 0) { "Autorité cliente TV invalide" }
        certificate.checkValidity()
        caCertificate.checkValidity()
        certificate.verify(caCertificate.publicKey)
        require(certificate.publicKey.encoded.contentEquals(bootstrapPublicKey.encoded)) {
            "Le certificat TV ne correspond pas à la clé Android Keystore"
        }
        require(certificate.extendedKeyUsage?.contains(CLIENT_AUTH_OID) == true) {
            "Usage client TLS absent du certificat TV"
        }
        val expectedUri = "urn:roomframe:tv:$normalizedId"
        val uriNames = certificate.subjectAlternativeNames
            .orEmpty()
            .filter { it.size >= 2 && it[0] == 6 }
            .mapNotNull { it[1] as? String }
        require(expectedUri in uriNames) { "Identité TV absente du certificat" }
        require(certificate.encoded.sha256() == expectedFingerprintSha256) {
            "Empreinte du certificat TV incorrecte"
        }

        keyStore.setKeyEntry(
            KEY_ALIAS,
            privateKey,
            null,
            arrayOf(certificate, caCertificate),
        )
        require(currentFingerprintSha256() == expectedFingerprintSha256) {
            "Installation du certificat TV non confirmée"
        }
    }

    fun currentFingerprintSha256(): String? {
        val chain = androidKeyStore().getCertificateChain(KEY_ALIAS) ?: return null
        if (chain.size < 2) return null
        return runCatching {
            val leaf = chain.first() as X509Certificate
            leaf.checkValidity()
            leaf.encoded.sha256()
        }.getOrNull()
    }

    fun currentExpiryEpochMs(): Long? {
        val chain = androidKeyStore().getCertificateChain(KEY_ALIAS) ?: return null
        if (chain.size < 2) return null
        return (chain.first() as? X509Certificate)?.notAfter?.time
    }

    fun keyManagersOrNull(): Array<KeyManager>? {
        if (currentFingerprintSha256() == null) return null
        return KeyManagerFactory
            .getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(androidKeyStore(), null) }
            .keyManagers
    }

    fun clear() {
        val keyStore = androidKeyStore()
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
    }

    private fun generateKeyPair() {
        try {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEY_STORE).run {
                initialize(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_SIGN,
                    )
                        .setKeySize(2048)
                        .setDigests(*TvClientTlsKeyPolicy.authorizedDigests())
                        .setSignaturePaddings(
                            KeyProperties.SIGNATURE_PADDING_RSA_PKCS1,
                            KeyProperties.SIGNATURE_PADDING_RSA_PSS,
                        )
                        .setEncryptionPaddings(
                            *TvClientTlsKeyPolicy.authorizedEncryptionPaddings(),
                        )
                        .setRandomizedEncryptionRequired(
                            TvClientTlsKeyPolicy.randomizedEncryptionRequired(),
                        )
                        .setCertificateSubject(X500Principal("CN=RoomFrame TV bootstrap"))
                        .setCertificateSerialNumber(BigInteger.ONE)
                        .build(),
                )
                generateKeyPair()
            }
        } catch (error: Exception) {
            throw TvTlsKeyGenerationException(error)
        }
    }

    private fun androidKeyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private fun parseCertificate(pem: String): X509Certificate {
        require(
            pem.length in 500..16_384 &&
                pem.startsWith("-----BEGIN CERTIFICATE-----") &&
                pem.trimEnd().endsWith("-----END CERTIFICATE-----"),
        ) { "Certificat PEM invalide" }
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(pem.toByteArray(Charsets.US_ASCII)))
            as X509Certificate
    }

    companion object {
        fun proofPayload(deviceId: String, enrollmentKey: String): ByteArray =
            "roomframe-tv-enrollment-v1\n$deviceId\n$enrollmentKey"
                .toByteArray(Charsets.UTF_8)

        private fun ByteArray.base64Url(): String =
            Base64.encodeToString(this, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

        private fun ByteArray.sha256(): String =
            MessageDigest.getInstance("SHA-256").digest(this)
                .joinToString("") { "%02x".format(it) }

        private const val KEY_ALIAS = "roomframe-tv-client-tls-v1"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val SIGNATURE_ALGORITHM = "SHA256withRSA"
        private const val CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2"
        private val SHA256 = Regex("^[a-f0-9]{64}$")
    }
}

object RoomFrameHttps {
    fun open(url: URL): HttpsURLConnection =
        (url.openConnection() as HttpsURLConnection).also { connection ->
            val keyManagers = TvClientCertificateStore().keyManagersOrNull()
            val trustManagers = RoomFrameServerTrust().trustManagersOrNull()
            if (keyManagers != null || trustManagers != null) {
                connection.sslSocketFactory = SSLContext.getInstance("TLS").apply {
                    init(keyManagers, trustManagers, null)
                }.socketFactory
            }
        }
}
