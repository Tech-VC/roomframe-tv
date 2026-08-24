package org.roomframe.tv.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.IBinder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.roomframe.tv.MainActivity
import org.roomframe.tv.R
import org.roomframe.tv.deviceadmin.AndroidPrivateApplicationAccessController
import org.roomframe.tv.deviceadmin.PrivateApplicationSessionState

/**
 * Heartbeat HTTPS minimal, séparé de l'activité HOME. Il garde une TV présente
 * dans le Parc quand une entrée HDMI, AirPlay ou Cast passe au premier plan.
 */
class RoomFramePresenceService : Service() {
    private val executor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "roomframe-heartbeat").apply { isDaemon = true }
    }
    private var scheduled: ScheduledFuture<*>? = null
    private var screenOffReceiverRegistered = false
    private var packageReceiverRegistered = false
    private val privateApplicationAccess by lazy {
        AndroidPrivateApplicationAccessController(applicationContext)
    }
    private val screenOffReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_SCREEN_OFF) return
            PrivateApplicationSessionState.lock()
            runCatching {
                executor.execute { privateApplicationAccess.lockPreviouslyManaged() }
            }
        }
    }
    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action !in PACKAGE_RECONCILIATION_ACTIONS) return
            runCatching {
                executor.execute {
                    val states = privateApplicationAccess.lockPreviouslyManaged()
                    DeviceCredentialStore(this@RoomFramePresenceService).load()?.let { credentials ->
                        runCatching { HttpPrivateApplicationStatusClient(credentials).send(states) }
                    }
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        registerScreenOffReceiver()
        registerPackageReceiver()
        startForeground(NOTIFICATION_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val credentials = DeviceCredentialStore(this).load()
        if (credentials == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (scheduled == null || scheduled?.isCancelled == true) {
            scheduled = executor.scheduleWithFixedDelay(
                { sendHeartbeat() },
                TvHeartbeatSchedule.initialDelayMillis(credentials.deviceId),
                TvHeartbeatSchedule.intervalMillis(credentials.deviceId),
                TimeUnit.MILLISECONDS,
            )
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (screenOffReceiverRegistered) {
            unregisterReceiver(screenOffReceiver)
            screenOffReceiverRegistered = false
        }
        if (packageReceiverRegistered) {
            unregisterReceiver(packageReceiver)
            packageReceiverRegistered = false
        }
        scheduled?.cancel(true)
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun sendHeartbeat() {
        val credentials = DeviceCredentialStore(this).load()
        if (credentials == null) {
            stopSelf()
            return
        }
        val state = runCatching { HttpTvHeartbeatClient(credentials).send() }
            .fold(onSuccess = { "accepted" }, onFailure = { "failed" })
        getSharedPreferences("roomframe-runtime", MODE_PRIVATE)
            .edit()
            .putString("last_heartbeat_state", state)
            .putLong("last_heartbeat_at", System.currentTimeMillis())
            .apply()
    }

    private fun registerScreenOffReceiver() {
        if (screenOffReceiverRegistered) return
        val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenOffReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(screenOffReceiver, filter)
        }
        screenOffReceiverRegistered = true
    }

    private fun registerPackageReceiver() {
        if (packageReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(packageReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(packageReceiver, filter)
        }
        packageReceiverRegistered = true
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.presence_channel_name),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = getString(R.string.presence_channel_description)
                setShowBadge(false)
            },
        )
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.presence_notification))
            .setContentIntent(contentIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "roomframe-presence"
        private const val NOTIFICATION_ID = 41
        val PACKAGE_RECONCILIATION_ACTIONS = setOf(
            Intent.ACTION_PACKAGE_ADDED,
            Intent.ACTION_PACKAGE_REPLACED,
        )

        fun start(context: Context) {
            context.startForegroundService(Intent(context, RoomFramePresenceService::class.java))
        }
    }
}
