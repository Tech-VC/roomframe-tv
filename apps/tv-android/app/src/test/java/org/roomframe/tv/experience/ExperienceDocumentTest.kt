package org.roomframe.tv.experience

import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ExperienceDocumentTest {
    @Test
    fun `canonical JSON sorts every object key`() {
        val value = JSONObject()
            .put("z", 1)
            .put("a", JSONObject().put("d", true).put("b", JSONArray().put(2).put(1)))
        assertEquals("""{"a":{"b":[2,1],"d":true},"z":1}""", CanonicalJson.stringify(value))
    }

    @Test
    fun `scene parser keeps bounded blur and one logical canvas`() {
        val scene = ExperienceDocumentParser.parseScene(sceneBytes(blur = 18.0))
        assertEquals(18f, scene.background.blur)
        assertEquals("Bonjour, bienvenue", scene.nodes.single().properties.text)
    }

    @Test
    fun `scene parser rejects path traversal in media references`() {
        assertThrows(IllegalArgumentException::class.java) {
            ExperienceDocumentParser.parseScene(sceneBytes(asset = "../private"))
        }
    }

    @Test
    fun `branding parser keeps the global palette`() {
        val branding = ExperienceDocumentParser.parseBranding(
            """{
              "schemaVersion":1,
              "displayName":"Salle Nord",
              "primary":"#123456",
              "accent":"#abcdef",
              "surface":"#f0f0f0",
              "ink":"#101010",
              "muted":"#777777",
              "fontPreset":"humanist"
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )
        assertEquals("Salle Nord", branding.displayName)
        assertEquals("#abcdef", branding.accent)
        assertEquals("humanist", branding.fontPreset)
    }

    private fun sceneBytes(blur: Double = 0.0, asset: String = "assets/background.webp"): ByteArray =
        JSONObject()
            .put("schemaVersion", 2)
            .put("layoutId", "00000000-0000-4000-8000-000000000100")
            .put("name", "Accueil")
            .put(
                "canvas",
                JSONObject()
                    .put("width", 1920)
                    .put("height", 1080)
                    .put("renderTarget", "1080p")
                    .put(
                        "background",
                        JSONObject()
                            .put("type", "image")
                            .put("asset", asset)
                            .put("mode", "cover")
                            .put("focusX", 0.5)
                            .put("focusY", 0.5)
                            .put("blur", blur),
                    ),
            )
            .put(
                "nodes",
                JSONArray().put(
                    JSONObject()
                        .put("id", "greeting")
                        .put("kind", "text")
                        .put("x", 90)
                        .put("y", 170)
                        .put("width", 1000)
                        .put("height", 220)
                        .put("zIndex", 20)
                        .put("focusOrder", 0)
                        .put(
                            "props",
                            JSONObject()
                                .put("role", "greeting")
                                .put("text", "Bonjour, bienvenue")
                                .put("fontScale", 1)
                                .put("maxLines", 1),
                        ),
                ),
            )
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
}
