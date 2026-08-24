package org.roomframe.tv.deviceadmin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateApplicationPolicyTest {
    @Test
    fun `policy accepts selected media applications only`() {
        assertTrue(
            PrivateApplicationPolicy.controllable(
                "com.canal.android.canal",
                "org.roomframe.tv",
            ),
        )
        assertTrue(
            PrivateApplicationPolicy.controllable(
                "com.google.android.youtube.tv",
                "org.roomframe.tv",
            ),
        )
        assertFalse(
            PrivateApplicationPolicy.controllable(
                "org.roomframe.tv",
                "org.roomframe.tv",
            ),
        )
    }

    @Test
    fun `policy never controls launchers store system or TV packages`() {
        listOf(
            "com.android.vending",
            "com.android.systemui",
            "com.google.android.apps.tv.launcherx",
            "com.google.android.tungsten.setupwraith",
            "com.mediatek.wwtv.tvcenter",
            "com.google.android.apps.mediashell",
            "com.google.android.gms",
            "org.droidtv.tv.media",
            "com.philips.tv.launcher",
            "com.tpvision.tv.settings",
        ).forEach { applicationId ->
            assertFalse(
                applicationId,
                PrivateApplicationPolicy.controllable(applicationId, "org.roomframe.tv"),
            )
        }
    }

    @Test
    fun `allowlist transition releases removed applications before forgetting them`() {
        val transition = PrivateApplicationPolicy.transition(
            previouslyManaged = setOf(
                "com.canal.android.canal",
                "com.google.android.youtube.tv",
            ),
            configuredApplicationIds = listOf("com.google.android.youtube.tv"),
            ownApplicationId = "org.roomframe.tv",
        )

        assertEquals(setOf("com.canal.android.canal"), transition.release)
        assertEquals(setOf("com.google.android.youtube.tv"), transition.manage)
    }

    @Test
    fun `disabled policy releases every previously managed application`() {
        val transition = PrivateApplicationPolicy.transition(
            previouslyManaged = setOf("com.canal.android.canal"),
            configuredApplicationIds = emptyList(),
            ownApplicationId = "org.roomframe.tv",
        )

        assertEquals(setOf("com.canal.android.canal"), transition.release)
        assertTrue(transition.manage.isEmpty())
    }

    @Test
    fun `a failed release is retried without being hidden again on restart`() {
        val applicationId = "com.canal.android.canal"
        val afterFirstFailure = pendingPrivateApplicationReleases(
            releaseCandidates = setOf(applicationId),
            successfullyReleased = emptySet(),
        )
        val afterSuccessfulRetry = pendingPrivateApplicationReleases(
            releaseCandidates = afterFirstFailure,
            successfullyReleased = setOf(applicationId),
        )

        assertEquals(setOf(applicationId), afterFirstFailure)
        assertTrue(afterSuccessfulRetry.isEmpty())
    }

    @Test
    fun `two full rotations cannot accumulate or forget failed releases`() {
        val first = (1..12).map { "org.example.first$it" }.toSet()
        val second = (1..12).map { "org.example.second$it" }.toSet()
        val third = (1..12).map { "org.example.third$it" }.toSet()

        val firstRotation = privateApplicationReconciliation(
            desired = second,
            previouslyManaged = first,
            pendingRelease = emptySet(),
            runtimeControllable = second,
        )
        val firstFailures = pendingPrivateApplicationReleases(
            firstRotation.release,
            successfullyReleased = emptySet(),
        )
        val managedAfterFirstRotation = managedPrivateApplicationsAfterRelease(
            firstRotation.manage,
            previouslyManaged = first,
            pendingRelease = firstFailures,
        )

        val secondRotation = privateApplicationReconciliation(
            desired = third,
            previouslyManaged = managedAfterFirstRotation,
            pendingRelease = firstFailures,
            runtimeControllable = third,
        )
        val secondFailures = pendingPrivateApplicationReleases(
            secondRotation.release,
            successfullyReleased = emptySet(),
        )
        val managedAfterSecondRotation = managedPrivateApplicationsAfterRelease(
            secondRotation.manage,
            previouslyManaged = managedAfterFirstRotation,
            pendingRelease = secondFailures,
        )

        assertEquals(first, firstFailures)
        assertTrue(managedAfterFirstRotation.isEmpty())
        assertEquals(first, secondFailures)
        assertTrue(managedAfterSecondRotation.isEmpty())
    }

    @Test
    fun `an absent desired app is retained then managed after installation`() {
        val applicationId = "com.canal.android.canal"
        val beforeInstall = privateApplicationReconciliation(
            desired = setOf(applicationId),
            previouslyManaged = emptySet(),
            pendingRelease = emptySet(),
            runtimeControllable = emptySet(),
        )
        val afterInstall = privateApplicationReconciliation(
            desired = beforeInstall.desired,
            previouslyManaged = beforeInstall.manage,
            pendingRelease = beforeInstall.release,
            runtimeControllable = setOf(applicationId),
        )

        assertEquals(setOf(applicationId), beforeInstall.desired)
        assertTrue(beforeInstall.manage.isEmpty())
        assertEquals(setOf(applicationId), afterInstall.manage)
        assertTrue(afterInstall.release.isEmpty())
    }

    @Test
    fun `an application made protected by a newer policy is released and forgotten`() {
        val applicationId = "com.philips.legacy.media"
        val reconciliation = privateApplicationReconciliation(
            desired = setOf(applicationId),
            previouslyManaged = setOf(applicationId),
            pendingRelease = emptySet(),
            runtimeControllable = emptySet(),
        )
        val pendingAfterSuccessfulUnhide = pendingPrivateApplicationReleases(
            reconciliation.release,
            successfullyReleased = reconciliation.release,
        )

        assertEquals(setOf(applicationId), reconciliation.release)
        assertTrue(reconciliation.manage.isEmpty())
        assertTrue(pendingAfterSuccessfulUnhide.isEmpty())
    }
}
