package org.roomframe.tv.deviceadmin

data class HomeActivity(
    val packageName: String,
    val className: String,
)

enum class PersistentHomePolicyResult {
    NOT_DEVICE_OWNER,
    ALREADY_APPLIED,
    APPLY_REQUESTED,
    CLEAR_REQUESTED,
    FAILED,
}

/**
 * Small testable boundary around DevicePolicyManager.
 *
 * The Android implementation is deliberately the only place that is allowed
 * to mutate the persistent HOME preference. No lock-task or user restriction
 * is part of this policy.
 */
interface PersistentHomePolicyPort {
    fun isDeviceOwner(packageName: String): Boolean

    fun resolveHomeActivity(): HomeActivity?

    fun addPersistentHome(target: HomeActivity)

    fun clearPersistentHome(packageName: String)
}

class PersistentHomePolicy(
    private val packageName: String,
    private val target: HomeActivity,
    private val port: PersistentHomePolicyPort,
) {
    fun isDeviceOwner(): Boolean = port.isDeviceOwner(packageName)

    fun ensureApplied(): PersistentHomePolicyResult {
        if (!isDeviceOwner()) {
            return PersistentHomePolicyResult.NOT_DEVICE_OWNER
        }
        if (port.resolveHomeActivity() == target) {
            return PersistentHomePolicyResult.ALREADY_APPLIED
        }
        return runCatching {
            // addPersistentPreferredActivity is idempotent. Android 14 reports
            // the final asynchronous enforcement result to PolicyUpdateReceiver.
            port.addPersistentHome(target)
            PersistentHomePolicyResult.APPLY_REQUESTED
        }.getOrElse {
            PersistentHomePolicyResult.FAILED
        }
    }

    fun clearForMaintenance(): PersistentHomePolicyResult {
        if (!isDeviceOwner()) {
            return PersistentHomePolicyResult.NOT_DEVICE_OWNER
        }
        return runCatching {
            // Clearing an already absent preference is safe and idempotent.
            port.clearPersistentHome(packageName)
            PersistentHomePolicyResult.CLEAR_REQUESTED
        }.getOrElse {
            PersistentHomePolicyResult.FAILED
        }
    }
}
