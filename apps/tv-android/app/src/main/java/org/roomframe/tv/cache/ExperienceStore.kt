package org.roomframe.tv.cache

import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

data class RevisionAsset(
    val relativePath: String,
    val bytes: ByteArray,
    val sha256: String,
)

data class RevisionPackage(
    val revisionId: String,
    val manifestBytes: ByteArray,
    val manifestSha256: String,
    val assets: List<RevisionAsset>,
)

data class ActiveRevision(
    val revisionId: String,
    val directory: File,
)

interface ExperienceStore {
    fun loadActive(): ActiveRevision?
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

    override fun loadActive(): ActiveRevision? {
        val revisionId = activePointer.takeIf(File::isFile)?.readText(StandardCharsets.UTF_8)?.trim()
            ?.takeIf(::isSafeRevisionId) ?: return null
        val directory = File(revisions, revisionId)
        return directory.takeIf(File::isDirectory)?.let { ActiveRevision(revisionId, it) }
    }

    @Synchronized
    override fun stageAndActivate(revision: RevisionPackage): ActiveRevision {
        require(isSafeRevisionId(revision.revisionId)) { "Identifiant de révision invalide" }
        verifyHash(revision.manifestBytes, revision.manifestSha256, "manifest")
        revisions.mkdirs()

        val staging = File(revisions, "${revision.revisionId}.staging")
        check(!staging.exists()) { "Un staging existe déjà pour cette révision" }
        check(!File(revisions, revision.revisionId).exists()) { "Cette révision existe déjà" }
        check(staging.mkdirs()) { "Impossible de créer le staging" }

        try {
            writeDurable(File(staging, "manifest.json"), revision.manifestBytes)
            revision.assets.forEach { asset ->
                val target = safeAssetTarget(staging, asset.relativePath)
                verifyHash(asset.bytes, asset.sha256, asset.relativePath)
                target.parentFile?.mkdirs()
                writeDurable(target, asset.bytes)
            }

            val finalDirectory = File(revisions, revision.revisionId)
            Files.move(staging.toPath(), finalDirectory.toPath(), StandardCopyOption.ATOMIC_MOVE)

            val previousId = loadActive()?.revisionId
            if (previousId != null) writePointer(previousPointer, previousId)
            writePointer(activePointer, revision.revisionId)
            return ActiveRevision(revision.revisionId, finalDirectory)
        } catch (error: Throwable) {
            staging.deleteRecursively()
            throw error
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

    private fun verifyHash(bytes: ByteArray, expected: String, label: String) {
        require(expected.matches(Regex("^[a-f0-9]{64}$"))) { "SHA-256 invalide pour $label" }
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
        require(actual == expected) { "SHA-256 incorrect pour $label" }
    }

    private fun isSafeRevisionId(value: String): Boolean = value.matches(Regex("^[A-Za-z0-9._-]{1,120}$"))
}
