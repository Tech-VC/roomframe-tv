package org.roomframe.tv.ui

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors
import kotlin.math.min
import kotlin.math.roundToInt
import org.roomframe.tv.deviceadmin.PrivateApplicationAccessController
import org.roomframe.tv.deviceadmin.PrivateApplicationRuntimeState
import org.roomframe.tv.deviceadmin.PrivateApplicationSessionState
import org.roomframe.tv.experience.BrandingDocument
import org.roomframe.tv.experience.ExperienceSnapshot
import org.roomframe.tv.sync.DeviceCredentials
import org.roomframe.tv.sync.HttpPrivateAccessClient
import org.roomframe.tv.sync.HttpPrivateApplicationStatusClient
import org.roomframe.tv.sync.PrivateUnlockResult

/**
 * Espace privé éphémère. Le code n'est jamais persisté ni journalisé et seule
 * sa validation explicite déclenche un accès réseau. La session survit au
 * lancement d'une application afin que Back retrouve ce mini-accueil.
 */
internal class PrivateSpaceOverlayController(
    private val activity: Activity,
    private val sceneHost: FrameLayout,
    private val overlayHost: FrameLayout,
    private val applicationAccess: PrivateApplicationAccessController,
    private val credentials: () -> DeviceCredentials?,
    private val onExitRequested: () -> Unit,
    private val onRefreshRequested: () -> Unit,
) {
    private val worker = Executors.newSingleThreadExecutor()
    private val reporter = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val applicationLauncher = AndroidApplicationLauncher(activity)
    private val enteredDigits = StringBuilder(PIN_LENGTH)
    private val attemptLimiter = PrivateAccessAttemptLimiter(5, 60)
    private var snapshot: ExperienceSnapshot? = null
    private var privateConfigurationKey: String? = null
    private var applicationIds: List<String> = emptyList()
    @Volatile private var unlockConfiguration = PrivateUnlockConfiguration.locked()
    private var lastRuntimeStates: List<PrivateApplicationRuntimeState> = emptyList()
    private var lockedCanvas: View? = null
    private var hubCanvas: View? = null
    private var codeText: TextView? = null
    private var statusText: TextView? = null
    private var returnFocusView: View? = null
    private var returnFocusTag: Any? = null
    private var previousSceneAccessibility: Int? = null
    private var visible = false
    private var sessionUnlocked = false
    private var validating = false
    @Volatile private var released = false

    val isVisible: Boolean
        get() = visible

    fun update(value: ExperienceSnapshot) {
        snapshot = value
        val privateSetting = value.sources.settingFor("private-app")
        val configured = if (privateSetting?.enabled == true) {
            privateSetting.applicationIds
                .distinct()
                .take(MAX_APPLICATIONS)
        } else {
            emptyList()
        }
        val nextKey = listOf(
            value.privateAccess.enabled.toString(),
            value.privateAccess.pinConfigured.toString(),
            value.privateAccess.generation.toString(),
            value.privateAccess.maxAttempts.toString(),
            value.privateAccess.lockoutSeconds.toString(),
            configured.joinToString(","),
        ).joinToString("|")
        val changed = nextKey != privateConfigurationKey
        privateConfigurationKey = nextKey
        applicationIds = configured
        unlockConfiguration = PrivateUnlockConfiguration(
            epoch = if (changed) {
                nextPrivateUnlockEpoch(unlockConfiguration.epoch)
            } else {
                unlockConfiguration.epoch
            },
            enabled = value.privateAccess.enabled,
            pinConfigured = value.privateAccess.pinConfigured,
            sourceEnabled = privateSetting?.enabled == true,
            generation = value.privateAccess.generation,
            applicationIds = configured.toList(),
        )
        if (changed) {
            PrivateApplicationSessionState.lock()
            lockedCanvas = null
            hubCanvas = null
            codeText = null
            statusText = null
            attemptLimiter.configure(
                value.privateAccess.maxAttempts,
                value.privateAccess.lockoutSeconds,
            )
            sessionUnlocked = false
            validating = false
            clearDigits()
            applyLockedPolicy(showLockedIfVisible = visible, reportStatus = true)
        } else if (visible) {
            showCurrentState()
        }
    }

    fun show(sourceView: View) {
        val current = snapshot ?: return
        if (
            !current.privateAccess.enabled ||
            !current.privateAccess.pinConfigured ||
            applicationIds.isEmpty()
        ) {
            toast("L'espace privé n'est pas encore configuré dans la régie")
            return
        }
        returnFocusView = sourceView
        returnFocusTag = sourceView.tag
        visible = true
        showCurrentState()
    }

    fun lockForHome() {
        lockSession(showLockedIfVisible = false)
        dismiss(restoreFocus = false)
    }

    fun lockForScreenOff() {
        lockSession(showLockedIfVisible = visible)
    }

    fun handleKeyEvent(event: KeyEvent): Boolean {
        if (!visible) return false
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) exit()
            return true
        }
        if (sessionUnlocked) return false
        val digit = keyDigit(event.keyCode)
        val handled = digit != null || event.keyCode in setOf(
            KeyEvent.KEYCODE_DEL,
            KeyEvent.KEYCODE_FORWARD_DEL,
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_NUMPAD_ENTER,
        )
        if (!handled) return false
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return true
        when {
            digit != null -> appendDigit(digit)
            event.keyCode == KeyEvent.KEYCODE_DEL || event.keyCode == KeyEvent.KEYCODE_FORWARD_DEL ->
                removeDigit()
            else -> submit()
        }
        return true
    }

    fun dismiss(restoreFocus: Boolean = true): Boolean {
        if (!visible) return false
        visible = false
        handler.removeCallbacks(lockoutTick)
        overlayHost.animate().cancel()
        overlayHost.removeAllViews()
        overlayHost.visibility = View.GONE
        overlayHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        sceneHost.importantForAccessibility = previousSceneAccessibility
            ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        previousSceneAccessibility = null
        if (restoreFocus) {
            val target = returnFocusView?.takeIf(View::isAttachedToWindow)
                ?: returnFocusTag?.let { tag -> sceneHost.findViewWithTag<View>(tag) }
            target?.post { if (target.isAttachedToWindow) target.requestFocus() }
        }
        returnFocusView = null
        returnFocusTag = null
        return true
    }

    fun release() {
        if (released) return
        released = true
        PrivateApplicationSessionState.lock()
        invalidateUnlockRequests()
        sessionUnlocked = false
        validating = false
        clearDigits()
        runCatching {
            applicationAccess.setLocked(enforcementApplicationIds(), locked = true)
        }
        dismiss(restoreFocus = false)
        handler.removeCallbacksAndMessages(null)
        worker.shutdownNow()
        reporter.shutdownNow()
    }

    private fun lockSession(showLockedIfVisible: Boolean) {
        PrivateApplicationSessionState.lock()
        invalidateUnlockRequests()
        sessionUnlocked = false
        validating = false
        clearDigits()
        applyLockedPolicy(showLockedIfVisible)
    }

    private fun applyLockedPolicy(
        showLockedIfVisible: Boolean,
        reportStatus: Boolean = false,
    ) {
        val configured = enforcementApplicationIds()
        val reportConfiguration = unlockConfiguration
        if (showLockedIfVisible) showLocked()
        worker.execute {
            val states = applicationAccess.setLocked(configured, locked = true)
            lastRuntimeStates = states
            if (reportStatus && reportConfiguration == unlockConfiguration && !released) {
                reporter.execute {
                    if (reportConfiguration == unlockConfiguration && !released) {
                        reportStates(states)
                    }
                }
            }
        }
    }

    private fun showCurrentState() {
        if (sessionUnlocked) showHub(lastRuntimeStates) else showLocked()
    }

    private fun showLocked() {
        val current = snapshot ?: return
        val canvas = lockedCanvas ?: buildLockedCanvas(current).also { lockedCanvas = it }
        attach(canvas)
        refreshCode()
        refreshAttemptState()
        canvas.post {
            canvas.findViewWithTag<View>(FIRST_PIN_KEY_TAG)?.requestFocus()
        }
    }

    private fun showHub(states: List<PrivateApplicationRuntimeState>) {
        val current = snapshot ?: return
        hubCanvas = buildHubCanvas(current, states)
        attach(requireNotNull(hubCanvas))
        requireNotNull(hubCanvas).post {
            requireNotNull(hubCanvas).findViewWithTag<View>(FIRST_APP_TAG)?.requestFocus()
                ?: requireNotNull(hubCanvas).findViewWithTag<View>(EXIT_TAG)?.requestFocus()
        }
    }

    private fun attach(canvas: View) {
        if (!visible) return
        (canvas.parent as? ViewGroup)?.removeView(canvas)
        overlayHost.animate().cancel()
        overlayHost.removeAllViews()
        overlayHost.setBackgroundColor(BACKGROUND)
        overlayHost.visibility = View.VISIBLE
        overlayHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        if (previousSceneAccessibility == null) {
            previousSceneAccessibility = sceneHost.importantForAccessibility
        }
        sceneHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        val metrics = activity.resources.displayMetrics
        val scale = min(
            metrics.widthPixels.toFloat() / CANVAS_WIDTH,
            metrics.heightPixels.toFloat() / CANVAS_HEIGHT,
        )
        overlayHost.addView(
            canvas,
            FrameLayout.LayoutParams(
                (CANVAS_WIDTH * scale).roundToInt(),
                (CANVAS_HEIGHT * scale).roundToInt(),
                Gravity.CENTER,
            ),
        )
        canvas.alpha = 0f
        canvas.animate().alpha(1f).setDuration(120L).start()
    }

    private fun buildLockedCanvas(value: ExperienceSnapshot): View {
        val style = OverlayStyle(activity, value.branding)
        return FrameLayout(activity).apply canvas@{
            setBackgroundColor(BACKGROUND)
            isClickable = true
            contentDescription = "Saisie du code de l'espace privé"

            addView(
                style.text("ESPACE PRIVÉ", 22f, Color.argb(185, 255, 255, 255)),
                style.place(760f, 40f, 100f, 88f),
            )
            addView(
                style.text("Entrez le code", 58f),
                style.place(820f, 170f, 100f, 160f),
            )
            addView(
                style.text(
                    "6 chiffres · défini dans la régie",
                    25f,
                    Color.argb(205, 255, 255, 255),
                ),
                style.place(760f, 48f, 100f, 350f),
            )

            codeText = style.text(emptyCodeDisplay(), 48f).apply {
                gravity = Gravity.CENTER
                letterSpacing = 0.08f
                background = style.panelBackground()
                contentDescription = "Code privé, aucun chiffre saisi"
            }
            addView(requireNotNull(codeText), style.place(720f, 112f, 100f, 545f))
            statusText = style.text("", 22f, Color.argb(215, 255, 255, 255)).apply {
                gravity = Gravity.CENTER_VERTICAL
                maxLines = 2
            }
            addView(requireNotNull(statusText), style.place(720f, 88f, 100f, 680f))

            val keypad = GridLayout(activity).apply {
                columnCount = 3
                rowCount = 4
            }
            val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "Effacer", "0", "Valider")
            keys.forEachIndexed { index, label ->
                val key = style.actionButton(label, if (label == "Valider") style.accent else style.primary).apply {
                    if (index == 0) tag = FIRST_PIN_KEY_TAG
                    setOnClickListener {
                        when (label) {
                            "Effacer" -> removeDigit()
                            "Valider" -> submit()
                            else -> appendDigit(label.single())
                        }
                    }
                }
                keypad.addView(
                    key,
                    GridLayout.LayoutParams(
                        GridLayout.spec(index / 3, 1f),
                        GridLayout.spec(index % 3, 1f),
                    ).apply {
                        width = style.px(248f)
                        height = style.px(152f)
                        setMargins(style.px(8f), style.px(8f), style.px(8f), style.px(8f))
                    },
                )
            }
            addView(keypad, style.place(810f, 690f, 990f, 190f))
            addView(
                style.text("Retour ferme l'espace privé", 18f, Color.argb(160, 255, 255, 255)),
                style.place(720f, 32f, 100f, 960f),
            )
        }
    }

    private fun buildHubCanvas(
        value: ExperienceSnapshot,
        states: List<PrivateApplicationRuntimeState>,
    ): View {
        val style = OverlayStyle(activity, value.branding)
        val statesById = states.associateBy(PrivateApplicationRuntimeState::applicationId)
        return FrameLayout(activity).apply canvas@{
            setBackgroundColor(BACKGROUND)
            isClickable = true
            contentDescription = "Applications de l'espace privé"
            addView(
                style.text("ESPACE PRIVÉ", 22f, Color.argb(185, 255, 255, 255)),
                style.place(700f, 40f, 100f, 82f),
            )
            addView(
                style.text("Applications autorisées", 58f),
                style.place(1_100f, 120f, 100f, 145f),
            )
            val limitedProtection = states.any { it.installed && !it.accessEnforced }
            val subtitle = if (limitedProtection) {
                "Protection système limitée sur cette TV."
            } else {
                "Home referme cet espace."
            }
            addView(
                style.text(
                    subtitle,
                    23f,
                    if (limitedProtection) Color.rgb(255, 205, 120) else Color.argb(200, 255, 255, 255),
                ).apply { maxLines = 2 },
                style.place(1_150f, 86f, 100f, 270f),
            )

            val grid = GridLayout(activity).apply {
                columnCount = PRIVATE_GRID_COLUMNS
                rowCount = privateApplicationGridRows(applicationIds.size).coerceAtLeast(1)
            }
            applicationIds.forEachIndexed { index, applicationId ->
                val runtime = statesById[applicationId]
                val installed = runtime?.installed == true
                val label = privateApplicationLabel(applicationId)
                val tile = style.actionButton(
                    if (installed) label else "$label\nInstaller",
                    style.primary,
                ).apply {
                    if (index == 0) tag = FIRST_APP_TAG
                    maxLines = 2
                    compoundDrawablePadding = style.px(18f)
                    applicationIcon(applicationId, installed)?.let { icon ->
                        val size = style.px(72f)
                        icon.setBounds(0, 0, size, size)
                        setCompoundDrawablesRelative(null, icon, null, null)
                    }
                    setOnClickListener { activateApplication(applicationId) }
                }
                grid.addView(
                    tile,
                    GridLayout.LayoutParams(
                        GridLayout.spec(index / 3),
                        GridLayout.spec(index % 3),
                    ).apply {
                        width = style.px(500f)
                        height = style.px(240f)
                        setMargins(style.px(12f), style.px(12f), style.px(12f), style.px(12f))
                    },
                )
            }
            if (applicationIds.isEmpty()) {
                grid.addView(
                    style.text("Aucune application n'est encore autorisée dans la régie.", 28f),
                    GridLayout.LayoutParams(GridLayout.spec(0), GridLayout.spec(0, 3)).apply {
                        width = style.px(1_520f)
                        height = style.px(180f)
                    },
                )
            }
            val scrollingGrid = ScrollView(activity).apply {
                isFocusable = false
                isFillViewport = true
                clipToPadding = false
                addView(
                    grid,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
            }
            addView(scrollingGrid, style.place(1_580f, 560f, 88f, 385f))
            addView(
                style.actionButton("Retour à l'accueil", style.accent).apply {
                    tag = EXIT_TAG
                    setOnClickListener { exit() }
                },
                style.place(480f, 84f, 1_340f, 930f),
            )
        }
    }

    private fun appendDigit(digit: Char) {
        if (validating || attemptLimiter.state() is PrivateAttemptState.Locked) {
            refreshAttemptState()
            return
        }
        if (enteredDigits.length >= PIN_LENGTH) return
        enteredDigits.append(digit)
        refreshCode()
        if (enteredDigits.length == PIN_LENGTH) submit()
    }

    private fun removeDigit() {
        if (validating || enteredDigits.isEmpty()) return
        enteredDigits.deleteCharAt(enteredDigits.lastIndex)
        statusText?.text = ""
        refreshCode()
    }

    private fun submit() {
        val requestedConfiguration = unlockConfiguration
        if (!requestedConfiguration.ready) return
        when (val attemptState = attemptLimiter.state()) {
            is PrivateAttemptState.Locked -> {
                showLockout(attemptState.retryAfterSeconds)
                return
            }
            PrivateAttemptState.Ready -> Unit
        }
        if (validating || enteredDigits.length != PIN_LENGTH) {
            statusText?.text = "Saisissez les 6 chiffres du code."
            return
        }
        val currentCredentials = credentials()
        if (currentCredentials == null) {
            statusText?.text = "Cette TV n'est pas connectée au serveur."
            return
        }
        val pin = enteredDigits.toString()
        clearDigits()
        validating = true
        statusText?.text = "Vérification…"
        worker.execute {
            val result = HttpPrivateAccessClient(currentCredentials).unlock(
                pin = pin,
                generation = requestedConfiguration.generation,
            )
            activity.runOnUiThread {
                if (released) return@runOnUiThread
                validating = false
                if (
                    !privateUnlockResultCanBeApplied(
                        requestedConfiguration,
                        unlockConfiguration,
                    )
                ) {
                    sessionUnlocked = false
                    applyLockedPolicy(showLockedIfVisible = visible)
                    return@runOnUiThread
                }
                when (result) {
                    is PrivateUnlockResult.Granted ->
                        unlockConfiguredApplications(requestedConfiguration)
                    PrivateUnlockResult.Invalid -> {
                        statusText?.text = "Code incorrect."
                        when (val state = attemptLimiter.recordInvalid()) {
                            is PrivateAttemptState.Locked -> showLockout(state.retryAfterSeconds)
                            PrivateAttemptState.Ready -> Unit
                        }
                    }
                    is PrivateUnlockResult.Locked -> {
                        val state = attemptLimiter.applyServerLockout(result.retryAfterSeconds)
                        showLockout((state as PrivateAttemptState.Locked).retryAfterSeconds)
                    }
                    PrivateUnlockResult.StaleGeneration -> {
                        statusText?.text = "Le code a changé dans la régie. Actualisation en cours…"
                        onRefreshRequested()
                    }
                    PrivateUnlockResult.Unavailable -> {
                        statusText?.text = "Serveur indisponible. Réessayez dans un instant."
                    }
                }
            }
        }
    }

    private fun unlockConfiguredApplications(
        requestedConfiguration: PrivateUnlockConfiguration,
    ) {
        if (
            !privateUnlockResultCanBeApplied(
                requestedConfiguration,
                unlockConfiguration,
            )
        ) {
            applyLockedPolicy(showLockedIfVisible = visible)
            return
        }
        statusText?.text = "Ouverture…"
        worker.execute {
            if (
                !privateUnlockResultCanBeApplied(
                    requestedConfiguration,
                    unlockConfiguration,
                )
            ) {
                lockCurrentConfigurationOnWorker()
                return@execute
            }
            val states = applicationAccess.setLocked(
                requestedConfiguration.applicationIds,
                locked = false,
            )
            if (
                !privateUnlockResultCanBeApplied(
                    requestedConfiguration,
                    unlockConfiguration,
                )
            ) {
                lockCurrentConfigurationOnWorker()
                return@execute
            }
            lastRuntimeStates = states
            activity.runOnUiThread {
                if (released) return@runOnUiThread
                if (
                    !privateUnlockResultCanBeApplied(
                        requestedConfiguration,
                        unlockConfiguration,
                    )
                ) {
                    sessionUnlocked = false
                    applyLockedPolicy(showLockedIfVisible = visible)
                    return@runOnUiThread
                }
                sessionUnlocked = true
                attemptLimiter.reset()
                if (visible) showHub(states)
                reporter.execute {
                    if (
                        privateUnlockResultCanBeApplied(
                            requestedConfiguration,
                            unlockConfiguration,
                        )
                    ) reportStates(states)
                }
            }
        }
    }

    private fun enforcementApplicationIds(): List<String> {
        val privateAccess = snapshot?.privateAccess ?: return emptyList()
        return if (privateAccess.enabled && privateAccess.pinConfigured) {
            applicationIds.toList()
        } else {
            emptyList()
        }
    }

    private fun invalidateUnlockRequests() {
        unlockConfiguration = unlockConfiguration.copy(
            epoch = nextPrivateUnlockEpoch(unlockConfiguration.epoch),
        )
    }

    private fun lockCurrentConfigurationOnWorker() {
        val current = unlockConfiguration
        val configured = if (current.ready) current.applicationIds else emptyList()
        lastRuntimeStates = applicationAccess.setLocked(configured, locked = true)
    }

    private fun activateApplication(applicationId: String) {
        when (
            launchOrInstallApplication(
                applicationId,
                applicationLauncher::launchInstalled,
                applicationLauncher::openStore,
            )
        ) {
            ApplicationLaunchResult.LAUNCHED -> Unit
            ApplicationLaunchResult.STORE_OPENED -> toast("Application à installer depuis Google Play")
            ApplicationLaunchResult.INVALID_CONFIGURATION -> toast("Application non autorisée")
            ApplicationLaunchResult.UNAVAILABLE -> toast("Application et Google Play indisponibles")
        }
    }

    private fun exit() {
        lockSession(showLockedIfVisible = false)
        dismiss(restoreFocus = true)
        onExitRequested()
    }

    private fun reportStates(states: List<PrivateApplicationRuntimeState>) {
        val currentCredentials = credentials() ?: return
        runCatching { HttpPrivateApplicationStatusClient(currentCredentials).send(states) }
    }

    private fun refreshCode() {
        val filled = enteredDigits.length
        codeText?.text = (0 until PIN_LENGTH).joinToString(separator = " ") { index ->
            val symbol = if (index < filled) "●" else "○"
            if (index == 3) "  $symbol" else symbol
        }
        codeText?.contentDescription = "Code privé, $filled chiffre${if (filled > 1) "s" else ""} saisi${if (filled > 1) "s" else ""}"
    }

    private fun refreshAttemptState() {
        when (val state = attemptLimiter.state()) {
            PrivateAttemptState.Ready -> {
                handler.removeCallbacks(lockoutTick)
                if (!validating && statusText?.text?.startsWith("Trop de tentatives") == true) {
                    statusText?.text = ""
                }
            }
            is PrivateAttemptState.Locked -> showLockout(state.retryAfterSeconds)
        }
    }

    private fun showLockout(retryAfterSeconds: Int) {
        statusText?.text = "Trop de tentatives. Réessayez dans ${retryAfterSeconds}s."
        handler.removeCallbacks(lockoutTick)
        handler.postDelayed(lockoutTick, 1_000L)
    }

    private val lockoutTick = object : Runnable {
        override fun run() {
            if (!visible || sessionUnlocked) return
            when (val state = attemptLimiter.state()) {
                PrivateAttemptState.Ready -> statusText?.text = "Vous pouvez réessayer."
                is PrivateAttemptState.Locked -> {
                    statusText?.text = "Trop de tentatives. Réessayez dans ${state.retryAfterSeconds}s."
                    handler.postDelayed(this, 1_000L)
                }
            }
        }
    }

    private fun clearDigits() {
        enteredDigits.setLength(0)
        refreshCode()
    }

    private fun applicationIcon(applicationId: String, installed: Boolean): Drawable? {
        if (!installed) return null
        return runCatching { activity.packageManager.getApplicationIcon(applicationId) }.getOrNull()
    }

    private fun keyDigit(keyCode: Int): Char? = when (keyCode) {
        KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_NUMPAD_0 -> '0'
        KeyEvent.KEYCODE_1, KeyEvent.KEYCODE_NUMPAD_1 -> '1'
        KeyEvent.KEYCODE_2, KeyEvent.KEYCODE_NUMPAD_2 -> '2'
        KeyEvent.KEYCODE_3, KeyEvent.KEYCODE_NUMPAD_3 -> '3'
        KeyEvent.KEYCODE_4, KeyEvent.KEYCODE_NUMPAD_4 -> '4'
        KeyEvent.KEYCODE_5, KeyEvent.KEYCODE_NUMPAD_5 -> '5'
        KeyEvent.KEYCODE_6, KeyEvent.KEYCODE_NUMPAD_6 -> '6'
        KeyEvent.KEYCODE_7, KeyEvent.KEYCODE_NUMPAD_7 -> '7'
        KeyEvent.KEYCODE_8, KeyEvent.KEYCODE_NUMPAD_8 -> '8'
        KeyEvent.KEYCODE_9, KeyEvent.KEYCODE_NUMPAD_9 -> '9'
        else -> null
    }

    private fun emptyCodeDisplay(): String = "○ ○ ○   ○ ○ ○"

    private fun toast(message: String) {
        Toast.makeText(activity, message.take(160), Toast.LENGTH_SHORT).show()
    }

    private class OverlayStyle(
        private val activity: Activity,
        branding: BrandingDocument,
    ) {
        private val scale = min(
            activity.resources.displayMetrics.widthPixels.toFloat() / CANVAS_WIDTH,
            activity.resources.displayMetrics.heightPixels.toFloat() / CANVAS_HEIGHT,
        )
        val primary = parseColor(branding.primary, Color.rgb(21, 21, 17))
        val accent = parseColor(branding.accent, Color.rgb(255, 79, 31))
        private val typeface = when (branding.fontPreset) {
            "humanist" -> Typeface.create("sans-serif", Typeface.NORMAL)
            else -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
        }

        fun px(value: Float): Int = (value * scale).roundToInt()

        fun place(width: Float, height: Float, left: Float, top: Float): FrameLayout.LayoutParams =
            FrameLayout.LayoutParams(px(width), px(height)).apply {
                leftMargin = px(left)
                topMargin = px(top)
            }

        fun text(
            value: String,
            size: Float,
            color: Int = Color.WHITE,
        ): TextView = TextView(activity).apply {
            text = value
            setTextColor(color)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, px(size).toFloat())
            typeface = this@OverlayStyle.typeface
            includeFontPadding = false
        }

        fun actionButton(label: String, color: Int): TextView = text(label, 28f).apply {
            id = View.generateViewId()
            isFocusable = true
            isFocusableInTouchMode = false
            gravity = Gravity.CENTER
            setTextColor(sceneForegroundColor(color))
            background = buttonBackground(color, focused = false)
            setOnFocusChangeListener { focusedView, focused ->
                focusedView.background = buttonBackground(color, focused)
                focusedView.animate().cancel()
                focusedView.animate()
                    .scaleX(if (focused) 1.025f else 1f)
                    .scaleY(if (focused) 1.025f else 1f)
                    .setDuration(100L)
                    .start()
            }
        }

        fun panelBackground(): GradientDrawable = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = px(10f).toFloat()
            setColor(Color.argb(210, Color.red(primary), Color.green(primary), Color.blue(primary)))
            setStroke(px(2f).coerceAtLeast(1), Color.argb(150, 255, 255, 255))
        }

        private fun buttonBackground(color: Int, focused: Boolean): GradientDrawable =
            GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = px(10f).toFloat()
                setColor(
                    Color.argb(
                        if (focused) 250 else 215,
                        Color.red(color),
                        Color.green(color),
                        Color.blue(color),
                    ),
                )
                setStroke(
                    px(if (focused) 4f else 1f).coerceAtLeast(1),
                    sceneForegroundColor(color),
                )
            }

        private fun parseColor(value: String, fallback: Int): Int =
            runCatching { Color.parseColor(value) }.getOrDefault(fallback)
    }

    private companion object {
        const val PIN_LENGTH = 6
        const val MAX_APPLICATIONS = 12
        const val PRIVATE_GRID_COLUMNS = 3
        const val CANVAS_WIDTH = 1920f
        const val CANVAS_HEIGHT = 1080f
        const val FIRST_PIN_KEY_TAG = "private-pin-first"
        const val FIRST_APP_TAG = "private-app-first"
        const val EXIT_TAG = "private-exit"
        val BACKGROUND = Color.rgb(4, 13, 17)
    }
}
