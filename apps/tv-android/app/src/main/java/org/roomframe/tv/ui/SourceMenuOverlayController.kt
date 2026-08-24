package org.roomframe.tv.ui

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlin.math.min
import kotlin.math.roundToInt
import org.roomframe.tv.adapters.DeviceAdapters
import org.roomframe.tv.experience.ExperienceSnapshot

/**
 * Menu local : le D-pad n'effectue aucun accès réseau et la scène reste
 * intacte derrière un écran totalement opaque réutilisé entre deux ouvertures.
 */
internal class SourceMenuOverlayController(
    private val activity: Activity,
    private val adapters: DeviceAdapters,
    private val sceneHost: FrameLayout,
    private val overlayHost: FrameLayout,
    private val onHomeRequested: () -> Unit,
    private val onPrivateRequested: (View) -> Unit,
    private val onCastWaitingRequested: (View) -> Unit,
) {
    private var snapshot: ExperienceSnapshot? = null
    private var cachedRevisionId: String? = null
    private var cachedCanvas: View? = null
    private var returnFocusView: View? = null
    private var returnFocusTag: Any? = null
    private var previousSceneAccessibility: Int? = null
    private var visible = false

    val isVisible: Boolean
        get() = visible

    fun update(value: ExperienceSnapshot) {
        snapshot = value
        val cacheKey = buildString {
            append(value.revisionId)
            append('|')
            append(value.sources.items.hashCode())
            append('|')
            append(value.privateAccess.hashCode())
        }
        if (cacheKey == cachedRevisionId) return
        cachedRevisionId = cacheKey
        cachedCanvas = buildCanvas(value)
        if (visible) attachCachedCanvas()
    }

    fun show(sourceView: View) {
        val current = snapshot ?: return
        returnFocusView = sourceView
        returnFocusTag = sourceView.tag
        if (cachedCanvas == null) cachedCanvas = buildCanvas(current)
        visible = true
        attachCachedCanvas()
    }

    fun dismiss(restoreFocus: Boolean = true): Boolean {
        if (!visible) return false
        visible = false
        overlayHost.animate().cancel()
        overlayHost.removeAllViews()
        overlayHost.visibility = View.GONE
        overlayHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        sceneHost.importantForAccessibility = previousSceneAccessibility
            ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        previousSceneAccessibility = null
        if (restoreFocus) {
            val target = returnFocusView?.takeIf(View::isAttachedToWindow)
                ?: returnFocusTag?.let { tag -> sceneHost.findViewWithTag<View>(tag) }
            target?.post { if (target.isAttachedToWindow) target.requestFocus() }
        }
        returnFocusView = null
        returnFocusTag = null
        return true
    }

    fun release() {
        dismiss(restoreFocus = false)
        cachedCanvas = null
        snapshot = null
    }

    private fun attachCachedCanvas() {
        val canvas = cachedCanvas ?: return
        (canvas.parent as? ViewGroup)?.removeView(canvas)
        overlayHost.animate().cancel()
        overlayHost.removeAllViews()
        overlayHost.setBackgroundColor(BACKGROUND)
        overlayHost.visibility = View.VISIBLE
        overlayHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        if (previousSceneAccessibility == null) {
            previousSceneAccessibility = sceneHost.importantForAccessibility
        }
        sceneHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        val metrics = activity.resources.displayMetrics
        val scale = min(
            metrics.widthPixels.toFloat() / CANVAS_WIDTH,
            metrics.heightPixels.toFloat() / CANVAS_HEIGHT,
        )
        overlayHost.addView(
            canvas,
            FrameLayout.LayoutParams(
                (CANVAS_WIDTH * scale).roundToInt(),
                (CANVAS_HEIGHT * scale).roundToInt(),
                Gravity.CENTER,
            ),
        )
        canvas.alpha = 0f
        canvas.animate().alpha(1f).setDuration(120L).start()
        canvas.post {
            canvas.findViewWithTag<View>(FIRST_ENTRY_TAG)?.requestFocus()
        }
    }

    private fun buildCanvas(value: ExperienceSnapshot): View {
        val metrics = activity.resources.displayMetrics
        val scale = min(
            metrics.widthPixels.toFloat() / CANVAS_WIDTH,
            metrics.heightPixels.toFloat() / CANVAS_HEIGHT,
        )
        fun px(value: Float): Int = (value * scale).roundToInt()
        val primary = parseColor(value.branding.primary, Color.rgb(21, 21, 17))
        val accent = parseColor(value.branding.accent, Color.rgb(255, 79, 31))
        val typeface = when (value.branding.fontPreset) {
            "humanist" -> Typeface.create("sans-serif", Typeface.NORMAL)
            else -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
        }

        fun label(text: String, size: Float, color: Int = Color.WHITE): TextView =
            TextView(activity).apply {
                this.text = text
                setTextColor(color)
                setTextSize(TypedValue.COMPLEX_UNIT_PX, px(size).toFloat())
                this.typeface = typeface
                includeFontPadding = false
            }

        return FrameLayout(activity).apply canvas@{
            setBackgroundColor(BACKGROUND)
            isClickable = true
            isFocusable = false
            contentDescription = "Menu des sources"

            addView(
                label("SOURCES", 22f, Color.argb(180, 255, 255, 255)),
                FrameLayout.LayoutParams(px(620f), px(42f)).apply {
                    leftMargin = px(100f)
                    topMargin = px(88f)
                },
            )
            addView(
                label("Choisissez une source", 58f),
                FrameLayout.LayoutParams(px(730f), px(190f)).apply {
                    leftMargin = px(100f)
                    topMargin = px(150f)
                },
            )
            val list = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val entries = sourceMenuEntries(value)
            entries.forEachIndexed { index, entry ->
                val button = label(entry.label, 31f).apply {
                    id = View.generateViewId()
                    tag = if (index == 0) FIRST_ENTRY_TAG else "source-menu-${entry.action.name}"
                    isFocusable = true
                    isFocusableInTouchMode = false
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(px(38f), 0, px(38f), 0)
                    setTextColor(sceneForegroundColor(primary))
                    background = entryBackground(primary, accent, false, scale)
                    setOnFocusChangeListener { focusedView, focused ->
                        (focusedView as TextView).setTextColor(
                            sceneForegroundColor(if (focused) accent else primary),
                        )
                        focusedView.background = entryBackground(primary, accent, focused, scale)
                        focusedView.animate().cancel()
                        focusedView.animate()
                            .scaleX(if (focused) 1.025f else 1f)
                            .scaleY(if (focused) 1.025f else 1f)
                            .setDuration(100L)
                            .start()
                    }
                    setOnClickListener { activate(entry.action, this) }
                }
                list.addView(
                    button,
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        px(112f),
                    ).apply { bottomMargin = px(18f) },
                )
            }
            addView(
                list,
                FrameLayout.LayoutParams(px(850f), px(820f)).apply {
                    leftMargin = px(970f)
                    topMargin = px(120f)
                },
            )
        }
    }

    private fun activate(action: SourceMenuAction, sourceView: View) {
        val current = snapshot ?: return
        val sceneAnchor = returnFocusView?.takeIf(View::isAttachedToWindow)
            ?: returnFocusTag?.let { tag -> sceneHost.findViewWithTag<View>(tag) }
            ?: sourceView
        when (action) {
            SourceMenuAction.HOME -> {
                dismiss(restoreFocus = false)
                onHomeRequested()
            }
            SourceMenuAction.PRIVATE -> {
                dismiss(restoreFocus = false)
                onPrivateRequested(sceneAnchor)
            }
            SourceMenuAction.AIRPLAY,
            SourceMenuAction.CAST,
            SourceMenuAction.HDMI,
            -> {
                val source = requireNotNull(action.sourceKind)
                val result = when (action) {
                    SourceMenuAction.AIRPLAY -> adapters.airPlay.activate()
                    SourceMenuAction.CAST -> adapters.cast.activate()
                    SourceMenuAction.HDMI -> adapters.hdmi.activate(
                        current.sources.settingFor("hdmi")?.physicalInput,
                    )
                    else -> error("Action de source inattendue")
                }
                when (val effect = sourceActivationEffect(source, result)) {
                    SourceActivationEffect.None -> dismiss(restoreFocus = false)
                    SourceActivationEffect.ShowCastWaiting -> {
                        dismiss(restoreFocus = false)
                        onCastWaitingRequested(sceneAnchor)
                    }
                    is SourceActivationEffect.ShowMessage -> toast(effect.message)
                }
            }
        }
    }

    private fun entryBackground(
        primary: Int,
        accent: Int,
        focused: Boolean,
        scale: Float,
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = 10f * scale
        val color = if (focused) accent else primary
        setColor(Color.argb(if (focused) 248 else 220, Color.red(color), Color.green(color), Color.blue(color)))
        setStroke(
            ((if (focused) 4f else 1f) * scale).roundToInt().coerceAtLeast(1),
            sceneForegroundColor(color),
        )
    }

    private fun parseColor(value: String, fallback: Int): Int =
        runCatching { Color.parseColor(value) }.getOrDefault(fallback)

    private fun toast(message: String) {
        Toast.makeText(activity, message.take(160), Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val CANVAS_WIDTH = 1920f
        const val CANVAS_HEIGHT = 1080f
        const val FIRST_ENTRY_TAG = "source-menu-first"
        val BACKGROUND = Color.rgb(4, 13, 17)
    }
}
