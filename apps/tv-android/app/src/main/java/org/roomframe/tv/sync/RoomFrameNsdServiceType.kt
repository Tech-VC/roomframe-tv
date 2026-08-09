package org.roomframe.tv.sync

import java.util.Locale

internal object RoomFrameNsdServiceType {
    const val QUERY = "_roomframe._tcp"

    fun normalize(value: String): String =
        value.trim().trimEnd('.').lowercase(Locale.ROOT)

    fun matches(value: String): Boolean = normalize(value) == QUERY

    fun serviceKey(serviceName: String, serviceType: String): String =
        "$serviceName\u0000${normalize(serviceType)}"
}
