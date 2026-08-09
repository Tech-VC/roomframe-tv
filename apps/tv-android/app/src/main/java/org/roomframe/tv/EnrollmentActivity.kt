package org.roomframe.tv

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.DiscoveryCandidate
import org.roomframe.tv.sync.EnrollmentCodePolicy
import org.roomframe.tv.sync.RoomFrameDiscovery
import org.roomframe.tv.sync.TvEnrollmentClient
import org.roomframe.tv.ui.EnrollmentCodeInputFormatter
import org.roomframe.tv.ui.TvSafeArea

class EnrollmentActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var discovery: RoomFrameDiscovery
    private var discoveredCandidate: DiscoveryCandidate? = null
    private lateinit var serverUrl: EditText
    private lateinit var enrollmentCode: EditText
    private lateinit var discover: Button
    private lateinit var manual: Button
    private lateinit var submit: Button
    private lateinit var status: TextView
    private var manualEntryRequested = false
    private val safeContentWidth by lazy {
        TvSafeArea.contentWidthPx(
            displayWidthPx = resources.displayMetrics.widthPixels,
            density = resources.displayMetrics.density,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (DeviceCredentialStore(this).load() != null) {
            finish()
            return
        }
        discovery = RoomFrameDiscovery(this)
        setContentView(buildView())
        status.post { discoverLocalServer() }
    }

    override fun onDestroy() {
        if (::discovery.isInitialized) discovery.close()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun buildView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            clipChildren = false
            clipToPadding = false
            setPadding(dp(32), dp(48), dp(32), dp(48))
            setBackgroundColor(Color.rgb(16, 26, 34))
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.enrollment_title)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f)
        }, row())
        root.addView(TextView(this).apply {
            text = getString(R.string.enrollment_explanation)
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        }, row(top = 10, bottom = 20))

        status = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
        }
        root.addView(status, row(bottom = 12))

        discover = Button(this).apply {
            text = getString(R.string.enrollment_discover)
            applyTvButtonStyle()
            setOnClickListener { discoverLocalServer() }
        }
        manual = Button(this).apply {
            text = getString(R.string.enrollment_manual)
            applyTvButtonStyle()
            setOnClickListener {
                manualEntryRequested = true
                showManualServerEntry(requestFocus = true)
            }
        }
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            clipChildren = false
            clipToPadding = false
            addView(discover, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8)
            })
            addView(manual, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(8)
            })
        }, row(bottom = 12))
        serverUrl = field(
            hint = getString(R.string.enrollment_server_url),
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
        ).apply { visibility = View.GONE }
        enrollmentCode = field(
            hint = getString(R.string.enrollment_code),
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_NORMAL,
        ).apply {
            id = View.generateViewId()
            textDirection = View.TEXT_DIRECTION_LTR
            imeOptions = EditorInfo.IME_ACTION_DONE
            applyEnrollmentCodeFormatting()
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE && submit.isEnabled) {
                    enroll()
                    true
                } else {
                    false
                }
            }
        }
        root.addView(serverUrl, row(bottom = 12))
        root.addView(enrollmentCode, row(bottom = 20))

        submit = Button(this).apply {
            id = View.generateViewId()
            text = getString(R.string.enrollment_submit)
            applyTvButtonStyle()
            setOnClickListener { enroll() }
        }
        enrollmentCode.nextFocusDownId = submit.id
        submit.nextFocusUpId = enrollmentCode.id
        root.addView(submit, row(bottom = 12))
        return root
    }

    private fun EditText.applyEnrollmentCodeFormatting() {
        var isFormatting = false
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(
                text: CharSequence?,
                start: Int,
                count: Int,
                after: Int,
            ) = Unit

            override fun onTextChanged(
                text: CharSequence?,
                start: Int,
                before: Int,
                count: Int,
            ) = Unit

            override fun afterTextChanged(editable: Editable?) {
                if (isFormatting || editable == null) return
                val raw = editable.toString()
                val formatted = EnrollmentCodeInputFormatter.format(raw)
                if (raw == formatted) return

                val nextSelection = EnrollmentCodeInputFormatter.selectionAfterFormatting(
                    raw,
                    selectionStart,
                )
                isFormatting = true
                try {
                    setText(formatted)
                    setSelection(nextSelection.coerceAtMost(formatted.length))
                } finally {
                    isFormatting = false
                }
            }
        })
    }

    private fun field(hint: String, inputType: Int): EditText = EditText(this).apply {
        this.hint = hint
        this.inputType = inputType
        setTextColor(Color.WHITE)
        setHintTextColor(Color.rgb(188, 200, 207))
        setSingleLine(true)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        setPadding(dp(18), dp(10), dp(18), dp(10))
        minHeight = dp(54)
        backgroundTintList = null
        background = fieldBackground()
        elevation = dp(2).toFloat()
        applyFocusMotion(focusedScale = 1.015f)
    }

    private fun Button.applyTvButtonStyle() {
        isFocusable = true
        minHeight = dp(54)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(18), dp(10), dp(18), dp(10))
        stateListAnimator = null
        backgroundTintList = null
        background = buttonBackground()
        setTextColor(buttonTextColors())
        elevation = dp(2).toFloat()
        applyFocusMotion(focusedScale = 1.04f)
    }

    private fun View.applyFocusMotion(focusedScale: Float) {
        setOnFocusChangeListener { focusedView, focused ->
            focusedView.animate().cancel()
            focusedView.animate()
                .scaleX(if (focused) focusedScale else 1f)
                .scaleY(if (focused) focusedScale else 1f)
                .setDuration(120L)
                .setInterpolator(DecelerateInterpolator())
                .start()
            focusedView.elevation = dp(if (focused) 12 else 2).toFloat()
        }
    }

    private fun buttonBackground(): StateListDrawable = StateListDrawable().apply {
        addState(
            intArrayOf(android.R.attr.state_enabled, android.R.attr.state_focused),
            roundedSurface(
                fill = Color.rgb(255, 90, 31),
                stroke = Color.WHITE,
                strokeWidth = 3,
            ),
        )
        addState(
            intArrayOf(android.R.attr.state_enabled, android.R.attr.state_pressed),
            roundedSurface(
                fill = Color.rgb(255, 132, 92),
                stroke = Color.WHITE,
                strokeWidth = 3,
            ),
        )
        addState(
            intArrayOf(-android.R.attr.state_enabled),
            roundedSurface(
                fill = Color.rgb(29, 41, 49),
                stroke = Color.rgb(67, 81, 91),
                strokeWidth = 1,
            ),
        )
        addState(
            intArrayOf(),
            roundedSurface(
                fill = Color.rgb(34, 49, 60),
                stroke = Color.rgb(109, 135, 151),
                strokeWidth = 1,
            ),
        )
    }

    private fun fieldBackground(): StateListDrawable = StateListDrawable().apply {
        addState(
            intArrayOf(android.R.attr.state_focused),
            roundedSurface(
                fill = Color.rgb(37, 57, 69),
                stroke = Color.rgb(255, 90, 31),
                strokeWidth = 4,
            ),
        )
        addState(
            intArrayOf(),
            roundedSurface(
                fill = Color.rgb(34, 49, 60),
                stroke = Color.rgb(83, 108, 123),
                strokeWidth = 1,
            ),
        )
    }

    private fun roundedSurface(fill: Int, stroke: Int, strokeWidth: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(fill)
            setStroke(dp(strokeWidth), stroke)
        }

    private fun buttonTextColors(): ColorStateList = ColorStateList(
        arrayOf(
            intArrayOf(android.R.attr.state_enabled, android.R.attr.state_focused),
            intArrayOf(android.R.attr.state_enabled, android.R.attr.state_pressed),
            intArrayOf(-android.R.attr.state_enabled),
            intArrayOf(),
        ),
        intArrayOf(
            Color.rgb(16, 26, 34),
            Color.rgb(16, 26, 34),
            Color.rgb(128, 144, 155),
            Color.WHITE,
        ),
    )

    private fun discoverLocalServer() {
        discover.isEnabled = false
        status.setTextColor(Color.LTGRAY)
        status.text = getString(R.string.enrollment_discovery_in_progress)
        runCatching {
            discovery.discover { result ->
                if (isFinishing || isDestroyed) return@discover
                discover.isEnabled = true
                result.onSuccess { candidates ->
                    when (candidates.size) {
                        0 -> {
                            discoveredCandidate = null
                            showManualServerEntry(requestFocus = false)
                            status.setTextColor(Color.rgb(255, 186, 105))
                            status.text = getString(R.string.enrollment_discovery_empty)
                        }
                        1 -> {
                            discoveredCandidate = candidates.single()
                            if (!manualEntryRequested || serverUrl.text.isBlank()) {
                                serverUrl.setText(candidates.single().descriptor.origin)
                            }
                            status.setTextColor(Color.rgb(91, 208, 139))
                            status.text = getString(
                                R.string.enrollment_discovery_found,
                                candidates.single().descriptor.host,
                            )
                            if (manualEntryRequested) {
                                serverUrl.visibility = View.VISIBLE
                            } else {
                                serverUrl.visibility = View.GONE
                                enrollmentCode.requestFocus()
                            }
                        }
                        else -> {
                            discoveredCandidate = null
                            showManualServerEntry(requestFocus = false)
                            status.setTextColor(Color.rgb(255, 186, 105))
                            status.text = getString(
                                R.string.enrollment_discovery_multiple,
                                candidates.size,
                            )
                            serverUrl.requestFocus()
                        }
                    }
                }.onFailure { error ->
                    discoveredCandidate = null
                    showManualServerEntry(requestFocus = false)
                    status.setTextColor(Color.rgb(255, 126, 105))
                    status.text = getString(
                        R.string.enrollment_discovery_error,
                        error.message?.take(100) ?: getString(R.string.enrollment_unknown_error),
                    )
                }
            }
        }.onFailure { error ->
            discover.isEnabled = true
            showManualServerEntry(requestFocus = false)
            status.setTextColor(Color.rgb(255, 126, 105))
            status.text = getString(
                R.string.enrollment_discovery_error,
                error.message?.take(100) ?: getString(R.string.enrollment_unknown_error),
            )
        }
    }

    private fun showManualServerEntry(requestFocus: Boolean) {
        serverUrl.visibility = View.VISIBLE
        if (requestFocus) serverUrl.requestFocus()
    }

    private fun enroll() {
        submit.isEnabled = false
        status.setTextColor(Color.LTGRAY)
        status.text = getString(R.string.enrollment_in_progress)
        val url = runCatching {
            EnrollmentCodePolicy.manualServerUrl(
                serverUrl.text.toString(),
            )
        }.getOrElse { error ->
            submit.isEnabled = true
            status.setTextColor(Color.rgb(255, 126, 105))
            status.text = getString(
                R.string.enrollment_error,
                error.message ?: getString(R.string.enrollment_unknown_error),
            )
            serverUrl.requestFocus()
            return
        }
        val code = enrollmentCode.text.toString()
        val candidate = discoveredCandidate
        val usesDiscoveredCandidate = candidate != null && runCatching {
            DeviceCredentialStore.validateServerUrl(url) == candidate.descriptor.origin
        }.getOrDefault(false)
        val enrollmentOrigins = buildList {
            add(url)
            if (usesDiscoveredCandidate) {
                add(requireNotNull(candidate).descriptor.fallbackOrigin)
            }
        }
        executor.execute {
            runCatching {
                val credentials = TvEnrollmentClient().enrollWithCode(
                    enrollmentOrigins,
                    code,
                    candidate
                        ?.takeIf { usesDiscoveredCandidate }
                        ?.descriptor
                        ?.serverCaFingerprintSha256,
                )
                DeviceCredentialStore(this).save(credentials)
            }.onSuccess {
                runOnUiThread {
                    enrollmentCode.text.clear()
                    status.setTextColor(Color.rgb(91, 208, 139))
                    status.text = getString(R.string.enrollment_success)
                    startActivity(
                        Intent(this, MainActivity::class.java).addFlags(
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK,
                        ),
                    )
                    finish()
                }
            }.onFailure { error ->
                runOnUiThread {
                    enrollmentCode.text.clear()
                    status.setTextColor(Color.rgb(255, 126, 105))
                    status.text = getString(
                        R.string.enrollment_error,
                        error.message?.take(120) ?: getString(R.string.enrollment_unknown_error),
                    )
                    submit.isEnabled = true
                    enrollmentCode.requestFocus()
                }
            }
        }
    }

    private fun row(top: Int = 0, bottom: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(safeContentWidth, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
