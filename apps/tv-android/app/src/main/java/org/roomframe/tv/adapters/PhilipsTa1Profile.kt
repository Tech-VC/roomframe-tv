package org.roomframe.tv.adapters

internal object PhilipsTa1Profile {
    const val AIRPLAY_PACKAGE = "com.mediatek.AirplayAPK"
    const val CAST_PACKAGE = "com.google.android.apps.mediashell"

    data class InputDescriptor(
        val id: String,
        val packageName: String,
        val isHdmi: Boolean,
    )

    data class SourceRoutes(
        val airPlayInputId: String?,
        val hdmiInputId: String?,
    )

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

    /** Capture les routes stables publiées par le firmware à cet instant. */
    fun sourceRoutes(inputs: List<InputDescriptor>, hdmiPort: Int): SourceRoutes = SourceRoutes(
        airPlayInputId = inputs
            .firstOrNull { input -> input.packageName == AIRPLAY_PACKAGE }
            ?.id,
        hdmiInputId = hdmiInputId(
            inputs.filter(InputDescriptor::isHdmi).map(InputDescriptor::id),
            hdmiPort,
        ),
    )
}

/**
 * Conserve le chemin nominal sans verrou quand une valeur est déjà connue.
 * Une route absente au démarrage peut réapparaître plus tard, mais sa recherche
 * reste limitée à une tentative par intervalle afin de garder l'appui rapide.
 */
internal class RateLimitedFallbackResolver<T>(
    initialValue: T?,
    private val retryIntervalMillis: Long = 15_000L,
    private val nowMillis: () -> Long = android.os.SystemClock::elapsedRealtime,
    private val fallback: () -> T?,
) {
    init {
        require(retryIntervalMillis > 0) { "Intervalle de nouvelle tentative invalide" }
    }

    @Volatile
    private var nextRetryAtMillis = if (initialValue == null) 0L else Long.MAX_VALUE

    @Volatile
    private var value: T? = initialValue

    fun resolve(): T? {
        value?.let { return it }
        val now = nowMillis()
        if (now < nextRetryAtMillis) return null
        return synchronized(this) {
            value?.let { return@synchronized it }
            val lockedNow = nowMillis()
            if (lockedNow < nextRetryAtMillis) return@synchronized null
            runCatching(fallback).getOrNull().also { resolved ->
                value = resolved
                nextRetryAtMillis = if (resolved == null) {
                    lockedNow + retryIntervalMillis
                } else {
                    Long.MAX_VALUE
                }
            }
        }
    }

    fun invalidate() = synchronized(this) {
        value = null
        nextRetryAtMillis = 0L
    }
}
