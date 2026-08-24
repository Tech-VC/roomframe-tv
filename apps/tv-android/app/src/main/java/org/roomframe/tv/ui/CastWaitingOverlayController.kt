package org.roomframe.tv.ui

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.min
import kotlin.math.roundToInt
import org.roomframe.tv.R
import org.roomframe.tv.experience.BrandingDocument

/**
 * Écran d'attente local affiché par-dessus la scène pendant que le récepteur
 * Cast système reste lié en arrière-plan. Il n'affirme jamais qu'une diffusion
 * est connectée : cette information n'est pas exposée par le firmware.
 */
internal class CastWaitingOverlayController(
    private val activity: Activity,
    private val sceneHost: FrameLayout,
    private val overlayHost: FrameLayout,
) {
    private var returnFocusView: View? = null
    private var returnFocusTag: Any? = null
    private var previousSceneAccessibility: Int? = null
    private var shown = false

    val isVisible: Boolean
        get() = shown

    fun show(sourceView: View, branding: BrandingDocument, tvDisplayName: String) {
        shown = true
        returnFocusView = sourceView
        returnFocusTag = sourceView.tag
        overlayHost.animate().cancel()
        overlayHost.removeAllViews()
        overlayHost.visibility = View.VISIBLE
        overlayHost.setBackgroundColor(Color.rgb(4, 13, 17))
        overlayHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        if (previousSceneAccessibility == null) {
            previousSceneAccessibility = sceneHost.importantForAccessibility
        }
        sceneHost.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS

        val metrics = activity.resources.displayMetrics
        val scale = min(metrics.widthPixels / CANVAS_WIDTH, metrics.heightPixels / CANVAS_HEIGHT)
        val canvas = buildCanvas(branding, tvDisplayName, scale)
        overlayHost.addView(
            canvas,
            FrameLayout.LayoutParams(
                (CANVAS_WIDTH * scale).roundToInt(),
                (CANVAS_HEIGHT * scale).roundToInt(),
                Gravity.CENTER,
            ),
        )
        overlayHost.alpha = 0f
        overlayHost.animate().alpha(1f).setDuration(180L).start()
    }

    fun dismiss(restoreFocus: Boolean = true): Boolean {
        if (!isVisible) return false
        shown = false
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
    }

    private fun buildCanvas(
        branding: BrandingDocument,
        tvDisplayName: String,
        scale: Float,
    ): FrameLayout {
        fun px(value: Float): Int = (value * scale).roundToInt()
        val primary = parseColor(branding.primary, Color.rgb(16, 105, 198))
        val accent = parseColor(branding.accent, Color.rgb(255, 79, 31))
        val primaryForeground = sceneForegroundColor(primary)
        val typeface = when (branding.fontPreset) {
            "humanist" -> Typeface.create("sans-serif", Typeface.NORMAL)
            else -> Typeface.create("sans-serif-condensed", Typeface.BOLD)
        }

        fun text(
            value: String,
            size: Float,
            color: Int = Color.WHITE,
            bold: Boolean = true,
        ): TextView = TextView(activity).apply {
            this.text = value
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, px(size).toFloat())
            this.typeface = Typeface.create(typeface, if (bold) Typeface.BOLD else Typeface.NORMAL)
            includeFontPadding = false
        }

        fun FrameLayout.place(view: View, width: Float, height: Float, left: Float, top: Float) {
            addView(
                view,
                FrameLayout.LayoutParams(px(width), px(height)).apply {
                    leftMargin = px(left)
                    topMargin = px(top)
                },
            )
        }

        return FrameLayout(activity).apply canvas@{
            setBackgroundColor(Color.rgb(4, 13, 17))
            isClickable = true
            contentDescription = activity.getString(
                R.string.cast_waiting_accessibility_named,
                tvDisplayName,
            )

            val iconTile = FrameLayout(activity).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = px(18f).toFloat()
                    setColor(primary)
                    setStroke(px(2f).coerceAtLeast(1), Color.argb(120, 255, 255, 255))
                }
                addView(
                    ImageView(activity).apply {
                        setImageResource(R.drawable.ic_source_cast)
                        imageTintList = ColorStateList.valueOf(primaryForeground)
                        contentDescription = null
                        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                    },
                    FrameLayout.LayoutParams(px(76f), px(76f), Gravity.CENTER),
                )
            }
            place(iconTile, 144f, 144f, 90f, 76f)

            place(
                text(tvDisplayName.uppercase(), 30f).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                },
                760f,
                46f,
                280f,
                105f,
            )
            place(
                text(activity.getString(R.string.cast_waiting_eyebrow), 19f, Color.argb(190, 255, 255, 255)),
                600f,
                34f,
                280f,
                158f,
            )

            place(
                text(activity.getString(R.string.cast_waiting_title), 76f),
                900f,
                190f,
                90f,
                330f,
            )
            place(
                text(
                    activity.getString(R.string.cast_waiting_instruction),
                    33f,
                    Color.argb(225, 255, 255, 255),
                    bold = false,
                ).apply {
                    maxLines = 3
                    gravity = Gravity.START or Gravity.CENTER_VERTICAL
                },
                900f,
                170f,
                90f,
                520f,
            )

            val status = text(activity.getString(R.string.cast_waiting_status), 24f).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(px(28f), 0, px(28f), 0)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = px(8f).toFloat()
                    setColor(Color.argb(115, Color.red(primary), Color.green(primary), Color.blue(primary)))
                    setStroke(px(2f).coerceAtLeast(1), Color.argb(150, 255, 255, 255))
                }
            }
            place(status, 650f, 78f, 90f, 756f)

            val stepsPanel = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(px(54f), px(42f), px(54f), px(42f))
                background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = px(10f).toFloat()
                    setColor(Color.argb(236, Color.red(primary), Color.green(primary), Color.blue(primary)))
                    setStroke(px(2f).coerceAtLeast(1), Color.argb(135, 255, 255, 255))
                }

                addView(
                    text(activity.getString(R.string.cast_waiting_steps_title), 30f, primaryForeground),
                    LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(62f)),
                )
                listOf(
                    R.string.cast_waiting_step_one,
                    R.string.cast_waiting_step_two,
                    R.string.cast_waiting_step_three,
                ).forEachIndexed { index, stringId ->
                    addView(
                        text(
                            "%02d   %s".format(index + 1, activity.getString(stringId)),
                            25f,
                            primaryForeground,
                        ).apply { gravity = Gravity.CENTER_VERTICAL },
                        LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT,
                            px(104f),
                        ),
                    )
                }
            }
            place(stepsPanel, 720f, 520f, 1110f, 220f)

            val backButton = text(activity.getString(R.string.cast_waiting_back), 24f).apply {
                id = View.generateViewId()
                isFocusable = true
                isFocusableInTouchMode = false
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                background = buttonBackground(accent, focused = false, scale)
                setOnFocusChangeListener { view, focused ->
                    (view as TextView).background = buttonBackground(accent, focused, scale)
                    view.animate().cancel()
                    view.animate()
                        .scaleX(if (focused) 1.035f else 1f)
                        .scaleY(if (focused) 1.035f else 1f)
                        .setDuration(120L)
                        .start()
                }
                setOnClickListener { dismiss() }
            }
            backButton.nextFocusLeftId = backButton.id
            backButton.nextFocusRightId = backButton.id
            backButton.nextFocusUpId = backButton.id
            backButton.nextFocusDownId = backButton.id
            place(backButton, 470f, 88f, 1360f, 874f)
            backButton.post { if (backButton.isAttachedToWindow) backButton.requestFocus() }

            place(
                text(
                    activity.getString(R.string.cast_waiting_hint),
                    18f,
                    Color.argb(165, 255, 255, 255),
                    bold = false,
                ),
                820f,
                34f,
                90f,
                958f,
            )
        }
    }

    private fun buttonBackground(color: Int, focused: Boolean, scale: Float): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = (8f * scale)
            setColor(if (focused) color else Color.argb(205, Color.red(color), Color.green(color), Color.blue(color)))
            setStroke(
                ((if (focused) 4f else 2f) * scale).roundToInt().coerceAtLeast(1),
                Color.WHITE,
            )
        }

    private fun parseColor(value: String, fallback: Int): Int =
        runCatching { Color.parseColor(value) }.getOrDefault(fallback)

    private companion object {
        const val CANVAS_WIDTH = 1920f
        const val CANVAS_HEIGHT = 1080f
    }
}
