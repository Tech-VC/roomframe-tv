package org.roomframe.tv.experience

import android.content.Context
import java.io.File
import java.nio.charset.StandardCharsets
import org.json.JSONObject
import org.roomframe.tv.cache.ActiveRevision
import org.roomframe.tv.cache.ExperienceStore

data class ExperienceSnapshot(
    val revisionId: String,
    val scene: SceneDocument,
    val branding: BrandingDocument,
    val messages: List<MessageDocument>,
    val weather: WeatherDocument,
    val assets: ExperienceAssetIndex,
    val bundled: Boolean,
)

data class ExperienceAssetDescriptor(
    val id: String,
    val assetId: String?,
    val variant: String?,
    val path: String,
    val sha256: String,
)

class ExperienceAssetIndex internal constructor(
    private val root: File?,
    descriptors: List<ExperienceAssetDescriptor>,
) {
    private val aliases = buildMap<String, List<ExperienceAssetDescriptor>> {
        val collected = mutableMapOf<String, MutableList<ExperienceAssetDescriptor>>()
        descriptors.forEach { descriptor ->
            listOfNotNull(
                descriptor.id,
                descriptor.assetId,
                descriptor.path,
                descriptor.path.removePrefix("assets/"),
                descriptor.sha256,
            ).forEach { alias -> collected.getOrPut(alias) { mutableListOf() }.add(descriptor) }
        }
        putAll(collected)
    }

    fun resolve(reference: String?, preferredVariant: String? = null): File? {
        if (reference.isNullOrBlank() || root == null) return null
        val candidates = aliases[reference].orEmpty()
        val descriptor = candidates.firstOrNull { it.variant == preferredVariant }
            ?: candidates.maxByOrNull { variantRank(it.variant) }
            ?: ExperienceAssetDescriptor(
                id = reference,
                assetId = null,
                variant = null,
                path = reference,
                sha256 = "",
            )
        return safeExistingFile(root, descriptor.path)
    }

    private fun variantRank(value: String?): Int = when (value) {
        "logo" -> 4
        "1080p" -> 3
        "4k" -> 2
        else -> 1
    }

    private fun safeExistingFile(base: File, relativePath: String): File? {
        if (
            relativePath.isBlank() ||
            relativePath.startsWith("/") ||
            relativePath.contains("..") ||
            relativePath.contains('\\')
        ) {
            return null
        }
        val canonicalBase = base.canonicalFile
        val candidate = File(canonicalBase, relativePath).canonicalFile
        if (!candidate.path.startsWith("${canonicalBase.path}${File.separator}")) return null
        return candidate.takeIf { it.isFile && it.length() > 0 }
    }

    companion object {
        fun empty(): ExperienceAssetIndex = ExperienceAssetIndex(null, emptyList())

        fun fromRevision(directory: File, manifestBytes: ByteArray): ExperienceAssetIndex {
            val manifest = JSONObject(manifestBytes.toString(StandardCharsets.UTF_8))
            val rawAssets = manifest.optJSONArray("assets")
            val descriptors = buildList {
                if (rawAssets != null) {
                    repeat(rawAssets.length()) { index ->
                        val asset = rawAssets.getJSONObject(index)
                        add(
                            ExperienceAssetDescriptor(
                                id = asset.getString("id"),
                                assetId = asset.optString("assetId").takeIf(String::isNotBlank),
                                variant = asset.optString("variant").takeIf(String::isNotBlank),
                                path = asset.getString("path"),
                                sha256 = asset.getString("sha256"),
                            ),
                        )
                    }
                }
            }
            return ExperienceAssetIndex(directory, descriptors)
        }
    }
}

class ExperienceRepository(
    private val context: Context,
    private val store: ExperienceStore,
) {
    fun load(): ExperienceSnapshot {
        val active = store.loadActive()
        if (active != null) {
            runCatching { loadRevision(active) }.getOrNull()?.let { return it }
        }
        return loadBundled()
    }

    private fun loadRevision(active: ActiveRevision): ExperienceSnapshot {
        val sceneBytes = readBounded(File(active.directory, "scene.json"), "scene")
        val brandingFile = File(active.directory, "branding.json")
        val messagesFile = File(active.directory, "messages.json")
        val weatherFile = File(active.directory, "weather.json")
        val manifestBytes = readBounded(File(active.directory, "manifest.json"), "manifest")
        return ExperienceSnapshot(
            revisionId = active.revisionId,
            scene = ExperienceDocumentParser.parseScene(sceneBytes),
            branding = ExperienceDocumentParser.parseBranding(
                brandingFile.takeIf(File::isFile)?.let { readBounded(it, "branding") },
            ),
            messages = ExperienceDocumentParser.parseMessages(
                messagesFile.takeIf(File::isFile)?.let { readBounded(it, "messages") },
            ),
            weather = ExperienceDocumentParser.parseWeather(
                weatherFile.takeIf(File::isFile)?.let { readBounded(it, "weather") },
            ),
            assets = ExperienceAssetIndex.fromRevision(active.directory, manifestBytes),
            bundled = false,
        )
    }

    private fun loadBundled(): ExperienceSnapshot {
        val sceneBytes = context.assets.open("default-experience/layout.json").use { it.readBytes() }
        val messageBytes = context.assets.open("default-experience/content.json").use { it.readBytes() }
        return ExperienceSnapshot(
            revisionId = "bundled-default-1.0.0",
            scene = ExperienceDocumentParser.parseScene(sceneBytes),
            branding = BrandingDocument(),
            messages = ExperienceDocumentParser.parseMessages(messageBytes),
            weather = WeatherDocument(),
            assets = ExperienceAssetIndex.empty(),
            bundled = true,
        )
    }

    private fun readBounded(file: File, label: String): ByteArray {
        require(file.isFile && file.length() in 1..MAX_FILE_BYTES) { "Document $label absent ou trop grand" }
        return file.readBytes()
    }

    private companion object {
        const val MAX_FILE_BYTES = 10L * 1024 * 1024
    }
}
