package org.roomframe.tv.experience

import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject

private const val MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
private const val CANVAS_WIDTH = 1920
private const val CANVAS_HEIGHT = 1080
private val SAFE_NODE_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
private val SAFE_ASSET_REFERENCE = Regex("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,599}$")
private val SAFE_PACKAGE_NAME = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")

enum class NodeKind(val wireName: String) {
    TEXT("text"),
    CLOCK("clock"),
    WEATHER("weather"),
    MESSAGE("message"),
    IMAGE("image"),
    VIDEO("video"),
    LOGO("logo"),
    SOURCE("source"),
    APP("app"),
    NETWORK("network");

    companion object {
        fun fromWireName(value: String): NodeKind =
            entries.firstOrNull { it.wireName == value }
                ?: throw IllegalArgumentException("Type de composant inconnu")
    }
}

data class BackgroundDocument(
    val type: String,
    val asset: String?,
    val color: String,
    val mode: String,
    val focusX: Float,
    val focusY: Float,
    val blur: Float,
)

data class NodeProperties(
    val role: String?,
    val text: String?,
    val label: String?,
    val value: String?,
    val title: String?,
    val location: String?,
    val locationKey: String?,
    val source: String?,
    val asset: String?,
    val assetId: String?,
    val fit: String,
    val packageName: String?,
    val feed: String?,
    val maximumItems: Int,
    val fontScale: Float,
    val maxLines: Int,
    val showDate: Boolean,
    val format: String,
)

data class SceneNodeDocument(
    val id: String,
    val kind: NodeKind,
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
    val zIndex: Int,
    val focusOrder: Int,
    val hidden: Boolean,
    val properties: NodeProperties,
)

data class SceneDocument(
    val layoutId: String,
    val name: String,
    val background: BackgroundDocument,
    val nodes: List<SceneNodeDocument>,
)

data class BrandingDocument(
    val displayName: String = "RoomFrame",
    val primary: String = "#151511",
    val accent: String = "#ff4f1f",
    val surface: String = "#e7e4da",
    val ink: String = "#11130f",
    val muted: String = "#62645d",
    val fontPreset: String = "studio",
    val logoAssetId: String? = null,
)

data class MessageDocument(
    val id: String,
    val title: String,
    val body: String,
    val priority: Int,
)

data class WeatherReadingDocument(
    val key: String,
    val location: String,
    val status: String,
    val temperatureUnit: String,
    val temperature: Float?,
    val weatherCode: Int?,
    val condition: String?,
)

data class WeatherDocument(
    val readings: Map<String, WeatherReadingDocument> = emptyMap(),
    val attributionLabel: String = "Données météo : Open-Meteo",
    val attributionUrl: String = "https://open-meteo.com/",
)

object ExperienceDocumentParser {
    fun parseScene(bytes: ByteArray): SceneDocument {
        val root = parseObject(bytes, "scene")
        require(root.getInt("schemaVersion") == 2) { "Version de scène non supportée" }
        val canvas = root.getJSONObject("canvas")
        require(canvas.getInt("width") == CANVAS_WIDTH && canvas.getInt("height") == CANVAS_HEIGHT) {
            "Dimensions de scène invalides"
        }
        require(canvas.getString("renderTarget") in setOf("1080p", "native")) {
            "Cible de rendu invalide"
        }
        val background = parseBackground(canvas.getJSONObject("background"))
        val rawNodes = root.getJSONArray("nodes")
        require(rawNodes.length() <= 200) { "Trop de composants dans la scène" }
        val ids = mutableSetOf<String>()
        val nodes = buildList {
            repeat(rawNodes.length()) { index ->
                val node = parseNode(rawNodes.getJSONObject(index))
                require(ids.add(node.id)) { "Identifiant de composant dupliqué" }
                add(node)
            }
        }
        return SceneDocument(
            layoutId = boundedText(root.getString("layoutId"), 80, singleLine = true),
            name = boundedText(root.optString("name", "Accueil"), 120, singleLine = true),
            background = background,
            nodes = nodes,
        )
    }

