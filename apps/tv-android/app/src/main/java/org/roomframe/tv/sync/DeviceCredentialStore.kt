package org.roomframe.tv.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceCredentials(
    val serverUrl: String,
    val deviceId: String,
    val deviceKey: String,
)

class DeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): DeviceCredentials? = runCatching {
        val serverUrl = preferences.getString(KEY_SERVER_URL, null) ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null) ?: return null
        val encrypted = preferences.getString(KEY_DEVICE_KEY, null) ?: return null
        val iv = preferences.getString(KEY_DEVICE_KEY_IV, null) ?: return null
        DeviceCredentials(
            serverUrl = validateServerUrl(serverUrl),
            deviceId = validateDeviceId(deviceId),
            deviceKey = decrypt(
                encrypted = Base64.decode(encrypted, Base64.NO_WRAP),
                iv = Base64.decode(iv, Base64.NO_WRAP),
                associatedData = associatedData(serverUrl, deviceId),
            ).also(::validateDeviceKey),
        )
    }.getOrNull()

    fun save(credentials: DeviceCredentials) {
        val serverUrl = validateServerUrl(credentials.serverUrl)
        val deviceId = validateDeviceId(credentials.deviceId)
        val deviceKey = credentials.deviceKey.also(::validateDeviceKey)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(associatedData(serverUrl, deviceId))
        val ciphertext = cipher.doFinal(deviceKey.toByteArray(StandardCharsets.UTF_8))
        check(
            preferences.edit()
                .putString(KEY_SERVER_URL, serverUrl)
                .putString(KEY_DEVICE_ID, deviceId)
                .putString(KEY_DEVICE_KEY, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(KEY_DEVICE_KEY_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .commit(),
        ) { "Impossible de conserver les identifiants TV" }
    }

    fun clear() {
        preferences.edit().clear().commit()
    }

    private fun decrypt(encrypted: ByteArray, iv: ByteArray, associatedData: ByteArray): String {
        require(iv.size == 12) { "IV de credential invalide" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(encrypted).toString(StandardCharsets.UTF_8)
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun associatedData(serverUrl: String, deviceId: String): ByteArray =
        "$serverUrl\u0000$deviceId".toByteArray(StandardCharsets.UTF_8)

    companion object {
        fun validateServerUrl(value: String): String {
            val normalized = value.trim().removeSuffix("/")
            val uri = URI(normalized)
            require(
                uri.scheme == "https" &&
                    !uri.host.isNullOrBlank() &&
                    uri.userInfo == null &&
                    uri.query == null &&
                    uri.fragment == null &&
                    (uri.path.isNullOrBlank() || uri.path == "/"),
            ) { "URL HTTPS RoomFrame invalide" }
            return "${uri.scheme}://${uri.rawAuthority}"
        }

        fun validateDeviceId(value: String): String =
            UUID.fromString(value.trim()).toString()

        fun validateDeviceKey(value: String) {
            require(value.length in 20..200 && value.none(Char::isWhitespace)) {
                "Clé appareil invalide"
            }
        }

        private const val PREFERENCES_NAME = "roomframe-device"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_KEY = "device_key_ciphertext"
        private const val KEY_DEVICE_KEY_IV = "device_key_iv"
        private const val KEY_ALIAS = "roomframe-device-credentials-v1"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
