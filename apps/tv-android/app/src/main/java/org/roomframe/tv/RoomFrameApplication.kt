package org.roomframe.tv

import android.app.Application
import org.roomframe.tv.deviceadmin.AndroidPersistentHomePolicy

class RoomFrameApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Reconcile after every process start, including after an APK update.
        // Outside Device Owner this is a guaranteed no-op.
        AndroidPersistentHomePolicy.from(this).ensureApplied()
    }
}
