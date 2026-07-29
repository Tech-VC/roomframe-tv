package org.roomframe.tv.sync

import org.junit.Assert.assertArrayEquals
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
}
