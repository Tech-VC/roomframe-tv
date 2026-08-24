package org.roomframe.tv

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.Toast
import android.widget.VideoView
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.roomframe.tv.adapters.DeviceAdapters
import org.roomframe.tv.adapters.CapabilityState
import org.roomframe.tv.cache.FileExperienceStore
import org.roomframe.tv.experience.ExperienceDocumentParser
import org.roomframe.tv.experience.ExperienceRepository
import org.roomframe.tv.experience.ExperienceSnapshot
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.CredentialRotationResult
import org.roomframe.tv.sync.HttpExperienceSyncClient
import org.roomframe.tv.sync.HttpTvMetricsClient
import org.roomframe.tv.sync.SyncResult
import org.roomframe.tv.sync.TvCredentialRotationClient
import org.roomframe.tv.sync.TvCertificateProvisioningClient
import org.roomframe.tv.sync.TvCertificateProvisioningResult
import org.roomframe.tv.sync.TvMetricSnapshot
import org.roomframe.tv.sync.RoomFramePresenceService
import org.roomframe.tv.sync.TvSyncSchedule
import org.roomframe.tv.ui.CastWaitingOverlayController
import org.roomframe.tv.ui.NativeSceneRenderer
import org.roomframe.tv.ui.PrivateSpaceOverlayController
import org.roomframe.tv.ui.shouldLockPrivateSessionFromNavigation
import org.roomframe.tv.ui.SourceMenuOverlayController
import org.roomframe.tv.deviceadmin.AndroidPrivateApplicationAccessController
import org.roomframe.tv.update.HttpAppUpdateCoordinator
import org.roomframe.tv.update.SafeUpdateInstallPolicy
import org.roomframe.tv.update.UpdateInstallMoment

internal const val EXTRA_LOCK_PRIVATE_SESSION =
    "org.roomframe.tv.extra.LOCK_PRIVATE_SESSION"

/**
 * Launcher local-first :
 * 1. vérifie et affiche la dernière révision locale complète ;
 * 2. utilise le bundle embarqué si le cache est absent ou corrompu ;
 * 3. synchronise en arrière-plan sans bloquer le premier rendu ;
 * 4. ne bascule qu'après téléchargement et validation atomiques.
 */
