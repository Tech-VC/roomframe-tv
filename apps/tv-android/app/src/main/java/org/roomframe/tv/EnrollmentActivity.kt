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
import java.util.concurrent.Executors
import org.roomframe.tv.sync.DeviceCredentialStore
import org.roomframe.tv.sync.TvEnrollmentClient

class EnrollmentActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var serverUrl: EditText
    private lateinit var deviceId: EditText
    private lateinit var enrollmentKey: EditText
    private lateinit var submit: Button
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (DeviceCredentialStore(this).load() != null) {
            finish()
            return
        }
        setContentView(buildView())
    }

    override fun onDestroy() {
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

        serverUrl = field(
            hint = getString(R.string.enrollment_server_url),
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
        )
        deviceId = field(
            hint = getString(R.string.enrollment_device_id),
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        )
        enrollmentKey = field(
            hint = getString(R.string.enrollment_key),
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        )
        root.addView(serverUrl, row(bottom = 12))
        root.addView(deviceId, row(bottom = 12))
        root.addView(enrollmentKey, row(bottom = 20))

        submit = Button(this).apply {
            text = getString(R.string.enrollment_submit)
            setOnClickListener { enroll() }
        }
        root.addView(submit, row(bottom = 12))
        status = TextView(this).apply {
            setTextColor(Color.LTGRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
        }
        root.addView(status, row())
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

    private fun enroll() {
        submit.isEnabled = false
        status.setTextColor(Color.LTGRAY)
        status.text = getString(R.string.enrollment_in_progress)
        val url = serverUrl.text.toString()
        val id = deviceId.text.toString()
        val key = enrollmentKey.text.toString()
        executor.execute {
            runCatching {
                val credentials = TvEnrollmentClient().enroll(url, id, key)
                DeviceCredentialStore(this).save(credentials)
            }.onSuccess {
                runOnUiThread {
                    enrollmentKey.text.clear()
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
                    enrollmentKey.text.clear()
                    status.setTextColor(Color.rgb(255, 126, 105))
                    status.text = getString(
                        R.string.enrollment_error,
                        error.message?.take(120) ?: getString(R.string.enrollment_unknown_error),
                    )
                    submit.isEnabled = true
                    enrollmentKey.requestFocus()
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
