package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

internal sealed interface PrivateUnlockResult {
    data class Granted(val generation: Long) : PrivateUnlockResult
    data object Invalid : PrivateUnlockResult
    data class Locked(val retryAfterSeconds: Int) : PrivateUnlockResult
    data object StaleGeneration : PrivateUnlockResult
    data object Unavailable : PrivateUnlockResult
}

internal fun privateUnlockResult(
    statusCode: Int,
    response: JSONObject?,
    expectedGeneration: Long,
): PrivateUnlockResult {
    val error = response
        ?.optString("error")
        ?.ifBlank { response.optString("code") }
        ?.lowercase()
        .orEmpty()
    if (statusCode in 200..299 && response?.optBoolean("granted", false) == true) {
        val generation = response.optLong("generation", -1)
        return if (generation == expectedGeneration) {
            PrivateUnlockResult.Granted(generation)
        } else {
            PrivateUnlockResult.StaleGeneration
        }
    }
    return when {
        error == "private_access_locked" || statusCode == 423 || statusCode == 429 ->
            PrivateUnlockResult.Locked(
                response?.optInt("retryAfterSeconds", 60)?.coerceIn(1, 3_600) ?: 60,
            )
        error == "private_access_generation_stale" ->
            PrivateUnlockResult.StaleGeneration
        error == "private_access_pin_invalid" ->
            PrivateUnlockResult.Invalid
        else -> PrivateUnlockResult.Unavailable
    }
}

internal class HttpPrivateAccessClient(
    private val credentials: DeviceCredentials,
) {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)

    fun unlock(pin: String, generation: Long): PrivateUnlockResult {
        require(PIN.matches(pin)) { "Format de code privé invalide" }
        require(generation in 0..9_007_199_254_740_991L) {
            "Génération d'accès privé invalide"
        }
        val bytes = JSONObject()
            .put("pin", pin)
            .put("generation", generation)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_REQUEST_BYTES) { "Demande privée trop grande" }
        val connection = open().apply {
            doOutput = true
            setFixedLengthStreamingMode(bytes.size)
        }
        return try {
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val response = readResponse(connection, status)
            privateUnlockResult(status, response, generation)
        } catch (_: Exception) {
            PrivateUnlockResult.Unavailable
        } finally {
            connection.disconnect()
        }
    }

    private fun open(): HttpsURLConnection {
        val base = URI(serverUrl)
        val resolved = base.resolve(UNLOCK_PATH)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine d'accès privé invalide" }
        return RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "POST"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
    }

    private fun readResponse(
        connection: HttpsURLConnection,
        statusCode: Int,
    ): JSONObject? {
        if (statusCode == 204) return null
        val input = if (statusCode in 200..299) {
            connection.inputStream
        } else {
            connection.errorStream
        } ?: return null
        val output = ByteArrayOutputStream()
        input.use {
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = it.read(buffer)
                if (read < 0) break
                total += read
                require(total <= MAX_RESPONSE_BYTES) { "Réponse privée trop grande" }
                output.write(buffer, 0, read)
            }
        }
        if (output.size() == 0) return null
        return runCatching {
            JSONObject(output.toString(StandardCharsets.UTF_8.name()))
        }.getOrNull()
    }

    private companion object {
        const val UNLOCK_PATH = "/api/v1/tv/private-access/unlock"
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 12_000
        const val MAX_REQUEST_BYTES = 1_024
        const val MAX_RESPONSE_BYTES = 8 * 1_024
        val PIN = Regex("^[0-9]{6}$")
    }
}
