package org.roomframe.tv.deviceadmin

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import org.roomframe.tv.MainActivity
import org.roomframe.tv.EXTRA_LOCK_PRIVATE_SESSION

/**
 * Reversible Philips HOME fallback.
 *
 * Some Philips firmwares give their privileged launcher a higher resolver
 * priority than the persistent HOME activity selected by Device Owner. This
 * service never disables that launcher: it consumes only KEYCODE_HOME and
 * reacts only when a known Google TV launcher becomes visible.
 */
class RoomFrameHomeAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private val limiter = HomeRedirectRateLimiter()
    private val launchRunnable = Runnable(::launchRoomFrame)
    private val confirmVisibleRunnable = Runnable(limiter::markSuccessful)

    override fun onServiceConnected() {
        super.onServiceConnected()
        val constrained = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            packageNames = OBSERVED_PACKAGES.toTypedArray()
            feedbackType = AccessibilityServiceInfo.FEEDBACK_VISUAL
            flags = (flags or AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS) and
                AccessibilityServiceInfo.FLAG_ENABLE_ACCESSIBILITY_VOLUME.inv()
            notificationTimeout = EVENT_TIMEOUT_MILLIS
        }
        setServiceInfo(constrained)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        when (event.packageName?.toString()) {
            packageName -> scheduleSuccessfulVisibilityConfirmation()
            in GOOGLE_TV_LAUNCHER_PACKAGES -> {
                handler.removeCallbacks(confirmVisibleRunnable)
                scheduleRedirect(LAUNCHER_REDIRECT_DELAY_MILLIS)
            }
        }
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != KeyEvent.KEYCODE_HOME) return false
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            scheduleRedirect(KEY_REDIRECT_DELAY_MILLIS)
        }
        // Consume both DOWN and UP so the stream seen by Android stays valid.
        return true
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun scheduleRedirect(delayMillis: Long) {
        handler.removeCallbacks(launchRunnable)
        handler.postDelayed(launchRunnable, delayMillis)
    }

    private fun scheduleSuccessfulVisibilityConfirmation() {
        handler.removeCallbacks(confirmVisibleRunnable)
        handler.postDelayed(confirmVisibleRunnable, SUCCESS_STABILITY_MILLIS)
    }

    private fun launchRoomFrame() {
        if (!limiter.tryAcquire(SystemClock.elapsedRealtime())) return
        val intent = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_LOCK_PRIVATE_SESSION, true)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }
        runCatching { startActivity(intent) }
    }

    private companion object {
        val GOOGLE_TV_LAUNCHER_PACKAGES = setOf(
            "com.google.android.apps.tv.launcherx",
            "com.google.android.tvlauncher",
        )
        val OBSERVED_PACKAGES = GOOGLE_TV_LAUNCHER_PACKAGES + "org.roomframe.tv"
        const val EVENT_TIMEOUT_MILLIS = 80L
        const val KEY_REDIRECT_DELAY_MILLIS = 80L
        const val LAUNCHER_REDIRECT_DELAY_MILLIS = 180L
        const val SUCCESS_STABILITY_MILLIS = 2_000L
    }
}
