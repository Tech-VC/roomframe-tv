package org.roomframe.tv.sync

import java.io.ByteArrayOutputStream
import java.net.URL
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

class TvEnrollmentClient {
    fun enroll(serverUrl: String, deviceId: String, enrollmentKey: String): DeviceCredentials {
        val normalizedUrl = DeviceCredentialStore.validateServerUrl(serverUrl)
        val normalizedId = DeviceCredentialStore.validateDeviceId(deviceId)
        DeviceCredentialStore.validateDeviceKey(enrollmentKey)
        val connection = (URL("$normalizedUrl/api/v1/tv/enroll").openConnection() as HttpsURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 15_000
            instanceFollowRedirects = false
            useCaches = false
            doOutput = true
            requestMethod = "POST"
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            val requestBody = JSONObject()
                .put("deviceId", normalizedId)
                .put("enrollmentKey", enrollmentKey)
                .toString()
                .toByteArray(StandardCharsets.UTF_8)
            connection.setFixedLengthStreamingMode(requestBody.size)
            connection.outputStream.use { it.write(requestBody) }
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                throw IllegalStateException("Enrôlement refusé (HTTP $status)")
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            require(contentType == "application/json") { "Réponse d'enrôlement invalide" }
            val response = JSONObject(
                connection.inputStream.use { readBounded(it, MAX_RESPONSE_BYTES) }
                    .toString(StandardCharsets.UTF_8),
            )
            require(response.optString("credentialDelivery") == "one-time") {
                "Mode de remise de credential inattendu"
            }
            return DeviceCredentials(
                serverUrl = normalizedUrl,
                deviceId = normalizedId,
                deviceKey = response.getString("deviceKey").also(DeviceCredentialStore::validateDeviceKey),
            )
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
            require(total <= maximum) { "Réponse d'enrôlement trop grande" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 128 * 1024
    }
}
