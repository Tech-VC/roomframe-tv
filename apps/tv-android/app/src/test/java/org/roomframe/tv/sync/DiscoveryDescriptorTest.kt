package org.roomframe.tv.sync

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.roomframe.tv.experience.CanonicalJson

class DiscoveryDescriptorTest {
    @Test
    fun `verifie un manifeste ECDSA P-256 et refuse une origine alteree`() {
        val keyPair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        val publicDer = keyPair.public.encoded
        val signed = JSONObject()
            .put("formatVersion", 1)
            .put("serviceType", "_roomframe._tcp")
            .put("path", "/api/v1/discovery")
            .put("origin", "https://roomframe.example.local")
            .put("fallbackOrigin", "https://192.0.2.24")
            .put("host", "roomframe.example.local")
            .put("ipv4", "192.0.2.24")
            .put("port", 443)
            .put("serverCaFingerprintSha256", "a".repeat(64))
            .put("generatedAt", "2026-07-29T12:00:00Z")
            .put(
                "signing",
                JSONObject()
                    .put("algorithm", "ECDSA-P256-SHA256")
                    .put("publicKeySpki", publicDer.base64Url())
                    .put("publicKeyFingerprintSha256", publicDer.sha256()),
            )
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update(CanonicalJson.encode(signed))
            sign()
        }
        val descriptor = JSONObject(signed.toString()).apply {
            getJSONObject("signing").put("signature", signature.base64Url())
        }

        val parsed = DiscoveryDescriptorPolicy.parseAndVerify(
            descriptor.toString().toByteArray(),
        )
        assertEquals("https://roomframe.example.local", parsed.origin)
        assertEquals("https://192.0.2.24", parsed.fallbackOrigin)
        DiscoveryDescriptorPolicy.verifyAdvertisement(
            mapOf(
                "version" to "1".toByteArray(),
                "path" to "/api/v1/discovery".toByteArray(),
                "key" to parsed.publicKeyFingerprintSha256.toByteArray(),
            ),
            parsed,
        )
        assertThrows(IllegalArgumentException::class.java) {
            DiscoveryDescriptorPolicy.verifyAdvertisement(
                mapOf(
                    "version" to "1".toByteArray(),
                    "path" to "/api/v1/discovery".toByteArray(),
                    "key" to "f".repeat(64).toByteArray(),
                ),
                parsed,
            )
        }

        descriptor.put("fallbackOrigin", "https://192.0.2.25")
        assertThrows(IllegalArgumentException::class.java) {
            DiscoveryDescriptorPolicy.parseAndVerify(descriptor.toString().toByteArray())
        }
        descriptor.put("fallbackOrigin", "https://192.0.2.24:8443")
        assertThrows(IllegalArgumentException::class.java) {
            DiscoveryDescriptorPolicy.parseAndVerify(descriptor.toString().toByteArray())
        }
    }

    private fun ByteArray.base64Url(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(this)

    private fun ByteArray.sha256(): String =
        MessageDigest.getInstance("SHA-256").digest(this)
            .joinToString("") { "%02x".format(it) }
}
