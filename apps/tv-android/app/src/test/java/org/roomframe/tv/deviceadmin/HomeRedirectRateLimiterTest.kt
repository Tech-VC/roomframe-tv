package org.roomframe.tv.deviceadmin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeRedirectRateLimiterTest {
    @Test
    fun `espace les redirections rapprochees`() {
        val limiter = HomeRedirectRateLimiter()

        assertTrue(limiter.tryAcquire(1_000L))
        assertFalse(limiter.tryAcquire(1_500L))
        assertTrue(limiter.tryAcquire(1_750L))
    }

    @Test
    fun `coupe les relances apres trois tentatives dans la fenetre`() {
        val limiter = HomeRedirectRateLimiter()

        assertTrue(limiter.tryAcquire(1_000L))
        assertTrue(limiter.tryAcquire(2_000L))
        assertTrue(limiter.tryAcquire(3_000L))
        assertFalse(limiter.tryAcquire(4_000L))
        assertFalse(limiter.tryAcquire(13_999L))
        assertTrue(limiter.tryAcquire(14_000L))
    }

    @Test
    fun `oublie les anciennes tentatives hors fenetre`() {
        val limiter = HomeRedirectRateLimiter()

        assertTrue(limiter.tryAcquire(1_000L))
        assertTrue(limiter.tryAcquire(2_000L))
        assertTrue(limiter.tryAcquire(6_000L))
        assertTrue(limiter.tryAcquire(7_000L))
    }

    @Test
    fun `des appuis home reguliers ne declenchent jamais le coupe circuit`() {
        val limiter = HomeRedirectRateLimiter()

        assertTrue(limiter.tryAcquire(1_000L))
        assertTrue(limiter.tryAcquire(5_000L))
        assertTrue(limiter.tryAcquire(9_000L))
        assertTrue(limiter.tryAcquire(13_000L))
        assertTrue(limiter.tryAcquire(17_000L))
    }

    @Test
    fun `un affichage stable remet a zero le budget anti boucle`() {
        val limiter = HomeRedirectRateLimiter()

        assertTrue(limiter.tryAcquire(1_000L))
        assertTrue(limiter.tryAcquire(2_000L))
        assertTrue(limiter.tryAcquire(3_000L))

        limiter.markSuccessful()

        assertTrue(limiter.tryAcquire(4_000L))
        assertTrue(limiter.tryAcquire(5_000L))
        assertTrue(limiter.tryAcquire(6_000L))
    }
}
