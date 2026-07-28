package org.roomframe.tv.adapters

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

class AppUpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_UPDATE_RESULT) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val versionCode = intent.getLongExtra(EXTRA_VERSION_CODE, -1)
        val state = if (status == PackageInstaller.STATUS_SUCCESS) {
            "installed:$versionCode"
        } else {
            "failed:$status"
        }
        context.getSharedPreferences("roomframe-runtime", Context.MODE_PRIVATE)
            .edit()
            .putString("last_update_state", state)
            .apply()
    }

    companion object {
        const val ACTION_UPDATE_RESULT = "org.roomframe.tv.UPDATE_RESULT"
        const val EXTRA_VERSION_CODE = "version_code"
    }
}
