package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApplicationLaunchPolicyTest {
    @Test
    fun `une application installée est ouverte sans solliciter le store`() {
        var storeCalled = false
        val result = launchOrInstallApplication(
            "com.canal.android.canal",
            launchInstalled = { true },
            openStore = {
                storeCalled = true
                true
            },
        )

        assertEquals(ApplicationLaunchResult.LAUNCHED, result)
        assertFalse(storeCalled)
    }

    @Test
    fun `une application absente ouvre sa fiche Google Play`() {
        var requestedApplicationId: String? = null
        val result = launchOrInstallApplication(
            "com.google.android.youtube.tv",
            launchInstalled = { false },
            openStore = {
                requestedApplicationId = it
                true
            },
        )

        assertEquals(ApplicationLaunchResult.STORE_OPENED, result)
        assertEquals("com.google.android.youtube.tv", requestedApplicationId)
    }

    @Test
    fun `une configuration invalide ne lance rien`() {
        var called = false
        val result = launchOrInstallApplication(
            "https://example.invalid/app",
            launchInstalled = {
                called = true
                true
            },
            openStore = {
                called = true
                true
            },
        )

        assertEquals(ApplicationLaunchResult.INVALID_CONFIGURATION, result)
        assertFalse(called)
    }

    @Test
    fun `un store indisponible produit un état explicite`() {
        val result = launchOrInstallApplication(
            "com.example.application",
            launchInstalled = { false },
            openStore = { false },
        )

        assertEquals(ApplicationLaunchResult.UNAVAILABLE, result)
        assertTrue(result != ApplicationLaunchResult.LAUNCHED)
    }
}
