package org.roomframe.tv.sync

import java.net.URI
import java.net.URL
import javax.net.ssl.HttpsURLConnection

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
        val connection = RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "POST"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("API heartbeat HTTP $status")
            }
            connection.inputStream?.close()
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
