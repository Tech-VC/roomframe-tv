package org.roomframe.tv.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest
import org.roomframe.tv.adapters.VerifiedApkArtifact

data class ApkUpdateDescriptor(
    val packageName: String,
    val versionCode: Long,
    val sha256: String,
    val size: Long,
    val signingCertificateSha256: String,
)

class ApkArtifactVerifier(
    private val context: Context,
    private val updateRoot: File,
) {
    fun verify(file: File, descriptor: ApkUpdateDescriptor): VerifiedApkArtifact {
        val canonicalRoot = updateRoot.canonicalFile
        val canonicalFile = file.canonicalFile
        require(canonicalFile.path.startsWith("${canonicalRoot.path}${File.separator}")) {
            "APK hors du stockage privé RoomFrame"
        }
        require(canonicalFile.isFile && canonicalFile.length() == descriptor.size && descriptor.size > 0) {
            "Taille APK incorrecte"
        }
        require(descriptor.packageName == context.packageName) { "Package APK inattendu" }
        require(descriptor.versionCode > currentVersionCode()) { "Version APK non croissante" }
        require(SHA256.matches(descriptor.sha256) && SHA256.matches(descriptor.signingCertificateSha256)) {
            "Empreinte APK invalide"
        }
        require(hashFile(canonicalFile) == descriptor.sha256) { "SHA-256 APK incorrect" }

        val archive = packageArchiveInfo(canonicalFile)
            ?: throw IllegalArgumentException("APK Android illisible")
        require(archive.packageName == descriptor.packageName) { "Package déclaré incohérent" }
        require(versionCode(archive) == descriptor.versionCode) { "VersionCode APK incohérent" }
        val archiveSigners = signerHashes(archive, includeHistory = false)
        require(descriptor.signingCertificateSha256 in archiveSigners) {
            "Signature APK différente du manifeste signé"
        }
        val installed = installedPackageInfo()
        val installedLineage = signerHashes(installed, includeHistory = true)
        require(archiveSigners.any(installedLineage::contains)) {
            "Signature APK incompatible avec l'application installée"
        }
        return VerifiedApkArtifact(
            localPath = canonicalFile.path,
            packageName = descriptor.packageName,
            versionCode = descriptor.versionCode,
            sha256 = descriptor.sha256,
        )
    }

    @Suppress("DEPRECATION")
    private fun packageArchiveInfo(file: File): PackageInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getPackageArchiveInfo(
                file.path,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            context.packageManager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
        }

    @Suppress("DEPRECATION")
    private fun installedPackageInfo(): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()),
            )
        } else {
            context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun currentVersionCode(): Long = versionCode(installedPackageInfo())

    @Suppress("DEPRECATION")
    private fun signerHashes(info: PackageInfo, includeHistory: Boolean): Set<String> {
        val signingInfo = info.signingInfo
        val signatures = when {
            signingInfo == null -> info.signatures.orEmpty()
            includeHistory && !signingInfo.hasMultipleSigners() -> signingInfo.signingCertificateHistory
            else -> signingInfo.apkContentsSigners
        }
        return signatures.mapTo(mutableSetOf()) { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).hex()
        }
    }

    private fun hashFile(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().hex()
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        val SHA256 = Regex("^[a-f0-9]{64}$")
    }
}
