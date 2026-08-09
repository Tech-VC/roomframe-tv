package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TvSyncScheduleTest {
    @Test
    fun `rafraichit la presence avant la fenetre online du serveur`() {
        val serverOnlineWindowMillis = 2L * 60L * 1_000L

        assertEquals(60_000L, TvSyncSchedule.PERIODIC_INTERVAL_MILLIS)
        assertTrue(TvSyncSchedule.PERIODIC_INTERVAL_MILLIS < serverOnlineWindowMillis)
    }
}
