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
    val credentialGeneration: Long = 1,
    val credentialRotatedAtEpochMs: Long = 0,
    val pendingDeviceKey: String? = null,
    val pendingCredentialGeneration: Long? = null,
)

class DeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): DeviceCredentials? = runCatching {
        val serverUrl = preferences.getString(KEY_SERVER_URL, null) ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null) ?: return null
        val encrypted = preferences.getString(KEY_DEVICE_KEY, null) ?: return null
        val iv = preferences.getString(KEY_DEVICE_KEY_IV, null) ?: return null
        val generation = preferences.getLong(KEY_CREDENTIAL_GENERATION, 1)
            .also(::validateCredentialGeneration)
        val pending = runCatching {
            val pendingEncrypted = preferences.getString(KEY_PENDING_DEVICE_KEY, null)
                ?: return@runCatching null
            val pendingIv = preferences.getString(KEY_PENDING_DEVICE_KEY_IV, null)
                ?: return@runCatching null
            val pendingGeneration = preferences.getLong(
                KEY_PENDING_CREDENTIAL_GENERATION,
                0,
            ).also(::validateCredentialGeneration)
            require(pendingGeneration == generation + 1) {
                "Génération de credential en attente incohérente"
            }
            decrypt(
                encrypted = Base64.decode(pendingEncrypted, Base64.NO_WRAP),
                iv = Base64.decode(pendingIv, Base64.NO_WRAP),
                associatedData = associatedData(serverUrl, deviceId, "pending"),
            ).also(::validateDeviceKey) to pendingGeneration
        }.getOrNull()
        DeviceCredentials(
            serverUrl = validateServerUrl(serverUrl),
            deviceId = validateDeviceId(deviceId),
            deviceKey = decryptActive(
                encrypted = Base64.decode(encrypted, Base64.NO_WRAP),
                iv = Base64.decode(iv, Base64.NO_WRAP),
                serverUrl = serverUrl,
                deviceId = deviceId,
            ).also(::validateDeviceKey),
            credentialGeneration = generation,
            credentialRotatedAtEpochMs = preferences.getLong(
                KEY_CREDENTIAL_ROTATED_AT,
                0,
            ).coerceAtLeast(0),
            pendingDeviceKey = pending?.first,
            pendingCredentialGeneration = pending?.second,
        )
    }.getOrNull()

    fun save(credentials: DeviceCredentials) {
        val serverUrl = validateServerUrl(credentials.serverUrl)
        val deviceId = validateDeviceId(credentials.deviceId)
        val deviceKey = credentials.deviceKey.also(::validateDeviceKey)
        validateCredentialGeneration(credentials.credentialGeneration)
        require(credentials.credentialRotatedAtEpochMs >= 0) {
            "Date de rotation invalide"
        }
        val active = encrypt(
            plaintext = deviceKey,
            associatedData = associatedData(serverUrl, deviceId, "active"),
        )
        val editor = preferences.edit()
            .putString(KEY_SERVER_URL, serverUrl)
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_DEVICE_KEY, Base64.encodeToString(active.first, Base64.NO_WRAP))
            .putString(KEY_DEVICE_KEY_IV, Base64.encodeToString(active.second, Base64.NO_WRAP))
            .putLong(KEY_CREDENTIAL_GENERATION, credentials.credentialGeneration)
            .putLong(KEY_CREDENTIAL_ROTATED_AT, credentials.credentialRotatedAtEpochMs)
        if (credentials.pendingDeviceKey != null) {
            val pendingGeneration = requireNotNull(credentials.pendingCredentialGeneration)
            validateCredentialGeneration(pendingGeneration)
            require(pendingGeneration == credentials.credentialGeneration + 1) {
                "Génération de credential en attente incohérente"
            }
            val pendingKey = credentials.pendingDeviceKey.also(::validateDeviceKey)
            require(pendingKey != deviceKey) { "La nouvelle clé doit être distincte" }
            val pending = encrypt(
                plaintext = pendingKey,
                associatedData = associatedData(serverUrl, deviceId, "pending"),
            )
            editor
                .putString(
                    KEY_PENDING_DEVICE_KEY,
                    Base64.encodeToString(pending.first, Base64.NO_WRAP),
                )
                .putString(
                    KEY_PENDING_DEVICE_KEY_IV,
                    Base64.encodeToString(pending.second, Base64.NO_WRAP),
                )
                .putLong(KEY_PENDING_CREDENTIAL_GENERATION, pendingGeneration)
        } else {
            require(credentials.pendingCredentialGeneration == null) {
                "Génération en attente sans clé"
            }
            editor
                .remove(KEY_PENDING_DEVICE_KEY)
                .remove(KEY_PENDING_DEVICE_KEY_IV)
                .remove(KEY_PENDING_CREDENTIAL_GENERATION)
        }
        check(
            editor.commit(),
        ) { "Impossible de conserver les identifiants TV" }
    }

    fun preparePending(nextKey: String): DeviceCredentials {
        val current = requireNotNull(load()) { "Identité TV absente" }
        val updated = current.copy(
            pendingDeviceKey = nextKey.also(::validateDeviceKey),
            pendingCredentialGeneration = current.credentialGeneration + 1,
        )
        save(updated)
        return updated
    }

    fun promotePending(rotatedAtEpochMs: Long): DeviceCredentials {
        val current = requireNotNull(load()) { "Identité TV absente" }
        val pendingKey = requireNotNull(current.pendingDeviceKey) {
            "Aucune rotation en attente"
        }
        val pendingGeneration = requireNotNull(current.pendingCredentialGeneration)
        val updated = current.copy(
            deviceKey = pendingKey,
            credentialGeneration = pendingGeneration,
            credentialRotatedAtEpochMs = rotatedAtEpochMs.coerceAtLeast(0),
            pendingDeviceKey = null,
            pendingCredentialGeneration = null,
        )
        save(updated)
        return updated
    }

    fun clear() {
        check(preferences.edit().clear().commit()) {
            "Impossible d’effacer l’identité TV"
        }
        TvClientCertificateStore().clear()
        RoomFrameServerTrust().clear()
    }

    private fun decrypt(encrypted: ByteArray, iv: ByteArray, associatedData: ByteArray): String {
        require(iv.size == 12) { "IV de credential invalide" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD(associatedData)
        return cipher.doFinal(encrypted).toString(StandardCharsets.UTF_8)
    }

    private fun decryptActive(
        encrypted: ByteArray,
        iv: ByteArray,
        serverUrl: String,
        deviceId: String,
    ): String = runCatching {
        decrypt(encrypted, iv, associatedData(serverUrl, deviceId, "active"))
    }.getOrElse {
        // Compatibilité avec les credentials chiffrés par les builds 0.3.0/0.3.1.
        decrypt(
            encrypted,
            iv,
            "$serverUrl\u0000$deviceId".toByteArray(StandardCharsets.UTF_8),
        )
    }

    private fun encrypt(plaintext: String, associatedData: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(associatedData)
        return cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8)) to cipher.iv
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

    private fun associatedData(serverUrl: String, deviceId: String, purpose: String): ByteArray =
        "$serverUrl\u0000$deviceId\u0000$purpose".toByteArray(StandardCharsets.UTF_8)

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
            require(value.matches(Regex("^[A-Za-z0-9_-]{32,200}$"))) {
                "Clé appareil invalide"
            }
        }

        fun validateCredentialGeneration(value: Long) {
            require(value in 1..9_007_199_254_740_991L) {
                "Génération de credential invalide"
            }
        }

        private const val PREFERENCES_NAME = "roomframe-device"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_KEY = "device_key_ciphertext"
        private const val KEY_DEVICE_KEY_IV = "device_key_iv"
        private const val KEY_CREDENTIAL_GENERATION = "credential_generation"
        private const val KEY_CREDENTIAL_ROTATED_AT = "credential_rotated_at"
        private const val KEY_PENDING_DEVICE_KEY = "pending_device_key_ciphertext"
        private const val KEY_PENDING_DEVICE_KEY_IV = "pending_device_key_iv"
        private const val KEY_PENDING_CREDENTIAL_GENERATION = "pending_credential_generation"
        private const val KEY_ALIAS = "roomframe-device-credentials-v1"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
