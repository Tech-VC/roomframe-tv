package org.roomframe.tv.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialRotationPolicyTest {
    private val now = 2_000_000_000_000L

    @Test
    fun `une identite recente ne tourne pas avant trente jours`() {
        val credentials = credentials(
            rotatedAt = now - CredentialRotationPolicy.ROTATION_INTERVAL_MS + 1,
        )

        assertFalse(CredentialRotationPolicy.isDue(credentials, now))
    }

    @Test
    fun `une identite ancienne ou migree doit tourner`() {
        assertTrue(CredentialRotationPolicy.isDue(credentials(rotatedAt = 0), now))
        assertTrue(
            CredentialRotationPolicy.isDue(
                credentials(
                    rotatedAt = now - CredentialRotationPolicy.ROTATION_INTERVAL_MS,
                ),
                now,
            ),
        )
    }

    @Test
    fun `une rotation en attente est toujours reprise`() {
        val credentials = credentials(rotatedAt = now).copy(
            pendingDeviceKey = CredentialRotationPolicy.generateKey(),
            pendingCredentialGeneration = 2,
        )

        assertTrue(CredentialRotationPolicy.isDue(credentials, now))
    }

    @Test
    fun `les nouvelles cles sont aleatoires et conformes`() {
        val first = CredentialRotationPolicy.generateKey()
        val second = CredentialRotationPolicy.generateKey()

        assertTrue(first.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        assertTrue(second.matches(Regex("^[A-Za-z0-9_-]{43}$")))
        assertNotEquals(first, second)
    }

    private fun credentials(rotatedAt: Long) = DeviceCredentials(
        serverUrl = "https://roomframe.example.local",
        deviceId = "00000000-0000-4000-8000-000000000001",
        deviceKey = "A".repeat(43),
        credentialGeneration = 1,
        credentialRotatedAtEpochMs = rotatedAt,
    )
}
