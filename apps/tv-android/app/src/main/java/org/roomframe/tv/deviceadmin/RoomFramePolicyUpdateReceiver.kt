package org.roomframe.tv.deviceadmin

import android.annotation.TargetApi
import android.app.admin.DevicePolicyIdentifiers
import android.app.admin.PolicyUpdateReceiver
import android.app.admin.PolicyUpdateResult
import android.app.admin.TargetUser
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.Log

/** Android 14 acknowledgement for the asynchronous persistent-HOME policy. */
@TargetApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class RoomFramePolicyUpdateReceiver : PolicyUpdateReceiver() {
    override fun onPolicySetResult(
        context: Context,
        policyIdentifier: String,
        additionalPolicyParams: Bundle,
        targetUser: TargetUser,
        policyUpdateResult: PolicyUpdateResult,
    ) {
        if (policyIdentifier == DevicePolicyIdentifiers.PERSISTENT_PREFERRED_ACTIVITY_POLICY) {
            Log.i(TAG, "persistent HOME policy result=${policyUpdateResult.resultCode}")
        }
    }

    override fun onPolicyChanged(
        context: Context,
        policyIdentifier: String,
        additionalPolicyParams: Bundle,
        targetUser: TargetUser,
        policyUpdateResult: PolicyUpdateResult,
    ) {
        if (policyIdentifier == DevicePolicyIdentifiers.PERSISTENT_PREFERRED_ACTIVITY_POLICY) {
            Log.i(TAG, "persistent HOME policy changed=${policyUpdateResult.resultCode}")
        }
    }

    private companion object {
        const val TAG = "RoomFrameHomePolicy"
    }
}
