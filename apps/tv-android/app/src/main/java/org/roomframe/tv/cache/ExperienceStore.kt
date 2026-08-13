package org.roomframe.tv.cache

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

data class RevisionAsset(
    val relativePath: String,
    val sha256: String,
    val size: Long,
    val bytes: ByteArray? = null,
    val sourceFile: File? = null,
    val deleteSourceAfterUse: Boolean = false,
) {
    init {
        require((bytes != null) xor (sourceFile != null)) { "Une seule source d'asset est requise" }
        require(size >= 0) { "Taille d'asset invalide" }
        if (bytes != null) require(bytes.size.toLong() == size) { "Taille d'asset incohérente" }
    }

    fun openStream(): InputStream = bytes?.inputStream() ?: FileInputStream(requireNotNull(sourceFile))

    fun cleanup() {
        if (deleteSourceAfterUse) sourceFile?.delete()
    }

    companion object {
        fun fromBytes(relativePath: String, bytes: ByteArray, sha256: String): RevisionAsset =
            RevisionAsset(
                relativePath = relativePath,
                sha256 = sha256,
                size = bytes.size.toLong(),
                bytes = bytes,
            )

        fun fromFile(
            relativePath: String,
            sourceFile: File,
            sha256: String,
            size: Long,
            deleteSourceAfterUse: Boolean = true,
        ): RevisionAsset = RevisionAsset(
            relativePath = relativePath,
            sha256 = sha256,
            size = size,
            sourceFile = sourceFile,
            deleteSourceAfterUse = deleteSourceAfterUse,
        )
    }
}

data class RevisionPackage(
    val revisionId: String,
    val manifestBytes: ByteArray,
    val manifestSha256: String,
    val assets: List<RevisionAsset>,
) {
    fun cleanupTemporaryAssets() = assets.forEach(RevisionAsset::cleanup)
}

data class ActiveRevision(
    val revisionId: String,
    val directory: File,
)

interface ExperienceStore {
    fun loadActive(): ActiveRevision?
    fun loadPreviouslyVerifiedActive(): ActiveRevision? = null
    fun stageAndActivate(revision: RevisionPackage): ActiveRevision
}

/**
 * Stockage local atomique :
 * - écrit et vérifie entièrement `<revision>.staging`;
 * - renomme la révision validée;
 * - remplace atomiquement le pointeur `active`;
 * - conserve le pointeur `previous`.
 */
