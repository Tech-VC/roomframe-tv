package org.roomframe.tv.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build

internal class AndroidApplicationLauncher(
    private val activity: Activity,
) {
    fun launchInstalled(applicationId: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val sender = runCatching {
                activity.packageManager.getLaunchIntentSenderForPackage(applicationId)
            }.getOrNull() ?: return false
            return runCatching {
                sender.sendIntent(activity, 0, null, null, null)
                true
            }.getOrDefault(false)
        }
        return launchLegacy(applicationId)
    }

    fun openStore(applicationId: String): Boolean {
        val marketUri = Uri.parse("market://details?id=$applicationId")
        val playStore = Intent(Intent.ACTION_VIEW, marketUri)
            .setPackage(PLAY_STORE_APPLICATION_ID)
        if (start(playStore)) return true
        if (start(Intent(Intent.ACTION_VIEW, marketUri))) return true
        return start(
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("https://play.google.com/store/apps/details?id=$applicationId"),
            ),
        )
    }

    @Suppress("DEPRECATION")
    private fun launchLegacy(applicationId: String): Boolean {
        val intent = activity.packageManager.getLeanbackLaunchIntentForPackage(applicationId)
            ?: activity.packageManager.getLaunchIntentForPackage(applicationId)
            ?: return false
        return start(intent)
    }

    private fun start(intent: Intent): Boolean = runCatching {
        activity.startActivity(intent)
        true
    }.getOrDefault(false)

    private companion object {
        const val PLAY_STORE_APPLICATION_ID = "com.android.vending"
    }
}
