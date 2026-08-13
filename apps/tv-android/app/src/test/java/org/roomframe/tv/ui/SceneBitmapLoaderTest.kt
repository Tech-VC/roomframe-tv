package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SceneBitmapLoaderTest {
    @Test
    fun `large scene image is sampled near its rendered size`() {
        assertEquals(2, sampledBitmapFactor(3840, 2160, 1920, 1080))
        assertEquals(4, sampledBitmapFactor(4096, 4096, 640, 640))
    }

    @Test
    fun `small image is never enlarged by the decoder`() {
        assertEquals(1, sampledBitmapFactor(640, 360, 1920, 1080))
        assertEquals(1, sampledBitmapFactor(0, 0, 1920, 1080))
    }
}
