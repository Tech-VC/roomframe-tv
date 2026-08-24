package org.roomframe.tv.adapters

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.media.tv.TvContract
import android.media.tv.TvInputInfo
import android.media.tv.TvInputManager
import android.os.Build
import android.os.IBinder

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
        val inputSnapshot = manager.sourceDescriptors()
        val airPlayInputId = PhilipsTa1Profile.sourceRoutes(inputSnapshot, hdmiPort = 1).airPlayInputId
        val hdmiInputIds = (1..4).associateWith { port ->
            PhilipsTa1Profile.sourceRoutes(inputSnapshot, hdmiPort = port).hdmiInputId
        }
        return PhilipsTa1SourceAdapterSet(
            hdmi = PhilipsTa1HdmiAdapter(
                activations = (1..4).associateWith { port ->
                    launcher.prepare(
                        inputId = hdmiInputIds[port],
                        label = "HDMI $port",
                        missingReason = "HDMI $port introuvable",
                        retryInputId = { manager.sourceRoutes(hdmiPort = port).hdmiInputId },
                    )
                },
            ),
            cast = PhilipsTa1CastAdapter(
                context = applicationContext,
                receiver = applicationContext::castReceiverSnapshot,
            ),
            airPlay = PhilipsTa1AirPlayAdapter(
                activation = launcher.prepare(
                    inputId = airPlayInputId,
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
    private val activations: Map<Int, PreparedTvInputActivation>,
) : HdmiAdapter {
    override val capability = CapabilityState.EXPERIMENTAL

    override fun activate(physicalInput: String?): AdapterResult {
        val port = PhilipsTa1Profile.hdmiPort(physicalInput)
            ?: return AdapterResult.Unavailable("Entrée HDMI non prise en charge sur cette TV")
        return activations[port]?.activate()
            ?: AdapterResult.Unavailable("HDMI $port introuvable")
    }

    override fun signalState(): HdmiSignalState = HdmiSignalState.UNKNOWN
}

private data class CastReceiverSnapshot(
    val available: Boolean,
    val icon: Drawable?,
)

private class PhilipsTa1CastAdapter(
    private val context: Context,
    private val receiver: () -> CastReceiverSnapshot,
) : CastAdapter {
    override val capability: CapabilityState
        get() = if (receiver().available) {
            CapabilityState.EXPERIMENTAL
        } else {
            CapabilityState.UNSUPPORTED
        }

    override fun activate(): AdapterResult {
        if (!receiver().available) {
            return AdapterResult.Unavailable("Récepteur Cast introuvable")
        }
        return when (PhilipsTa1CastReceiverLease.ensureBound(context)) {
            CastReceiverBindingResult.READY -> AdapterResult.Pending(
                "Récepteur Cast prêt. Choisissez ce téléviseur sur votre appareil.",
            )
            CastReceiverBindingResult.STARTING -> AdapterResult.Pending(
                "Démarrage du récepteur Cast. Il sera disponible dans quelques secondes.",
            )
            CastReceiverBindingResult.FAILED -> AdapterResult.Failure(
                "Démarrage du récepteur Cast impossible",
            )
        }
    }

    override fun brandedIcon(): Drawable? = receiver().icon
}

/**
 * Conserve une liaison applicative vers le récepteur système. Ce chemin est
 * celui publié par le paquet Cast et évite tout démarrage forcé de service de
 * premier plan, incompatible avec ce firmware Android 14.
 */
private object PhilipsTa1CastReceiverLease {
    private var applicationContext: Context? = null

    private val coordinator: CastReceiverBindingCoordinator by lazy {
        CastReceiverBindingCoordinator(
            bind = {
                val context = checkNotNull(applicationContext)
                context.bindService(
                    Intent(PhilipsTa1Profile.CAST_RECEIVER_BIND_ACTION).setComponent(
                        ComponentName(
                            PhilipsTa1Profile.CAST_PACKAGE,
                            PhilipsTa1Profile.CAST_RECEIVER_SERVICE,
                        ),
                    ),
                    connection,
                    Context.BIND_AUTO_CREATE,
                )
            },
            unbind = {
                applicationContext?.unbindService(connection)
            },
        )
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            coordinator.onConnected()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            coordinator.onDisconnected()
        }

        override fun onBindingDied(name: ComponentName) {
            coordinator.onBindingDied()
        }

        override fun onNullBinding(name: ComponentName) {
            coordinator.onNullBinding()
        }
    }

    @Synchronized
    fun ensureBound(context: Context): CastReceiverBindingResult {
        applicationContext = context.applicationContext
        return coordinator.ensureBound()
    }
}

internal enum class CastReceiverBindingResult {
    READY,
    STARTING,
    FAILED,
}

private enum class CastReceiverBindingState {
    UNBOUND,
    BINDING,
    BOUND,
    RECONNECTING,
}

/**
 * Garde une seule liaison enregistrée et distingue une demande acceptée d'un
 * service réellement connecté. Un callback absent est récupéré de façon
 * bornée au prochain appui, sans empiler les ServiceConnection.
 */
internal class CastReceiverBindingCoordinator(
    private val bind: () -> Boolean,
    private val unbind: () -> Unit,
    private val retryAfterMillis: Long = 10_000L,
    private val nowMillis: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) {
    private var state = CastReceiverBindingState.UNBOUND
    private var stateChangedAt = 0L

    @Synchronized
    fun ensureBound(): CastReceiverBindingResult {
        val now = nowMillis()
        when (state) {
            CastReceiverBindingState.BOUND -> return CastReceiverBindingResult.READY
            CastReceiverBindingState.BINDING,
            CastReceiverBindingState.RECONNECTING,
            -> if (now - stateChangedAt < retryAfterMillis) {
                return CastReceiverBindingResult.STARTING
            } else {
                releaseRegisteredBinding()
            }
            CastReceiverBindingState.UNBOUND -> Unit
        }

        state = CastReceiverBindingState.BINDING
        stateChangedAt = now
        val accepted = runCatching(bind).getOrDefault(false)
        if (!accepted) {
            state = CastReceiverBindingState.UNBOUND
            stateChangedAt = now
            return CastReceiverBindingResult.FAILED
        }
        return CastReceiverBindingResult.STARTING
    }

    @Synchronized
    fun onConnected() {
        state = CastReceiverBindingState.BOUND
        stateChangedAt = nowMillis()
    }

    @Synchronized
    fun onDisconnected() {
        if (state != CastReceiverBindingState.UNBOUND) {
            state = CastReceiverBindingState.RECONNECTING
            stateChangedAt = nowMillis()
        }
    }

    @Synchronized
    fun onBindingDied() = releaseRegisteredBinding()

    @Synchronized
    fun onNullBinding() = releaseRegisteredBinding()

    private fun releaseRegisteredBinding() {
        if (state != CastReceiverBindingState.UNBOUND) {
            runCatching(unbind)
        }
        state = CastReceiverBindingState.UNBOUND
        stateChangedAt = nowMillis()
    }
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
    return PhilipsTa1Profile.sourceRoutes(sourceDescriptors(), hdmiPort = hdmiPort)
}

private fun TvInputManager.sourceDescriptors(): List<PhilipsTa1Profile.InputDescriptor> =
    runCatching { tvInputList }.getOrDefault(emptyList()).map { info ->
        PhilipsTa1Profile.InputDescriptor(
            id = info.id,
            packageName = info.serviceInfo.packageName,
            isHdmi = info.type == TvInputInfo.TYPE_HDMI,
        )
    }
