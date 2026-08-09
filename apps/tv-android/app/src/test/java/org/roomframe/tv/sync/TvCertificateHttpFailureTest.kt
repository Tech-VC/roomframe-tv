package org.roomframe.tv.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class TvCertificateHttpFailureTest {
    @Test
    fun `decrit une absence mTLS sans recopier le corps serveur`() {
        val reason = TvCertificateHttpFailure.safeReason(
            status = 401,
            responseBody = """{"error":"tv_client_certificate_required","detail":"secret"}""",
            clientCertificatePresented = false,
        )

        assertEquals(
            "Certificat TV refusé (HTTP 401, certificat TV absent, mTLS absent)",
            reason,
        )
        assertFalse(reason.contains("secret"))
    }

    @Test
    fun `masque un code serveur non approuve`() {
        assertEquals(
            "Certificat TV refusé (HTTP 429, mTLS présenté)",
            TvCertificateHttpFailure.safeReason(
                status = 429,
                responseBody = """{"error":"detail_interne"}""",
                clientCertificatePresented = true,
            ),
        )
    }
}
