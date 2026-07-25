package org.roomframe.tv.adapters

/**
 * Adaptateurs réservés aux tests et démonstrations explicitement simulées.
 * Ils ne sont pas sélectionnés par l'application de production.
 */
class SimulatedHdmiAdapter(
    private var signal: HdmiSignalState = HdmiSignalState.NO_SIGNAL,
) : HdmiAdapter {
    override val capability = CapabilityState.SUPPORTED
    override fun activate(): AdapterResult =
        if (signal == HdmiSignalState.ACTIVE) AdapterResult.Success
        else AdapterResult.Unavailable("Simulation : aucun signal HDMI")

    override fun signalState(): HdmiSignalState = signal

    fun setSignalState(value: HdmiSignalState) {
        signal = value
    }
}

class SimulatedCastAdapter(
    private val available: Boolean = true,
) : CastAdapter {
    override val capability = CapabilityState.SUPPORTED
    override fun activate(): AdapterResult =
        if (available) AdapterResult.Success else AdapterResult.Unavailable("Simulation : Cast indisponible")
}

class SimulatedAirPlayAdapter(
    private val available: Boolean = true,
) : AirPlayAdapter {
    override val capability = CapabilityState.SUPPORTED
    override fun activate(): AdapterResult =
        if (available) AdapterResult.Success else AdapterResult.Unavailable("Simulation : AirPlay indisponible")
}

class SimulatedPowerAdapter(
    private val capabilities: PowerCapabilities = PowerCapabilities(
        sleep = CapabilityState.SUPPORTED,
        scheduledWake = CapabilityState.EXPERIMENTAL,
    ),
) : PowerAdapter {
    override fun probeCapabilities(): PowerCapabilities = capabilities
    override fun requestSleep(): AdapterResult =
        if (capabilities.sleep == CapabilityState.SUPPORTED) AdapterResult.Success
        else AdapterResult.Unavailable("Simulation : veille indisponible")

    override fun scheduleWake(epochMillis: Long): AdapterResult =
        if (capabilities.scheduledWake in setOf(CapabilityState.SUPPORTED, CapabilityState.EXPERIMENTAL)) {
            AdapterResult.Success
        } else {
            AdapterResult.Unavailable("Simulation : réveil indisponible")
        }
}

class SimulatedAppUpdateAdapter(
    private val silentInstallAvailable: Boolean = true,
) : AppUpdateAdapter {
    override fun probeCapabilities() = AppUpdateCapabilities(
        verifiedDownload = CapabilityState.SUPPORTED,
        silentInstall = if (silentInstallAvailable) {
            CapabilityState.SUPPORTED
        } else {
            CapabilityState.UNSUPPORTED
        },
    )

    override fun installVerified(apk: VerifiedApkArtifact): AdapterResult =
        when {
            !silentInstallAvailable ->
                AdapterResult.Unavailable("Simulation : installation silencieuse indisponible")
            apk.localPath.isBlank() ||
                apk.packageName != "org.roomframe.tv" ||
                apk.versionCode <= 0 ||
                !apk.sha256.matches(Regex("^[0-9a-f]{64}$")) ->
                AdapterResult.Failure("Simulation : descripteur APK vérifié invalide")
            else -> AdapterResult.Success
        }
}
