package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

sealed interface CredentialRotationResult {
    data object NotEnrolled : CredentialRotationResult
    data object NotDue : CredentialRotationResult
    data class Rotated(val generation: Long) : CredentialRotationResult
    data class Pending(val reason: String) : CredentialRotationResult
}

class TvCredentialRotationClient(
    private val store: DeviceCredentialStore,
) {
    fun rotateIfDue(nowEpochMs: Long = System.currentTimeMillis()): CredentialRotationResult {
        var credentials = store.load() ?: return CredentialRotationResult.NotEnrolled
        if (credentials.pendingDeviceKey == null) {
            if (!CredentialRotationPolicy.isDue(credentials, nowEpochMs)) {
                return CredentialRotationResult.NotDue
            }
            credentials = store.preparePending(CredentialRotationPolicy.generateKey())
        }
        val pendingKey = requireNotNull(credentials.pendingDeviceKey)
        val pendingGeneration = requireNotNull(credentials.pendingCredentialGeneration)
        val prepare = runCatching {
            post(
                credentials = credentials,
                deviceKey = credentials.deviceKey,
                path = "/api/v1/tv/credentials/rotate",
                body = JSONObject()
                    .put("nextKey", pendingKey)
                    .put("currentGeneration", credentials.credentialGeneration),
            )
        }.getOrElse { error ->
            return CredentialRotationResult.Pending(
                "prepare:${error.message?.take(100) ?: "network"}",
            )
        }
        if (prepare.status in 200..299) {
            val serverGeneration = prepare.body?.getLong("nextGeneration")
            if (serverGeneration != pendingGeneration) {
                return CredentialRotationResult.Pending("prepare:generation")
            }
        } else if (prepare.status !in setOf(401, 409)) {
            return CredentialRotationResult.Pending("prepare:http-${prepare.status}")
        }

        val confirmation = runCatching {
            post(
                credentials = credentials,
                deviceKey = pendingKey,
                path = "/api/v1/tv/credentials/confirm",
                body = JSONObject().put("generation", pendingGeneration),
            )
        }.getOrElse { error ->
            return CredentialRotationResult.Pending(
                "confirm:${error.message?.take(100) ?: "network"}",
            )
        }
        if (confirmation.status !in 200..299) {
            return CredentialRotationResult.Pending("confirm:http-${confirmation.status}")
        }
        val confirmedGeneration = confirmation.body?.getLong("credentialGeneration")
        if (confirmedGeneration != pendingGeneration) {
            return CredentialRotationResult.Pending("confirm:generation")
        }
        val rotatedAt = runCatching {
            Instant.parse(
                requireNotNull(confirmation.body).getString("credentialRotatedAt"),
            ).toEpochMilli()
        }.getOrDefault(nowEpochMs)
        store.promotePending(rotatedAt)
        return CredentialRotationResult.Rotated(pendingGeneration)
    }

    private fun post(
        credentials: DeviceCredentials,
        deviceKey: String,
        path: String,
        body: JSONObject,
    ): HttpResponse {
        DeviceCredentialStore.validateDeviceKey(deviceKey)
        val base = URI(DeviceCredentialStore.validateServerUrl(credentials.serverUrl))
        val resolved = base.resolve(path)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine de rotation invalide" }
        val payload = body.toString().toByteArray(StandardCharsets.UTF_8)
        val connection = (URL(resolved.toString()).openConnection() as HttpsURLConnection).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            doOutput = true
            requestMethod = "POST"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", deviceKey)
            setFixedLengthStreamingMode(payload.size)
        }
        try {
            connection.outputStream.use { it.write(payload) }
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.use { readBounded(it, MAX_RESPONSE_BYTES) }
                return HttpResponse(status, null)
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") { "Réponse de rotation invalide" }
            val response = JSONObject(
                connection.inputStream.use { readBounded(it, MAX_RESPONSE_BYTES) }
                    .toString(StandardCharsets.UTF_8),
            )
            return HttpResponse(status, response)
        } finally {
            connection.disconnect()
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
            require(total <= maximum) { "Réponse de rotation trop grande" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private data class HttpResponse(
        val status: Int,
        val body: JSONObject?,
    )

    private companion object {
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 15_000
        const val MAX_RESPONSE_BYTES = 128 * 1024
    }
}

object CredentialRotationPolicy {
    const val ROTATION_INTERVAL_MS = 30L * 24 * 60 * 60 * 1000

    fun isDue(credentials: DeviceCredentials, nowEpochMs: Long): Boolean {
        if (credentials.pendingDeviceKey != null) return true
        if (credentials.credentialRotatedAtEpochMs <= 0) return true
        return nowEpochMs - credentials.credentialRotatedAtEpochMs >= ROTATION_INTERVAL_MS
    }

    fun generateKey(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            .also(DeviceCredentialStore::validateDeviceKey)
    }
}
