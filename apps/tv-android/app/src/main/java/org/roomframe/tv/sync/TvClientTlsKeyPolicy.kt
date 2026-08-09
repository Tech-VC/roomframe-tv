package org.roomframe.tv.sync

import android.security.keystore.KeyProperties

/** Authorizations required by Conscrypt when it delegates TLS RSA signing to Keystore. */
object TvClientTlsKeyPolicy {
    fun authorizedDigests(): Array<String> = arrayOf(
        KeyProperties.DIGEST_NONE,
        KeyProperties.DIGEST_SHA256,
    )

    fun authorizedEncryptionPaddings(): Array<String> = arrayOf(
        KeyProperties.ENCRYPTION_PADDING_NONE,
    )

    // Android Keystore rejects padding NONE while randomized encryption remains required.
    fun randomizedEncryptionRequired(): Boolean = false

    fun supportsConscryptRawRsa(
        digests: Collection<String>,
        encryptionPaddings: Collection<String>,
    ): Boolean = KeyProperties.DIGEST_NONE in digests &&
        KeyProperties.ENCRYPTION_PADDING_NONE in encryptionPaddings
}

internal class TvTlsKeyGenerationException(cause: Throwable) :
    IllegalStateException("tv-client-tls-key-generation", cause)