class MainActivity : Activity() {
    private val processStartedAt = SystemClock.elapsedRealtime()
    @Volatile private var lastUserInteractionAt = processStartedAt
    @Volatile private var userInteractedSinceStartup = false
    private var okDownAt: Long? = null
    private val adapters by lazy { DeviceAdapters.forAndroid(this) }
    private val syncExecutor = Executors.newSingleThreadExecutor()
    private val syncRunning = AtomicBoolean(false)
    private val startupUpdatePending = AtomicBoolean(true)
    private val scheduler = Handler(Looper.getMainLooper())
    private val periodicSync = object : Runnable {
        override fun run() {
            synchronizeInBackground()
            scheduler.postDelayed(this, TvSyncSchedule.PERIODIC_INTERVAL_MILLIS)
        }
    }
    private lateinit var store: FileExperienceStore
    private lateinit var repository: ExperienceRepository
    private lateinit var credentialStore: DeviceCredentialStore
    private lateinit var rootHost: FrameLayout
    private lateinit var sceneHost: FrameLayout
    private lateinit var overlayHost: FrameLayout
    private lateinit var castWaitingOverlay: CastWaitingOverlayController
    private lateinit var sourceMenuOverlay: SourceMenuOverlayController
    private lateinit var privateSpaceOverlay: PrivateSpaceOverlayController
    private var screenOffReceiverRegistered = false
    private val screenOffReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (
                intent?.action == Intent.ACTION_SCREEN_OFF &&
                ::privateSpaceOverlay.isInitialized
            ) {
                privateSpaceOverlay.lockForScreenOff()
            }
        }
    }
    private var renderedSceneView: View? = null
    @Volatile private var currentSnapshot: ExperienceSnapshot? = null
    @Volatile private var startupDurationMs: Long? = null
    @Volatile private var resumeDurationMs: Long? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        credentialStore = DeviceCredentialStore(this)
        if (credentialStore.load() == null) {
            startActivity(Intent(this, EnrollmentActivity::class.java))
            finish()
            return
        }
        store = FileExperienceStore(File(filesDir, "experience"))
        repository = ExperienceRepository(this, store)
        rootHost = FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            clipChildren = false
            clipToPadding = false
        }
        sceneHost = FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            clipChildren = false
            clipToPadding = false
        }
        overlayHost = FrameLayout(this).apply {
            visibility = View.GONE
            clipChildren = false
            clipToPadding = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        rootHost.addView(
            sceneHost,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        rootHost.addView(
            overlayHost,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        castWaitingOverlay = CastWaitingOverlayController(this, sceneHost, overlayHost)
        privateSpaceOverlay = PrivateSpaceOverlayController(
            activity = this,
            sceneHost = sceneHost,
            overlayHost = overlayHost,
            applicationAccess = AndroidPrivateApplicationAccessController(applicationContext),
            credentials = credentialStore::load,
            onExitRequested = ::completePrivateExit,
            onRefreshRequested = ::synchronizeInBackground,
        )
        sourceMenuOverlay = SourceMenuOverlayController(
            activity = this,
            adapters = adapters,
            sceneHost = sceneHost,
            overlayHost = overlayHost,
            onHomeRequested = ::returnToRoomFrameHome,
            onPrivateRequested = ::showPrivateSpace,
            onCastWaitingRequested = ::showCastWaiting,
        )
        setContentView(rootHost)
        registerScreenOffReceiver()
        RoomFramePresenceService.start(applicationContext)
        render(repository.loadPreviouslyVerified() ?: repository.loadBundled())
        consumeHomeRedirect(intent)
        startupDurationMs = SystemClock.elapsedRealtime() - processStartedAt
        verifyLocalRevisionInBackground()
    }

    override fun onResume() {
        val resumedAt = SystemClock.elapsedRealtime()
        super.onResume()
        scheduler.removeCallbacks(periodicSync)
        periodicSync.run()
        window.decorView.post {
            enterImmersiveMode()
            resumeDurationMs = SystemClock.elapsedRealtime() - resumedAt
        }
    }

    override fun onPause() {
        scheduler.removeCallbacks(periodicSync)
        if (::castWaitingOverlay.isInitialized) {
            castWaitingOverlay.dismiss(restoreFocus = false)
        }
        super.onPause()
    }

    override fun onDestroy() {
        scheduler.removeCallbacks(periodicSync)
        if (::castWaitingOverlay.isInitialized) castWaitingOverlay.release()
        if (::sourceMenuOverlay.isInitialized) sourceMenuOverlay.release()
        if (::privateSpaceOverlay.isInitialized) privateSpaceOverlay.release()
        if (screenOffReceiverRegistered) {
            unregisterReceiver(screenOffReceiver)
            screenOffReceiverRegistered = false
        }
        syncExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent != null) {
            setIntent(intent)
            consumeHomeRedirect(intent)
        }
    }

    private fun render(snapshot: ExperienceSnapshot) {
        currentSnapshot = snapshot
        val renderedSnapshot = localDebugBranding(snapshot)
        sourceMenuOverlay.update(renderedSnapshot)
        privateSpaceOverlay.update(renderedSnapshot)
        val previous = renderedSceneView
        val preferredFocusNodeId = previous?.findFocus()?.tag as? String
        val renderer = NativeSceneRenderer(
            activity = this,
            adapters = adapters,
            debugBackground = localDebugBrandingDrawable("background"),
            debugLogo = localDebugBrandingDrawable("logo"),
            onCastWaitingRequested = { sourceView ->
                showCastWaiting(sourceView)
            },
            onSourceMenuRequested = ::showSourceMenu,
            onPrivateSpaceRequested = ::showPrivateSpace,
        )
        val next = renderer.render(renderedSnapshot, preferredFocusNodeId)
        renderedSceneView = next
        sceneHost.addView(
            next,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        if (previous != null) {
            next.alpha = 0f
            next.animate()
                .alpha(1f)
                .setDuration(SCENE_TRANSITION_DURATION_MILLIS)
                .withEndAction {
                    releaseScene(previous)
                    sceneHost.removeView(previous)
                }
                .start()
        }
        window.decorView.post { enterImmersiveMode() }
    }

    private fun verifyLocalRevisionInBackground() {
        syncExecutor.execute {
            val verified = repository.load()
            val displayedRevisionId = currentSnapshot?.revisionId
            if (verified.revisionId == displayedRevisionId) return@execute
            runOnUiThread {
                if (!isFinishing && !isDestroyed) render(verified)
            }
        }
    }

    private fun releaseScene(view: View) {
        if (view is VideoView) view.stopPlayback()
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) releaseScene(view.getChildAt(index))
        }
    }

    private fun synchronizeInBackground() {
        val credentials = credentialStore.load() ?: return
        if (!syncRunning.compareAndSet(false, true)) return
        val updateInstallMoment = if (startupUpdatePending.compareAndSet(true, false)) {
            UpdateInstallMoment.STARTUP
        } else {
            UpdateInstallMoment.PERIODIC
        }
        val activeRevisionId = currentSnapshot?.revisionId
        syncExecutor.execute {
            val syncStartedAt = SystemClock.elapsedRealtime()
            var reportedRevision = revisionNumber(activeRevisionId)
            var syncErrorCode: String? = null
            try {
                recordCertificateState(
                    when (
                        val certificate = TvCertificateProvisioningClient()
                            .synchronize(credentials)
                    ) {
                        TvCertificateProvisioningResult.NotRequested -> "legacy"
                        is TvCertificateProvisioningResult.Pending ->
                            "pending:${certificate.status}"
                        is TvCertificateProvisioningResult.Active ->
                            "active:${certificate.fingerprintSha256.take(12)}"
                        is TvCertificateProvisioningResult.Failed ->
                            "failed:${certificate.reason}"
                    },
                )
                when (
                    val result = HttpExperienceSyncClient(
                        credentials = credentials,
                        downloadRoot = File(cacheDir, "sync-downloads"),
                    ).fetchAfter(activeRevisionId)
                ) {
                    SyncResult.UpToDate -> recordSyncState("up-to-date")
                    is SyncResult.RevisionAvailable -> {
                        store.stageAndActivate(result.revision)
                        reportedRevision = revisionNumber(result.revision.revisionId)
                        val updated = repository.load()
                        recordSyncState("active:${updated.revisionId}")
                        runOnUiThread {
                            if (!isFinishing && !isDestroyed) render(updated)
                        }
                    }
                    is SyncResult.Failed -> {
                        syncErrorCode = "sync-failed"
                        recordSyncState("failed:${result.reason}")
                    }
                }
            } catch (error: Exception) {
                syncErrorCode = "sync-failed"
                recordSyncState("failed:${error.message?.take(140) ?: "internal"}")
            } finally {
                val updateResult = synchronizeAppUpdate(credentials, updateInstallMoment)
                val updateState = metricUpdateState(updateResult)
                if (syncErrorCode == null && updateState == "failed") {
                    syncErrorCode = "update-failed"
                }
                val runtime = Runtime.getRuntime()
                val metric = TvMetricSnapshot(
                    startupMs = startupDurationMs,
                    resumeMs = resumeDurationMs,
                    memoryBytes = runtime.totalMemory() - runtime.freeMemory(),
                    storageFreeBytes = filesDir.usableSpace.coerceAtLeast(0),
                    networkState = currentNetworkState(),
                    syncRevision = reportedRevision,
                    syncDurationMs = SystemClock.elapsedRealtime() - syncStartedAt,
                    updateState = updateState,
                    silentUpdateCapable = adapters.appUpdate
                        .probeCapabilities()
                        .silentInstall == CapabilityState.SUPPORTED,
                    errorCode = syncErrorCode,
                )
                runCatching { HttpTvMetricsClient(credentials).send(metric) }
                    .onFailure { recordMetricState("failed") }
                    .onSuccess { recordMetricState("accepted") }
                recordCredentialRotationState(synchronizeCredentialRotation())
                syncRunning.set(false)
            }
        }
    }

    private fun synchronizeAppUpdate(
        credentials: org.roomframe.tv.sync.DeviceCredentials,
        installMoment: UpdateInstallMoment,
    ): String {
        val state = runCatching {
            HttpAppUpdateCoordinator(
                context = applicationContext,
                credentials = credentials,
                updateRoot = File(filesDir, "updates"),
                adapter = adapters.appUpdate,
            ).checkAndApply {
                SafeUpdateInstallPolicy.decide(
                    moment = installMoment,
                    nowElapsedRealtime = SystemClock.elapsedRealtime(),
                    lastUserInteractionElapsedRealtime = lastUserInteractionAt,
                    userInteractedSinceStartup = userInteractedSinceStartup,
                )
            }
        }.getOrElse { error ->
            "failed:${error.message?.take(140) ?: "internal"}"
        }
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_update_check", state.take(180))
            .apply()
        return state
    }

    private fun recordSyncState(value: String) {
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_sync_state", value.take(180))
            .apply()
    }

    private fun recordMetricState(value: String) {
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_metric_delivery", value)
            .apply()
    }

    private fun synchronizeCredentialRotation(): String = runCatching {
        when (val result = TvCredentialRotationClient(credentialStore).rotateIfDue()) {
            CredentialRotationResult.NotEnrolled -> "not-enrolled"
            CredentialRotationResult.NotDue -> "current"
            is CredentialRotationResult.Rotated -> "rotated:g${result.generation}"
            is CredentialRotationResult.Pending -> "pending:${result.reason}"
        }
    }.getOrElse { error ->
        "failed:${error.message?.take(120) ?: "internal"}"
    }

    private fun recordCredentialRotationState(value: String) {
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_credential_rotation", value.take(180))
            .apply()
    }

    private fun recordCertificateState(value: String) {
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_certificate_state", value.take(180))
            .apply()
    }

    private fun currentNetworkState(): String {
        val manager = getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork ?: return "offline"
        val capabilities = manager.getNetworkCapabilities(network) ?: return "unknown"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) -> "unknown"
            else -> "degraded"
        }
    }

    private fun metricUpdateState(value: String): String = when {
        value.startsWith("failed:") -> "failed"
        value.startsWith("installing:") -> "installing"
        value.startsWith("downloaded:") -> "staged"
        value.startsWith("installed:") -> "ready"
        else -> "idle"
    }

    private fun revisionNumber(value: String?): Long? = value
        ?.removePrefix("sync-")
        ?.toLongOrNull()
        ?.takeIf { it >= 0 }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) window.decorView.post { enterImmersiveMode() }
    }

    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        // Sur le firmware Philips TPM231WW, le contrôleur ne doit être demandé
        // qu'après attachement du décor, sinon le constructeur déclenche une NPE.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.decorView.windowInsetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                )
        }
    }

    /**
     * Surcharge locale réservée aux APK debuggables. Une révision serveur
     * validée reste prioritaire sur ces fichiers de laboratoire.
     */
    private fun localDebugBranding(snapshot: ExperienceSnapshot): ExperienceSnapshot {
        if (
            applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0 ||
            !snapshot.bundled
        ) {
            return snapshot
        }
        val candidate = File(filesDir, "branding/branding.json")
        if (!candidate.isFile || candidate.length() !in 1..MAX_LOCAL_BRANDING_DOCUMENT_BYTES) {
            return snapshot
        }
        val branding = runCatching {
            ExperienceDocumentParser.parseBranding(candidate.readBytes())
        }.getOrNull() ?: return snapshot
        return snapshot.copy(branding = branding)
    }

    private fun localDebugBrandingDrawable(name: String): Drawable? {
        if (
            applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0 ||
            currentSnapshot?.bundled == false
        ) {
            return null
        }
        val brandingDirectory = File(filesDir, "branding")
        val candidate = listOf("webp", "png", "jpg", "jpeg")
            .asSequence()
            .map { extension -> File(brandingDirectory, "$name.$extension") }
            .firstOrNull { file -> file.isFile && file.length() in 1..MAX_LOCAL_BRANDING_BYTES }
            ?: return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(candidate.absolutePath, bounds)
        val pixelCount = bounds.outWidth.toLong() * bounds.outHeight.toLong()
        if (
            bounds.outWidth <= 0 ||
            bounds.outHeight <= 0 ||
            bounds.outWidth > MAX_LOCAL_BRANDING_DIMENSION ||
            bounds.outHeight > MAX_LOCAL_BRANDING_DIMENSION ||
            pixelCount > MAX_LOCAL_BRANDING_PIXELS
        ) {
            return null
        }
        val bitmap = BitmapFactory.decodeFile(candidate.absolutePath) ?: return null
        return BitmapDrawable(resources, bitmap)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            lastUserInteractionAt = SystemClock.elapsedRealtime()
            userInteractedSinceStartup = true
        }
        if (
            ::privateSpaceOverlay.isInitialized &&
            privateSpaceOverlay.handleKeyEvent(event)
        ) {
            return true
        }
        if (
            ::sourceMenuOverlay.isInitialized &&
            sourceMenuOverlay.isVisible &&
            event.keyCode == KeyEvent.KEYCODE_BACK
        ) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                sourceMenuOverlay.dismiss()
            }
            return true
        }
        if (
            ::castWaitingOverlay.isInitialized &&
            castWaitingOverlay.isVisible &&
            event.keyCode == KeyEvent.KEYCODE_BACK
        ) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                castWaitingOverlay.dismiss()
            }
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                okDownAt = System.currentTimeMillis()
            }
            if (event.action == KeyEvent.ACTION_UP) {
                val held = System.currentTimeMillis() - (okDownAt ?: System.currentTimeMillis())
                okDownAt = null
                if (held >= ADMIN_HOLD_MILLIS) {
                    if (credentialStore.load() == null) {
                        startActivity(Intent(this, EnrollmentActivity::class.java))
                    } else {
                        Toast.makeText(
                            this,
                            getString(R.string.enrollment_already_done),
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun showSourceMenu(sourceView: View) {
        castWaitingOverlay.dismiss(restoreFocus = false)
        privateSpaceOverlay.lockForHome()
        sourceMenuOverlay.show(sourceView)
    }

    private fun showPrivateSpace(sourceView: View) {
        castWaitingOverlay.dismiss(restoreFocus = false)
        sourceMenuOverlay.dismiss(restoreFocus = false)
        privateSpaceOverlay.show(sourceView)
    }

    private fun showCastWaiting(sourceView: View) {
        sourceMenuOverlay.dismiss(restoreFocus = false)
        privateSpaceOverlay.lockForHome()
        val displayed = currentSnapshot?.let(::localDebugBranding) ?: return
        castWaitingOverlay.show(
            sourceView = sourceView,
            branding = displayed.branding,
            tvDisplayName = displayed.deviceIdentity?.displayName
                ?: displayed.branding.displayName,
        )
    }

    private fun returnToRoomFrameHome() {
        castWaitingOverlay.dismiss(restoreFocus = false)
        sourceMenuOverlay.dismiss(restoreFocus = false)
        privateSpaceOverlay.lockForHome()
        renderedSceneView?.post {
            renderedSceneView?.findFocus()?.clearFocus()
            renderedSceneView?.let(::firstFocusableDescendant)?.requestFocus()
        }
    }

    private fun firstFocusableDescendant(view: View): View? {
        if (view.visibility == View.VISIBLE && view.isFocusable) return view
        if (view !is ViewGroup) return null
        for (index in 0 until view.childCount) {
            firstFocusableDescendant(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun completePrivateExit() {
        castWaitingOverlay.dismiss(restoreFocus = false)
        sourceMenuOverlay.dismiss(restoreFocus = false)
    }

    private fun consumeHomeRedirect(intent: Intent) {
        val explicitRedirect = intent.getBooleanExtra(EXTRA_LOCK_PRIVATE_SESSION, false)
        if (
            !shouldLockPrivateSessionFromNavigation(
                action = intent.action,
                hasHomeCategory = intent.hasCategory(Intent.CATEGORY_HOME),
                explicitHomeRedirect = explicitRedirect,
            )
        ) return
        intent.removeExtra(EXTRA_LOCK_PRIVATE_SESSION)
        if (::privateSpaceOverlay.isInitialized) returnToRoomFrameHome()
    }

    private fun registerScreenOffReceiver() {
        if (screenOffReceiverRegistered) return
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenOffReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(screenOffReceiver, filter)
        }
        screenOffReceiverRegistered = true
    }

    private companion object {
        const val ADMIN_HOLD_MILLIS = 8_000L
        const val SCENE_TRANSITION_DURATION_MILLIS = 140L
        const val MAX_LOCAL_BRANDING_DOCUMENT_BYTES = 64L * 1024
        const val MAX_LOCAL_BRANDING_BYTES = 25L * 1024 * 1024
        const val MAX_LOCAL_BRANDING_DIMENSION = 4096
        const val MAX_LOCAL_BRANDING_PIXELS = 3840L * 2160L
    }
}
