package org.roomframe.tv.ui

internal sealed interface PrivateAttemptState {
    data object Ready : PrivateAttemptState
    data class Locked(val retryAfterSeconds: Int) : PrivateAttemptState
}

/**
 * Temporisation locale complémentaire à celle du serveur. Elle ne persiste ni
 * le code ni la session et évite de marteler l'API depuis la télécommande.
 */
internal class PrivateAccessAttemptLimiter(
    private var maximumAttempts: Int,
    private var lockoutSeconds: Int,
    private val nowMillis: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) {
    private var failedAttempts = 0
    private var lockedUntilMillis = 0L

    fun configure(maximumAttempts: Int, lockoutSeconds: Int) {
        require(maximumAttempts in 1..10)
        require(lockoutSeconds in 1..3_600)
        this.maximumAttempts = maximumAttempts
        this.lockoutSeconds = lockoutSeconds
        reset()
    }

    fun state(): PrivateAttemptState {
        val remainingMillis = lockedUntilMillis - nowMillis()
        if (remainingMillis <= 0) {
            if (lockedUntilMillis != 0L) reset()
            return PrivateAttemptState.Ready
        }
        return PrivateAttemptState.Locked(
            ((remainingMillis + 999L) / 1_000L).toInt().coerceAtLeast(1),
        )
    }

    fun recordInvalid(): PrivateAttemptState {
        if (state() is PrivateAttemptState.Locked) return state()
        failedAttempts += 1
        if (failedAttempts >= maximumAttempts) {
            lockedUntilMillis = nowMillis() + lockoutSeconds * 1_000L
            failedAttempts = 0
        }
        return state()
    }

    fun applyServerLockout(retryAfterSeconds: Int): PrivateAttemptState {
        val boundedSeconds = retryAfterSeconds.coerceIn(1, 3_600)
        lockedUntilMillis = maxOf(
            lockedUntilMillis,
            nowMillis() + boundedSeconds * 1_000L,
        )
        failedAttempts = 0
        return state()
    }

    fun reset() {
        failedAttempts = 0
        lockedUntilMillis = 0L
    }
}
