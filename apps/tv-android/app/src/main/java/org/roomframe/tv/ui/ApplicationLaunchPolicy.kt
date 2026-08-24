package org.roomframe.tv.ui

private val SAFE_ANDROID_APPLICATION_ID =
    Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")

internal enum class ApplicationLaunchResult {
    LAUNCHED,
    STORE_OPENED,
    INVALID_CONFIGURATION,
    UNAVAILABLE,
}

internal fun launchOrInstallApplication(
    applicationId: String?,
    launchInstalled: (String) -> Boolean,
    openStore: (String) -> Boolean,
): ApplicationLaunchResult {
    val normalized = applicationId?.trim().orEmpty()
    if (!SAFE_ANDROID_APPLICATION_ID.matches(normalized)) {
        return ApplicationLaunchResult.INVALID_CONFIGURATION
    }
    if (runCatching { launchInstalled(normalized) }.getOrDefault(false)) {
        return ApplicationLaunchResult.LAUNCHED
    }
    if (runCatching { openStore(normalized) }.getOrDefault(false)) {
        return ApplicationLaunchResult.STORE_OPENED
    }
    return ApplicationLaunchResult.UNAVAILABLE
}
