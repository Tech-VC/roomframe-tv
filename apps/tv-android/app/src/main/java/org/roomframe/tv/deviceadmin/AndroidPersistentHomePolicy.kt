package org.roomframe.tv.deviceadmin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import org.roomframe.tv.MainActivity
import org.roomframe.tv.RoomFrameAdminReceiver

class AndroidPersistentHomePolicy private constructor(
    private val policy: PersistentHomePolicy,
) {
    fun ensureApplied(): PersistentHomePolicyResult = policy.ensureApplied()

    /**
     * Controlled maintenance hook. It intentionally does not remove Device
     * Owner and does not alter any other policy.
     */
    fun clearForMaintenance(): PersistentHomePolicyResult = policy.clearForMaintenance()

    companion object {
        fun from(context: Context): AndroidPersistentHomePolicy {
            val applicationContext = context.applicationContext
            val target = HomeActivity(
                packageName = applicationContext.packageName,
                className = MainActivity::class.java.name,
            )
            return AndroidPersistentHomePolicy(
                PersistentHomePolicy(
                    packageName = applicationContext.packageName,
                    target = target,
                    port = AndroidPersistentHomePolicyPort(applicationContext),
                ),
            )
        }
    }
}

private class AndroidPersistentHomePolicyPort(
    private val context: Context,
) : PersistentHomePolicyPort {
    private val devicePolicyManager = requireNotNull(
        context.getSystemService(DevicePolicyManager::class.java),
    ) { "DevicePolicyManager indisponible" }
    private val admin = ComponentName(context, RoomFrameAdminReceiver::class.java)

    override fun isDeviceOwner(packageName: String): Boolean =
        devicePolicyManager.isDeviceOwnerApp(packageName)

    override fun resolveHomeActivity(): HomeActivity? {
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        val resolved = context.packageManager.resolveActivity(
            intent,
            PackageManager.MATCH_DEFAULT_ONLY,
        )?.activityInfo ?: return null
        return HomeActivity(
            packageName = resolved.packageName,
            className = resolved.name,
        )
    }

    override fun addPersistentHome(target: HomeActivity) {
        val filter = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        devicePolicyManager.addPersistentPreferredActivity(
            admin,
            filter,
            ComponentName(target.packageName, target.className),
        )
    }

    override fun clearPersistentHome(packageName: String) {
        devicePolicyManager.clearPackagePersistentPreferredActivities(admin, packageName)
    }
}
