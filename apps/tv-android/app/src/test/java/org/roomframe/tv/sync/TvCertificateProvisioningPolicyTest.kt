package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Test

class TvCertificateProvisioningPolicyTest {
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
