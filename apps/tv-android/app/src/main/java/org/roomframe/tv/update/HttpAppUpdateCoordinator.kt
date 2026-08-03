package org.roomframe.tv.update

import android.content.Context
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject
import org.roomframe.tv.adapters.AdapterResult
import org.roomframe.tv.adapters.AppUpdateAdapter
import org.roomframe.tv.adapters.CapabilityState
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.DeviceCredentials
import org.roomframe.tv.sync.RoomFrameHttps

/**
 * Télécharge et contrôle un APK depuis l'origine RoomFrame avant de le remettre
 * à PackageInstaller. Une TV non Device Owner conserve l'APK vérifié sans
 * annoncer une installation silencieuse fictive.
 */
class HttpAppUpdateCoordinator(
    private val context: Context,
    private val credentials: DeviceCredentials,
    private val updateRoot: File,
    private val adapter: AppUpdateAdapter,
) {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)
    private val runtime = context.getSharedPreferences(RUNTIME_PREFERENCES, Context.MODE_PRIVATE)
    private val verifier = ApkArtifactVerifier(context, updateRoot)

    fun checkAndApply(
        installDecision: () -> UpdateInstallDecision,
    ): String {
        flushInstallerResult()?.let { return it }
        val response = requestJson("GET", "/api/v1/tv/update")
        if (!response.optBoolean("available", false)) return "up-to-date"

        val deployment = response.getJSONObject("deployment")
        val deploymentId = UUID.fromString(deployment.getString("id")).toString()
        val targetState = deployment.getString("state")
        require(targetState in TARGET_STATES) { "État de déploiement inattendu" }
        val releaseVersion = response.getJSONObject("release").getString("version").also {
            require(it.matches(SEMVER)) { "Version de release invalide" }
        }
        val artifact = response.getJSONObject("artifact")
        val descriptor = ApkUpdateDescriptor(
            packageName = artifact.getString("packageName"),
            versionCode = artifact.getLong("versionCode"),
            sha256 = artifact.getString("sha256"),
            size = artifact.getLong("size"),
            signingCertificateSha256 = artifact.getString("signingCertificateSha256"),
        )
        val relativeUrl = artifact.getString("url")
        require(relativeUrl == "/api/v1/tv/updates/$deploymentId/apk") {
            "URL APK incohérente"
        }

        if (descriptor.versionCode <= currentVersionCode()) {
            if (targetState == "installing" && descriptor.versionCode == currentVersionCode()) {
                report(deploymentId, "installed", releaseVersion)
                clearPending()
                return "installed:$releaseVersion"
            }
            report(deploymentId, "failed", releaseVersion, "version-not-newer")
            return "failed:version-not-newer"
        }
        if (targetState == "installing") return "installing:$releaseVersion"

        updateRoot.mkdirs()
        val apk = File(updateRoot, "${descriptor.sha256}.apk")
        updateRoot.listFiles()
            .orEmpty()
            .filter { it.isFile && it.extension == "apk" && it.name != apk.name }
            .forEach(File::delete)
        val verified = runCatching { verifier.verify(apk, descriptor) }.getOrNull()
            ?: run {
                download(relativeUrl, apk, descriptor)
                runCatching { verifier.verify(apk, descriptor) }.getOrElse { error ->
                    apk.delete()
                    report(deploymentId, "failed", releaseVersion, "apk-verification")
                    throw IllegalStateException(
                        error.message?.take(160) ?: "Vérification APK impossible",
                    )
                }
            }

        if (targetState != "downloaded") {
            report(deploymentId, "downloaded", releaseVersion)
        }
        if (adapter.probeCapabilities().silentInstall != CapabilityState.SUPPORTED) {
            recordState("downloaded:device-owner-required")
            return "downloaded:device-owner-required"
        }
        val decision = installDecision()
        require(decision.reason.matches(Regex("^[a-z0-9-]{1,40}$"))) {
            "Motif de mise à jour différée invalide"
        }
        if (!decision.allowed) {
            val state = "downloaded:${decision.reason}"
            recordState(state)
            return state
        }

        report(deploymentId, "installing", releaseVersion)
        runtime.edit()
            .putString(PENDING_DEPLOYMENT, deploymentId)
            .putLong(PENDING_VERSION_CODE, descriptor.versionCode)
            .putString(PENDING_RELEASE_VERSION, releaseVersion)
            .putString(LAST_UPDATE_STATE, "installing:${descriptor.versionCode}")
            .apply()
        return when (val result = adapter.installVerified(verified)) {
            AdapterResult.Success -> "installing:$releaseVersion"
            is AdapterResult.Pending -> "installing:$releaseVersion"
            is AdapterResult.Unavailable -> {
                report(deploymentId, "failed", releaseVersion, "installer-unavailable")
                clearPending()
                "failed:installer-unavailable"
            }
            is AdapterResult.Failure -> {
                report(deploymentId, "failed", releaseVersion, "package-installer")
                clearPending()
                "failed:package-installer"
            }
        }
    }

    private fun flushInstallerResult(): String? {
        val deploymentId = runtime.getString(PENDING_DEPLOYMENT, null) ?: return null
        val releaseVersion = runtime.getString(PENDING_RELEASE_VERSION, null) ?: return null
        val expectedVersionCode = runtime.getLong(PENDING_VERSION_CODE, -1)
        val state = runtime.getString(LAST_UPDATE_STATE, null) ?: return null
        return when {
            currentVersionCode() >= expectedVersionCode && expectedVersionCode > 0 -> {
                report(deploymentId, "installed", releaseVersion)
                clearPending()
                "installed:$releaseVersion"
            }
            state.startsWith("installed:") -> {
                report(deploymentId, "installed", releaseVersion)
                clearPending()
                "installed:$releaseVersion"
            }
            state.startsWith("failed:") -> {
                report(deploymentId, "failed", releaseVersion, "package-installer")
                clearPending()
                "failed:package-installer"
            }
            else -> null
        }
    }

    private fun download(relativeUrl: String, target: File, descriptor: ApkUpdateDescriptor) {
        require(descriptor.size in 1..MAX_APK_BYTES && SHA256.matches(descriptor.sha256)) {
            "Descripteur APK invalide"
        }
        val staged = File(updateRoot, ".${descriptor.sha256}.part")
        staged.delete()
        val connection = open(relativeUrl, "GET")
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive")
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("Téléchargement APK HTTP $status")
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/vnd.android.package-archive") {
                "Type MIME APK inattendu"
            }
            connection.contentLengthLong.takeIf { it >= 0 }?.let {
                require(it == descriptor.size) { "Taille HTTP APK incorrecte" }
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            connection.inputStream.use { input ->
                FileOutputStream(staged).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= descriptor.size) { "APK plus grand que le manifeste" }
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                    output.fd.sync()
                }
            }
            require(total == descriptor.size) { "Taille APK incorrecte" }
            require(digest.digest().hex() == descriptor.sha256) { "SHA-256 APK incorrect" }
            Files.move(
                staged.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } finally {
            connection.disconnect()
            staged.delete()
        }
    }

    private fun report(
        deploymentId: String,
        status: String,
        releaseVersion: String,
        errorCode: String? = null,
    ) {
        val body = JSONObject()
            .put("status", status)
            .put("version", releaseVersion)
        if (errorCode != null) body.put("errorCode", errorCode)
        requestJson(
            method = "POST",
            path = "/api/v1/tv/updates/$deploymentId/status",
            body = body.toString().toByteArray(StandardCharsets.UTF_8),
        )
    }

    private fun requestJson(method: String, path: String, body: ByteArray? = null): JSONObject {
        val connection = open(path, method)
        connection.setRequestProperty("Accept", "application/json")
        if (body != null) {
            require(body.size <= MAX_JSON_BYTES)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body) }
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("API de mise à jour HTTP $status")
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") { "Type de réponse inattendu" }
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    require(total <= MAX_JSON_BYTES) { "Réponse JSON trop grande" }
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            }
            return JSONObject(bytes.toString(StandardCharsets.UTF_8))
        } finally {
            connection.disconnect()
        }
    }

    private fun open(path: String, method: String): HttpsURLConnection {
        require(path.startsWith("/api/v1/") && !path.contains("..")) { "URL update invalide" }
        val base = URI(serverUrl)
        val resolved = base.resolve(path)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine de mise à jour invalide" }
        return RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = method
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
    }

    private fun recordState(value: String) {
        runtime.edit().putString(LAST_UPDATE_STATE, value.take(180)).apply()
    }

    private fun clearPending() {
        runtime.edit()
            .remove(PENDING_DEPLOYMENT)
            .remove(PENDING_VERSION_CODE)
            .remove(PENDING_RELEASE_VERSION)
            .remove(LAST_UPDATE_STATE)
            .apply()
        updateRoot.listFiles()
            .orEmpty()
            .filter { it.isFile && (it.extension == "apk" || it.name.endsWith(".part")) }
            .forEach(File::delete)
    }

    @Suppress("DEPRECATION")
    private fun currentVersionCode(): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }
    }

    private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        const val RUNTIME_PREFERENCES = "roomframe-runtime"
        const val LAST_UPDATE_STATE = "last_update_state"
        const val PENDING_DEPLOYMENT = "pending_update_deployment"
        const val PENDING_VERSION_CODE = "pending_update_version_code"
        const val PENDING_RELEASE_VERSION = "pending_update_release_version"
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 120_000
        const val MAX_JSON_BYTES = 256 * 1024
        const val MAX_APK_BYTES = 500L * 1024 * 1024
        val SHA256 = Regex("^[a-f0-9]{64}$")
        val SEMVER = Regex(
            "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)" +
                "(?:-[0-9A-Za-z.-]+)?$",
        )
        val TARGET_STATES = setOf("offered", "downloading", "downloaded", "installing")
    }
}
