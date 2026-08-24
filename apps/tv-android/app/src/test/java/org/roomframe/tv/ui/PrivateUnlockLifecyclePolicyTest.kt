package org.roomframe.tv.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateUnlockLifecyclePolicyTest {
    private val requested = PrivateUnlockConfiguration(
        epoch = 4,
        enabled = true,
        pinConfigured = true,
        sourceEnabled = true,
        generation = 2,
        applicationIds = listOf("com.canal.android.canal"),
    )

    @Test
    fun `a delayed result is accepted only for the exact current configuration`() {
        assertTrue(privateUnlockResultCanBeApplied(requested, requested.copy()))
        assertFalse(
            privateUnlockResultCanBeApplied(
                requested,
                requested.copy(applicationIds = listOf("com.google.android.youtube.tv")),
            ),
        )
        assertFalse(
            privateUnlockResultCanBeApplied(
                requested,
                requested.copy(generation = 3),
            ),
        )
    }

    @Test
    fun `HOME screen off or policy disable invalidates an in flight unlock`() {
        assertFalse(
            privateUnlockResultCanBeApplied(
                requested,
                requested.copy(epoch = nextPrivateUnlockEpoch(requested.epoch)),
            ),
        )
        assertFalse(
            privateUnlockResultCanBeApplied(
                requested,
                requested.copy(enabled = false),
            ),
        )
    }
}
