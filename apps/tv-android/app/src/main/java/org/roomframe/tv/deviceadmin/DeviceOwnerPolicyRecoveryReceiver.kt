package org.roomframe.tv.deviceadmin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Narrow ADB/shell recovery for the persistent HOME preference.
 *
 * The manifest requires the platform DUMP permission from the caller. The
 * receiver cannot remove Device Owner, disable packages or change any other
 * policy, and it never accepts data from the intent.
 */
class DeviceOwnerPolicyRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val policy = AndroidPersistentHomePolicy.from(context)
        val result = when (intent.action) {
            ACTION_APPLY -> policy.ensureApplied()
            ACTION_CLEAR -> policy.clearForMaintenance()
            else -> PersistentHomePolicyResult.FAILED
        }
        resultData = result.name
    }

    companion object {
        const val ACTION_APPLY = "org.roomframe.tv.maintenance.APPLY_PERSISTENT_HOME"
        const val ACTION_CLEAR = "org.roomframe.tv.maintenance.CLEAR_PERSISTENT_HOME"
    }
}
