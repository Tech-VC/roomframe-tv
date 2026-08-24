package org.roomframe.tv.deviceadmin

/**
 * Bounds HOME redirections so a crashing activity can never create an
 * unbounded relaunch loop. The limiter is deliberately independent from
 * Android so its safety behavior remains covered by unit tests.
 */
class HomeRedirectRateLimiter(
    private val minimumIntervalMillis: Long = 750L,
    private val maximumAttemptsPerWindow: Int = 3,
    private val windowMillis: Long = 5_000L,
    private val cooldownMillis: Long = 10_000L,
) {
    private val attempts = ArrayDeque<Long>()
    private var blockedUntilMillis = 0L

    fun tryAcquire(nowMillis: Long): Boolean {
        require(nowMillis >= 0L)
        if (nowMillis < blockedUntilMillis) return false

        while (attempts.isNotEmpty() && nowMillis - attempts.first() >= windowMillis) {
            attempts.removeFirst()
        }

        val lastAttempt = attempts.lastOrNull()
        if (lastAttempt != null && nowMillis - lastAttempt < minimumIntervalMillis) {
            return false
        }

        if (attempts.size >= maximumAttemptsPerWindow) {
            attempts.clear()
            blockedUntilMillis = nowMillis + cooldownMillis
            return false
        }

        attempts.addLast(nowMillis)
        return true
    }

    /**
     * A redirect is successful only after RoomFrame has remained visible for
     * the stability delay enforced by the accessibility service. Successful
     * HOME presses must never consume the crash-loop budget.
     */
    fun markSuccessful() {
        attempts.clear()
        blockedUntilMillis = 0L
    }
}
