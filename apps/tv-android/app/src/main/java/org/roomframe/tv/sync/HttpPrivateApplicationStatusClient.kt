package org.roomframe.tv.sync

import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import org.json.JSONArray
import org.json.JSONObject
import org.roomframe.tv.deviceadmin.PrivateApplicationRuntimeState

internal class HttpPrivateApplicationStatusClient(
    private val credentials: DeviceCredentials,
) {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)

    fun send(states: List<PrivateApplicationRuntimeState>) {
        require(states.size <= MAX_APPLICATIONS) { "Trop d'états d'applications" }
        require(states.map(PrivateApplicationRuntimeState::applicationId).distinct().size == states.size) {
            "État d'application dupliqué"
        }
        val items = JSONArray()
        states.forEach { state ->
            items.put(
                JSONObject()
                    .put("applicationId", state.applicationId)
                    .put("installed", state.installed)
                    .put("versionName", state.versionName ?: JSONObject.NULL)
                    .put("versionCode", state.versionCode ?: JSONObject.NULL)
                    .put("accessEnforced", state.accessEnforced),
            )
        }
        val bytes = JSONObject()
            .put("items", items)
            .toString()
            .toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_REQUEST_BYTES) { "États d'applications trop volumineux" }
        val connection = open().apply {
            doOutput = true
            setFixedLengthStreamingMode(bytes.size)
        }
        try {
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("API applications HTTP $status")
            }
            if (status != 204) connection.inputStream?.close()
        } finally {
            connection.disconnect()
        }
    }

    private fun open(): HttpsURLConnection {
        val base = URI(serverUrl)
        val resolved = base.resolve(STATUS_PATH)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine d'état d'applications invalide" }
        return RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "PUT"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
    }

    private companion object {
        const val STATUS_PATH = "/api/v1/tv/applications/status"
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 12_000
        const val MAX_APPLICATIONS = 12
        const val MAX_REQUEST_BYTES = 16 * 1_024
    }
}
