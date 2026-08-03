package org.roomframe.tv.update

enum class UpdateInstallMoment {
    STARTUP,
    PERIODIC,
    BEFORE_SLEEP,
}

data class UpdateInstallDecision(
    val allowed: Boolean,
    val reason: String,
)

object SafeUpdateInstallPolicy {
    const val IDLE_THRESHOLD_MILLIS = 15L * 60L * 1_000L

    fun decide(
        moment: UpdateInstallMoment,
        nowElapsedRealtime: Long,
        lastUserInteractionElapsedRealtime: Long,
        userInteractedSinceStartup: Boolean,
    ): UpdateInstallDecision {
        require(nowElapsedRealtime >= 0)
        require(lastUserInteractionElapsedRealtime in 0..nowElapsedRealtime)
        return when (moment) {
            UpdateInstallMoment.BEFORE_SLEEP -> UpdateInstallDecision(
                allowed = true,
                reason = "before-sleep",
            )
            UpdateInstallMoment.STARTUP -> if (!userInteractedSinceStartup) {
                UpdateInstallDecision(allowed = true, reason = "startup")
            } else {
                idleDecision(nowElapsedRealtime, lastUserInteractionElapsedRealtime)
            }
            UpdateInstallMoment.PERIODIC -> idleDecision(
                nowElapsedRealtime,
                lastUserInteractionElapsedRealtime,
            )
        }
    }

    private fun idleDecision(
        nowElapsedRealtime: Long,
        lastUserInteractionElapsedRealtime: Long,
    ): UpdateInstallDecision {
        val idleMillis = (nowElapsedRealtime - lastUserInteractionElapsedRealtime).coerceAtLeast(0)
        return if (idleMillis >= IDLE_THRESHOLD_MILLIS) {
            UpdateInstallDecision(allowed = true, reason = "idle-15m")
        } else {
            UpdateInstallDecision(allowed = false, reason = "waiting-idle")
        }
    }
}
