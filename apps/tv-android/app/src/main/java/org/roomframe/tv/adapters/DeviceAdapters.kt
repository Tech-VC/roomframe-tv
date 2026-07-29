package org.roomframe.tv.adapters

import android.content.Context

/**
 * Une capacité inconnue ou non supportée n'est jamais présentée comme un succès.
 * Les adaptateurs constructeur seront ajoutés dans des modules séparés après test matériel.
 */
enum class CapabilityState {
    SUPPORTED,
    UNSUPPORTED,
    UNKNOWN,
    EXPERIMENTAL,
}

sealed interface AdapterResult {
    data object Success : AdapterResult
    data class Pending(val reason: String) : AdapterResult
    data class Unavailable(val reason: String) : AdapterResult
    data class Failure(val reason: String) : AdapterResult
}

enum class HdmiSignalState {
    ACTIVE,
    NO_SIGNAL,
    UNKNOWN,
}

data class PowerCapabilities(
    val sleep: CapabilityState,
    val scheduledWake: CapabilityState,
)

data class AppUpdateCapabilities(
    val verifiedDownload: CapabilityState,
    val silentInstall: CapabilityState,
)

/**
 * L'APK doit avoir été téléchargé dans le stockage privé de l'application,
 * vérifié par SHA-256 et contrôlé comme étant signé par la clé RoomFrame
 * attendue avant d'atteindre l'adaptateur d'installation.
 */
data class VerifiedApkArtifact(
    val localPath: String,
    val packageName: String,
    val versionCode: Long,
    val sha256: String,
)

interface SourceAdapter {
    val capability: CapabilityState
    fun activate(): AdapterResult
}

interface HdmiAdapter : SourceAdapter {
    fun signalState(): HdmiSignalState
}

interface CastAdapter : SourceAdapter

interface AirPlayAdapter : SourceAdapter

interface PowerAdapter {
    fun probeCapabilities(): PowerCapabilities
    fun requestSleep(): AdapterResult
    fun scheduleWake(epochMillis: Long): AdapterResult
}

interface AppUpdateAdapter {
    fun probeCapabilities(): AppUpdateCapabilities
    fun installVerified(apk: VerifiedApkArtifact): AdapterResult
}

data class DeviceAdapters(
    val hdmi: HdmiAdapter,
    val cast: CastAdapter,
    val airPlay: AirPlayAdapter,
    val power: PowerAdapter,
    val appUpdate: AppUpdateAdapter,
) {
    companion object {
        fun unsupported(): DeviceAdapters = DeviceAdapters(
            hdmi = UnsupportedHdmiAdapter,
            cast = UnsupportedCastAdapter,
            airPlay = UnsupportedAirPlayAdapter,
            power = UnsupportedPowerAdapter,
            appUpdate = UnsupportedAppUpdateAdapter,
        )

        fun forAndroid(context: Context): DeviceAdapters = DeviceAdapters(
            hdmi = UnsupportedHdmiAdapter,
            cast = UnsupportedCastAdapter,
            airPlay = UnsupportedAirPlayAdapter,
            power = UnsupportedPowerAdapter,
            appUpdate = AndroidPackageInstallerAdapter(context.applicationContext),
        )
    }
}
