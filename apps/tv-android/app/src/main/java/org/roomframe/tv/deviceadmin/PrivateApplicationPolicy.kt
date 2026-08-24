package org.roomframe.tv.deviceadmin

private val SAFE_APPLICATION_ID =
    Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")

/**
 * Borne la politique Device Owner aux seules applications explicitement
 * choisies. Les composants indispensables au démarrage, au HOME, à la TV et
 * au magasin ne peuvent jamais être masqués par l'espace privé.
 */
internal object PrivateApplicationPolicy {
    private val protectedPackages = setOf(
        "android",
        "com.android.settings",
        "com.android.systemui",
        "com.android.vending",
        "com.google.android.apps.tv.launcherx",
        "com.google.android.tvlauncher",
        "com.google.android.tungsten.setupwraith",
        "com.google.android.setupwizard",
        "com.mediatek.wwtv.tvcenter",
        "com.google.android.apps.mediashell",
    )
    private val protectedPrefixes = setOf(
        "org.roomframe.",
        "org.droidtv.",
        "com.android.",
        "com.google.android.apps.tv.launcher",
        "com.google.android.gms",
        "com.google.android.gsf",
        "com.google.android.tungsten.",
        "com.mediatek.",
        "com.philips.",
        "com.tpvision.",
    )

    fun controllable(applicationId: String, ownApplicationId: String): Boolean =
        validIdentifier(applicationId) &&
            applicationId != ownApplicationId &&
            applicationId !in protectedPackages &&
            protectedPrefixes.none(applicationId::startsWith)

    fun validIdentifier(applicationId: String): Boolean =
        applicationId.length <= MAX_APPLICATION_ID_LENGTH &&
            SAFE_APPLICATION_ID.matches(applicationId)

    fun sanitize(
        configuredApplicationIds: List<String>,
        ownApplicationId: String,
    ): List<String> = configuredApplicationIds
        .asSequence()
        .distinct()
        .take(MAX_CONFIGURED_APPLICATIONS)
        .filter { controllable(it, ownApplicationId) }
        .toList()

    fun transition(
        previouslyManaged: Set<String>,
        configuredApplicationIds: List<String>,
        ownApplicationId: String,
    ): PrivateApplicationTransition {
        val desired = sanitize(configuredApplicationIds, ownApplicationId).toSet()
        val previous = previouslyManaged
            .filterTo(linkedSetOf()) { controllable(it, ownApplicationId) }
        return PrivateApplicationTransition(
            release = previous - desired,
            manage = desired,
        )
    }

    private const val MAX_CONFIGURED_APPLICATIONS = 12
    private const val MAX_APPLICATION_ID_LENGTH = 255
}

internal data class PrivateApplicationTransition(
    val release: Set<String>,
    val manage: Set<String>,
)

internal fun pendingPrivateApplicationReleases(
    releaseCandidates: Set<String>,
    successfullyReleased: Set<String>,
): Set<String> {
    require(successfullyReleased.all(releaseCandidates::contains)) {
        "Une application libérée doit appartenir aux retraits en attente"
    }
    return releaseCandidates - successfullyReleased
}

/**
 * Une nouvelle allowlist n'est confiée au Device Owner qu'après libération
 * complète de l'ancienne. Cette barrière empêche les retraits en échec de
 * s'accumuler puis d'être oubliés au fil de plusieurs rotations.
 */
internal fun managedPrivateApplicationsAfterRelease(
    manageCandidates: Set<String>,
    previouslyManaged: Set<String>,
    pendingRelease: Set<String>,
): Set<String> = if (pendingRelease.isEmpty()) {
    manageCandidates
} else {
    manageCandidates intersect previouslyManaged
}

internal data class PrivateApplicationReconciliation(
    val desired: Set<String>,
    val manage: Set<String>,
    val release: Set<String>,
)

internal fun privateApplicationReconciliation(
    desired: Set<String>,
    previouslyManaged: Set<String>,
    pendingRelease: Set<String>,
    runtimeControllable: Set<String>,
): PrivateApplicationReconciliation {
    val manage = desired intersect runtimeControllable
    return PrivateApplicationReconciliation(
        desired = desired,
        manage = manage,
        release = (previouslyManaged - manage) + (pendingRelease - manage),
    )
}
