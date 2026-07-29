package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject
import org.roomframe.tv.cache.RevisionAsset
import org.roomframe.tv.cache.RevisionPackage
import org.roomframe.tv.experience.CanonicalJson

class HttpExperienceSyncClient(
    private val credentials: DeviceCredentials,
    private val downloadRoot: File,
) : ExperienceSyncClient {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)

    override fun fetchAfter(activeRevisionId: String?): SyncResult {
        downloadRoot.mkdirs()
        downloadRoot.listFiles()
            .orEmpty()
            .filter { it.isFile && it.name.endsWith(".part") }
            .forEach(File::delete)
        val currentRevision = activeRevisionId
            ?.removePrefix(REVISION_PREFIX)
            ?.toLongOrNull()
            ?.takeIf { it >= 0 }
            ?: 0L
        val temporaryFiles = mutableListOf<File>()
        return try {
            val response = requestJson("/api/v1/tv/sync?revision=$currentRevision")
            if (response.optBoolean("upToDate", false)) return SyncResult.UpToDate
            val revision = response.getLong("revision")
            require(revision > currentRevision) { "Révision distante non croissante" }
            val manifest = response.getJSONObject("manifest")
            require(manifest.getLong("revision") == revision) { "Révision de manifeste incohérente" }
            val expectedManifestHash = manifest.getString("sha256")
            require(SHA256.matches(expectedManifestHash)) { "Hash de manifeste invalide" }
            val manifestBase = withoutKey(manifest, "sha256")
            val manifestBytes = CanonicalJson.encode(manifestBase)
            require(CanonicalJson.sha256(manifestBytes) == expectedManifestHash) {
                "SHA-256 du manifeste invalide"
            }

            val documents = response.getJSONObject("documents")
            val packageAssets = mutableListOf<RevisionAsset>()
            val documentEntries = manifest.getJSONArray("documents")
            repeat(documentEntries.length()) { index ->
                val descriptor = documentEntries.getJSONObject(index)
                val path = validateRelativePath(descriptor.getString("path"))
                require(path.endsWith(".json")) { "Document de synchronisation invalide" }
                val key = path.removeSuffix(".json")
                require(documents.has(key)) { "Document $path absent" }
                val bytes = CanonicalJson.encode(documents.get(key))
                val expectedSize = descriptor.getLong("size")
                val expectedHash = descriptor.getString("sha256")
                require(bytes.size.toLong() == expectedSize) { "Taille incorrecte pour $path" }
                require(CanonicalJson.sha256(bytes) == expectedHash) { "SHA-256 incorrect pour $path" }
                packageAssets += RevisionAsset.fromBytes(path, bytes, expectedHash)
            }

            val assetEntries = manifest.getJSONArray("assets")
            require(assetEntries.length() <= 1_000) { "Trop d'assets à synchroniser" }
            repeat(assetEntries.length()) { index ->
                val descriptor = assetEntries.getJSONObject(index)
                val path = validateRelativePath(descriptor.getString("path"))
                val expectedSize = descriptor.getLong("size")
                val expectedHash = descriptor.getString("sha256")
                require(expectedSize in 1..MAX_ASSET_BYTES) { "Taille média invalide" }
                require(SHA256.matches(expectedHash)) { "Hash média invalide" }
                val temporary = File.createTempFile("asset-", ".part", downloadRoot)
                temporaryFiles += temporary
                downloadAsset(
                    relativeUrl = descriptor.getString("url"),
                    target = temporary,
                    expectedSize = expectedSize,
                    expectedHash = expectedHash,
                )
                packageAssets += RevisionAsset.fromFile(
                    relativePath = path,
                    sourceFile = temporary,
                    sha256 = expectedHash,
                    size = expectedSize,
                    deleteSourceAfterUse = true,
                )
            }

            SyncResult.RevisionAvailable(
                RevisionPackage(
                    revisionId = "$REVISION_PREFIX$revision",
                    manifestBytes = manifestBytes,
                    manifestSha256 = expectedManifestHash,
                    assets = packageAssets,
                ),
            )
        } catch (error: Exception) {
            temporaryFiles.forEach(File::delete)
            SyncResult.Failed(error.message?.take(160) ?: "Synchronisation impossible")
        }
    }

    private fun requestJson(path: String): JSONObject {
        val connection = open(path)
        try {
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("HTTP $status")
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") { "Type de réponse inattendu" }
            val bytes = connection.inputStream.use { readBounded(it, MAX_JSON_BYTES) }
            return JSONObject(bytes.toString(StandardCharsets.UTF_8))
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadAsset(
        relativeUrl: String,
        target: File,
        expectedSize: Long,
        expectedHash: String,
    ) {
        require(relativeUrl.startsWith("/api/v1/") && !relativeUrl.contains("..")) {
            "URL média invalide"
        }
        val connection = open(relativeUrl)
        try {
            connection.setRequestProperty("Accept", "application/octet-stream,image/*,video/*")
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("Téléchargement média HTTP $status")
            }
            connection.contentLengthLong.takeIf { it >= 0 }?.let {
                require(it == expectedSize) { "Taille HTTP média incorrecte" }
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            connection.inputStream.use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= expectedSize) { "Média plus grand que le manifeste" }
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                    output.fd.sync()
                }
            }
            require(total == expectedSize) { "Taille média incorrecte" }
            require(digest.digest().hex() == expectedHash) { "SHA-256 média incorrect" }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(path: String): HttpsURLConnection {
        val base = URI(serverUrl)
        val resolved = base.resolve(path)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine de synchronisation invalide" }
        return RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "GET"
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
    }

    private fun readBounded(input: java.io.InputStream, maximum: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= maximum) { "Réponse JSON trop grande" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private fun withoutKey(source: JSONObject, excluded: String): JSONObject {
        val result = JSONObject()
        source.keys().forEach { key ->
            if (key != excluded) result.put(key, source.get(key))
        }
        return result
    }

    private fun validateRelativePath(value: String): String = value.also {
        require(
            it.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")) &&
                !it.startsWith("/") &&
                !it.contains("..") &&
                !it.contains('\\'),
        ) { "Chemin de synchronisation invalide" }
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        const val REVISION_PREFIX = "sync-"
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 30_000
        const val MAX_JSON_BYTES = 12 * 1024 * 1024
        const val MAX_ASSET_BYTES = 2L * 1024 * 1024 * 1024
        val SHA256 = Regex("^[a-f0-9]{64}$")
    }
}
