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
    fun `canonical JSON matches server escaping for URLs and paths`() {
        val value = JSONObject()
            .put("path", "/api/v1/discovery")
            .put("origin", "https://roomframe.example.local")
            .put("label", "Ligne 1\n\"Ligne 2\"")
            .put("key/with/slashes", true)
        assertEquals(
            """{"key/with/slashes":true,"label":"Ligne 1\n\"Ligne 2\"","origin":"https://roomframe.example.local","path":"/api/v1/discovery"}""",
            CanonicalJson.stringify(value),
        )
    }

    @Test
    fun `scene parser keeps bounded blur and one logical canvas`() {
        val scene = ExperienceDocumentParser.parseScene(sceneBytes(blur = 18.0))
        assertEquals(18f, scene.background.blur)
        assertEquals("Bonjour,\nBienvenue", scene.nodes.single().properties.text)
        assertEquals(2, scene.nodes.single().properties.maxLines)
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

    @Test
    fun `weather parser keeps cached data and attribution`() {
        val weather = ExperienceDocumentParser.parseWeather(
            """{
              "schemaVersion":1,
              "provider":"open-meteo",
              "attribution":{"label":"Données météo : Open-Meteo","url":"https://open-meteo.com/"},
              "items":[{
                "key":"${"a".repeat(64)}",
                "location":"Ville Exemple 12345",
                "timezone":"Europe/Paris",
                "units":"metric",
                "status":"ready",
                "temperatureUnit":"°C",
                "temperature":21.4,
                "apparentTemperature":21.0,
                "weatherCode":2,
                "condition":"Éclaircies",
                "isDay":true,
                "observedAt":"2026-08-03T12:00:00.000Z",
                "fetchedAt":"2026-08-03T12:01:00.000Z",
                "errorCode":null
              }]
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )
        assertEquals("Ville Exemple 12345", weather.readings.values.single().location)
        assertEquals(21.4f, weather.readings.values.single().temperature)
        assertEquals(2, weather.readings.values.single().weatherCode)
        assertEquals("Données météo : Open-Meteo", weather.attributionLabel)
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
                                .put("text", "Bonjour,\nBienvenue")
                                .put("fontScale", 1)
                                .put("maxLines", 2),
                        ),
                ),
            )
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
}
