package org.roomframe.tv.sync

data class TvCertificateProvisioningPlan(
    val install: Boolean,
    val activate: Boolean,
)

object TvCertificateProvisioningPolicy {
    fun plan(
        currentFingerprintSha256: String?,
        expectedFingerprintSha256: String,
        activationRequired: Boolean,
    ): TvCertificateProvisioningPlan = TvCertificateProvisioningPlan(
        install = currentFingerprintSha256 != expectedFingerprintSha256,
        activate = activationRequired,
    )
}
