package org.roomframe.tv

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.File
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
        // La présence d'une révision active est consultée avant toute synchronisation réseau.
        // Le renderer typé sera branché sur ce store dans le prochain jalon Android.
        FileExperienceStore(File(filesDir, "experience")).loadActive()
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )

        val root = FrameLayout(this).apply {
            background = BitmapDrawable(resources, resources.openRawResource(R.drawable.background_default)).apply {
                gravity = Gravity.FILL
            }
        }

        root.addView(TextView(this).apply {
            text = "Bonjour, bienvenue dans cette salle"
            textSize = 44f
            typeface = Typeface.create(Typeface.SERIF, Typeface.NORMAL)
            setTextColor(Color.WHITE)
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
        }, FrameLayout.LayoutParams(dp(940), dp(240), Gravity.START or Gravity.TOP).apply {
            leftMargin = dp(72)
            topMargin = dp(118)
        })

        val sources = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            listOf(
                "AirPlay" to adapters.airPlay,
                "Cast" to adapters.cast,
                "HDMI" to adapters.hdmi,
            ).forEach { (label, adapter) ->
                addView(TextView(context).apply {
                    text = label
                    textSize = 24f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.WHITE)
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(22), 0, dp(22), 0)
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
                }, LinearLayout.LayoutParams(dp(390), dp(92)).apply { bottomMargin = dp(14) })
            }
        }
        root.addView(sources, FrameLayout.LayoutParams(dp(390), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.START or Gravity.TOP).apply {
            leftMargin = dp(72)
            topMargin = dp(430)
        })

        root.addView(ImageView(this).apply {
            setImageResource(R.drawable.logo_placeholder)
            scaleType = ImageView.ScaleType.FIT_END
            contentDescription = "Logo"
        }, FrameLayout.LayoutParams(dp(300), dp(110), Gravity.END or Gravity.BOTTOM).apply {
            rightMargin = dp(72)
            bottomMargin = dp(46)
        })

        setContentView(root)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

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
}
