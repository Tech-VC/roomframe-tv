package org.roomframe.tv.ui

import org.roomframe.tv.experience.ExperienceSnapshot
import org.roomframe.tv.experience.PrivateAccessDocument
import org.roomframe.tv.experience.SourceSettingsDocument

internal enum class SourceMenuAction(val sourceKind: String?) {
    HOME(null),
    AIRPLAY("airplay"),
    CAST("cast"),
    HDMI("hdmi"),
    PRIVATE("private-app"),
}

internal data class SourceMenuEntry(
    val action: SourceMenuAction,
    val label: String,
)

internal fun sourceMenuEntries(snapshot: ExperienceSnapshot): List<SourceMenuEntry> =
    sourceMenuEntries(snapshot.sources, snapshot.privateAccess)

internal fun sourceMenuEntries(
    sources: SourceSettingsDocument,
    privateAccess: PrivateAccessDocument,
): List<SourceMenuEntry> = buildList {
    add(SourceMenuEntry(SourceMenuAction.HOME, "Accueil"))
    listOf(
        SourceMenuAction.AIRPLAY,
        SourceMenuAction.CAST,
        SourceMenuAction.HDMI,
    ).forEach { action ->
        val setting = sources.settingFor(requireNotNull(action.sourceKind))
        if (setting?.enabled != false) {
            add(
                SourceMenuEntry(
                    action = action,
                    label = setting?.label ?: when (action) {
                        SourceMenuAction.AIRPLAY -> "AirPlay"
                        SourceMenuAction.CAST -> "Cast"
                        SourceMenuAction.HDMI -> "HDMI"
                        else -> error("Action de source inattendue")
                    },
                ),
            )
        }
    }
    val privateSetting = sources.settingFor("private-app")
    if (
        privateAccess.enabled &&
        privateAccess.pinConfigured &&
        privateSetting?.enabled == true &&
        privateSetting.applicationIds.isNotEmpty()
    ) {
        add(
            SourceMenuEntry(
                SourceMenuAction.PRIVATE,
                privateSetting?.label ?: "Espace privé",
            ),
        )
    }
}

internal fun privateApplicationLabel(applicationId: String): String = when (applicationId) {
    "com.canal.android.canal" -> "CANAL+"
    "com.google.android.youtube.tv" -> "YouTube"
    else -> applicationId
        .substringAfterLast('.')
        .replace('_', ' ')
        .replaceFirstChar { character ->
            if (character.isLowerCase()) character.titlecase() else character.toString()
        }
        .ifBlank { "Application" }
}

internal fun privateApplicationGridRows(applicationCount: Int, columns: Int = 3): Int {
    require(applicationCount in 0..12) { "Nombre d'applications privées invalide" }
    require(columns in 1..4) { "Nombre de colonnes privées invalide" }
    return (applicationCount + columns - 1) / columns
}
