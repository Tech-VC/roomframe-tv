package org.roomframe.tv.deviceadmin

import android.app.admin.DevicePolicyManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProvisioningModePolicyTest {
    @Test
    fun `accepte uniquement le mode appareil entierement gere et preserve les apps systeme`() {
        val decision = ProvisioningModePolicy.choose(
                listOf(
                    DevicePolicyManager.PROVISIONING_MODE_MANAGED_PROFILE,
                    DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE,
                ),
        )
        assertEquals(DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE, decision?.mode)
        assertEquals(true, decision?.leaveAllSystemAppsEnabled)
        assertNull(
            ProvisioningModePolicy.choose(
                listOf(DevicePolicyManager.PROVISIONING_MODE_MANAGED_PROFILE),
            ),
        )
        assertNull(ProvisioningModePolicy.choose(emptyList()))
    }
}
