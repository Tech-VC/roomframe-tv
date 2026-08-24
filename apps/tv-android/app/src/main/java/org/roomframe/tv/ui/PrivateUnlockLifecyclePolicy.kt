package org.roomframe.tv.ui

internal data class PrivateUnlockConfiguration(
    val epoch: Long,
    val enabled: Boolean,
    val pinConfigured: Boolean,
    val sourceEnabled: Boolean,
    val generation: Long,
    val applicationIds: List<String>,
) {
    val ready: Boolean
        get() = enabled && pinConfigured && sourceEnabled && applicationIds.isNotEmpty()

    companion object {
        fun locked(): PrivateUnlockConfiguration = PrivateUnlockConfiguration(
            epoch = 0,
            enabled = false,
            pinConfigured = false,
            sourceEnabled = false,
            generation = 0,
            applicationIds = emptyList(),
        )
    }
}

internal fun privateUnlockResultCanBeApplied(
    requested: PrivateUnlockConfiguration,
    current: PrivateUnlockConfiguration,
): Boolean = requested.ready && requested == current

internal fun nextPrivateUnlockEpoch(current: Long): Long =
    if (current == Long.MAX_VALUE) 0 else current + 1
