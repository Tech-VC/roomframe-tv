package org.roomframe.tv

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.text.InputFilter
import java.util.concurrent.Executors
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.DiscoveryCandidate
import org.roomframe.tv.sync.EnrollmentCodePolicy
import org.roomframe.tv.sync.RoomFrameDiscovery
import org.roomframe.tv.sync.TvEnrollmentClient

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
            setPadding(dp(96), dp(64), dp(96), dp(64))
            setBackgroundColor(Color.rgb(16, 26, 34))
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.enrollment_title)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f)
        }, row())
        root.addView(TextView(this).apply {
            text = getString(R.string.enrollment_explanation)
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        }, row(top = 12, bottom = 24))

        status = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
        }
        root.addView(status, row(bottom = 12))

        discover = Button(this).apply {
            text = getString(R.string.enrollment_discover)
            setOnClickListener { discoverLocalServer() }
        }
        manual = Button(this).apply {
            text = getString(R.string.enrollment_manual)
            setOnClickListener {
                manualEntryRequested = true
                showManualServerEntry(requestFocus = true)
            }
        }
        root.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
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
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        ).apply { filters = arrayOf(InputFilter.LengthFilter(19)) }
        root.addView(serverUrl, row(bottom = 12))
        root.addView(enrollmentCode, row(bottom = 20))

        submit = Button(this).apply {
            text = getString(R.string.enrollment_submit)
            setOnClickListener { enroll() }
        }
        root.addView(submit, row(bottom = 12))
        return root
    }

    private fun field(hint: String, inputType: Int): EditText = EditText(this).apply {
        this.hint = hint
        this.inputType = inputType
        setTextColor(Color.WHITE)
        setHintTextColor(Color.GRAY)
        setSingleLine(true)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        setPadding(dp(18), dp(10), dp(18), dp(10))
        setBackgroundColor(Color.rgb(34, 49, 60))
    }

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
        LinearLayout.LayoutParams(dp(780), LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
