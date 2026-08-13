package org.roomframe.tv.adapters

import android.content.ComponentName
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
        val routes = manager.sourceRoutes(hdmiPort = 1)
        val castReceiver = applicationContext.castReceiverSnapshot()
        return PhilipsTa1SourceAdapterSet(
            hdmi = PhilipsTa1HdmiAdapter(
                activation = launcher.prepare(
                    inputId = routes.hdmiInputId,
                    label = "HDMI 1",
                    missingReason = "HDMI 1 introuvable",
                    retryInputId = { manager.sourceRoutes(hdmiPort = 1).hdmiInputId },
                ),
            ),
            cast = PhilipsTa1CastAdapter(castReceiver),
            airPlay = PhilipsTa1AirPlayAdapter(
                activation = launcher.prepare(
                    inputId = routes.airPlayInputId,
                    label = "AirPlay",
                    missingReason = "Récepteur AirPlay Philips introuvable",
                    retryInputId = { manager.sourceRoutes(hdmiPort = 1).airPlayInputId },
                ),
            ),
        )
    }
}

private class TvInputLauncher(private val context: Context) {
    fun prepare(
        inputId: String?,
        label: String,
        missingReason: String,
        retryInputId: () -> String?,
    ): PreparedTvInputActivation = PreparedTvInputActivation(
        context = context,
        intents = RateLimitedFallbackResolver(
            initialValue = inputId?.let(::explicitIntent),
            fallback = { retryInputId()?.let(::explicitIntent) },
        ),
        label = label,
        unavailableReason = missingReason,
    )

    private fun explicitIntent(inputId: String): Intent? {
        val intent = Intent(
            Intent.ACTION_VIEW,
            TvContract.buildChannelUriForPassthroughInput(inputId),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activityInfo = context.packageManager
            .resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
            ?.activityInfo
            ?: return null
        intent.component = ComponentName(activityInfo.packageName, activityInfo.name)
        return intent
    }
}

/**
 * Intent déjà validé et rendu explicite : le chemin nominal ne recherche rien
 * à l'appui. Une route absente ou devenue invalide est réévaluée à fréquence
 * bornée par le résolveur.
 */
private class PreparedTvInputActivation(
    private val context: Context,
    private val intents: RateLimitedFallbackResolver<Intent>,
    private val label: String,
    private val unavailableReason: String,
) {
    fun activate(): AdapterResult {
        val launchIntent = intents.resolve()
            ?: return AdapterResult.Unavailable(unavailableReason)
        return runCatching { context.startActivity(Intent(launchIntent)) }
            .fold(
                onSuccess = { AdapterResult.Success },
                onFailure = {
                    intents.invalidate()
                    AdapterResult.Failure("Ouverture de $label impossible")
                },
            )
    }
}

private class PhilipsTa1AirPlayAdapter(
    private val activation: PreparedTvInputActivation,
) : AirPlayAdapter {
    override val capability = CapabilityState.EXPERIMENTAL

    override fun activate(): AdapterResult = activation.activate()
}

private class PhilipsTa1HdmiAdapter(
    private val activation: PreparedTvInputActivation,
) : HdmiAdapter {
    override val capability = CapabilityState.EXPERIMENTAL

    override fun activate(): AdapterResult = activation.activate()

    override fun signalState(): HdmiSignalState = HdmiSignalState.UNKNOWN
}

private data class CastReceiverSnapshot(
    val available: Boolean,
    val icon: Drawable?,
)

private class PhilipsTa1CastAdapter(
    private val receiver: CastReceiverSnapshot,
) : CastAdapter {
    override val capability: CapabilityState =
        if (receiver.available) CapabilityState.EXPERIMENTAL else CapabilityState.UNSUPPORTED

    override fun activate(): AdapterResult = if (receiver.available) {
        AdapterResult.Pending(
            "Récepteur Cast détecté. Choisissez ce téléviseur sur votre appareil.",
        )
    } else {
        AdapterResult.Unavailable("Récepteur Cast introuvable")
    }

    override fun brandedIcon(): Drawable? = receiver.icon
}

@Suppress("DEPRECATION")
private fun Context.castReceiverSnapshot(): CastReceiverSnapshot {
    val available = runCatching {
        packageManager.getApplicationInfo(PhilipsTa1Profile.CAST_PACKAGE, 0).enabled
    }.getOrDefault(false)
    return CastReceiverSnapshot(
        available = available,
        icon = if (available) {
            runCatching { packageManager.getApplicationIcon(PhilipsTa1Profile.CAST_PACKAGE) }.getOrNull()
        } else {
            null
        },
    )
}

private fun TvInputManager.sourceRoutes(hdmiPort: Int): PhilipsTa1Profile.SourceRoutes {
    val inputs = runCatching { tvInputList }.getOrDefault(emptyList())
    return PhilipsTa1Profile.sourceRoutes(
        inputs.map { info ->
            PhilipsTa1Profile.InputDescriptor(
                id = info.id,
                packageName = info.serviceInfo.packageName,
                isHdmi = info.type == TvInputInfo.TYPE_HDMI,
            )
        },
        hdmiPort = hdmiPort,
    )
}
