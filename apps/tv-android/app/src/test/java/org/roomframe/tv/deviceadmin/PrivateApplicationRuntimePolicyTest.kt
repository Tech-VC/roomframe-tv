package org.roomframe.tv.deviceadmin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateApplicationRuntimePolicyTest {
    @Test
    fun `an unknown system or persistent package is never hidden`() {
        assertFalse(
            privateApplicationRuntimeControllable(
                descriptor("org.example.system", systemApplication = true),
            ),
        )
        assertFalse(
            privateApplicationRuntimeControllable(
                descriptor("org.example.persistent", persistent = true),
            ),
        )
    }

    @Test
    fun `CANAL user app and explicitly allowed YouTube system app remain controllable`() {
        assertTrue(
            privateApplicationRuntimeControllable(
                descriptor("com.canal.android.canal"),
            ),
        )
        assertTrue(
            privateApplicationRuntimeControllable(
                descriptor("com.google.android.youtube.tv", systemApplication = true),
            ),
        )
    }

    @Test
    fun `HOME protected components and packages without a launcher are rejected`() {
        assertFalse(
            privateApplicationRuntimeControllable(
                descriptor("org.example.home", providesHome = true),
            ),
        )
        assertFalse(
            privateApplicationRuntimeControllable(
                descriptor("org.example.admin", exposesProtectedComponent = true),
            ),
        )
        assertFalse(
            privateApplicationRuntimeControllable(
                descriptor("org.example.headless", launchable = false),
            ),
        )
    }

    private fun descriptor(
        applicationId: String,
        persistent: Boolean = false,
        systemApplication: Boolean = false,
        updatedSystemApplication: Boolean = false,
        providesHome: Boolean = false,
        exposesProtectedComponent: Boolean = false,
        launchable: Boolean = true,
    ) = PrivateApplicationRuntimeDescriptor(
        applicationId = applicationId,
        persistent = persistent,
        systemApplication = systemApplication,
        updatedSystemApplication = updatedSystemApplication,
        providesHome = providesHome,
        exposesProtectedComponent = exposesProtectedComponent,
        launchable = launchable,
    )
}
