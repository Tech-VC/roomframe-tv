package org.roomframe.tv.experience

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

object CanonicalJson {
    fun encode(value: Any?): ByteArray = stringify(value).toByteArray(StandardCharsets.UTF_8)

    fun stringify(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
            prefix = "{",
            postfix = "}",
            separator = ",",
        ) { key -> "${quote(key)}:${stringify(value.get(key))}" }
        is JSONArray -> (0 until value.length()).joinToString(
            prefix = "[",
            postfix = "]",
            separator = ",",
        ) { index -> stringify(value.get(index)) }
        is String -> quote(value)
        is Boolean -> value.toString()
        is Number -> JSONObject.numberToString(value)
        else -> throw IllegalArgumentException("Type JSON non supporté")
    }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }

    /**
     * Android's platform `JSONObject.quote` escapes every `/`, unlike the
     * Python/JavaScript canonical JSON produced by the RoomFrame server.
     * Encode strings here so signatures and hashes are identical on Android.
     */
    private fun quote(value: String): String = buildString(value.length + 2) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                in '\u0000'..'\u001f' -> append(
                    "\\u${character.code.toString(16).padStart(4, '0')}",
                )
                else -> append(character)
            }
        }
        append('"')
    }
}
