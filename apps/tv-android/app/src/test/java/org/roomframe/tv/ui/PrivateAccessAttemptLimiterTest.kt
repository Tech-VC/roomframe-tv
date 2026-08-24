package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateAccessAttemptLimiterTest {
    @Test
    fun `local limiter locks after the configured failures and expires`() {
        var now = 1_000L
        val limiter = PrivateAccessAttemptLimiter(
            maximumAttempts = 3,
            lockoutSeconds = 30,
            nowMillis = { now },
        )

        assertEquals(PrivateAttemptState.Ready, limiter.recordInvalid())
        assertEquals(PrivateAttemptState.Ready, limiter.recordInvalid())
        assertEquals(PrivateAttemptState.Locked(30), limiter.recordInvalid())
        now += 29_100L
        assertEquals(PrivateAttemptState.Locked(1), limiter.state())
        now += 900L
        assertEquals(PrivateAttemptState.Ready, limiter.state())
    }

    @Test
    fun `server lockout is bounded and reset after a successful unlock`() {
        var now = 5_000L
        val limiter = PrivateAccessAttemptLimiter(5, 60) { now }

        assertEquals(PrivateAttemptState.Locked(3_600), limiter.applyServerLockout(9_999))
        limiter.reset()
        assertTrue(limiter.state() is PrivateAttemptState.Ready)
    }
}
