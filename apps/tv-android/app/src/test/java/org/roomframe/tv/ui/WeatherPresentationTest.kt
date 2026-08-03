package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class WeatherPresentationTest {
    @Test
    fun postcodeIsRemovedOnlyFromTheDisplayedLocation() {
        assertEquals("Ville Exemple", weatherDisplayLocation("Ville Exemple 12345"))
        assertEquals("Paris 15e", weatherDisplayLocation("Paris 15e"))
    }

    @Test
    fun weatherCodesUseReadableSymbols() {
        assertEquals("☀️", weatherIconForCode(0))
        assertEquals("⛅️", weatherIconForCode(2))
        assertEquals("🌧️", weatherIconForCode(63))
        assertEquals("⛈️", weatherIconForCode(95))
    }

    @Test
    fun clockUsesTheRequestedFrenchDateAndTimeShape() {
        assertEquals("d MMMM - HH'h'mm", clockPattern(showDate = true, format = "24h"))
        assertEquals("HH'h'mm", clockPattern(showDate = false, format = "24h"))
    }
}
