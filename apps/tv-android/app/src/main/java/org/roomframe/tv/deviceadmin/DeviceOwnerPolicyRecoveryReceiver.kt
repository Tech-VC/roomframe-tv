package org.roomframe.tv.deviceadmin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.io.File

/**
 * Narrow ADB/shell recovery for the persistent HOME preference.
 *
 * The manifest requires the platform DUMP permission from the caller. The
 * receiver cannot remove Device Owner, disable packages or change any other
 * policy, and it never accepts data from the intent.
 */
class DeviceOwnerPolicyRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_STATUS) {
            resultData = runtimeStatus(context)
            return
        }
        val policy = AndroidPersistentHomePolicy.from(context)
        val result = when (intent.action) {
            ACTION_APPLY -> policy.ensureApplied()
            ACTION_CLEAR -> policy.clearForMaintenance()
            else -> PersistentHomePolicyResult.FAILED
        }
        resultData = result.name
    }

    companion object {
        const val ACTION_APPLY = "org.roomframe.tv.maintenance.APPLY_PERSISTENT_HOME"
        const val ACTION_CLEAR = "org.roomframe.tv.maintenance.CLEAR_PERSISTENT_HOME"
        const val ACTION_STATUS = "org.roomframe.tv.maintenance.READ_RUNTIME_STATUS"

        private fun runtimeStatus(context: Context): String {
            val runtime = context.getSharedPreferences("roomframe-runtime", Context.MODE_PRIVATE)
            val activeRevision = File(context.filesDir, "experience/active")
                .takeIf { it.isFile && it.length() in 1..80 }
                ?.readText()
                ?.trim()
                ?.takeIf { it.matches(Regex("^[A-Za-z0-9._-]{1,80}$")) }
                ?: "bundled"
            fun exactState(name: String, allowed: Set<String>): String = runtime
                .getString(name, null)
                ?.takeIf(allowed::contains)
                ?: "unknown"
            val rawSync = runtime.getString("last_sync_state", null)
            val sync = when {
                rawSync == "up-to-date" -> rawSync
                rawSync?.matches(Regex("^active:sync-[0-9]+$")) == true -> rawSync
                rawSync?.startsWith("failed:") == true -> {
                    val httpCode = Regex("HTTP ([0-9]{3})").find(rawSync)?.groupValues?.get(1)
                    if (httpCode == null) "failed:validation-or-network" else "failed:http-$httpCode"
                }
                else -> "unknown"
            }
            val rawCertificate = runtime.getString("last_certificate_state", null)
            val certificate = when {
                rawCertificate == "legacy" -> rawCertificate
                rawCertificate?.startsWith("active:") == true -> "active"
                rawCertificate?.startsWith("pending:") == true -> "pending"
                rawCertificate?.contains("identité TV refusée") == true -> "failed:credentials"
                rawCertificate?.contains("certificat TV absent") == true -> "failed:mtls-absent"
                rawCertificate?.contains("certificat TV inconnu") == true -> "failed:mtls-unknown"
                rawCertificate?.startsWith("failed:") == true -> {
                    val httpCode = Regex("HTTP ([0-9]{3})")
                        .find(rawCertificate)
                        ?.groupValues
                        ?.get(1)
                    if (httpCode == null) "failed:other" else "failed:http-$httpCode"
                }
                else -> "unknown"
            }
            val rawRotation = runtime.getString("last_credential_rotation", null)
            val rotation = when {
                rawRotation == "current" -> rawRotation
                rawRotation?.matches(Regex("^rotated:g[0-9]+$")) == true -> rawRotation
                rawRotation?.startsWith("pending:") == true -> "pending"
                rawRotation?.startsWith("failed:") == true -> "failed"
                else -> "unknown"
            }
            return listOf(
                "revision=$activeRevision",
                "sync=$sync",
                "metrics=${exactState("last_metric_delivery", setOf("accepted", "failed"))}",
                "heartbeat=${exactState("last_heartbeat_state", setOf("accepted", "failed"))}",
                "certificate=$certificate",
                "rotation=$rotation",
            ).joinToString(";")
        }
    }
}
