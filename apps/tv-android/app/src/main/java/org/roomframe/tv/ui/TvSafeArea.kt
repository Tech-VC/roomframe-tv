package org.roomframe.tv.ui

import kotlin.math.roundToInt

object TvSafeArea {
    private const val HORIZONTAL_SAFE_MARGIN_RATIO = 0.15f
    private const val MINIMUM_HORIZONTAL_MARGIN_DP = 48
    private const val MAXIMUM_CONTENT_WIDTH_DP = 640

    fun contentWidthPx(displayWidthPx: Int, density: Float): Int {
        require(displayWidthPx > 0) { "La largeur d’affichage doit être positive" }
        require(density > 0f && density.isFinite()) { "La densité d’affichage doit être positive" }

        val proportionalMargin =
            (displayWidthPx * HORIZONTAL_SAFE_MARGIN_RATIO).roundToInt()
        val minimumMargin = (MINIMUM_HORIZONTAL_MARGIN_DP * density).roundToInt()
        val safeMargin = maxOf(proportionalMargin, minimumMargin)
        val availableWidth = (displayWidthPx - (safeMargin * 2)).coerceAtLeast(1)
        val maximumContentWidth = (MAXIMUM_CONTENT_WIDTH_DP * density).roundToInt()

        return minOf(availableWidth, maximumContentWidth).coerceAtLeast(1)
    }
}
