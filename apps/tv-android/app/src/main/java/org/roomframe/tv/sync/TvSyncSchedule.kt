package org.roomframe.tv.sync

/** Keeps the TV presence fresh inside the server's two-minute online window. */
object TvSyncSchedule {
    const val PERIODIC_INTERVAL_MILLIS = 60_000L
}
