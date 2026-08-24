package org.roomframe.tv.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateSessionNavigationPolicyTest {
    @Test
    fun `a real HOME navigation locks the private session`() {
        assertTrue(
            shouldLockPrivateSessionFromNavigation(
                action = "android.intent.action.MAIN",
                hasHomeCategory = true,
                explicitHomeRedirect = false,
            ),
        )
    }

    @Test
    fun `the bounded accessibility redirect locks without pretending Back is Home`() {
        assertTrue(
            shouldLockPrivateSessionFromNavigation(
                action = null,
                hasHomeCategory = false,
                explicitHomeRedirect = true,
            ),
        )
        assertFalse(
            shouldLockPrivateSessionFromNavigation(
                action = "android.intent.action.MAIN",
                hasHomeCategory = false,
                explicitHomeRedirect = false,
            ),
        )
    }
}
