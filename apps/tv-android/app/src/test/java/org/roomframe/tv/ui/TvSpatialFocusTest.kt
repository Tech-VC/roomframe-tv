package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TvSpatialFocusTest {
    @Test
    fun `une colonne se parcourt verticalement sans ordre explicite`() {
        val targets = listOf(
            target("airplay", 90f, 420f),
            target("cast", 90f, 560f),
            target("hdmi", 90f, 700f),
        )

        assertEquals("airplay", initialSpatialFocusTargetId(targets))
        assertEquals("cast", spatialFocusNeighborId(targets, "airplay", SpatialFocusDirection.DOWN))
        assertEquals("airplay", spatialFocusNeighborId(targets, "cast", SpatialFocusDirection.UP))
        assertNull(spatialFocusNeighborId(targets, "airplay", SpatialFocusDirection.LEFT))
    }

    @Test
    fun `une grille choisit d abord le voisin aligne`() {
        val targets = listOf(
            target("top-left", 0f, 0f),
            target("top-right", 300f, 0f),
            target("bottom-left", 0f, 200f),
            target("bottom-right", 300f, 200f),
        )

        assertEquals(
            "top-right",
            spatialFocusNeighborId(targets, "top-left", SpatialFocusDirection.RIGHT),
        )
        assertEquals(
            "bottom-left",
            spatialFocusNeighborId(targets, "top-left", SpatialFocusDirection.DOWN),
        )
    }

    @Test
    fun `le plus petit ordre positif fixe le premier focus`() {
        val targets = listOf(
            target("visual-first", 0f, 0f),
            target("ordered-second", 0f, 200f, order = 2),
            target("ordered-first", 0f, 400f, order = 1),
        )

        assertEquals("ordered-first", initialSpatialFocusTargetId(targets))
    }

    @Test
    fun `le texte choisit le meilleur contraste WCAG noir ou blanc`() {
        assertEquals(0xff000000.toInt(), sceneForegroundColor(0xffffd740.toInt()))
        assertEquals(0xff000000.toInt(), sceneForegroundColor(0xff00fc00.toInt()))
        assertEquals(0xffffffff.toInt(), sceneForegroundColor(0xff102030.toInt()))
        assertEquals(0xffffffff.toInt(), sceneForegroundColor(0xff0000ff.toInt()))
    }

    private fun target(
        id: String,
        left: Float,
        top: Float,
        order: Int = 0,
    ) = SpatialFocusTarget(
        id = id,
        left = left,
        top = top,
        width = 200f,
        height = 100f,
        order = order,
    )
}