    fun parseBranding(bytes: ByteArray?): BrandingDocument {
        if (bytes == null) return BrandingDocument()
        val root = parseObject(bytes, "branding")
        require(root.optInt("schemaVersion", 1) == 1) { "Version de charte non supportée" }
        val fontPreset = root.optString("fontPreset", "studio")
        require(fontPreset in setOf("studio", "compact", "humanist")) {
            "Style typographique invalide"
        }
        return BrandingDocument(
            displayName = boundedText(root.optString("displayName", "RoomFrame"), 120, singleLine = true),
            primary = color(root.optString("primary", "#151511"), "#151511"),
            accent = color(root.optString("accent", "#ff4f1f"), "#ff4f1f"),
            surface = color(root.optString("surface", "#e7e4da"), "#e7e4da"),
            ink = color(root.optString("ink", "#11130f"), "#11130f"),
            muted = color(root.optString("muted", "#62645d"), "#62645d"),
            fontPreset = fontPreset,
            logoAssetId = optionalAsset(root.optNullableString("logoAssetId")),
        )
    }

    fun parseMessages(bytes: ByteArray?): List<MessageDocument> {
        if (bytes == null) return emptyList()
        val root = parseObject(bytes, "messages")
        val items = when {
            root.has("items") -> root.getJSONArray("items")
            root.has("feeds") -> root.getJSONObject("feeds").optJSONArray("default") ?: JSONArray()
            else -> JSONArray()
        }
        require(items.length() <= 500) { "Trop de messages" }
        return buildList {
            repeat(items.length()) { index ->
                val item = items.getJSONObject(index)
                add(
                    MessageDocument(
                        id = boundedText(item.optString("id", "message-$index"), 128, singleLine = true),
                        title = boundedText(item.getString("title"), 200, singleLine = true),
                        body = boundedText(item.optString("body", ""), 2_000, singleLine = false),
                        priority = item.optInt("priority", 0).coerceIn(-100, 100),
                    ),
                )
            }
        }.sortedByDescending(MessageDocument::priority)
    }

    fun parseWeather(bytes: ByteArray?): WeatherDocument {
        if (bytes == null) return WeatherDocument()
        val root = parseObject(bytes, "weather")
        require(root.getInt("schemaVersion") == 1) { "Version météo non supportée" }
        require(root.getString("provider") == "open-meteo") { "Fournisseur météo non supporté" }
        val attribution = root.getJSONObject("attribution")
        val label = boundedText(attribution.getString("label"), 100, singleLine = true)
        val url = boundedText(attribution.getString("url"), 200, singleLine = true)
        require(url == "https://open-meteo.com/") { "Attribution météo invalide" }
        val rawItems = root.getJSONArray("items")
        require(rawItems.length() <= 50) { "Trop de lieux météo" }
        val readings = buildMap {
            repeat(rawItems.length()) { index ->
                val item = rawItems.getJSONObject(index)
                val key = item.getString("key")
                require(Regex("^[a-f0-9]{64}$").matches(key)) { "Clé météo invalide" }
                val status = item.getString("status")
                require(status in setOf("ready", "stale", "unavailable")) { "État météo invalide" }
                val unit = item.getString("temperatureUnit")
                require(unit in setOf("°C", "°F")) { "Unité météo invalide" }
                val temperature = if (item.isNull("temperature")) null else {
                    finiteFloat(item.getDouble("temperature"), -150f, 160f, "temperature")
                }
                put(
                    key,
                    WeatherReadingDocument(
                        key = key,
                        location = boundedText(item.getString("location"), 200, singleLine = true),
                        status = status,
                        temperatureUnit = unit,
                        temperature = temperature,
                        weatherCode = if (item.isNull("weatherCode")) null else {
                            item.getInt("weatherCode").also {
                                require(it in 0..99) { "Code météo invalide" }
                            }
                        },
                        condition = if (item.isNull("condition")) null else {
                            boundedText(item.getString("condition"), 100, singleLine = true)
                        },
                    ),
                )
            }
        }
        return WeatherDocument(
            readings = readings,
            attributionLabel = label,
            attributionUrl = url,
        )
    }

    private fun parseBackground(raw: JSONObject): BackgroundDocument {
        val type = raw.getString("type")
        require(type in setOf("color", "image", "video")) { "Type de fond invalide" }
        val mode = raw.getString("mode")
        require(mode in setOf("cover", "contain", "focus")) { "Mode de fond invalide" }
        return BackgroundDocument(
            type = type,
            asset = optionalAsset(raw.optNullableString("asset")),
            color = color(raw.optString("color", "#132323"), "#132323"),
            mode = mode,
            focusX = finiteFloat(raw.optDouble("focusX", 0.5), 0f, 1f, "focusX"),
            focusY = finiteFloat(raw.optDouble("focusY", 0.5), 0f, 1f, "focusY"),
            blur = finiteFloat(raw.optDouble("blur", 0.0), 0f, 40f, "blur"),
        )
    }

