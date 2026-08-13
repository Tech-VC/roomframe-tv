package org.roomframe.tv.ui

internal data class SpatialFocusTarget(
    val id: String,
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
    val order: Int = 0,
) {
    val right: Float get() = left + width
    val bottom: Float get() = top + height
    val centerX: Float get() = left + width / 2f
    val centerY: Float get() = top + height / 2f
}

internal enum class SpatialFocusDirection {
    LEFT,
    RIGHT,
    UP,
    DOWN,
}

internal fun initialSpatialFocusTargetId(targets: List<SpatialFocusTarget>): String? = targets
    .minWithOrNull(
        compareBy<SpatialFocusTarget> { if (it.order > 0) 0 else 1 }
            .thenBy { if (it.order > 0) it.order else Int.MAX_VALUE }
            .thenBy(SpatialFocusTarget::top)
            .thenBy(SpatialFocusTarget::left)
            .thenBy(SpatialFocusTarget::id),
    )
    ?.id

internal fun spatialFocusNeighborId(
    targets: List<SpatialFocusTarget>,
    currentId: String,
    direction: SpatialFocusDirection,
): String? {
    val current = targets.firstOrNull { it.id == currentId } ?: return null
    return targets
        .asSequence()
        .filterNot { it.id == currentId }
        .mapNotNull { candidate ->
            val primary = when (direction) {
                SpatialFocusDirection.LEFT -> current.centerX - candidate.centerX
                SpatialFocusDirection.RIGHT -> candidate.centerX - current.centerX
                SpatialFocusDirection.UP -> current.centerY - candidate.centerY
                SpatialFocusDirection.DOWN -> candidate.centerY - current.centerY
            }
            if (primary <= 0f) return@mapNotNull null

            val verticalDirection = direction == SpatialFocusDirection.UP ||
                direction == SpatialFocusDirection.DOWN
            val aligned = if (verticalDirection) {
                rangesOverlap(current.left, current.right, candidate.left, candidate.right)
            } else {
                rangesOverlap(current.top, current.bottom, candidate.top, candidate.bottom)
            }
            val secondary = if (verticalDirection) {
                kotlin.math.abs(candidate.centerX - current.centerX)
            } else {
                kotlin.math.abs(candidate.centerY - current.centerY)
            }
            FocusCandidate(
                target = candidate,
                alignmentPenalty = if (aligned) 0 else 1,
                primaryDistance = primary,
                secondaryDistance = secondary,
                orderDistance = if (current.order > 0 && candidate.order > 0) {
                    kotlin.math.abs(candidate.order - current.order)
                } else {
                    Int.MAX_VALUE
                },
            )
        }
        .minWithOrNull(
            compareBy<FocusCandidate> { it.alignmentPenalty }
                .thenBy(FocusCandidate::primaryDistance)
                .thenBy(FocusCandidate::secondaryDistance)
                .thenBy(FocusCandidate::orderDistance)
                .thenBy { it.target.top }
                .thenBy { it.target.left }
                .thenBy { it.target.id },
        )
        ?.target
        ?.id
}

internal fun sceneForegroundColor(background: Int): Int {
    val backgroundLuminance = relativeLuminance(background)
    val darkContrast = contrastRatio(backgroundLuminance, relativeLuminance(DARK_FOREGROUND))
    val lightContrast = contrastRatio(backgroundLuminance, relativeLuminance(LIGHT_FOREGROUND))
    return if (darkContrast >= lightContrast) DARK_FOREGROUND else LIGHT_FOREGROUND
}

private data class FocusCandidate(
    val target: SpatialFocusTarget,
    val alignmentPenalty: Int,
    val primaryDistance: Float,
    val secondaryDistance: Float,
    val orderDistance: Int,
)

private fun rangesOverlap(firstStart: Float, firstEnd: Float, secondStart: Float, secondEnd: Float): Boolean =
    firstStart < secondEnd && secondStart < firstEnd

private fun relativeLuminance(color: Int): Double {
    fun linearComponent(component: Int): Double {
        val channel = component / 255.0
        return if (channel <= 0.04045) {
            channel / 12.92
        } else {
            Math.pow((channel + 0.055) / 1.055, 2.4)
        }
    }

    val red = linearComponent(color ushr 16 and 0xff)
    val green = linearComponent(color ushr 8 and 0xff)
    val blue = linearComponent(color and 0xff)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

private fun contrastRatio(firstLuminance: Double, secondLuminance: Double): Double {
    val lighter = maxOf(firstLuminance, secondLuminance)
    val darker = minOf(firstLuminance, secondLuminance)
    return (lighter + 0.05) / (darker + 0.05)
}

private val DARK_FOREGROUND: Int = 0xff000000.toInt()
private val LIGHT_FOREGROUND: Int = 0xffffffff.toInt()
