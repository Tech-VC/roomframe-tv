package org.roomframe.tv.ui

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

class SceneContrastPolicyTest {
    @Test
    fun `background wash protects both text edges while preserving the image center`() {
        val colors = sceneBackgroundWashColors()

        assertArrayEquals(
            intArrayOf(
                0xc2020606.toInt(),
                0x6b020606,
                0x14020606,
                0x8c020606.toInt(),
            ),
            colors,
        )
        assertTrue(whiteTextContrastOverWorstCaseWhiteImage(colors.first()) >= 4.5)
        assertTrue(whiteTextContrastOverWorstCaseWhiteImage(colors.last()) >= 4.5)
        assertTrue(colors[2].ushr(24) / 255.0 < 0.1)
    }

    private fun whiteTextContrastOverWorstCaseWhiteImage(overlayColor: Int): Double {
        val alpha = overlayColor.ushr(24) / 255.0
        val compositedChannel = 1.0 - alpha
        val backgroundLuminance = if (compositedChannel <= 0.04045) {
            compositedChannel / 12.92
        } else {
            ((compositedChannel + 0.055) / 1.055).pow(2.4)
        }
        return 1.05 / (backgroundLuminance + 0.05)
    }
}