class FileExperienceStore(
    private val root: File,
) : ExperienceStore {
    private val revisions = File(root, "revisions")
    private val activePointer = File(root, "active")
    private val previousPointer = File(root, "previous")

    @Synchronized
    override fun loadActive(): ActiveRevision? {
        loadPointer(activePointer)?.let { revisionId ->
            val directory = File(revisions, revisionId)
            if (verifyRevisionDirectory(directory)) {
                writeVerificationReceipt(directory, revisionId)
                return ActiveRevision(revisionId, directory)
            }
            deleteVerificationReceipt(directory)
        }
        loadPointer(previousPointer)?.let { revisionId ->
            val directory = File(revisions, revisionId)
            if (verifyRevisionDirectory(directory)) {
                writeVerificationReceipt(directory, revisionId)
                writePointer(activePointer, revisionId)
                return ActiveRevision(revisionId, directory)
            }
            deleteVerificationReceipt(directory)
        }
        return null
    }

    /**
     * Retourne uniquement une révision qui a déjà passé la vérification SHA-256
     * complète. Cette lecture courte sert au premier rendu ; `loadActive()` est
     * tout de même relancé en arrière-plan à chaque démarrage.
     */
    @Synchronized
    override fun loadPreviouslyVerifiedActive(): ActiveRevision? {
        val revisionId = loadPointer(activePointer) ?: return null
        val directory = File(revisions, revisionId)
        if (!safeRevisionDirectory(directory)) return null
        val receipt = File(directory, VERIFICATION_RECEIPT_NAME)
        val manifestHash = File(directory, "manifest.sha256")
            .takeIf { it.isFile && it.length() in 64..66 }
            ?.readText(StandardCharsets.UTF_8)
            ?.trim()
            ?: return null
        val expectedReceipt = verificationReceipt(revisionId, manifestHash)
        val storedReceipt = receipt
            .takeIf { it.isFile && it.length() in 1..MAX_VERIFICATION_RECEIPT_BYTES }
            ?.readText(StandardCharsets.UTF_8)
            ?.trim()
            ?: return null
        return ActiveRevision(revisionId, directory).takeIf { storedReceipt == expectedReceipt }
    }

    @Synchronized
    override fun stageAndActivate(revision: RevisionPackage): ActiveRevision =
        try {
            stageVerifiedRevision(revision)
        } finally {
            revision.cleanupTemporaryAssets()
        }

    private fun stageVerifiedRevision(revision: RevisionPackage): ActiveRevision {
        require(isSafeRevisionId(revision.revisionId)) { "Identifiant de révision invalide" }
        verifyHash(revision.manifestBytes, revision.manifestSha256, "manifest")
        revisions.mkdirs()

        val staging = File(revisions, "${revision.revisionId}.staging")
        if (staging.exists()) {
            require(staging.canonicalFile.parentFile == revisions.canonicalFile) { "Staging invalide" }
            check(staging.deleteRecursively()) { "Impossible de nettoyer le staging incomplet" }
        }
        val finalDirectory = File(revisions, revision.revisionId)
        if (finalDirectory.exists()) {
            check(verifyRevisionDirectory(finalDirectory)) { "Révision existante invalide" }
            writeVerificationReceipt(finalDirectory, revision.revisionId)
            activate(finalDirectory.name)
            pruneRevisions()
            return ActiveRevision(revision.revisionId, finalDirectory)
        }
        check(staging.mkdirs()) { "Impossible de créer le staging" }

        try {
            writeDurable(File(staging, "manifest.json"), revision.manifestBytes)
            writeDurable(
                File(staging, "manifest.sha256"),
                "${revision.manifestSha256}\n".toByteArray(StandardCharsets.UTF_8),
            )
            revision.assets.forEach { asset ->
                val target = safeAssetTarget(staging, asset.relativePath)
                target.parentFile?.mkdirs()
                writeAssetDurable(target, asset)
            }
            check(verifyRevisionDirectory(staging)) { "Révision staging invalide" }
            writeVerificationReceipt(staging, revision.revisionId)

            Files.move(staging.toPath(), finalDirectory.toPath(), StandardCopyOption.ATOMIC_MOVE)
            activate(revision.revisionId)
            pruneRevisions()
            return ActiveRevision(revision.revisionId, finalDirectory)
        } catch (error: Throwable) {
            staging.deleteRecursively()
            throw error
        }
    }

    private fun activate(revisionId: String) {
        val previousId = loadPointer(activePointer)
        if (previousId != null && previousId != revisionId) writePointer(previousPointer, previousId)
        writePointer(activePointer, revisionId)
    }

    private fun pruneRevisions() {
        val keep = setOfNotNull(loadPointer(activePointer), loadPointer(previousPointer))
        val canonicalRoot = revisions.canonicalFile
        revisions.listFiles().orEmpty().forEach { candidate ->
            if (candidate.name in keep) return@forEach
            if (Files.isSymbolicLink(candidate.toPath())) {
                candidate.delete()
            } else if (candidate.canonicalFile.parentFile == canonicalRoot) {
                candidate.deleteRecursively()
            }
        }
    }

    private fun safeAssetTarget(base: File, relativePath: String): File {
        require(relativePath.isNotBlank() && !relativePath.startsWith("/") && !relativePath.contains("..")) {
            "Chemin d'asset invalide"
        }
        val target = File(base, relativePath).canonicalFile
        require(target.path.startsWith("${base.canonicalPath}${File.separator}")) { "Chemin d'asset hors staging" }
        return target
    }

    private fun writePointer(target: File, revisionId: String) {
        val temporary = File(root, "${target.name}.tmp")
        root.mkdirs()
        writeDurable(temporary, "$revisionId\n".toByteArray(StandardCharsets.UTF_8))
        Files.move(
            temporary.toPath(),
            target.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
    }

    private fun writeDurable(target: File, bytes: ByteArray) {
        FileOutputStream(target).use { stream ->
            stream.write(bytes)
            stream.fd.sync()
        }
    }

    private fun writeAssetDurable(target: File, asset: RevisionAsset) {
        val digest = MessageDigest.getInstance("SHA-256")
        var written = 0L
        asset.openStream().use { input ->
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    written += read
                    require(written <= asset.size) { "Asset plus grand que prévu : ${asset.relativePath}" }
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                output.fd.sync()
            }
        }
        require(written == asset.size) { "Taille incorrecte pour ${asset.relativePath}" }
        require(digest.digest().hex() == asset.sha256) { "SHA-256 incorrect pour ${asset.relativePath}" }
    }

    private fun writeVerificationReceipt(directory: File, revisionId: String) {
        if (!safeRevisionDirectory(directory)) return
        val manifestHash = File(directory, "manifest.sha256")
            .takeIf { it.isFile && it.length() in 64..66 }
            ?.readText(StandardCharsets.UTF_8)
            ?.trim()
            ?.takeIf { it.matches(Regex("^[a-f0-9]{64}$")) }
            ?: return
        val receiptText = verificationReceipt(revisionId, manifestHash)
        val receiptFile = File(directory, VERIFICATION_RECEIPT_NAME)
        if (
            receiptFile.isFile &&
            receiptFile.length() in 1..MAX_VERIFICATION_RECEIPT_BYTES &&
            receiptFile.readText(StandardCharsets.UTF_8).trim() == receiptText
        ) {
            return
        }
        writeDurable(
            receiptFile,
            "$receiptText\n".toByteArray(StandardCharsets.UTF_8),
        )
    }

    private fun deleteVerificationReceipt(directory: File) {
        if (safeRevisionDirectory(directory)) File(directory, VERIFICATION_RECEIPT_NAME).delete()
    }

    private fun verificationReceipt(revisionId: String, manifestHash: String): String =
        "roomframe-verified-v1:$revisionId:$manifestHash"

    private fun safeRevisionDirectory(directory: File): Boolean = runCatching {
        directory.isDirectory &&
            !Files.isSymbolicLink(directory.toPath()) &&
            directory.canonicalFile.parentFile == revisions.canonicalFile
    }.getOrDefault(false)

    private fun verifyHash(bytes: ByteArray, expected: String, label: String) {
        require(expected.matches(Regex("^[a-f0-9]{64}$"))) { "SHA-256 invalide pour $label" }
        val actual = MessageDigest.getInstance("SHA-256").digest(bytes).hex()
        require(actual == expected) { "SHA-256 incorrect pour $label" }
    }

    private fun verifyRevisionDirectory(directory: File): Boolean = runCatching {
        require(directory.isDirectory)
        val manifestFile = File(directory, "manifest.json")
        val hashFile = File(directory, "manifest.sha256")
        require(manifestFile.isFile && manifestFile.length() in 1..MAX_MANIFEST_BYTES)
        require(hashFile.isFile && hashFile.length() in 64..66)
        val expectedManifestHash = hashFile.readText(StandardCharsets.UTF_8).trim()
        require(expectedManifestHash.matches(Regex("^[a-f0-9]{64}$")))
        val manifestBytes = manifestFile.readBytes()
        verifyHash(manifestBytes, expectedManifestHash, "manifest")
        val manifest = JSONObject(manifestBytes.toString(StandardCharsets.UTF_8))
        verifyEntries(directory, manifest.optJSONArray("documents") ?: JSONArray())
        verifyEntries(directory, manifest.optJSONArray("assets") ?: JSONArray())
        true
    }.getOrDefault(false)

    private fun verifyEntries(directory: File, entries: JSONArray) {
        require(entries.length() <= MAX_MANIFEST_ENTRIES) { "Trop d'entrées de manifeste" }
        repeat(entries.length()) { index ->
            val entry = entries.getJSONObject(index)
            val relativePath = entry.getString("path")
            val expectedHash = entry.getString("sha256")
            val expectedSize = entry.getLong("size")
            require(expectedSize >= 0)
            val file = safeAssetTarget(directory, relativePath)
            require(file.isFile && file.length() == expectedSize) { "Asset de révision absent" }
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            require(digest.digest().hex() == expectedHash) { "Asset de révision corrompu" }
        }
    }

    private fun loadPointer(pointer: File): String? =
        pointer.takeIf(File::isFile)
            ?.readText(StandardCharsets.UTF_8)
            ?.trim()
            ?.takeIf(::isSafeRevisionId)

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    private fun isSafeRevisionId(value: String): Boolean = value.matches(Regex("^[A-Za-z0-9._-]{1,120}$"))

    private companion object {
        const val MAX_MANIFEST_BYTES = 2L * 1024 * 1024
        const val MAX_MANIFEST_ENTRIES = 1_020
        const val VERIFICATION_RECEIPT_NAME = ".roomframe-verified"
        const val MAX_VERIFICATION_RECEIPT_BYTES = 256L
    }
}
