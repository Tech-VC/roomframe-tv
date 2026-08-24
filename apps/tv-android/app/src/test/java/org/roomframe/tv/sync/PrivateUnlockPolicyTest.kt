package org.roomframe.tv.sync

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PrivateUnlockPolicyTest {
    @Test
    fun `unlock accepts only the generation requested by this TV`() {
        assertEquals(
            PrivateUnlockResult.Granted(8),
            privateUnlockResult(
                200,
                JSONObject().put("granted", true).put("generation", 8),
                8,
            ),
        )
        assertEquals(
            PrivateUnlockResult.StaleGeneration,
            privateUnlockResult(
                200,
                JSONObject().put("granted", true).put("generation", 9),
                8,
            ),
        )
    }

    @Test
    fun `unlock distinguishes invalid locked and unavailable errors`() {
        assertEquals(
            PrivateUnlockResult.Invalid,
            privateUnlockResult(
                401,
                JSONObject().put("error", "private_access_pin_invalid"),
                4,
            ),
        )
        assertEquals(
            PrivateUnlockResult.Locked(75),
            privateUnlockResult(
                429,
                JSONObject().put("error", "locked").put("retryAfterSeconds", 75),
                4,
            ),
        )
        assertEquals(
            PrivateUnlockResult.Unavailable,
            privateUnlockResult(401, JSONObject().put("error", "unknown_tv"), 4),
        )
        assertEquals(
            PrivateUnlockResult.Unavailable,
            privateUnlockResult(
                409,
                JSONObject().put("error", "private_access_disabled"),
                4,
            ),
        )
        assertEquals(
            PrivateUnlockResult.Unavailable,
            privateUnlockResult(
                401,
                JSONObject().put("error", "tv_client_certificate_required"),
                4,
            ),
        )
        listOf("invalid_pin", "certificate_invalid", "device_auth_invalid").forEach { error ->
            assertEquals(
                error,
                PrivateUnlockResult.Unavailable,
                privateUnlockResult(
                    401,
                    JSONObject().put("error", error),
                    4,
                ),
            )
        }
    }
}
