package org.roomframe.tv

import android.app.Application
import android.util.Log
import org.roomframe.tv.deviceadmin.AndroidPrivateApplicationAccessController
import org.roomframe.tv.deviceadmin.PrivateApplicationSessionState
import org.roomframe.tv.deviceadmin.AndroidPersistentHomePolicy
import org.roomframe.tv.deviceadmin.AndroidRequiredSystemAppPolicy
import org.roomframe.tv.deviceadmin.RequiredSystemAppPolicyResult

class RoomFrameApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Reconcile after every process start, including after an APK update.
        // Outside Device Owner this is a guaranteed no-op.
        AndroidPersistentHomePolicy.from(this).ensureApplied()
        // Une session privée n'est jamais restaurée après un redémarrage du
        // processus. Seuls les paquets précédemment gérés sont reverrouillés.
        PrivateApplicationSessionState.lock()
        AndroidPrivateApplicationAccessController(this).lockPreviouslyManaged()
        val castResult = AndroidRequiredSystemAppPolicy.from(this).ensureCastReceiverAvailable()
        if (
            castResult == RequiredSystemAppPolicyResult.FAILED ||
            castResult == RequiredSystemAppPolicyResult.SYSTEM_PACKAGE_MISSING
        ) {
            Log.w("RoomFrameSystemApps", "Cast receiver reconciliation: $castResult")
        }
    }
}
