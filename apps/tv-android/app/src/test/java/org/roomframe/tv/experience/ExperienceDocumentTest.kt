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
    fun `device identity parser keeps the configured TV name`() {
        val identity = ExperienceDocumentParser.parseDeviceIdentity(
            """{
              "schemaVersion":1,
              "displayName":"Salle de réunion 01",
              "roomName":"Salle de réunion"
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals("Salle de réunion 01", identity?.displayName)
        assertEquals("Salle de réunion", identity?.roomName)
    }

    @Test
    fun `device identity parser keeps old cached revisions compatible`() {
        assertEquals(null, ExperienceDocumentParser.parseDeviceIdentity(null))
    }

    @Test
    fun `device identity parser normalizes multiline labels`() {
        val identity = ExperienceDocumentParser.parseDeviceIdentity(
            """{
              "schemaVersion":1,
              "displayName":"Salle\ninterdite",
              "roomName":"Salle"
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals("Salle interdite", identity?.displayName)
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

    @Test
    fun `sources parser keeps the configured HDMI input`() {
        val sources = ExperienceDocumentParser.parseSources(
            """{
              "schemaVersion":1,
              "items":[{
                "source_kind":"hdmi",
                "enabled":true,
                "label":"Console de réunion",
                "configuration":{"physicalInput":"HDMI3"}
              }]
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals(true, sources.settingFor("hdmi")?.enabled)
        assertEquals("Console de réunion", sources.settingFor("hdmi")?.label)
        assertEquals("HDMI3", sources.settingFor("hdmi")?.physicalInput)
    }

    @Test
    fun `sources parser keeps the configured private application`() {
        val sources = ExperienceDocumentParser.parseSources(
            """{
              "schemaVersion":1,
              "items":[{
                "source_kind":"private-app",
                "enabled":true,
                "label":"CANAL+",
                "configuration":{"applicationId":"com.canal.android.canal"}
              }]
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals(true, sources.settingFor("private-app")?.enabled)
        assertEquals("CANAL+", sources.settingFor("private-app")?.label)
        assertEquals(
            "com.canal.android.canal",
            sources.settingFor("private-app")?.applicationId,
        )
        assertEquals(
            listOf("com.canal.android.canal"),
            sources.settingFor("private-app")?.applicationIds,
        )
    }

    @Test
    fun `sources parser keeps a bounded private application allowlist`() {
        val sources = ExperienceDocumentParser.parseSources(
            """{
              "schemaVersion":1,
              "items":[{
                "source_kind":"private-app",
                "enabled":true,
                "label":"Espace privé",
                "configuration":{
                  "applicationIds":[
                    "com.canal.android.canal",
                    "com.google.android.youtube.tv"
                  ]
                }
              }]
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals(
            listOf("com.canal.android.canal", "com.google.android.youtube.tv"),
            sources.settingFor("private-app")?.applicationIds,
        )
        assertEquals(
            "com.canal.android.canal",
            sources.settingFor("private-app")?.applicationId,
        )
    }

    @Test
    fun `sources parser rejects duplicate private application identifiers`() {
        assertThrows(IllegalArgumentException::class.java) {
            ExperienceDocumentParser.parseSources(
                """{
                  "schemaVersion":1,
                  "items":[{
                    "source_kind":"private-app",
                    "enabled":true,
                    "configuration":{
                      "applicationIds":[
                        "com.canal.android.canal",
                        "com.canal.android.canal"
                      ]
                    }
                  }]
                }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
            )
        }
    }

    @Test
    fun `sources parser rejects contradictory canonical and legacy application identifiers`() {
        assertThrows(IllegalArgumentException::class.java) {
            ExperienceDocumentParser.parseSources(
                """{
                  "schemaVersion":1,
                  "items":[{
                    "source_kind":"private-app",
                    "enabled":true,
                    "configuration":{
                      "applicationId":"com.canal.android.canal",
                      "applicationIds":["com.google.android.youtube.tv"]
                    }
                  }]
                }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
            )
        }
    }

    @Test
    fun `private access parser keeps only bounded policy values`() {
        val policy = ExperienceDocumentParser.parsePrivateAccess(
            """{
              "schemaVersion":1,
              "enabled":true,
              "pinConfigured":true,
              "generation":7,
              "maxAttempts":4,
              "lockoutSeconds":90
            }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
        )

        assertEquals(true, policy.enabled)
        assertEquals(true, policy.pinConfigured)
        assertEquals(7L, policy.generation)
        assertEquals(4, policy.maxAttempts)
        assertEquals(90, policy.lockoutSeconds)
    }

    @Test
    fun `missing private access document keeps historical caches locked off`() {
        assertEquals(PrivateAccessDocument(), ExperienceDocumentParser.parsePrivateAccess(null))
    }

    @Test
    fun `sources parser rejects an invalid private application identifier`() {
        assertThrows(IllegalArgumentException::class.java) {
            ExperienceDocumentParser.parseSources(
                """{
                  "schemaVersion":1,
                  "items":[{
                    "source_kind":"private-app",
                    "enabled":true,
                    "configuration":{"applicationId":"not a package"}
                  }]
                }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
            )
        }
    }

    @Test
    fun `sources parser rejects an unsupported physical input`() {
        assertThrows(IllegalArgumentException::class.java) {
            ExperienceDocumentParser.parseSources(
                """{
                  "schemaVersion":1,
                  "items":[{
                    "source_kind":"hdmi",
                    "enabled":true,
                    "configuration":{"physicalInput":"USB1"}
                  }]
                }""".trimIndent().toByteArray(StandardCharsets.UTF_8),
            )
        }
    }

    @Test
    fun `scene parser uses applicationId and keeps packageName as a legacy fallback`() {
        val canonical = ExperienceDocumentParser.parseScene(
            sceneBytesWithApplication("applicationId", "com.canal.android.canal"),
        )
        val legacy = ExperienceDocumentParser.parseScene(
            sceneBytesWithApplication("packageName", "com.google.android.youtube.tv"),
        )

        assertEquals("com.canal.android.canal", canonical.nodes.single().properties.applicationId)
        assertEquals("com.google.android.youtube.tv", legacy.nodes.single().properties.applicationId)
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

    private fun sceneBytesWithApplication(property: String, applicationId: String): ByteArray {
        val scene = JSONObject(String(sceneBytes(), StandardCharsets.UTF_8))
        scene.put(
            "nodes",
            JSONArray().put(
                JSONObject()
                    .put("id", "application")
                    .put("kind", "app")
                    .put("x", 90)
                    .put("y", 170)
                    .put("width", 410)
                    .put("height", 125)
                    .put("zIndex", 20)
                    .put("focusOrder", 1)
                    .put("props", JSONObject().put("label", "Application").put(property, applicationId)),
            ),
        )
        return scene.toString().toByteArray(StandardCharsets.UTF_8)
    }
}
