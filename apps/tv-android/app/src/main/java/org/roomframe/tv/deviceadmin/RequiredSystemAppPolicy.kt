package org.roomframe.tv.deviceadmin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import org.roomframe.tv.RoomFrameAdminReceiver
import org.roomframe.tv.adapters.PhilipsTa1Profile

enum class RequiredSystemAppPolicyResult {
    NOT_DEVICE_OWNER,
    NOT_TARGET_PLATFORM,
    ALREADY_AVAILABLE,
    ENABLED,
    SYSTEM_PACKAGE_MISSING,
    FAILED,
}

interface RequiredSystemAppPolicyPort {
    fun isDeviceOwner(): Boolean
    fun isTargetPlatform(): Boolean
    fun isPackageAvailable(packageName: String): Boolean
    fun isSystemPackageInstalled(packageName: String): Boolean
    fun enableAndUnhideSystemApp(packageName: String)
}

class RequiredSystemAppPolicy(
    private val packageName: String,
    private val port: RequiredSystemAppPolicyPort,
) {
    fun ensureAvailable(): RequiredSystemAppPolicyResult {
        if (!port.isDeviceOwner()) return RequiredSystemAppPolicyResult.NOT_DEVICE_OWNER
        if (!port.isTargetPlatform()) return RequiredSystemAppPolicyResult.NOT_TARGET_PLATFORM
        if (port.isPackageAvailable(packageName)) {
            return RequiredSystemAppPolicyResult.ALREADY_AVAILABLE
        }
        if (!port.isSystemPackageInstalled(packageName)) {
            return RequiredSystemAppPolicyResult.SYSTEM_PACKAGE_MISSING
        }
        return runCatching {
            port.enableAndUnhideSystemApp(packageName)
            if (port.isPackageAvailable(packageName)) {
                RequiredSystemAppPolicyResult.ENABLED
            } else {
                RequiredSystemAppPolicyResult.FAILED
            }
        }.getOrElse {
            RequiredSystemAppPolicyResult.FAILED
        }
    }
}

class AndroidRequiredSystemAppPolicy private constructor(
    private val castPolicy: RequiredSystemAppPolicy,
) {
    fun ensureCastReceiverAvailable(): RequiredSystemAppPolicyResult = castPolicy.ensureAvailable()

    companion object {
        fun from(context: Context): AndroidRequiredSystemAppPolicy {
            val applicationContext = context.applicationContext
            val port = AndroidRequiredSystemAppPolicyPort(applicationContext)
            return AndroidRequiredSystemAppPolicy(
                RequiredSystemAppPolicy(PhilipsTa1Profile.CAST_PACKAGE, port),
            )
        }
    }
}

private class AndroidRequiredSystemAppPolicyPort(
    private val context: Context,
) : RequiredSystemAppPolicyPort {
    private val packageManager = context.packageManager
    private val devicePolicyManager = requireNotNull(
        context.getSystemService(DevicePolicyManager::class.java),
    ) { "DevicePolicyManager indisponible" }
    private val admin = ComponentName(context, RoomFrameAdminReceiver::class.java)

    override fun isDeviceOwner(): Boolean =
        devicePolicyManager.isDeviceOwnerApp(context.packageName)

    override fun isTargetPlatform(): Boolean = PhilipsTa1Profile.matches(
        Build.MANUFACTURER,
        Build.BRAND,
        Build.PRODUCT,
    )

    override fun isPackageAvailable(packageName: String): Boolean =
        applicationInfo(packageName, includeUnavailable = false)?.enabled == true

    override fun isSystemPackageInstalled(packageName: String): Boolean {
        val info = applicationInfo(packageName, includeUnavailable = true) ?: return false
        return info.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
    }

    override fun enableAndUnhideSystemApp(packageName: String) {
        devicePolicyManager.enableSystemApp(admin, packageName)
        if (devicePolicyManager.isApplicationHidden(admin, packageName)) {
            devicePolicyManager.setApplicationHidden(admin, packageName, false)
            check(!devicePolicyManager.isApplicationHidden(admin, packageName)) {
                "Le paquet système reste masqué"
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun applicationInfo(packageName: String, includeUnavailable: Boolean): ApplicationInfo? {
        val flags = if (includeUnavailable) {
            PackageManager.MATCH_DISABLED_COMPONENTS or PackageManager.MATCH_UNINSTALLED_PACKAGES
        } else {
            0
        }
        return runCatching { packageManager.getApplicationInfo(packageName, flags) }.getOrNull()
    }
}
