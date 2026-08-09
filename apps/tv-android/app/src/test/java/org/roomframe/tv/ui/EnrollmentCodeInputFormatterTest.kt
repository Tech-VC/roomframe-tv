package org.roomframe.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class EnrollmentCodeInputFormatterTest {
    @Test
    fun `ajoute les separateurs et limite a seize chiffres`() {
        assertEquals("", EnrollmentCodeInputFormatter.format("lettres"))
        assertEquals("1234", EnrollmentCodeInputFormatter.format("12 34"))
        assertEquals("1234-5", EnrollmentCodeInputFormatter.format("12345"))
        assertEquals(
            "1234-5678-9012-3456",
            EnrollmentCodeInputFormatter.format("12 34-56a78/9012.34567890"),
        )
    }

    @Test
    fun `replace le curseur apres les separateurs automatiques`() {
        assertEquals(0, EnrollmentCodeInputFormatter.selectionAfterFormatting("", 0))
        assertEquals(4, EnrollmentCodeInputFormatter.selectionAfterFormatting("1234", 4))
        assertEquals(6, EnrollmentCodeInputFormatter.selectionAfterFormatting("12345", 5))
        assertEquals(11, EnrollmentCodeInputFormatter.selectionAfterFormatting("1234-56789", 10))
        assertEquals(19, EnrollmentCodeInputFormatter.selectionAfterFormatting("1".repeat(24), 24))
    }

    @Test
    fun `nettoie un collage sans compter les caracteres rejetes dans le curseur`() {
        val pasted = " 12AB34-56 "
        assertEquals("1234-56", EnrollmentCodeInputFormatter.format(pasted))
        assertEquals(
            7,
            EnrollmentCodeInputFormatter.selectionAfterFormatting(pasted, pasted.length),
        )
    }
}
