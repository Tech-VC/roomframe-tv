package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.roomframe.tv.adapters.AdapterResult

class SourceActivationPresentationTest {
    @Test
    fun `cast success or pending opens the waiting screen`() {
        assertEquals(
            SourceActivationEffect.ShowCastWaiting,
            sourceActivationEffect("cast", AdapterResult.Success),
        )
        assertEquals(
            SourceActivationEffect.ShowCastWaiting,
            sourceActivationEffect("cast", AdapterResult.Pending("Démarrage")),
        )
    }

    @Test
    fun `cast failures remain short messages`() {
        assertEquals(
            SourceActivationEffect.ShowMessage("Récepteur absent"),
            sourceActivationEffect("cast", AdapterResult.Unavailable("Récepteur absent")),
        )
        assertEquals(
            SourceActivationEffect.ShowMessage("Démarrage impossible"),
            sourceActivationEffect("cast", AdapterResult.Failure("Démarrage impossible")),
        )
    }

    @Test
    fun `other sources preserve their existing presentation`() {
        assertEquals(
            SourceActivationEffect.None,
            sourceActivationEffect("hdmi", AdapterResult.Success),
        )
        assertEquals(
            SourceActivationEffect.ShowMessage("En cours"),
            sourceActivationEffect("airplay", AdapterResult.Pending("En cours")),
        )
        assertEquals(
            SourceActivationEffect.ShowMessage("Source non prise en charge"),
            sourceActivationEffect("unknown", null),
        )
    }
}
