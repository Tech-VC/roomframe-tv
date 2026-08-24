package org.roomframe.tv.sync

import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection

internal object TvHeartbeatHttpPolicy {
    val requestBody: ByteArray
        get() = "{}".toByteArray(StandardCharsets.UTF_8)

    fun shouldReadResponseBody(statusCode: Int): Boolean = statusCode != 204
}

class HttpTvHeartbeatClient(
    private val credentials: DeviceCredentials,
) {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)

    fun send() {
        val base = URI(serverUrl)
        val resolved = base.resolve(HEARTBEAT_PATH)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine heartbeat invalide" }
        val requestBody = TvHeartbeatHttpPolicy.requestBody
        val connection = RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "POST"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
            doOutput = true
            setFixedLengthStreamingMode(requestBody.size)
            outputStream.use { it.write(requestBody) }
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("API heartbeat HTTP $status")
            }
            if (TvHeartbeatHttpPolicy.shouldReadResponseBody(status)) {
                connection.inputStream?.close()
            }
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val HEARTBEAT_PATH = "/api/v1/tv/heartbeat"
        const val CONNECT_TIMEOUT_MS = 5_000
        const val READ_TIMEOUT_MS = 5_000
    }
}
