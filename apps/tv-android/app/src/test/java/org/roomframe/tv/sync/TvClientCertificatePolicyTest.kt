package org.roomframe.tv.sync

import android.security.keystore.KeyProperties
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TvClientCertificatePolicyTest {
    @Test
    fun `la preuve de possession utilise un format canonique partage`() {
        val deviceId = "11111111-1111-4111-8111-111111111111"
        val enrollmentKey = "abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890"

        assertArrayEquals(
            (
                "roomframe-tv-enrollment-v1\n" +
                    "$deviceId\n" +
                    enrollmentKey
            ).toByteArray(Charsets.UTF_8),
            TvClientCertificateStore.proofPayload(deviceId, enrollmentKey),
        )
    }

    @Test
    fun `la cle RSA autorise la signature brute demandee par Conscrypt`() {
        assertArrayEquals(
            arrayOf(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256),
            TvClientTlsKeyPolicy.authorizedDigests(),
        )
        assertArrayEquals(
            arrayOf(KeyProperties.ENCRYPTION_PADDING_NONE),
            TvClientTlsKeyPolicy.authorizedEncryptionPaddings(),
        )
        assertFalse(TvClientTlsKeyPolicy.randomizedEncryptionRequired())
        assertTrue(
            TvClientTlsKeyPolicy.supportsConscryptRawRsa(
                TvClientTlsKeyPolicy.authorizedDigests().toSet(),
                TvClientTlsKeyPolicy.authorizedEncryptionPaddings().toSet(),
            ),
        )
        assertFalse(
            TvClientTlsKeyPolicy.supportsConscryptRawRsa(
                setOf(KeyProperties.DIGEST_SHA256),
                emptySet(),
            ),
        )
    }
}
