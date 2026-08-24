package org.roomframe.tv.deviceadmin

import org.junit.Assert.assertEquals
import org.junit.Test

class RequiredSystemAppPolicyTest {
    @Test
    fun `does nothing outside Device Owner`() {
        val port = FakeRequiredSystemAppPolicyPort(deviceOwner = false)

        assertEquals(
            RequiredSystemAppPolicyResult.NOT_DEVICE_OWNER,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(0, port.enableCalls)
    }

    @Test
    fun `does nothing on an unrelated Android TV`() {
        val port = FakeRequiredSystemAppPolicyPort(targetPlatform = false)

        assertEquals(
            RequiredSystemAppPolicyResult.NOT_TARGET_PLATFORM,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(0, port.enableCalls)
    }

    @Test
    fun `re-enables only the known installed system receiver`() {
        val port = FakeRequiredSystemAppPolicyPort(available = false, systemPackageInstalled = true)

        assertEquals(
            RequiredSystemAppPolicyResult.ENABLED,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(1, port.enableCalls)
    }

    @Test
    fun `does not touch an already available receiver`() {
        val port = FakeRequiredSystemAppPolicyPort(available = true)

        assertEquals(
            RequiredSystemAppPolicyResult.ALREADY_AVAILABLE,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(0, port.enableCalls)
    }

    @Test
    fun `reports failure when the firmware keeps the receiver disabled`() {
        val port = FakeRequiredSystemAppPolicyPort(
            available = false,
            systemPackageInstalled = true,
            availableAfterEnable = false,
        )

        assertEquals(
            RequiredSystemAppPolicyResult.FAILED,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(1, port.enableCalls)
    }

    @Test
    fun `reports failure when Device Policy rejects the operation`() {
        val port = FakeRequiredSystemAppPolicyPort(
            available = false,
            systemPackageInstalled = true,
            failOnEnable = true,
        )

        assertEquals(
            RequiredSystemAppPolicyResult.FAILED,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(1, port.enableCalls)
    }

    @Test
    fun `refuses a missing non-system package`() {
        val port = FakeRequiredSystemAppPolicyPort(available = false, systemPackageInstalled = false)

        assertEquals(
            RequiredSystemAppPolicyResult.SYSTEM_PACKAGE_MISSING,
            RequiredSystemAppPolicy("system.receiver", port).ensureAvailable(),
        )
        assertEquals(0, port.enableCalls)
    }
}

private class FakeRequiredSystemAppPolicyPort(
    private val deviceOwner: Boolean = true,
    private val targetPlatform: Boolean = true,
    private var available: Boolean = true,
    private val systemPackageInstalled: Boolean = true,
    private val availableAfterEnable: Boolean = true,
    private val failOnEnable: Boolean = false,
) : RequiredSystemAppPolicyPort {
    var enableCalls = 0

    override fun isDeviceOwner(): Boolean = deviceOwner
    override fun isTargetPlatform(): Boolean = targetPlatform
    override fun isPackageAvailable(packageName: String): Boolean = available
    override fun isSystemPackageInstalled(packageName: String): Boolean = systemPackageInstalled
    override fun enableAndUnhideSystemApp(packageName: String) {
        enableCalls += 1
        if (failOnEnable) error("Device Policy refused")
        available = availableAfterEnable
    }
}
