package org.roomframe.tv.adapters

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.media.tv.TvContract
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.os.Build

data class PhilipsTa1SourceAdapterSet(
    val hdmi: HdmiAdapter,
    val cast: CastAdapter,
    val airPlay: AirPlayAdapter,
)

/**
 * Adaptateurs activés uniquement sur la plateforme Philips TA1 observée.
 * Les chemins TvInput restent publics, réversibles et sans API constructeur privée.
 */
object PhilipsTa1SourceAdapters {
    fun create(context: Context): PhilipsTa1SourceAdapterSet? {
        if (!PhilipsTa1Profile.matches(Build.MANUFACTURER, Build.BRAND, Build.PRODUCT)) return null
        val applicationContext = context.applicationContext
        val manager = applicationContext.getSystemService(TvInputManager::class.java) ?: return null
        val launcher = TvInputLauncher(applicationContext)
        return PhilipsTa1SourceAdapterSet(
            hdmi = PhilipsTa1HdmiAdapter(manager, launcher, port = 1),
            cast = PhilipsTa1CastAdapter(applicationContext),
            airPlay = PhilipsTa1AirPlayAdapter(manager, launcher),
        )
    }
}

private class TvInputLauncher(private val context: Context) {
    fun activate(inputId: String, label: String): AdapterResult {
        val intent = Intent(
            Intent.ACTION_VIEW,
            TvContract.buildChannelUriForPassthroughInput(inputId),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) == null) {
            return AdapterResult.Unavailable("$label n'est pas accessible sur ce téléviseur")
        }
        return runCatching { context.startActivity(intent) }
            .fold(
                onSuccess = { AdapterResult.Success },
                onFailure = { AdapterResult.Failure("Ouverture de $label impossible") },
            )
    }
}

private class PhilipsTa1AirPlayAdapter(
    private val manager: TvInputManager,
    private val launcher: TvInputLauncher,
) : AirPlayAdapter {
    override val capability = CapabilityState.EXPERIMENTAL

    override fun activate(): AdapterResult {
        val inputId = manager.tvInputList
            .firstOrNull { info -> info.serviceInfo.packageName == PhilipsTa1Profile.AIRPLAY_PACKAGE }
            ?.id
            ?: return AdapterResult.Unavailable("Récepteur AirPlay Philips introuvable")
        return launcher.activate(inputId, "AirPlay")
    }
}

private class PhilipsTa1HdmiAdapter(
    private val manager: TvInputManager,
    private val launcher: TvInputLauncher,
    private val port: Int,
) : HdmiAdapter {
    override val capability = CapabilityState.EXPERIMENTAL

    override fun activate(): AdapterResult {
        val inputId = PhilipsTa1Profile.hdmiInputId(
            manager.tvInputList
                .filter { info -> info.type == TvInputInfo.TYPE_HDMI }
                .map(TvInputInfo::getId),
            port,
        ) ?: return AdapterResult.Unavailable("HDMI $port introuvable")
        return launcher.activate(inputId, "HDMI $port")
    }

    override fun signalState(): HdmiSignalState = HdmiSignalState.UNKNOWN
}

private class PhilipsTa1CastAdapter(private val context: Context) : CastAdapter {
    override val capability: CapabilityState
        get() = if (receiverInstalled()) CapabilityState.EXPERIMENTAL else CapabilityState.UNSUPPORTED

    override fun activate(): AdapterResult = if (receiverInstalled()) {
        AdapterResult.Pending(
            "Chromecast intégré est prêt. Ouvrez Cast sur votre appareil et choisissez ce téléviseur.",
        )
    } else {
        AdapterResult.Unavailable("Récepteur Cast introuvable")
    }

    override fun brandedIcon(): Drawable? = context.applicationIcon(PhilipsTa1Profile.CAST_PACKAGE)

    @Suppress("DEPRECATION")
    private fun receiverInstalled(): Boolean = runCatching {
        context.packageManager.getApplicationInfo(PhilipsTa1Profile.CAST_PACKAGE, 0).enabled
    }.getOrDefault(false)
}

private fun Context.applicationIcon(packageName: String): Drawable? =
    runCatching { packageManager.getApplicationIcon(packageName) }.getOrNull()
