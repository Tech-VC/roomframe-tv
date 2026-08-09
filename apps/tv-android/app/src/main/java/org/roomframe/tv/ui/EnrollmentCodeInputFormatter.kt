package org.roomframe.tv.ui

/** Keeps TV enrollment input numeric and readable without making users type separators. */
object EnrollmentCodeInputFormatter {
    const val MAX_DIGITS = 16

    fun format(value: CharSequence): String = value
        .asSequence()
        .filter { it in '0'..'9' }
        .take(MAX_DIGITS)
        .toList()
        .chunked(4)
        .joinToString("-") { it.joinToString("") }

    fun selectionAfterFormatting(value: CharSequence, selectionStart: Int): Int {
        val safeSelection = selectionStart.coerceIn(0, value.length)
        val digitCount = value
            .take(safeSelection)
            .count { it in '0'..'9' }
            .coerceAtMost(MAX_DIGITS)
        if (digitCount == 0) return 0
        return digitCount + ((digitCount - 1) / 4)
    }
}
