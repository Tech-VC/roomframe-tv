package org.roomframe.tv

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import org.roomframe.tv.deviceadmin.AndroidPersistentHomePolicy

class RoomFrameAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        AndroidPersistentHomePolicy.from(context).ensureApplied()
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        AndroidPersistentHomePolicy.from(context).ensureApplied()
    }
}
