package org.roomframe.tv.deviceadmin

/** État uniquement en mémoire : tout nouveau processus redémarre verrouillé. */
internal object PrivateApplicationSessionState {
    @Volatile
    private var unlocked = false

    fun unlock() {
        unlocked = true
    }

    fun lock() {
        unlocked = false
    }

    fun isUnlocked(): Boolean = unlocked
}
