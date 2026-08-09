package org.roomframe.tv.sync

import java.net.URI
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import org.json.JSONObject
import org.roomframe.tv.experience.CanonicalJson

data class SignedDiscoveryDescriptor(
    val origin: String,
    val fallbackOrigin: String,
    val host: String,
    val ipv4: String,
    val port: Int,
    val serverCaFingerprintSha256: String,
    val publicKeyFingerprintSha256: String,
    val generatedAt: Instant,
)

object DiscoveryDescriptorPolicy {
    fun parseAndVerify(bytes: ByteArray): SignedDiscoveryDescriptor {
        require(bytes.size in 200..MAX_BYTES) { "Manifeste de découverte hors limites" }
        val descriptor = JSONObject(bytes.toString(Charsets.UTF_8))
        require(descriptor.keys().asSequence().toSet() == DESCRIPTOR_KEYS) {
            "Champs de découverte invalides"
        }
        require(descriptor.getInt("formatVersion") == 1) {
            "Version de découverte inconnue"
        }
        require(descriptor.getString("serviceType") == MANIFEST_SERVICE_TYPE) {
            "Type de service de découverte invalide"
        }
        require(descriptor.getString("path") == DISCOVERY_PATH) {
            "Chemin de découverte invalide"
        }
        val port = descriptor.getInt("port")
        require(port == 443) { "Port de découverte invalide" }
        val host = descriptor.getString("host").lowercase()
        require(host.matches(HOST_PATTERN)) { "Hôte de découverte invalide" }
        val ipv4 = descriptor.getString("ipv4")
        require(
            ipv4.matches(IPV4_PATTERN) && ipv4.split('.').all {
                val octet = it.toIntOrNull()
                octet != null && octet in 0..255 && (it == "0" || !it.startsWith('0'))
            },
        ) { "IPv4 de découverte invalide" }
        val origin = validateOrigin(descriptor.getString("origin"), host)
        val fallbackOrigin = validateOrigin(descriptor.getString("fallbackOrigin"), ipv4)
        val caFingerprint = descriptor.getString("serverCaFingerprintSha256")
        require(caFingerprint.matches(SHA256_PATTERN)) {
            "Empreinte de CA HTTPS invalide"
        }
        val generatedAt = Instant.parse(descriptor.getString("generatedAt"))

        val signing = descriptor.getJSONObject("signing")
        require(signing.keys().asSequence().toSet() == SIGNING_KEYS) {
            "Champs de signature de découverte invalides"
        }
        require(signing.getString("algorithm") == SIGNING_ALGORITHM) {
            "Algorithme de découverte incompatible"
        }
        val publicKeyDer = decodeCanonical(
            signing.getString("publicKeySpki"),
            80,
            200,
            "Clé publique de découverte",
        )
        val keyFingerprint = sha256(publicKeyDer)
        require(
            signing.getString("publicKeyFingerprintSha256") == keyFingerprint,
        ) { "Empreinte de clé de découverte invalide" }
        val publicKey = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(publicKeyDer))
        require(
            publicKey is ECPublicKey &&
                publicKey.params.curve.field.fieldSize == 256 &&
                publicKey.params.order.bitLength() == 256,
        ) { "La clé de découverte n'utilise pas ECDSA P-256" }
        val signatureBytes = decodeCanonical(
            signing.getString("signature"),
            64,
            80,
            "Signature de découverte",
        )

        val signedDescriptor = JSONObject(descriptor.toString())
        signedDescriptor.getJSONObject("signing").remove("signature")
        val verified = Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(CanonicalJson.encode(signedDescriptor))
            verify(signatureBytes)
        }
        require(verified) { "Signature de découverte invalide" }

        return SignedDiscoveryDescriptor(
            origin = origin,
            fallbackOrigin = fallbackOrigin,
            host = host,
            ipv4 = ipv4,
            port = port,
            serverCaFingerprintSha256 = caFingerprint,
            publicKeyFingerprintSha256 = keyFingerprint,
            generatedAt = generatedAt,
        )
    }

    fun verifyAdvertisement(
        attributes: Map<String, ByteArray>,
        descriptor: SignedDiscoveryDescriptor,
    ) {
        fun attribute(name: String, maximumLength: Int): String {
            val bytes = requireNotNull(attributes[name]) {
                "Attribut DNS-SD RoomFrame absent: $name"
            }
            require(bytes.isNotEmpty() && bytes.size <= maximumLength) {
                "Attribut DNS-SD RoomFrame hors limites: $name"
            }
            require(bytes.all { it.toInt() in 0x20..0x7e }) {
                "Attribut DNS-SD RoomFrame non ASCII: $name"
            }
            return bytes.toString(Charsets.US_ASCII)
        }
        require(attribute("version", 8) == "1") {
            "Version DNS-SD RoomFrame incompatible"
        }
        require(attribute("path", 64) == DISCOVERY_PATH) {
            "Chemin DNS-SD RoomFrame invalide"
        }
        require(attribute("key", 64) == descriptor.publicKeyFingerprintSha256) {
            "L'annonce DNS-SD ne correspond pas au manifeste signé"
        }
    }

    private fun validateOrigin(value: String, expectedHost: String): String {
        val normalized = DeviceCredentialStore.validateServerUrl(value)
        val parsed = URI(normalized)
        require(parsed.host == expectedHost && parsed.port in setOf(-1, 443)) {
            "Origine HTTPS de découverte incohérente"
        }
        return normalized
    }

    private fun decodeCanonical(
        value: String,
        minimum: Int,
        maximum: Int,
        label: String,
    ): ByteArray {
        require(value.matches(BASE64URL_PATTERN)) { "$label invalide" }
        val decoded = Base64.getUrlDecoder().decode(value)
        require(decoded.size in minimum..maximum) { "$label hors limites" }
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(decoded) == value) {
            "$label non canonique"
        }
        return decoded
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    const val MANIFEST_SERVICE_TYPE = "_roomframe._tcp"
    const val DISCOVERY_PATH = "/api/v1/discovery"
    private const val SIGNING_ALGORITHM = "ECDSA-P256-SHA256"
    private const val MAX_BYTES = 32 * 1024
    private val DESCRIPTOR_KEYS = setOf(
        "formatVersion",
        "serviceType",
        "path",
        "origin",
        "fallbackOrigin",
        "host",
        "ipv4",
        "port",
        "serverCaFingerprintSha256",
        "generatedAt",
        "signing",
    )
    private val SIGNING_KEYS = setOf(
        "algorithm",
        "publicKeySpki",
        "publicKeyFingerprintSha256",
        "signature",
    )
    private val HOST_PATTERN = Regex(
        "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*" +
            "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    )
    private val IPV4_PATTERN = Regex("^[0-9]{1,3}(?:\\.[0-9]{1,3}){3}$")
    private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    private val BASE64URL_PATTERN = Regex("^[A-Za-z0-9_-]+$")
}
