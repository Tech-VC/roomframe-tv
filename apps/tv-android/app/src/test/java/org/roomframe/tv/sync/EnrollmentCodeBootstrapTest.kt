package org.roomframe.tv.sync

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EnrollmentCodeBootstrapTest {
    @Test
    fun `normalise le code affiche par la regie`() {
        assertEquals(
            "23456789ABCDEFGH",
            EnrollmentCodePolicy.normalize(" 2345-6789-abcd-efgh "),
        )
        assertEquals(
            "2345-6789-ABCD-EFGH",
            EnrollmentCodePolicy.format("23456789abcdefgh"),
        )
        assertEquals(
            "805ffeb0f1d0771fc4926c0812fc53ae9329110a493135bc05c90dc6df3cfdf9",
            EnrollmentCodeBootstrapCrypto.lookupId("2345-6789-ABCD-EFGH"),
        )
        assertEquals(
            "https://roomframe.example.local",
            EnrollmentCodePolicy.manualServerUrl("roomframe.example.local"),
        )
        assertEquals(
            "https://192.0.2.20",
            EnrollmentCodePolicy.manualServerUrl(" https://192.0.2.20 "),
        )
        assertThrows(IllegalArgumentException::class.java) {
            EnrollmentCodePolicy.normalize("2345-6789-ABCD-EFG1")
        }
    }

    @Test
    fun `dechiffre le paquet produit pour un code installation`() {
        val code = "2345-6789-ABCD-EFGH"
        val certificate = "-----BEGIN CERTIFICATE-----\n" +
            "A".repeat(600) +
            "\n-----END CERTIFICATE-----\n"
        val payload = encryptedPayload(code, certificate)
        val resolved = EnrollmentCodeBootstrapCrypto.decrypt(payload, code)

        assertEquals("11111111-1111-4111-8111-111111111111", resolved.deviceId)
        assertEquals(
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            resolved.enrollmentKey,
        )
        assertEquals(certificate, resolved.certificatePem)
        assertEquals("a".repeat(64), resolved.certificateFingerprintSha256)
        assertThrows(AEADBadTagException::class.java) {
            EnrollmentCodeBootstrapCrypto.decrypt(payload, "2345-6789-ABCD-EFGJ")
        }
    }

    private fun encryptedPayload(
        code: String,
        certificate: String,
    ): EnrollmentCodeBootstrapPayload {
        val context = EnrollmentCodeBootstrapCrypto.CONTEXT
        val normalized = EnrollmentCodePolicy.normalize(code)
        val salt = ByteArray(32) { 7 }
        val iv = ByteArray(12) { 9 }
        val info = context.toByteArray(StandardCharsets.UTF_8)
        val inputKeyMaterial = MessageDigest.getInstance("SHA-256").digest(
            "$context\u0000$normalized".toByteArray(StandardCharsets.UTF_8),
        )
        val extract = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(inputKeyMaterial)
        }
        val key = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(extract, "HmacSHA256"))
            update(info)
            update(1)
            doFinal().copyOf(32)
        }
        val plaintext = JSONObject()
            .put("version", 1)
            .put("deviceId", "11111111-1111-4111-8111-111111111111")
            .put(
                "enrollmentKey",
                "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
            )
            .put("certificatePem", certificate)
            .put("certificateFingerprintSha256", "a".repeat(64))
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(info)
        }
        val encrypted = cipher.doFinal(plaintext)
        return EnrollmentCodeBootstrapPayload(
            version = 1,
            algorithm = "AES-256-GCM",
            keyDerivation = "HKDF-SHA256",
            context = context,
            salt = salt.base64Url(),
            iv = iv.base64Url(),
            ciphertext = encrypted.copyOfRange(0, encrypted.size - 16).base64Url(),
            tag = encrypted.copyOfRange(encrypted.size - 16, encrypted.size).base64Url(),
        )
    }

    private fun ByteArray.base64Url(): String = Base64
        .getUrlEncoder()
        .withoutPadding()
        .encodeToString(this)
}
