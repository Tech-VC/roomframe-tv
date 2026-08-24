package org.roomframe.tv.ui

/**
 * Distingue un vrai retour Home d'un simple retour depuis une application :
 * Back conserve la session, Home la referme.
 */
internal fun shouldLockPrivateSessionFromNavigation(
    action: String?,
    hasHomeCategory: Boolean,
    explicitHomeRedirect: Boolean,
): Boolean = explicitHomeRedirect ||
    (action == "android.intent.action.MAIN" && hasHomeCategory)
