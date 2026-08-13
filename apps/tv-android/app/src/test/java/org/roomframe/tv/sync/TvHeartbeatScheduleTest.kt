package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TvHeartbeatScheduleTest {
    @Test
    fun `heartbeat remains below server online window and is stable per TV`() {
        val first = TvHeartbeatSchedule.intervalMillis("00000000-0000-4000-8000-000000000001")
        val repeated = TvHeartbeatSchedule.intervalMillis("00000000-0000-4000-8000-000000000001")

        assertEquals(first, repeated)
        assertTrue(first in 55_000L until 70_000L)
        assertTrue(first < 120_000L)
    }

    @Test
    fun `initial heartbeat is staggered but prompt`() {
        val delay = TvHeartbeatSchedule.initialDelayMillis("00000000-0000-4000-8000-000000000002")
        assertTrue(delay in 8_000L until 25_000L)
    }
}
