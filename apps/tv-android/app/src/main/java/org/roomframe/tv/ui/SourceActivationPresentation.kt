package org.roomframe.tv.ui

import org.roomframe.tv.adapters.AdapterResult

internal sealed interface SourceActivationEffect {
    data object None : SourceActivationEffect
    data object ShowCastWaiting : SourceActivationEffect
    data class ShowMessage(val message: String) : SourceActivationEffect
}

/**
 * Sépare la réponse matérielle de sa présentation. Cast ouvre un état d'attente
 * durable ; les autres sources conservent leurs messages courts.
 */
internal fun sourceActivationEffect(
    source: String,
    result: AdapterResult?,
): SourceActivationEffect = when {
    source == "cast" && (result == AdapterResult.Success || result is AdapterResult.Pending) ->
        SourceActivationEffect.ShowCastWaiting
    result == AdapterResult.Success -> SourceActivationEffect.None
    result is AdapterResult.Pending -> SourceActivationEffect.ShowMessage(result.reason)
    result is AdapterResult.Unavailable -> SourceActivationEffect.ShowMessage(result.reason)
    result is AdapterResult.Failure -> SourceActivationEffect.ShowMessage(result.reason)
    else -> SourceActivationEffect.ShowMessage("Source non prise en charge")
}
