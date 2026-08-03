package org.roomframe.tv.adapters

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import java.io.File

class AndroidPackageInstallerAdapter(
    private val context: Context,
) : AppUpdateAdapter {
    override fun probeCapabilities(): AppUpdateCapabilities {
        val deviceOwner = context.getSystemService(DevicePolicyManager::class.java)
            ?.isDeviceOwnerApp(context.packageName) == true
        return AppUpdateCapabilities(
            verifiedDownload = CapabilityState.SUPPORTED,
            silentInstall = if (deviceOwner) CapabilityState.SUPPORTED else CapabilityState.UNSUPPORTED,
        )
    }

    override fun installVerified(apk: VerifiedApkArtifact): AdapterResult {
        if (probeCapabilities().silentInstall != CapabilityState.SUPPORTED) {
            return AdapterResult.Unavailable(
                "APK vérifié, mais installation silencieuse désactivée tant que RoomFrame n'est pas Device Owner",
            )
        }
        val file = File(apk.localPath)
        if (
            apk.packageName != context.packageName ||
            apk.versionCode <= currentVersionCode() ||
            !apk.sha256.matches(Regex("^[a-f0-9]{64}$")) ||
            !file.isFile ||
            file.length() <= 0
        ) {
            return AdapterResult.Failure("Descripteur APK vérifié invalide")
        }
        return runCatching {
            val installer = context.packageManager.packageInstaller
            val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(apk.packageName)
                setInstallReason(PackageManager.INSTALL_REASON_POLICY)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
            }
            val sessionId = installer.createSession(parameters)
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { output ->
                    file.inputStream().use { input -> input.copyTo(output) }
                    session.fsync(output)
                }
                val resultIntent = Intent(context, AppUpdateResultReceiver::class.java)
                    .setAction(AppUpdateResultReceiver.ACTION_UPDATE_RESULT)
                    .putExtra(AppUpdateResultReceiver.EXTRA_VERSION_CODE, apk.versionCode)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_MUTABLE
                } else {
                    0
                }
                val pending = PendingIntent.getBroadcast(context, sessionId, resultIntent, flags)
                session.commit(pending.intentSender)
            }
            AdapterResult.Pending("Installation APK transmise à Android PackageInstaller")
        }.getOrElse { error ->
            AdapterResult.Failure(error.message?.take(160) ?: "PackageInstaller indisponible")
        }
    }

    @Suppress("DEPRECATION")
    private fun currentVersionCode(): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    }
}
