package org.roomframe.tv.deviceadmin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.roomframe.tv.MainActivity

/** One bounded launch after Android has completed a boot. */
class RoomFrameBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!AndroidPersistentHomePolicy.from(context).isDeviceOwner()) return
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                },
            )
        }
    }
}
