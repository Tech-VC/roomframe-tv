package org.roomframe.tv.adapters

internal object PhilipsTa1Profile {
    const val AIRPLAY_PACKAGE = "com.mediatek.AirplayAPK"
    const val CAST_PACKAGE = "com.google.android.apps.mediashell"

    fun matches(manufacturer: String, brand: String, product: String): Boolean =
        manufacturer.equals("TPV", ignoreCase = true) &&
            brand.equals("Philips", ignoreCase = true) &&
            product == "PH1M_WW_9972"

    fun hdmiInputId(inputIds: List<String>, port: Int): String? {
        if (port !in 1..4) return null
        val expectedHardwareId = port + 1
        return inputIds
            .sorted()
            .firstOrNull { inputId ->
                Regex("/HW(\\d+)$").find(inputId)?.groupValues?.getOrNull(1)?.toIntOrNull() ==
                    expectedHardwareId
            }
            ?: inputIds.sorted().getOrNull(port - 1)
    }
}
