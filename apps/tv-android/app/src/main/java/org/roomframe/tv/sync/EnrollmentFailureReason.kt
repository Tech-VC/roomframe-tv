package org.roomframe.tv.sync

import java.io.IOException
import java.net.SocketTimeoutException
import javax.crypto.AEADBadTagException
import javax.net.ssl.SSLException

/** Produces a bounded enrollment failure reason without exposing remote or user input. */
object EnrollmentFailureReason {
    fun describe(error: Throwable): String {
        val causes = causeChain(error)

        causes.forEach { cause ->
            val message = cause.message.orEmpty()
            val status = HTTP_STATUS.find(message)?.groupValues?.get(1)
            if (status != null) {
                return when {
                    message.startsWith("Code d’installation refusé") ->
                        "vérification du code · HTTP $status"
                    message.startsWith("Enrôlement refusé") ->
                        "création de la TV · HTTP $status"
                    else -> "réponse du serveur · HTTP $status"
                }
            }
        }

        if (causes.any { it is TvTlsKeyGenerationException }) {
            return "création de la clé sécurisée impossible"
        }
        if (causes.any(::isAndroidKeyStoreFailure)) {
            return "accès à la clé sécurisée impossible"
        }
        if (causes.any { it is AEADBadTagException }) {
            return "déchiffrement du code impossible"
        }
        if (causes.any(::isEnrollmentPayloadFailure)) {
            return "paquet d’installation invalide"
        }
        if (causes.any { it.javaClass.name == "org.json.JSONException" }) {
            return "réponse du serveur invalide"
        }
        if (causes.any { it.message == "Code d’installation invalide" }) {
            return "code d’installation invalide"
        }
        if (causes.any { it is SSLException }) {
            return "connexion HTTPS impossible"
        }
        if (causes.any { it is SocketTimeoutException }) {
            return "délai de connexion dépassé"
        }
        if (causes.any { it is IOException }) {
            return "serveur injoignable"
        }

        val type = causes.lastOrNull()?.javaClass?.simpleName
            ?.takeIf { SAFE_TYPE.matches(it) }
            ?: "ErreurInconnue"
        return "échec local · $type"
    }

    private fun causeChain(error: Throwable): List<Throwable> {
        val causes = mutableListOf<Throwable>()
        var current: Throwable? = error
        while (current != null && causes.size < MAX_CAUSE_DEPTH) {
            if (causes.any { it === current }) break
            causes += current
            current = current.cause
        }
        return causes
    }

    private fun isAndroidKeyStoreFailure(error: Throwable): Boolean {
        val type = error.javaClass.name
        return type.contains("KeyStore", ignoreCase = true) ||
            error.message.orEmpty().contains("AndroidKeyStore", ignoreCase = true) ||
            error.message.orEmpty().contains("Incompatible padding mode", ignoreCase = true)
    }

    private fun isEnrollmentPayloadFailure(error: Throwable): Boolean {
        val message = error.message.orEmpty().lowercase()
        return ENROLLMENT_PAYLOAD_MARKERS.any(message::contains)
    }

    private const val MAX_CAUSE_DEPTH = 8
    private val HTTP_STATUS = Regex("\\bHTTP ([1-5][0-9]{2})\\b")
    private val SAFE_TYPE = Regex("[A-Za-z][A-Za-z0-9]{0,39}")
    private val ENROLLMENT_PAYLOAD_MARKERS = listOf(
        "chiffrement de code d’installation",
        "dérivation de code d’installation",
        "contexte de code d’installation",
        "sel d’installation",
        "iv d’installation",
        "paquet d’installation",
        "tag d’installation",
        "autorité https d’installation",
        "empreinte https d’installation",
    )
}
