package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TvCertificateProvisioningPolicyTest {
    @Test
    fun `la lecture du certificat essaie le mtls avant le repli de recuperation`() {
        assertTrue(
            TvCertificateTransportPolicy.includeClientCertificate(
                method = "GET",
                path = "/api/v1/tv/certificate",
                recoveryAttempt = false,
            ),
        )
        assertFalse(
            TvCertificateTransportPolicy.includeClientCertificate(
                method = "GET",
                path = "/api/v1/tv/certificate",
                recoveryAttempt = true,
            ),
        )
        assertTrue(
            TvCertificateTransportPolicy.includeClientCertificate(
                method = "POST",
                path = "/api/v1/tv/certificate/activate",
                recoveryAttempt = true,
            ),
        )
        assertTrue(
            TvCertificateTransportPolicy.includeClientCertificate(
                method = "GET",
                path = "/api/v1/sync",
                recoveryAttempt = true,
            ),
        )
    }

    @Test
    fun `installe puis active un nouveau certificat`() {
        assertEquals(
            TvCertificateProvisioningPlan(install = true, activate = true),
            TvCertificateProvisioningPolicy.plan(
                currentFingerprintSha256 = null,
                expectedFingerprintSha256 = "a".repeat(64),
                activationRequired = true,
            ),
        )
    }

    @Test
    fun `active une empreinte differente meme si un ancien serveur dit le contraire`() {
        assertEquals(
            TvCertificateProvisioningPlan(install = true, activate = true),
            TvCertificateProvisioningPolicy.plan(
                currentFingerprintSha256 = "a".repeat(64),
                expectedFingerprintSha256 = "b".repeat(64),
                activationRequired = false,
            ),
        )
    }

    @Test
    fun `retente une activation serveur sans reinstaller le certificat`() {
        val fingerprint = "b".repeat(64)

        assertEquals(
            TvCertificateProvisioningPlan(install = false, activate = true),
            TvCertificateProvisioningPolicy.plan(
                currentFingerprintSha256 = fingerprint,
                expectedFingerprintSha256 = fingerprint,
                activationRequired = true,
            ),
        )
    }

    @Test
    fun `ne refait rien lorsque le serveur confirme le certificat actif`() {
        val fingerprint = "c".repeat(64)

        assertEquals(
            TvCertificateProvisioningPlan(install = false, activate = false),
            TvCertificateProvisioningPolicy.plan(
                currentFingerprintSha256 = fingerprint,
                expectedFingerprintSha256 = fingerprint,
                activationRequired = false,
            ),
        )
    }

}
