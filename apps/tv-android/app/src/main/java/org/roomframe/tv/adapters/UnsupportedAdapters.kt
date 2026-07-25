package org.roomframe.tv.adapters

private const val HARDWARE_NOT_VALIDATED = "Intégration matérielle non validée sur ce téléviseur"

object UnsupportedHdmiAdapter : HdmiAdapter {
    override val capability = CapabilityState.UNSUPPORTED
    override fun activate(): AdapterResult = AdapterResult.Unavailable(HARDWARE_NOT_VALIDATED)
    override fun signalState(): HdmiSignalState = HdmiSignalState.UNKNOWN
}

object UnsupportedCastAdapter : CastAdapter {
    override val capability = CapabilityState.UNSUPPORTED
    override fun activate(): AdapterResult = AdapterResult.Unavailable(HARDWARE_NOT_VALIDATED)
}

object UnsupportedAirPlayAdapter : AirPlayAdapter {
    override val capability = CapabilityState.UNSUPPORTED
    override fun activate(): AdapterResult = AdapterResult.Unavailable(HARDWARE_NOT_VALIDATED)
}

object UnsupportedPowerAdapter : PowerAdapter {
    override fun probeCapabilities() = PowerCapabilities(
        sleep = CapabilityState.UNKNOWN,
        scheduledWake = CapabilityState.UNKNOWN,
    )

    override fun requestSleep(): AdapterResult = AdapterResult.Unavailable(HARDWARE_NOT_VALIDATED)

    override fun scheduleWake(epochMillis: Long): AdapterResult =
        AdapterResult.Unavailable(HARDWARE_NOT_VALIDATED)
}

object UnsupportedAppUpdateAdapter : AppUpdateAdapter {
    override fun probeCapabilities() = AppUpdateCapabilities(
        verifiedDownload = CapabilityState.UNKNOWN,
        silentInstall = CapabilityState.UNKNOWN,
    )

    override fun installVerified(apk: VerifiedApkArtifact): AdapterResult =
        AdapterResult.Unavailable(
            "Installation silencieuse indisponible tant que Device Owner n'est pas validé",
        )
}
