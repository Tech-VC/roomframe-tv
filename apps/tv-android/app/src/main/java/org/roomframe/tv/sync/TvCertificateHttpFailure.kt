package org.roomframe.tv.sync

import org.json.JSONObject

object TvCertificateHttpFailure {
    fun safeReason(
        status: Int,
        responseBody: String,
        clientCertificatePresented: Boolean,
    ): String {
        val code = runCatching { JSONObject(responseBody).optString("error") }.getOrNull()
        val reason = when (code) {
            "invalid_tv_credentials" -> "identité TV refusée"
            "invalid_tv_client_certificate" -> "certificat TV inconnu"
            "tv_client_certificate_required" -> "certificat TV absent"
            else -> null
        }
        val presentation = if (clientCertificatePresented) "mTLS présenté" else "mTLS absent"
        return listOfNotNull("HTTP $status", reason, presentation)
            .joinToString(prefix = "Certificat TV refusé (", postfix = ")")
    }
}
