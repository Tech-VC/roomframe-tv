package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomFrameNsdServiceTypeTest {
    @Test
    fun `utilise le type Android sans point final pour la recherche`() {
        assertEquals("_roomframe._tcp", RoomFrameNsdServiceType.QUERY)
    }

    @Test
    fun `accepte les variantes Android avec ou sans point final`() {
        assertTrue(RoomFrameNsdServiceType.matches("_roomframe._tcp"))
        assertTrue(RoomFrameNsdServiceType.matches("_roomframe._tcp."))
    }

    @Test
    fun `normalise la casse les espaces et les points finaux`() {
        assertEquals(
            "_roomframe._tcp",
            RoomFrameNsdServiceType.normalize("  _ROOMFRAME._TCP..  "),
        )
        assertTrue(RoomFrameNsdServiceType.matches("_ROOMFRAME._TCP."))
    }

    @Test
    fun `refuse un autre service DNS-SD`() {
        assertFalse(RoomFrameNsdServiceType.matches("_roomframe._udp."))
        assertFalse(RoomFrameNsdServiceType.matches("_http._tcp"))
        assertFalse(RoomFrameNsdServiceType.matches("_roomframe._tcp.local."))
    }

    @Test
    fun `conserve la meme cle si Android change le point final`() {
        assertEquals(
            RoomFrameNsdServiceType.serviceKey("RoomFrame", "_roomframe._tcp"),
            RoomFrameNsdServiceType.serviceKey("RoomFrame", "_roomframe._tcp."),
        )
    }
}
