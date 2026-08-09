package org.roomframe.tv.sync

import java.net.SocketTimeoutException
import java.security.InvalidAlgorithmParameterException
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class EnrollmentFailureReasonTest {
    @Test
    fun `remonte le statut HTTP de la derniere origine sans recopier sa reponse`() {
        val error = IllegalStateException(
            "Aucune origine RoomFrame n’a accepté le code d’installation",
            IllegalStateException("Code d’installation refusé (HTTP 404) secret-body"),
        )

        val reason = EnrollmentFailureReason.describe(error)

        assertEquals("vérification du code · HTTP 404", reason)
        assertFalse(reason.contains("secret-body"))
    }

    @Test
    fun `distingue le dechiffrement de la generation Keystore`() {
        assertEquals(
            "déchiffrement du code impossible",
            EnrollmentFailureReason.describe(
                IllegalStateException("outer", AEADBadTagException("secret code and URL")),
            ),
        )
        assertEquals(
            "création de la clé sécurisée impossible",
            EnrollmentFailureReason.describe(
                IllegalStateException(
                    "outer",
                    TvTlsKeyGenerationException(
                        InvalidAlgorithmParameterException("https://private.invalid secret"),
                    ),
                ),
            ),
        )
    }

    @Test
    fun `borne les erreurs reseau et inconnues a un type sur`() {
        assertEquals(
            "délai de connexion dépassé",
            EnrollmentFailureReason.describe(SocketTimeoutException("https://private.invalid")),
        )
        val unknown = EnrollmentFailureReason.describe(
            IllegalStateException("https://private.invalid secret-response"),
        )
        assertEquals("échec local · IllegalStateException", unknown)
        assertFalse(unknown.contains("private.invalid"))
        assertFalse(unknown.contains("secret-response"))
    }
}
