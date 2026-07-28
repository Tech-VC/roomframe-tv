package org.roomframe.tv

import android.app.Activity
import android.content.Intent
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
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Toast
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.roomframe.tv.adapters.DeviceAdapters
import org.roomframe.tv.cache.FileExperienceStore
import org.roomframe.tv.experience.ExperienceRepository
import org.roomframe.tv.experience.ExperienceSnapshot
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.CredentialRotationResult
import org.roomframe.tv.sync.HttpExperienceSyncClient
import org.roomframe.tv.sync.HttpTvMetricsClient
import org.roomframe.tv.sync.SyncResult
import org.roomframe.tv.sync.TvCredentialRotationClient
import org.roomframe.tv.sync.TvMetricSnapshot
import org.roomframe.tv.ui.NativeSceneRenderer
import org.roomframe.tv.update.HttpAppUpdateCoordinator

/**
 * Launcher local-first :
 * 1. vérifie et affiche la dernière révision locale complète ;
 * 2. utilise le bundle embarqué si le cache est absent ou corrompu ;
 * 3. synchronise en arrière-plan sans bloquer le premier rendu ;
 * 4. ne bascule qu'après téléchargement et validation atomiques.
 */
class MainActivity : Activity() {
    private val processStartedAt = SystemClock.elapsedRealtime()
    private var okDownAt: Long? = null
    private val adapters by lazy { DeviceAdapters.forAndroid(this) }
    private val syncExecutor = Executors.newSingleThreadExecutor()
    private val syncRunning = AtomicBoolean(false)
    private val scheduler = Handler(Looper.getMainLooper())
    private val periodicSync = object : Runnable {
        override fun run() {
            synchronizeInBackground()
            scheduler.postDelayed(this, SYNC_INTERVAL_MILLIS)
        }
    }
    private lateinit var store: FileExperienceStore
    private lateinit var repository: ExperienceRepository
    private lateinit var credentialStore: DeviceCredentialStore
    private var currentSnapshot: ExperienceSnapshot? = null
    @Volatile private var startupDurationMs: Long? = null
    @Volatile private var resumeDurationMs: Long? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        store = FileExperienceStore(File(filesDir, "experience"))
        repository = ExperienceRepository(this, store)
        credentialStore = DeviceCredentialStore(this)
        render(repository.load())
        startupDurationMs = SystemClock.elapsedRealtime() - processStartedAt
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
        super.onPause()
    }

    override fun onDestroy() {
        scheduler.removeCallbacks(periodicSync)
        syncExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun render(snapshot: ExperienceSnapshot) {
        currentSnapshot = snapshot
        val renderer = NativeSceneRenderer(
            activity = this,
            adapters = adapters,
            debugBackground = localDebugBrandingDrawable("background"),
            debugLogo = localDebugBrandingDrawable("logo"),
        )
        setContentView(renderer.render(snapshot))
        window.decorView.post { enterImmersiveMode() }
    }

    private fun synchronizeInBackground() {
        val credentials = credentialStore.load() ?: return
        if (!syncRunning.compareAndSet(false, true)) return
        val activeRevisionId = currentSnapshot?.revisionId
        syncExecutor.execute {
            val syncStartedAt = SystemClock.elapsedRealtime()
            var reportedRevision = revisionNumber(activeRevisionId)
            var syncErrorCode: String? = null
            try {
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
                val updateResult = synchronizeAppUpdate(credentials)
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
    ): String {
        val state = runCatching {
            HttpAppUpdateCoordinator(
                context = applicationContext,
                credentials = credentials,
                updateRoot = File(filesDir, "updates"),
                adapter = adapters.appUpdate,
            ).checkAndApply()
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

    private companion object {
        const val ADMIN_HOLD_MILLIS = 8_000L
        const val SYNC_INTERVAL_MILLIS = 5L * 60L * 1_000L
        const val MAX_LOCAL_BRANDING_BYTES = 25L * 1024 * 1024
        const val MAX_LOCAL_BRANDING_DIMENSION = 4096
        const val MAX_LOCAL_BRANDING_PIXELS = 3840L * 2160L
    }
}
