package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.roomframe.tv.experience.PrivateAccessDocument
import org.roomframe.tv.experience.SourceSettingDocument
import org.roomframe.tv.experience.SourceSettingsDocument

class SourceMenuPolicyTest {
    @Test
    fun `canonical source tile opens the RoomFrame selector`() {
        assertEquals(true, shouldOpenRoomFrameSourceMenu("menu", "Sources"))
        assertEquals(true, shouldOpenRoomFrameSourceMenu("sources", null))
    }

    @Test
    fun `legacy tile labelled Sources opens RoomFrame instead of the hardware selector`() {
        assertEquals(true, shouldOpenRoomFrameSourceMenu("hdmi", "Sources"))
        assertEquals(true, shouldOpenRoomFrameSourceMenu("airplay", "  sources  "))
        assertEquals(false, shouldOpenRoomFrameSourceMenu("hdmi", "HDMI 3"))
        assertEquals(false, shouldOpenRoomFrameSourceMenu("private-app", "Sources"))
    }

    @Test
    fun `menu stays concise and orders home sources then private space`() {
        val sources = SourceSettingsDocument(
            mapOf(
                "airplay" to setting("airplay", "AirPlay"),
                "cast" to setting("cast", "Cast"),
                "hdmi" to setting("hdmi", "HDMI 3"),
                "private-app" to SourceSettingDocument(
                    kind = "private-app",
                    enabled = true,
                    label = "Espace privé",
                    physicalInput = null,
                    applicationId = "com.canal.android.canal",
                    applicationIds = listOf("com.canal.android.canal"),
                ),
            ),
        )

        assertEquals(
            listOf(
                SourceMenuAction.HOME,
                SourceMenuAction.AIRPLAY,
                SourceMenuAction.CAST,
                SourceMenuAction.HDMI,
                SourceMenuAction.PRIVATE,
            ),
            sourceMenuEntries(
                sources,
                PrivateAccessDocument(enabled = true, pinConfigured = true, generation = 2),
            ).map(SourceMenuEntry::action),
        )
    }

    @Test
    fun `private entry is absent until the PIN is configured`() {
        val sources = SourceSettingsDocument(
            mapOf("private-app" to setting("private-app", "Privé")),
        )

        assertFalse(
            sourceMenuEntries(
                sources,
                PrivateAccessDocument(enabled = true, pinConfigured = false),
            ).any { it.action == SourceMenuAction.PRIVATE },
        )
    }

    @Test
    fun `private entry stays absent when no application is configured`() {
        val sources = SourceSettingsDocument(
            mapOf("private-app" to setting("private-app", "Privé")),
        )

        assertFalse(
            sourceMenuEntries(
                sources,
                PrivateAccessDocument(enabled = true, pinConfigured = true),
            ).any { it.action == SourceMenuAction.PRIVATE },
        )
    }

    @Test
    fun `known applications use human names and manual packages stay readable`() {
        assertEquals("CANAL+", privateApplicationLabel("com.canal.android.canal"))
        assertEquals("YouTube", privateApplicationLabel("com.google.android.youtube.tv"))
        assertEquals("Player", privateApplicationLabel("org.example.player"))
    }

    @Test
    fun `private grid keeps every configured application through four scrollable rows`() {
        assertEquals(1, privateApplicationGridRows(1))
        assertEquals(2, privateApplicationGridRows(6))
        assertEquals(3, privateApplicationGridRows(7))
        assertEquals(4, privateApplicationGridRows(12))
        assertThrows(IllegalArgumentException::class.java) {
            privateApplicationGridRows(13)
        }
    }

    private fun setting(kind: String, label: String) = SourceSettingDocument(
        kind = kind,
        enabled = true,
        label = label,
        physicalInput = null,
        applicationId = null,
    )
}