    private fun parseNode(raw: JSONObject): SceneNodeDocument {
        val id = raw.getString("id")
        require(SAFE_NODE_ID.matches(id)) { "Identifiant de composant invalide" }
        val props = raw.getJSONObject("props")
        require((props.names()?.length() ?: 0) <= 40) { "Trop de propriétés de composant" }
        val packageName = props.optNullableString("packageName")?.also {
            require(SAFE_PACKAGE_NAME.matches(it)) { "Nom de package Android invalide" }
        }
        return SceneNodeDocument(
            id = id,
            kind = NodeKind.fromWireName(raw.getString("kind")),
            x = finiteFloat(raw.getDouble("x"), 0f, CANVAS_WIDTH.toFloat(), "x"),
            y = finiteFloat(raw.getDouble("y"), 0f, CANVAS_HEIGHT.toFloat(), "y"),
            width = finiteFloat(raw.getDouble("width"), 0.01f, CANVAS_WIDTH.toFloat(), "width"),
            height = finiteFloat(raw.getDouble("height"), 0.01f, CANVAS_HEIGHT.toFloat(), "height"),
            zIndex = raw.getInt("zIndex").also { require(it in 0..10_000) { "Calque invalide" } },
            focusOrder = raw.optInt("focusOrder", 0).also {
                require(it in 0..10_000) { "Ordre de focus invalide" }
            },
            hidden = raw.optBoolean("hidden", false),
            properties = NodeProperties(
                role = props.optNullableString("role")?.let { boundedText(it, 64, true) },
                text = props.optNullableString("text")?.let { boundedText(it, 2_000, false) },
                label = props.optNullableString("label")?.let { boundedText(it, 200, true) },
                value = props.optNullableString("value")?.let { boundedText(it, 500, false) },
                title = props.optNullableString("title")?.let { boundedText(it, 200, true) },
                location = props.optNullableString("location")?.let { boundedText(it, 200, true) },
                locationKey = props.optNullableString("locationKey")?.also {
                    require(Regex("^[a-f0-9]{64}$").matches(it)) { "Clé météo invalide" }
                },
                source = props.optNullableString("source")?.let { boundedText(it, 64, true) },
                asset = optionalAsset(props.optNullableString("asset")),
                assetId = optionalAsset(props.optNullableString("assetId")),
                fit = props.optString("fit", "contain").also {
                    require(it in setOf("cover", "contain", "focus")) { "Mode média invalide" }
                },
                packageName = packageName,
                feed = props.optNullableString("feed")?.let { boundedText(it, 64, true) },
                maximumItems = props.optInt("maximumItems", 3).coerceIn(1, 20),
                fontScale = finiteFloat(props.optDouble("fontScale", 1.0), 0.25f, 4f, "fontScale"),
                maxLines = props.optInt("maxLines", if (props.optString("role") == "greeting") 2 else 10)
                    .coerceIn(1, 20),
                showDate = props.optBoolean("showDate", false),
                format = props.optString("format", "24h").takeIf { it in setOf("12h", "24h") } ?: "24h",
            ),
        )
    }

    private fun parseObject(bytes: ByteArray, label: String): JSONObject {
        require(bytes.isNotEmpty() && bytes.size <= MAX_DOCUMENT_BYTES) {
            "Taille du document $label invalide"
        }
        return JSONObject(bytes.toString(StandardCharsets.UTF_8))
    }

    private fun boundedText(value: String, maximum: Int, singleLine: Boolean): String {
        val cleaned = value
            .replace(Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]"), "")
            .let { if (singleLine) it.replace(Regex("\\s+"), " ") else it }
            .trim()
        require(cleaned.length <= maximum) { "Texte trop long" }
        return cleaned
    }

    private fun finiteFloat(value: Double, minimum: Float, maximum: Float, label: String): Float {
        require(value.isFinite() && value >= minimum && value <= maximum) { "Valeur $label invalide" }
        return value.toFloat()
    }

    private fun color(value: String, fallback: String): String =
        value.takeIf(HEX_COLOR::matches) ?: fallback

    private fun optionalAsset(value: String?): String? = value
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.also {
            require(
                SAFE_ASSET_REFERENCE.matches(it) &&
                    !it.startsWith("/") &&
                    !it.contains("..") &&
                    !it.contains("://"),
            ) { "Référence média invalide" }
        }

    private fun JSONObject.optNullableString(name: String): String? =
        if (!has(name) || isNull(name)) null else getString(name)
}
