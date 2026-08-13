package org.roomframe.tv.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import android.widget.ImageView
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import org.roomframe.tv.R

internal fun sampledBitmapFactor(
    sourceWidth: Int,
    sourceHeight: Int,
    requestedWidth: Int,
    requestedHeight: Int,
): Int {
    if (sourceWidth <= 0 || sourceHeight <= 0 || requestedWidth <= 0 || requestedHeight <= 0) return 1
    var factor = 1
    while (
        sourceWidth / (factor * 2) >= requestedWidth &&
        sourceHeight / (factor * 2) >= requestedHeight
    ) {
        factor *= 2
    }
    return factor
}

/**
 * Décode les médias de scène hors du thread UI et à une taille proche de leur
 * surface réelle. Le cache reste borné et indexé par le fichier immuable de la
 * révision ainsi que par la taille demandée.
 */
internal object SceneBitmapLoader {
    private val executor = Executors.newFixedThreadPool(2) { task ->
        Thread(task, "roomframe-scene-image").apply { isDaemon = true }
    }
    private val cache = object : LruCache<String, Bitmap>(cacheSizeKilobytes()) {
        override fun sizeOf(key: String, value: Bitmap): Int =
            (value.allocationByteCount / 1024).coerceAtLeast(1)
    }

    fun load(
        view: ImageView,
        file: File,
        onReady: (ImageView) -> Unit = {},
    ) {
        if (view.width > 0 && view.height > 0) {
            enqueue(view, file, view.width, view.height, onReady)
            return
        }
        view.addOnLayoutChangeListener(object : android.view.View.OnLayoutChangeListener {
            override fun onLayoutChange(
                changed: android.view.View,
                left: Int,
                top: Int,
                right: Int,
                bottom: Int,
                oldLeft: Int,
                oldTop: Int,
                oldRight: Int,
                oldBottom: Int,
            ) {
                val width = right - left
                val height = bottom - top
                if (width <= 0 || height <= 0) return
                changed.removeOnLayoutChangeListener(this)
                enqueue(view, file, width, height, onReady)
            }
        })
    }

    private fun enqueue(
        view: ImageView,
        file: File,
        requestedWidth: Int,
        requestedHeight: Int,
        onReady: (ImageView) -> Unit,
    ) {
        val widthBucket = dimensionBucket(requestedWidth)
        val heightBucket = dimensionBucket(requestedHeight)
        val key = "${file.absolutePath}:${file.length()}:${file.lastModified()}:$widthBucket:$heightBucket"
        view.setTag(R.id.scene_image_request_key, key)
        cache.get(key)?.let { bitmap ->
            apply(view, key, bitmap, onReady, animate = false)
            return
        }
        val reference = WeakReference(view)
        executor.execute {
            val bitmap = decode(file, widthBucket, heightBucket) ?: return@execute
            cache.put(key, bitmap)
            val target = reference.get() ?: return@execute
            target.post { apply(target, key, bitmap, onReady, animate = true) }
        }
    }

    private fun decode(file: File, requestedWidth: Int, requestedHeight: Int): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampledBitmapFactor(
                bounds.outWidth,
                bounds.outHeight,
                requestedWidth,
                requestedHeight,
            )
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        BitmapFactory.decodeFile(file.absolutePath, options)
    }.getOrNull()

    private fun apply(
        view: ImageView,
        key: String,
        bitmap: Bitmap,
        onReady: (ImageView) -> Unit,
        animate: Boolean,
    ) {
        if (view.getTag(R.id.scene_image_request_key) != key) return
        if (animate) view.alpha = 0f
        view.setImageBitmap(bitmap)
        onReady(view)
        if (animate) view.animate().alpha(1f).setDuration(90L).start()
    }

    private fun dimensionBucket(value: Int): Int = ((value.coerceAtLeast(1) + 127) / 128) * 128

    private fun cacheSizeKilobytes(): Int = minOf(
        32 * 1024,
        (Runtime.getRuntime().maxMemory() / 8L / 1024L).toInt().coerceAtLeast(4 * 1024),
    )
}
