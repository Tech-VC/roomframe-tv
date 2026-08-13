package org.roomframe.tv.adapters

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhilipsTa1ProfileTest {
    @Test
    fun `profile matches only the validated Philips TA1 platform`() {
        assertTrue(PhilipsTa1Profile.matches("TPV", "Philips", "PH1M_WW_9972"))
        assertFalse(PhilipsTa1Profile.matches("TPV", "Philips", "unknown"))
        assertFalse(PhilipsTa1Profile.matches("Other", "Philips", "PH1M_WW_9972"))
    }

    @Test
    fun `HDMI port maps to the observed hardware input`() {
        val inputs = listOf(
            "com.mediatek.tis/.HdmiInputService/HW5",
            "com.mediatek.tis/.HdmiInputService/HW2",
            "com.mediatek.tis/.HdmiInputService/HW4",
            "com.mediatek.tis/.HdmiInputService/HW3",
        )
        assertEquals("com.mediatek.tis/.HdmiInputService/HW2", PhilipsTa1Profile.hdmiInputId(inputs, 1))
        assertEquals("com.mediatek.tis/.HdmiInputService/HW5", PhilipsTa1Profile.hdmiInputId(inputs, 4))
        assertNull(PhilipsTa1Profile.hdmiInputId(inputs, 5))
    }

    @Test
    fun `source routes are captured from one input snapshot`() {
        val routes = PhilipsTa1Profile.sourceRoutes(
            listOf(
                PhilipsTa1Profile.InputDescriptor(
                    id = "airplay-input",
                    packageName = PhilipsTa1Profile.AIRPLAY_PACKAGE,
                    isHdmi = false,
                ),
                PhilipsTa1Profile.InputDescriptor(
                    id = "com.mediatek.tis/.HdmiInputService/HW2",
                    packageName = "com.mediatek.tis",
                    isHdmi = true,
                ),
                PhilipsTa1Profile.InputDescriptor(
                    id = "unrelated-input",
                    packageName = "example.receiver",
                    isHdmi = false,
                ),
            ),
            hdmiPort = 1,
        )

        assertEquals("airplay-input", routes.airPlayInputId)
        assertEquals("com.mediatek.tis/.HdmiInputService/HW2", routes.hdmiInputId)
    }

    @Test
    fun `missing source routes stay unavailable instead of faking success`() {
        val routes = PhilipsTa1Profile.sourceRoutes(emptyList(), hdmiPort = 1)

        assertNull(routes.airPlayInputId)
        assertNull(routes.hdmiInputId)
    }

    @Test
    fun `missing startup route is cached after a successful late resolution`() {
        var calls = 0
        val resolver = RateLimitedFallbackResolver<String>(
            initialValue = null,
            nowMillis = { 1_000L },
        ) {
            calls += 1
            "late-airplay-input"
        }

        assertEquals("late-airplay-input", resolver.resolve())
        assertEquals("late-airplay-input", resolver.resolve())
        assertEquals(1, calls)
    }

    @Test
    fun `failed late route lookup is rate limited then retried`() {
        var calls = 0
        var now = 1_000L
        val resolver = RateLimitedFallbackResolver(
            initialValue = null,
            retryIntervalMillis = 15_000L,
            nowMillis = { now },
        ) {
            calls += 1
            null
        }

        assertNull(resolver.resolve())
        assertNull(resolver.resolve())
        assertEquals(1, calls)
        now += 15_000L
        assertNull(resolver.resolve())
        assertEquals(2, calls)
    }

    @Test
    fun `preloaded route keeps the no lookup fast path`() {
        var calls = 0
        val resolver = RateLimitedFallbackResolver(initialValue = "ready-input") {
            calls += 1
            "unexpected-input"
        }

        assertEquals("ready-input", resolver.resolve())
        assertEquals(0, calls)
    }

    @Test
    fun `invalidated cached route is resolved again`() {
        var calls = 0
        val resolver = RateLimitedFallbackResolver(
            initialValue = "stale-input",
            nowMillis = { 1_000L },
        ) {
            calls += 1
            "fresh-input"
        }

        resolver.invalidate()

        assertEquals("fresh-input", resolver.resolve())
        assertEquals(1, calls)
    }
}
