package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TvSafeAreaTest {
    @Test
    fun `reserve une zone sure sur la surface Philips logique`() {
        assertEquals(
            1280,
            TvSafeArea.contentWidthPx(displayWidthPx = 1920, density = 2f),
        )
    }

    @Test
    fun `reste dans la surface sur un affichage plus etroit`() {
        val width = TvSafeArea.contentWidthPx(displayWidthPx = 960, density = 2f)

        assertTrue(width in 1..960)
        assertEquals(672, width)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `refuse une geometrie invalide`() {
        TvSafeArea.contentWidthPx(displayWidthPx = 0, density = 2f)
    }
}
