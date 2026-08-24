package org.roomframe.tv.adapters

import org.junit.Assert.assertEquals
import org.junit.Test

class CastReceiverBindingCoordinatorTest {
    @Test
    fun `accepted binding stays starting until the service connects`() {
        var binds = 0
        val coordinator = CastReceiverBindingCoordinator(
            bind = { binds += 1; true },
            unbind = {},
            nowMillis = { 1_000L },
        )

        assertEquals(CastReceiverBindingResult.STARTING, coordinator.ensureBound())
        assertEquals(CastReceiverBindingResult.STARTING, coordinator.ensureBound())
        assertEquals(1, binds)

        coordinator.onConnected()

        assertEquals(CastReceiverBindingResult.READY, coordinator.ensureBound())
        assertEquals(1, binds)
    }

    @Test
    fun `callback timeout releases the old binding before retrying`() {
        var now = 1_000L
        var binds = 0
        var unbinds = 0
        val coordinator = CastReceiverBindingCoordinator(
            bind = { binds += 1; true },
            unbind = { unbinds += 1 },
            retryAfterMillis = 10_000L,
            nowMillis = { now },
        )

        assertEquals(CastReceiverBindingResult.STARTING, coordinator.ensureBound())
        now += 10_000L
        assertEquals(CastReceiverBindingResult.STARTING, coordinator.ensureBound())

        assertEquals(2, binds)
        assertEquals(1, unbinds)
    }

    @Test
    fun `temporary disconnect keeps the registered connection`() {
        var now = 1_000L
        var binds = 0
        var unbinds = 0
        val coordinator = CastReceiverBindingCoordinator(
            bind = { binds += 1; true },
            unbind = { unbinds += 1 },
            nowMillis = { now },
        )

        coordinator.ensureBound()
        coordinator.onConnected()
        coordinator.onDisconnected()

        assertEquals(CastReceiverBindingResult.STARTING, coordinator.ensureBound())
        assertEquals(1, binds)
        assertEquals(0, unbinds)
    }

    @Test
    fun `dead or null bindings are released before a later retry`() {
        var binds = 0
        var unbinds = 0
        val coordinator = CastReceiverBindingCoordinator(
            bind = { binds += 1; true },
            unbind = { unbinds += 1 },
            nowMillis = { 1_000L },
        )

        coordinator.ensureBound()
        coordinator.onBindingDied()
        coordinator.ensureBound()
        coordinator.onNullBinding()
        coordinator.ensureBound()

        assertEquals(3, binds)
        assertEquals(2, unbinds)
    }

    @Test
    fun `rejected or failing bind reports failure without a stale binding`() {
        var attempts = 0
        val coordinator = CastReceiverBindingCoordinator(
            bind = {
                attempts += 1
                if (attempts == 1) false else error("receiver rejected")
            },
            unbind = {},
            nowMillis = { 1_000L },
        )

        assertEquals(CastReceiverBindingResult.FAILED, coordinator.ensureBound())
        assertEquals(CastReceiverBindingResult.FAILED, coordinator.ensureBound())
        assertEquals(2, attempts)
    }
}
