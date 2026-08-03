package org.roomframe.tv.ui

import android.app.Activity
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.TextView
import android.widget.Toast
import android.widget.VideoView
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import org.roomframe.tv.R
import org.roomframe.tv.adapters.AdapterResult
import org.roomframe.tv.adapters.DeviceAdapters
import org.roomframe.tv.adapters.SourceAdapter
import org.roomframe.tv.experience.BackgroundDocument
import org.roomframe.tv.experience.BrandingDocument
import org.roomframe.tv.experience.ExperienceSnapshot
import org.roomframe.tv.experience.NodeKind
import org.roomframe.tv.experience.SceneNodeDocument

internal fun weatherDisplayLocation(value: String): String = value
    .trim()
    .replace(Regex("\\s+\\d{4,6}$"), "")
    .trim()

internal fun weatherIconForCode(code: Int?): String = when (code) {
    0 -> "☀️"
    1, 2 -> "⛅️"
    3 -> "☁️"
    45, 48 -> "🌫️"
    51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82 -> "🌧️"
    71, 73, 75, 77, 85, 86 -> "❄️"
    95, 96, 99 -> "⛈️"
    else -> "🌡️"
}

internal fun clockPattern(showDate: Boolean, format: String): String {
    val time = if (format == "12h") "h:mm a" else "HH'h'mm"
    return if (showDate) "d MMMM - $time" else time
}

