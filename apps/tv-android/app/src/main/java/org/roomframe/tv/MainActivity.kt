package org.roomframe.tv

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.File
import kotlin.math.min
import kotlin.math.roundToInt
import org.roomframe.tv.adapters.AdapterResult
import org.roomframe.tv.adapters.DeviceAdapters
import org.roomframe.tv.cache.FileExperienceStore

/**
 * Squelette visuel local-first. La version de production chargera la dernière scène validée
 * depuis le cache, puis synchronisera en arrière-plan. Ce fallback ne dépend pas du réseau.
 */
class MainActivity : Activity() {
    private var okDownAt: Long? = null
    private val adapters = DeviceAdapters.unsupported()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // La présence d'une révision active est consultée avant toute synchronisation réseau.
        // Le renderer typé sera branché sur ce store dans le prochain jalon Android.
        FileExperienceStore(File(filesDir, "experience")).loadActive()

        val localBackground = localDebugBrandingDrawable("background")
        val root = FrameLayout(this)
        root.addView(ImageView(this).apply {
            setImageDrawable(
                localBackground ?: resources.getDrawable(R.drawable.background_default, theme),
            )
            scaleType = ImageView.ScaleType.CENTER_CROP
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        if (localBackground != null) {
            root.addView(View(this).apply {
                setBackgroundColor(0x40000000)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ))
        }

        root.addView(TextView(this).apply {
            text = getString(R.string.welcome_default)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(44).toFloat())
            setAutoSizeTextTypeUniformWithConfiguration(
                scenePx(28),
                scenePx(44),
                1,
                TypedValue.COMPLEX_UNIT_PX,
            )
            typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            setTextColor(Color.WHITE)
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            includeFontPadding = false
            isSingleLine = true
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }, FrameLayout.LayoutParams(scenePx(1180), scenePx(120), Gravity.START or Gravity.TOP).apply {
            leftMargin = scenePx(72)
            topMargin = scenePx(160)
        })

        val sources = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            listOf(
                getString(R.string.source_airplay) to adapters.airPlay,
                getString(R.string.source_cast) to adapters.cast,
                getString(R.string.source_hdmi) to adapters.hdmi,
            ).forEach { (label, adapter) ->
                addView(TextView(context).apply {
                    text = label
                    setTextSize(TypedValue.COMPLEX_UNIT_PX, scenePx(24).toFloat())
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(scenePx(22), 0, scenePx(22), 0)
                    setBackgroundColor(0x18000000)
                    isFocusable = true
                    setOnFocusChangeListener { view, focused ->
                        view.setBackgroundColor(if (focused) 0x553D5A48 else 0x18000000)
                    }
                    setOnClickListener {
                        when (val result = adapter.activate()) {
                            AdapterResult.Success -> Unit
                            is AdapterResult.Unavailable -> Toast.makeText(context, result.reason, Toast.LENGTH_SHORT).show()
                            is AdapterResult.Failure -> Toast.makeText(context, result.reason, Toast.LENGTH_SHORT).show()
                        }
                    }
                }, LinearLayout.LayoutParams(scenePx(390), scenePx(92)).apply {
                    bottomMargin = scenePx(14)
                })
            }
        }
        root.addView(sources, FrameLayout.LayoutParams(scenePx(390), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.TOP).apply {
            leftMargin = scenePx(72)
            topMargin = scenePx(430)
        })

        root.addView(ImageView(this).apply {
            setImageDrawable(
                localDebugBrandingDrawable("logo")
                    ?: resources.getDrawable(R.drawable.logo_placeholder, theme),
            )
            scaleType = ImageView.ScaleType.FIT_END
            contentDescription = getString(R.string.logo_content_description)
        }, FrameLayout.LayoutParams(scenePx(300), scenePx(110), Gravity.END or Gravity.BOTTOM).apply {
            rightMargin = scenePx(72)
            bottomMargin = scenePx(46)
        })

        setContentView(root)
        window.decorView.post { enterImmersiveMode() }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            window.decorView.post { enterImmersiveMode() }
        }
    }

    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.decorView.windowInsetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                )
        }
    }

    /**
     * Surcharge locale réservée aux APK debuggables. La production recevra les
     * médias validés par le pipeline de synchronisation, jamais par ce chemin.
     */
    private fun localDebugBrandingDrawable(name: String): Drawable? {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
            return null
        }

        val brandingDirectory = File(filesDir, "branding")
        val candidate = listOf("webp", "png", "jpg", "jpeg")
            .asSequence()
            .map { extension -> File(brandingDirectory, "$name.$extension") }
            .firstOrNull { file ->
                file.isFile && file.length() in 1..MAX_LOCAL_BRANDING_BYTES
            }
            ?: return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(candidate.absolutePath, bounds)
        val pixelCount = bounds.outWidth.toLong() * bounds.outHeight.toLong()
        if (
            bounds.outWidth <= 0 ||
            bounds.outHeight <= 0 ||
            bounds.outWidth > MAX_LOCAL_BRANDING_DIMENSION ||
            bounds.outHeight > MAX_LOCAL_BRANDING_DIMENSION ||
            pixelCount > MAX_LOCAL_BRANDING_PIXELS
        ) {
            return null
        }

        val bitmap = BitmapFactory.decodeFile(candidate.absolutePath) ?: return null
        return BitmapDrawable(resources, bitmap)
    }

    /**
     * Les coordonnées du renderer sont exprimées dans la scène logique 1920 × 1080.
     * La densité Android ne doit pas les agrandir : seule la taille de la fenêtre
     * détermine le facteur d'échelle.
     */
    private fun scenePx(value: Int): Int {
        val metrics = resources.displayMetrics
        val scale = min(metrics.widthPixels / 1920f, metrics.heightPixels / 1080f)
        return (value * scale).roundToInt()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                okDownAt = System.currentTimeMillis()
            }
            if (event.action == KeyEvent.ACTION_UP) {
                val held = System.currentTimeMillis() - (okDownAt ?: System.currentTimeMillis())
                okDownAt = null
                if (held >= 8_000) {
                    Toast.makeText(
                        this,
                        "Menu administrateur indisponible dans ce jalon.",
                        Toast.LENGTH_SHORT,
                    ).show()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private companion object {
        const val MAX_LOCAL_BRANDING_BYTES = 25L * 1024 * 1024
        const val MAX_LOCAL_BRANDING_DIMENSION = 4096
        const val MAX_LOCAL_BRANDING_PIXELS = 3840L * 2160L
    }
}
