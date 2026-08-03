package org.roomframe.tv.sync

import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

data class TvMetricSnapshot(
    val startupMs: Long?,
    val resumeMs: Long?,
    val memoryBytes: Long,
    val storageFreeBytes: Long,
    val networkState: String,
    val syncRevision: Long?,
    val syncDurationMs: Long,
    val updateState: String,
    val silentUpdateCapable: Boolean,
    val errorCode: String?,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        startupMs?.let { put("startupMs", it) }
        resumeMs?.let { put("resumeMs", it) }
        put("memoryBytes", memoryBytes)
        put("storageFreeBytes", storageFreeBytes)
        put("networkState", networkState)
        syncRevision?.let { put("syncRevision", it) }
        put("syncDurationMs", syncDurationMs)
        put("updateState", updateState)
        put("silentUpdateCapable", silentUpdateCapable)
        errorCode?.let { put("errorCode", it) }
    }
}

/**
 * Envoie uniquement les indicateurs techniques explicitement autorisés par
 * RoomFrame. Aucun SSID, adresse, appareil associé ou contenu consulté ne fait
 * partie du document.
 */
class HttpTvMetricsClient(
    private val credentials: DeviceCredentials,
) {
    private val serverUrl = DeviceCredentialStore.validateServerUrl(credentials.serverUrl)

    fun send(snapshot: TvMetricSnapshot) {
        val bytes = snapshot.toJson().toString().toByteArray(StandardCharsets.UTF_8)
        require(bytes.size <= MAX_REQUEST_BYTES) { "Métriques trop volumineuses" }
        val connection = open()
        try {
            connection.doOutput = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("API métriques HTTP $status")
            }
            connection.inputStream.use { input ->
                var total = 0
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    require(total <= MAX_RESPONSE_BYTES) { "Réponse métriques trop grande" }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(): HttpsURLConnection {
        val base = URI(serverUrl)
        val resolved = base.resolve(METRICS_PATH)
        require(
            resolved.scheme == "https" &&
                resolved.host == base.host &&
                resolved.port == base.port,
        ) { "Origine métriques invalide" }
        return RoomFrameHttps.open(URL(resolved.toString())).apply {
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            instanceFollowRedirects = false
            useCaches = false
            requestMethod = "POST"
            setRequestProperty("x-roomframe-device-id", credentials.deviceId)
            setRequestProperty("x-roomframe-device-key", credentials.deviceKey)
        }
    }

    private companion object {
        const val METRICS_PATH = "/api/v1/tv/metrics"
        const val CONNECT_TIMEOUT_MS = 8_000
        const val READ_TIMEOUT_MS = 12_000
        const val MAX_REQUEST_BYTES = 8 * 1024
        const val MAX_RESPONSE_BYTES = 32 * 1024
    }
}