class NativeSceneRenderer(
    private val activity: Activity,
    private val adapters: DeviceAdapters,
    private val debugBackground: Drawable? = null,
    private val debugLogo: Drawable? = null,
) {
    private lateinit var snapshot: ExperienceSnapshot
    private lateinit var branding: BrandingDocument
    private var scale = 1f
    private val focusableViews = mutableListOf<Pair<Int, View>>()

    fun render(value: ExperienceSnapshot): View {
        snapshot = value
        branding = value.branding
        focusableViews.clear()
        val metrics = activity.resources.displayMetrics
        scale = min(metrics.widthPixels / CANVAS_WIDTH, metrics.heightPixels / CANVAS_HEIGHT)
        val canvasWidth = (CANVAS_WIDTH * scale).roundToInt()
        val canvasHeight = (CANVAS_HEIGHT * scale).roundToInt()

        val viewport = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        val canvas = FrameLayout(activity).apply {
            clipChildren = true
            clipToPadding = true
            contentDescription = value.scene.name
        }
        viewport.addView(
            canvas,
            FrameLayout.LayoutParams(canvasWidth, canvasHeight, Gravity.CENTER),
        )
        renderBackground(canvas, value.scene.background)
        value.scene.nodes
            .asSequence()
            .filterNot(SceneNodeDocument::hidden)
            .sortedBy(SceneNodeDocument::zIndex)
            .forEach { node ->
                renderNode(node)?.let { view ->
                    view.elevation = node.zIndex * scale
                    canvas.addView(view, geometry(node))
                }
            }
        linkDpadFocus()
        focusableViews.minByOrNull { it.first }?.second?.requestFocus()
        return viewport
    }

    private fun renderBackground(canvas: FrameLayout, background: BackgroundDocument) {
        canvas.setBackgroundColor(parseColor(background.color, Color.rgb(19, 35, 35)))
        val media = snapshot.assets.resolve(background.asset, "1080p")
        val backgroundView: View? = when {
            background.type == "video" && media?.isFile == true -> video(media, muted = true)
            media?.isFile == true -> image(media, background.mode, background.focusX, background.focusY)
            debugBackground != null && snapshot.bundled -> ImageView(activity).apply {
                setImageDrawable(debugBackground)
                scaleType = ImageView.ScaleType.CENTER_CROP
            }
            background.type != "color" -> ImageView(activity).apply {
                setImageResource(R.drawable.background_default)
                scaleType = ImageView.ScaleType.CENTER_CROP
            }
            else -> null
        }
        if (backgroundView != null) {
            val blur = background.blur.coerceIn(0f, 40f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && blur > 0f) {
                val radius = max(0.1f, scenePx(blur))
                backgroundView.setRenderEffect(
                    RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP),
                )
                val enlargement = 1f + blur / 240f
                backgroundView.scaleX = enlargement
                backgroundView.scaleY = enlargement
            }
            backgroundView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            canvas.addView(
                backgroundView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
    }

    private fun renderNode(node: SceneNodeDocument): View? = when (node.kind) {
        NodeKind.TEXT -> textNode(node)
        NodeKind.CLOCK -> clockNode(node)
        NodeKind.WEATHER -> weatherNode(node)
        NodeKind.MESSAGE -> messageNode(node)
        NodeKind.IMAGE -> mediaNode(node, preferredVariant = "1080p")
        NodeKind.VIDEO -> videoNode(node)
        NodeKind.LOGO -> logoNode(node)
        NodeKind.SOURCE -> sourceNode(node)
        NodeKind.APP -> appNode(node)
        NodeKind.NETWORK -> simpleTextNode(
            node,
            listOfNotNull(node.properties.label, node.properties.value).joinToString(" · "),
        )
    }

    private fun textNode(node: SceneNodeDocument): TextView {
        val greeting = node.properties.role == "greeting"
        return baseText(node).apply {
            text = node.properties.text.orEmpty()
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setTextSize(
                TypedValue.COMPLEX_UNIT_PX,
                scenePx((if (greeting) 44f else 34f) * node.properties.fontScale),
            )
            if (greeting) {
                isSingleLine = false
                maxLines = node.properties.maxLines.coerceIn(1, 2)
                ellipsize = TextUtils.TruncateAt.END
                setAutoSizeTextTypeUniformWithConfiguration(
                    scenePx(28f).roundToInt(),
                    scenePx(44f * node.properties.fontScale).roundToInt().coerceAtLeast(scenePx(28f).roundToInt()),
                    1,
                    TypedValue.COMPLEX_UNIT_PX,
                )
            } else {
                maxLines = node.properties.maxLines
                ellipsize = TextUtils.TruncateAt.END
            }
        }
    }

    private fun clockNode(node: SceneNodeDocument): TextClock = TextClock(activity).apply {
        val displayed = clockPattern(node.properties.showDate, node.properties.format)
        format24Hour = displayed
        format12Hour = displayed
        setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(44f * node.properties.fontScale))
        setTextColor(Color.WHITE)
        typeface = sceneTypeface()
        gravity = Gravity.END or Gravity.CENTER_VERTICAL
        includeFontPadding = false
        contentDescription = if (node.properties.showDate) "Date et heure" else "Heure"
    }

    private fun weatherNode(node: SceneNodeDocument): View {
        val reading = node.properties.locationKey?.let(snapshot.weather.readings::get)
        val location = weatherDisplayLocation(node.properties.location ?: reading?.location ?: "Météo")
        val value = when {
            reading?.temperature != null -> {
                "$location\n${weatherIconForCode(reading.weatherCode)} ${reading.temperature.roundToInt()} ${reading.temperatureUnit} · ${reading.condition ?: "Conditions inconnues"}"
            }
            node.properties.locationKey != null -> "$location\nDonnées indisponibles"
            else -> "Météo à configurer"
        }
        return LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            addView(baseText(node).apply {
                text = value
                setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(20f * node.properties.fontScale))
                gravity = Gravity.END
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
            })
            contentDescription = "$value. ${snapshot.weather.attributionLabel}"
        }
    }

    private fun messageNode(node: SceneNodeDocument): View? {
        val messages = snapshot.messages.take(node.properties.maximumItems)
        if (messages.isEmpty()) return null
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(scenePx(24f).roundToInt(), scenePx(20f).roundToInt(), scenePx(24f).roundToInt(), 0)
            setBackgroundColor(withAlpha(parseColor(branding.primary, Color.DKGRAY), 0xCC))
        }
        container.addView(baseText(node).apply {
            text = node.properties.title ?: "ACTUALITÉS"
            setTextColor(parseColor(branding.accent, Color.CYAN))
            setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(20f))
            typeface = Typeface.create(sceneTypeface(), Typeface.BOLD)
            isSingleLine = true
        })
        messages.forEach { message ->
                container.addView(baseText(node).apply {
                    text = listOf(message.title, message.body).filter(String::isNotBlank).joinToString("\n")
                    setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(18f))
                    maxLines = 3
                    ellipsize = TextUtils.TruncateAt.END
                    setPadding(0, scenePx(14f).roundToInt(), 0, 0)
                })
            }
        return container
    }

    private fun mediaNode(node: SceneNodeDocument, preferredVariant: String): View {
        val reference = node.properties.assetId ?: node.properties.asset
        val file = snapshot.assets.resolve(reference, preferredVariant)
        return if (file != null) {
            image(file, node.properties.fit, 0.5f, 0.5f)
        } else {
            placeholder(node.properties.label ?: "Image")
        }
    }

    private fun videoNode(node: SceneNodeDocument): View {
        val reference = node.properties.assetId ?: node.properties.asset
        val file = snapshot.assets.resolve(reference, "1080p")
        return if (file != null) video(file, muted = true) else placeholder("Vidéo")
    }

    private fun logoNode(node: SceneNodeDocument): View {
        val rawReference = node.properties.assetId ?: node.properties.asset
        val reference = if (
            !branding.logoAssetId.isNullOrBlank() &&
            (rawReference.isNullOrBlank() || rawReference == "assets/logo-placeholder.png")
        ) {
            branding.logoAssetId
        } else {
            rawReference
        }
        val file = snapshot.assets.resolve(reference, "logo")
        return ImageView(activity).apply {
            when {
                file != null -> setImageURI(Uri.fromFile(file))
                debugLogo != null && snapshot.bundled -> setImageDrawable(debugLogo)
                else -> setImageResource(R.drawable.logo_placeholder)
            }
            scaleType = if (node.properties.fit == "cover") {
                ImageView.ScaleType.CENTER_CROP
            } else {
                ImageView.ScaleType.FIT_CENTER
            }
            val padding = scenePx(8f).roundToInt()
            setPadding(padding, padding, padding, padding)
            contentDescription = branding.displayName
        }
    }

    private fun sourceNode(node: SceneNodeDocument): TextView {
        val source = node.properties.source.orEmpty()
        val adapter = sourceAdapter(source)
        return baseText(node).apply {
            text = node.properties.label ?: source.replaceFirstChar(Char::uppercase)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(24f))
            typeface = Typeface.create(sceneTypeface(), Typeface.BOLD)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(scenePx(22f).roundToInt(), 0, scenePx(22f).roundToInt(), 0)
            val icon = sourceIcon(source, adapter)
            val iconSize = scenePx(58f).roundToInt()
            icon?.setBounds(0, 0, iconSize, iconSize)
            setCompoundDrawablesRelative(icon, null, null, null)
            compoundDrawablePadding = scenePx(18f).roundToInt()
            setBackgroundColor(withAlpha(parseColor(branding.primary, Color.BLACK), 0xCC))
            isFocusable = true
            id = View.generateViewId()
            setOnFocusChangeListener { view, focused ->
                view.setBackgroundColor(
                    withAlpha(
                        parseColor(if (focused) branding.accent else branding.primary, Color.DKGRAY),
                        if (focused) 0xEE else 0xCC,
                    ),
                )
            }
            setOnClickListener {
                when (val result = adapter?.activate()) {
                    AdapterResult.Success -> Unit
                    is AdapterResult.Pending -> toast(result.reason)
                    is AdapterResult.Unavailable -> toast(result.reason)
                    is AdapterResult.Failure -> toast(result.reason)
                    null -> toast("Source non prise en charge")
                }
            }
            registerFocus(node, this)
        }
    }

    private fun appNode(node: SceneNodeDocument): TextView = baseText(node).apply {
        text = node.properties.label ?: "Application"
        setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(24f))
        typeface = Typeface.create(sceneTypeface(), Typeface.BOLD)
        gravity = Gravity.CENTER_VERTICAL
        setPadding(scenePx(22f).roundToInt(), 0, scenePx(22f).roundToInt(), 0)
        setBackgroundColor(withAlpha(parseColor(branding.primary, Color.BLACK), 0xCC))
        isFocusable = true
        id = View.generateViewId()
        setOnClickListener {
            val packageName = node.properties.packageName
            val launchIntent = packageName?.let {
                activity.packageManager.getLeanbackLaunchIntentForPackage(it)
                    ?: activity.packageManager.getLaunchIntentForPackage(it)
            }
            if (launchIntent == null) toast("Application non disponible")
            else runCatching { activity.startActivity(launchIntent) }
                .onFailure { toast("Ouverture de l'application impossible") }
        }
        registerFocus(node, this)
    }

    private fun simpleTextNode(node: SceneNodeDocument, value: String): TextView = baseText(node).apply {
        text = value
        setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(20f * node.properties.fontScale))
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        maxLines = node.properties.maxLines
        ellipsize = TextUtils.TruncateAt.END
    }

    private fun baseText(node: SceneNodeDocument): TextView = TextView(activity).apply {
        setTextColor(Color.WHITE)
        typeface = sceneTypeface()
        includeFontPadding = false
        contentDescription = node.properties.label ?: node.kind.wireName
    }

    private fun image(file: File, mode: String, focusX: Float, focusY: Float): ImageView =
        ImageView(activity).apply {
            setImageURI(Uri.fromFile(file))
            when (mode) {
                "contain" -> scaleType = ImageView.ScaleType.FIT_CENTER
                "focus" -> {
                    scaleType = ImageView.ScaleType.MATRIX
                    addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ ->
                        applyFocusMatrix(view as ImageView, focusX, focusY)
                    }
                }
                else -> scaleType = ImageView.ScaleType.CENTER_CROP
            }
        }

    private fun applyFocusMatrix(view: ImageView, focusX: Float, focusY: Float) {
        val drawable = view.drawable ?: return
        if (view.width <= 0 || view.height <= 0 || drawable.intrinsicWidth <= 0 || drawable.intrinsicHeight <= 0) return
        val sourceWidth = drawable.intrinsicWidth.toFloat()
        val sourceHeight = drawable.intrinsicHeight.toFloat()
        val factor = max(view.width / sourceWidth, view.height / sourceHeight)
        val renderedWidth = sourceWidth * factor
        val renderedHeight = sourceHeight * factor
        val tx = (view.width / 2f - renderedWidth * focusX).coerceIn(view.width - renderedWidth, 0f)
        val ty = (view.height / 2f - renderedHeight * focusY).coerceIn(view.height - renderedHeight, 0f)
        view.imageMatrix = Matrix().apply {
            setScale(factor, factor)
            postTranslate(tx, ty)
        }
    }

    private fun video(file: File, muted: Boolean): VideoView = VideoView(activity).apply {
        setVideoURI(Uri.fromFile(file))
        setOnPreparedListener { player ->
            player.isLooping = true
            if (muted) player.setVolume(0f, 0f)
            start()
        }
    }

    private fun placeholder(label: String): TextView = TextView(activity).apply {
        text = label
        setTextColor(Color.WHITE)
        setBackgroundColor(0x66000000)
        gravity = Gravity.CENTER
    }

    private fun geometry(node: SceneNodeDocument): FrameLayout.LayoutParams =
        FrameLayout.LayoutParams(scenePx(node.width).roundToInt(), scenePx(node.height).roundToInt()).apply {
            leftMargin = scenePx(node.x).roundToInt()
            topMargin = scenePx(node.y).roundToInt()
        }

    private fun sourceAdapter(source: String): SourceAdapter? = when (source) {
        "airplay" -> adapters.airPlay
        "cast" -> adapters.cast
        "hdmi" -> adapters.hdmi
        else -> null
    }

    private fun sourceIcon(source: String, adapter: SourceAdapter?): Drawable? =
        adapter?.brandedIcon()?.mutate() ?: sourceIconResource(source).takeIf { it != 0 }
            ?.let(activity::getDrawable)
            ?.mutate()

    private fun sourceIconResource(source: String): Int = when (source) {
        "airplay" -> R.drawable.ic_source_airplay
        "cast" -> R.drawable.ic_source_cast
        "hdmi" -> R.drawable.ic_source_hdmi
        else -> 0
    }

    private fun registerFocus(node: SceneNodeDocument, view: View) {
        if (node.focusOrder > 0) focusableViews += node.focusOrder to view
    }

    private fun linkDpadFocus() {
        val ordered = focusableViews.sortedBy { it.first }.map { it.second }
        ordered.forEachIndexed { index, view ->
            val previous = ordered.getOrNull(index - 1)
            val next = ordered.getOrNull(index + 1)
            if (previous != null) {
                view.nextFocusUpId = previous.id
                view.nextFocusLeftId = previous.id
            }
            if (next != null) {
                view.nextFocusDownId = next.id
                view.nextFocusRightId = next.id
            }
        }
    }

    private fun sceneTypeface(): Typeface = when (branding.fontPreset) {
        "compact" -> Typeface.create("sans-serif-condensed", Typeface.NORMAL)
        "humanist" -> Typeface.create("sans-serif", Typeface.NORMAL)
        else -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
    }

    private fun scenePx(value: Float): Float = value * scale

    private fun parseColor(value: String, fallback: Int): Int =
        runCatching { Color.parseColor(value) }.getOrDefault(fallback)

    private fun withAlpha(color: Int, alpha: Int): Int = Color.argb(
        alpha.coerceIn(0, 255),
        Color.red(color),
        Color.green(color),
        Color.blue(color),
    )

    private fun toast(message: String) {
        Toast.makeText(activity, message.take(160), Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val CANVAS_WIDTH = 1920f
        const val CANVAS_HEIGHT = 1080f
    }
}
