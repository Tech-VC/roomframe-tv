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
}
