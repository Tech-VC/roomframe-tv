package org.roomframe.tv.deviceadmin

import org.junit.Assert.assertEquals
import org.junit.Test

class PersistentHomePolicyTest {
    private val target = HomeActivity("org.roomframe.tv", "org.roomframe.tv.MainActivity")

    @Test
    fun `ne change rien hors Device Owner`() {
        val port = FakePort(deviceOwner = false, resolved = null)
        val policy = PersistentHomePolicy(target.packageName, target, port)

        assertEquals(PersistentHomePolicyResult.NOT_DEVICE_OWNER, policy.ensureApplied())
        assertEquals(PersistentHomePolicyResult.NOT_DEVICE_OWNER, policy.clearForMaintenance())
        assertEquals(0, port.applyCalls)
        assertEquals(0, port.clearCalls)
    }

    @Test
    fun `ne reapplique pas si RoomFrame est deja HOME`() {
        val port = FakePort(deviceOwner = true, resolved = target)
        val policy = PersistentHomePolicy(target.packageName, target, port)

        assertEquals(PersistentHomePolicyResult.ALREADY_APPLIED, policy.ensureApplied())
        assertEquals(0, port.applyCalls)
    }

    @Test
    fun `applique le HOME persistant une seule fois necessaire`() {
        val port = FakePort(
            deviceOwner = true,
            resolved = HomeActivity("com.vendor.launcher", "com.vendor.launcher.Home"),
        )
        val policy = PersistentHomePolicy(target.packageName, target, port)

        assertEquals(PersistentHomePolicyResult.APPLY_REQUESTED, policy.ensureApplied())
        assertEquals(1, port.applyCalls)
        assertEquals(target, port.lastTarget)
    }

    @Test
    fun `retire uniquement la preference HOME pour la maintenance`() {
        val port = FakePort(deviceOwner = true, resolved = target)
        val policy = PersistentHomePolicy(target.packageName, target, port)

        assertEquals(PersistentHomePolicyResult.CLEAR_REQUESTED, policy.clearForMaintenance())
        assertEquals(1, port.clearCalls)
        assertEquals(target.packageName, port.lastClearedPackage)
    }

    @Test
    fun `transforme un refus Android en echec sans crash`() {
        val port = FakePort(deviceOwner = true, resolved = null, fail = true)
        val policy = PersistentHomePolicy(target.packageName, target, port)

        assertEquals(PersistentHomePolicyResult.FAILED, policy.ensureApplied())
        assertEquals(PersistentHomePolicyResult.FAILED, policy.clearForMaintenance())
    }

    private class FakePort(
        private val deviceOwner: Boolean,
        private val resolved: HomeActivity?,
        private val fail: Boolean = false,
    ) : PersistentHomePolicyPort {
        var applyCalls = 0
        var clearCalls = 0
        var lastTarget: HomeActivity? = null
        var lastClearedPackage: String? = null

        override fun isDeviceOwner(packageName: String): Boolean = deviceOwner

        override fun resolveHomeActivity(): HomeActivity? = resolved

        override fun addPersistentHome(target: HomeActivity) {
            if (fail) throw SecurityException("refused")
            applyCalls += 1
            lastTarget = target
        }

        override fun clearPersistentHome(packageName: String) {
            if (fail) throw SecurityException("refused")
            clearCalls += 1
            lastClearedPackage = packageName
        }
    }
}
