package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class TvMetricSnapshotTest {
    @Test
    fun `payload contains technical health only`() {
        val json = TvMetricSnapshot(
            startupMs = 1200,
            resumeMs = 180,
            memoryBytes = 805_306_368,
            storageFreeBytes = 2_147_483_648,
            networkState = "ethernet",
            syncRevision = 14,
            syncDurationMs = 245,
            updateState = "idle",
            silentUpdateCapable = true,
            errorCode = null,
        ).toJson()

        assertEquals("ethernet", json.getString("networkState"))
        assertEquals(14L, json.getLong("syncRevision"))
        assertEquals(2_147_483_648L, json.getLong("storageFreeBytes"))
        assertEquals(true, json.getBoolean("silentUpdateCapable"))
        assertFalse(json.has("ssid"))
        assertFalse(json.has("content"))
        assertFalse(json.has("personalDevices"))
    }
}
