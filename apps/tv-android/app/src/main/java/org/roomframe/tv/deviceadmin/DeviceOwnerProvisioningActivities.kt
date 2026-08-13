package org.roomframe.tv.deviceadmin

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle

data class ProvisioningModeDecision(
    val mode: Int,
    val leaveAllSystemAppsEnabled: Boolean,
)

object ProvisioningModePolicy {
    fun choose(allowedModes: Collection<Int>): ProvisioningModeDecision? =
        DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE
            .takeIf(allowedModes::contains)
            ?.let { mode ->
                ProvisioningModeDecision(
                    mode = mode,
                    // Philips relies on OEM system packages for recovery,
                    // HDMI, Cast and AirPlay. Provisioning must preserve them.
                    leaveAllSystemAppsEnabled = true,
                )
            }
}

/** Android 12+ admin-integrated provisioning entry point. */
class RoomFrameProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.action != DevicePolicyManager.ACTION_GET_PROVISIONING_MODE) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }
        val allowedModes = intent.getIntegerArrayListExtra(
            DevicePolicyManager.EXTRA_PROVISIONING_ALLOWED_PROVISIONING_MODES,
        ).orEmpty()
        val decision = ProvisioningModePolicy.choose(allowedModes)
        if (decision == null) {
            setResult(RESULT_CANCELED)
        } else {
            setResult(
                RESULT_OK,
                Intent()
                    .putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, decision.mode)
                    .putExtra(
                        DevicePolicyManager.EXTRA_PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED,
                        decision.leaveAllSystemAppsEnabled,
                    ),
            )
        }
        finish()
    }
}

/**
 * Android 12+ provisioning completion gate.
 *
 * We deliberately do not enable lock task or add restrictions here. The only
 * managed-device policy is the reversible persistent HOME preference.
 */
class RoomFrameAdminPolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.action != DevicePolicyManager.ACTION_ADMIN_POLICY_COMPLIANCE) {
            setResult(RESULT_CANCELED)
            finish()
            return
        }
        val result = AndroidPersistentHomePolicy.from(this).ensureApplied()
        val accepted = result == PersistentHomePolicyResult.ALREADY_APPLIED ||
            result == PersistentHomePolicyResult.APPLY_REQUESTED
        setResult(if (accepted) RESULT_OK else RESULT_CANCELED)
        finish()
    }
}
