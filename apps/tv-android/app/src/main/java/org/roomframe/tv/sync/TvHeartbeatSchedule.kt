package org.roomframe.tv.sync

internal object TvHeartbeatSchedule {
    private const val MIN_INTERVAL_MILLIS = 55_000L
    private const val INTERVAL_SPREAD_MILLIS = 15_000L
    private const val MIN_INITIAL_DELAY_MILLIS = 8_000L
    private const val INITIAL_SPREAD_MILLIS = 17_000L

    fun intervalMillis(deviceId: String): Long =
        MIN_INTERVAL_MILLIS + stableOffset(deviceId, INTERVAL_SPREAD_MILLIS)

    fun initialDelayMillis(deviceId: String): Long =
        MIN_INITIAL_DELAY_MILLIS + stableOffset(deviceId.reversed(), INITIAL_SPREAD_MILLIS)

    private fun stableOffset(value: String, range: Long): Long =
        (value.hashCode().toLong() and 0x7fff_ffffL) % range
}
