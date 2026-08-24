package org.roomframe.tv.deviceadmin

internal data class PrivateApplicationRuntimeDescriptor(
    val applicationId: String,
    val persistent: Boolean,
    val systemApplication: Boolean,
    val updatedSystemApplication: Boolean,
    val providesHome: Boolean,
    val exposesProtectedComponent: Boolean,
    val launchable: Boolean,
)

/** Défense runtime : une simple chaîne de package ne suffit jamais au DPM. */
internal fun privateApplicationRuntimeControllable(
    descriptor: PrivateApplicationRuntimeDescriptor,
): Boolean {
    if (descriptor.persistent || descriptor.providesHome || descriptor.exposesProtectedComponent) {
        return false
    }
    if (!descriptor.launchable) return false
    val systemApplication = descriptor.systemApplication || descriptor.updatedSystemApplication
    return !systemApplication || descriptor.applicationId in EXPLICIT_SYSTEM_MEDIA_ALLOWLIST
}

private val EXPLICIT_SYSTEM_MEDIA_ALLOWLIST = setOf(
    "com.google.android.youtube.tv",
)
