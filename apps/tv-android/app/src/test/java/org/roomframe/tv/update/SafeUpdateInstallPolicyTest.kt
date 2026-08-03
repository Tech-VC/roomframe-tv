package org.roomframe.tv.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SafeUpdateInstallPolicyTest {
    @Test
    fun `autorise au demarrage seulement avant toute interaction`() {
        val startup = SafeUpdateInstallPolicy.decide(
            moment = UpdateInstallMoment.STARTUP,
            nowElapsedRealtime = 5_000,
            lastUserInteractionElapsedRealtime = 1_000,
            userInteractedSinceStartup = false,
        )
        assertTrue(startup.allowed)
        assertEquals("startup", startup.reason)

        val interrupted = SafeUpdateInstallPolicy.decide(
            moment = UpdateInstallMoment.STARTUP,
            nowElapsedRealtime = 5_000,
            lastUserInteractionElapsedRealtime = 4_900,
            userInteractedSinceStartup = true,
        )
        assertFalse(interrupted.allowed)
        assertEquals("waiting-idle", interrupted.reason)
    }

    @Test
    fun `attend quinze minutes inactivite et autorise avant la veille`() {
        val tooSoon = SafeUpdateInstallPolicy.decide(
            moment = UpdateInstallMoment.PERIODIC,
            nowElapsedRealtime = 899_999,
            lastUserInteractionElapsedRealtime = 0,
            userInteractedSinceStartup = true,
        )
        assertFalse(tooSoon.allowed)

        val idle = SafeUpdateInstallPolicy.decide(
            moment = UpdateInstallMoment.PERIODIC,
            nowElapsedRealtime = 900_000,
            lastUserInteractionElapsedRealtime = 0,
            userInteractedSinceStartup = true,
        )
        assertTrue(idle.allowed)
        assertEquals("idle-15m", idle.reason)

        val beforeSleep = SafeUpdateInstallPolicy.decide(
            moment = UpdateInstallMoment.BEFORE_SLEEP,
            nowElapsedRealtime = 100,
            lastUserInteractionElapsedRealtime = 100,
            userInteractedSinceStartup = true,
        )
        assertTrue(beforeSleep.allowed)
        assertEquals("before-sleep", beforeSleep.reason)
    }
}
