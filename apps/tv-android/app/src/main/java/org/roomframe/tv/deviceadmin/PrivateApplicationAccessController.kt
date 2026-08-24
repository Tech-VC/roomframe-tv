package org.roomframe.tv.deviceadmin

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import org.roomframe.tv.RoomFrameAdminReceiver

internal data class PrivateApplicationRuntimeState(
    val applicationId: String,
    val installed: Boolean,
    val versionName: String?,
    val versionCode: Long?,
    val accessEnforced: Boolean,
)

internal interface PrivateApplicationAccessController {
    fun lockPreviouslyManaged(): List<PrivateApplicationRuntimeState>

    fun setLocked(
        configuredApplicationIds: List<String>,
        locked: Boolean,
    ): List<PrivateApplicationRuntimeState>

    fun inspect(
        configuredApplicationIds: List<String>,
    ): List<PrivateApplicationRuntimeState>
}

/**
 * Le Device Owner ne reçoit jamais un inventaire global : chaque appel porte
 * uniquement sur les identifiants déjà synchronisés dans l'allowlist privée.
 */
internal class AndroidPrivateApplicationAccessController(
    context: Context,
) : PrivateApplicationAccessController {
    private val applicationContext = context.applicationContext
    private val packageManager = applicationContext.packageManager
    private val devicePolicyManager =
        applicationContext.getSystemService(DevicePolicyManager::class.java)
    private val admin = ComponentName(applicationContext, RoomFrameAdminReceiver::class.java)
    private val preferences = applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    private val enforcement = mutableMapOf<String, Boolean>()

    /**
     * Referme les paquets déjà confiés à RoomFrame après un redémarrage du
     * processus ou un écran éteint, sans découvrir ni toucher aucun autre
     * paquet de la TV.
     */
    override fun lockPreviouslyManaged(): List<PrivateApplicationRuntimeState> =
        synchronized(POLICY_LOCK) {
            val managed = managedApplicationIds()
            val desired = desiredApplicationIds(managed)
            val pendingRelease = pendingReleaseApplicationIds()
            val isDeviceOwner = runCatching {
                devicePolicyManager.isDeviceOwnerApp(applicationContext.packageName)
            }.getOrDefault(false)
            val runtimeEligible = desired.filterTo(linkedSetOf()) { applicationId ->
                PrivateApplicationPolicy.controllable(
                    applicationId,
                    applicationContext.packageName,
                ) && runtimeControllable(applicationId)
            }
            val reconciliation = privateApplicationReconciliation(
                desired = desired,
                previouslyManaged = managed,
                pendingRelease = pendingRelease,
                runtimeControllable = runtimeEligible,
            )
            val hidden = !PrivateApplicationSessionState.isUnlocked()
            val successfullyReleased = if (isDeviceOwner) {
                reconciliation.release.filterTo(linkedSetOf()) { applicationId ->
                    setHiddenAndConfirm(applicationId, hidden = false)
                }
            } else {
                emptySet()
            }
            val releaseFailures = pendingPrivateApplicationReleases(
                reconciliation.release,
                successfullyReleased,
            )
            val activelyManaged = if (isDeviceOwner) {
                managedPrivateApplicationsAfterRelease(
                    manageCandidates = reconciliation.manage,
                    previouslyManaged = managed,
                    pendingRelease = releaseFailures,
                )
            } else {
                emptySet()
            }
            activelyManaged.forEach { applicationId ->
                enforcement[applicationId] = isDeviceOwner &&
                    setHiddenAndConfirm(applicationId, hidden = hidden)
            }
            desired.forEach { applicationId ->
                if (applicationId !in activelyManaged) enforcement[applicationId] = false
            }
            enforcement.keys.retainAll(desired)
            persistManagedApplicationState(
                desired = reconciliation.desired,
                managed = activelyManaged,
                pendingRelease = releaseFailures,
            )
            inspect(desired.toList())
        }

    override fun setLocked(
        configuredApplicationIds: List<String>,
        locked: Boolean,
    ): List<PrivateApplicationRuntimeState> = synchronized(POLICY_LOCK) {
        val configured = configuredApplicationIds
            .asSequence()
            .filter(PrivateApplicationPolicy::validIdentifier)
            .distinct()
            .take(MAX_APPLICATIONS)
            .toList()
        if (locked) {
            PrivateApplicationSessionState.lock()
        }
        val isDeviceOwner = runCatching {
            devicePolicyManager.isDeviceOwnerApp(applicationContext.packageName)
        }.getOrDefault(false)
        val previouslyManaged = managedApplicationIds()
        val desired = configured.toCollection(linkedSetOf())
        val runtimeEligible = desired.filterTo(linkedSetOf()) { applicationId ->
            PrivateApplicationPolicy.controllable(applicationId, applicationContext.packageName) &&
                runtimeControllable(applicationId)
        }
        val reconciliation = privateApplicationReconciliation(
            desired = desired,
            previouslyManaged = previouslyManaged,
            pendingRelease = pendingReleaseApplicationIds(),
            runtimeControllable = runtimeEligible,
        )
        val successfullyReleased = if (isDeviceOwner) {
            reconciliation.release.filterTo(linkedSetOf()) { applicationId ->
                setHiddenAndConfirm(applicationId, hidden = false)
            }
        } else {
            emptySet()
        }
        val releaseFailures = pendingPrivateApplicationReleases(
            reconciliation.release,
            successfullyReleased,
        )
        val activelyManaged = if (isDeviceOwner) {
            managedPrivateApplicationsAfterRelease(
                manageCandidates = reconciliation.manage,
                previouslyManaged = previouslyManaged,
                pendingRelease = releaseFailures,
            )
        } else {
            emptySet()
        }

        configured.forEach { applicationId ->
            val installed = packageInfo(applicationId) != null
            val canControl = isDeviceOwner && installed && applicationId in activelyManaged
            enforcement[applicationId] = if (!canControl) {
                false
            } else {
                setHiddenAndConfirm(applicationId, locked)
            }
        }
        enforcement.keys.retainAll(configured.toSet())
        try {
            persistManagedApplicationState(
                desired = reconciliation.desired,
                managed = activelyManaged,
                pendingRelease = releaseFailures,
            )
        } catch (error: RuntimeException) {
            PrivateApplicationSessionState.lock()
            if (isDeviceOwner) {
                activelyManaged.forEach { applicationId ->
                    setHiddenAndConfirm(applicationId, hidden = true)
                }
            }
            throw error
        }
        // Un déverrouillage n'est publié au reste du processus qu'après la
        // politique DPM et sa persistance. Une erreur garde ainsi l'état
        // process-local fermé et sera réconciliée au prochain événement.
        if (!locked) PrivateApplicationSessionState.unlock()
        inspect(configured)
    }

    override fun inspect(
        configuredApplicationIds: List<String>,
    ): List<PrivateApplicationRuntimeState> = synchronized(POLICY_LOCK) {
        configuredApplicationIds
            .distinct()
            .take(MAX_APPLICATIONS)
            .map { applicationId ->
                val packageInfo = packageInfo(applicationId)
                PrivateApplicationRuntimeState(
                    applicationId = applicationId,
                    installed = packageInfo != null,
                    versionName = packageInfo?.versionName?.take(MAX_VERSION_NAME_LENGTH),
                    versionCode = packageInfo?.longVersionCode,
                    accessEnforced = enforcement[applicationId] == true,
                )
            }
    }

    private fun setHiddenAndConfirm(applicationId: String, hidden: Boolean): Boolean =
        runCatching {
            devicePolicyManager.setApplicationHidden(admin, applicationId, hidden)
            devicePolicyManager.isApplicationHidden(admin, applicationId) == hidden
        }.getOrDefault(false)

    private fun runtimeControllable(applicationId: String): Boolean {
        val packageInfo = packageInfo(applicationId) ?: return false
        val applicationInfo = packageInfo.applicationInfo ?: return false
        val flags = applicationInfo.flags
        val protectedComponent = packageInfo.services.orEmpty().any { service ->
            service.permission in PROTECTED_COMPONENT_PERMISSIONS
        } || packageInfo.receivers.orEmpty().any { receiver ->
            receiver.permission in PROTECTED_COMPONENT_PERMISSIONS
        }
        return privateApplicationRuntimeControllable(
            PrivateApplicationRuntimeDescriptor(
                applicationId = applicationId,
                persistent = flags and ApplicationInfo.FLAG_PERSISTENT != 0,
                systemApplication = flags and ApplicationInfo.FLAG_SYSTEM != 0,
                updatedSystemApplication = flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP != 0,
                providesHome = providesHome(applicationId),
                exposesProtectedComponent = protectedComponent,
                launchable = hasLaunchableActivity(applicationId),
            ),
        )
    }

    private fun providesHome(applicationId: String): Boolean {
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_HOME)
            .setPackage(applicationId)
        return queryIntentActivitiesIncludingHidden(intent).isNotEmpty()
    }

    private fun hasLaunchableActivity(applicationId: String): Boolean = listOf(
        Intent.CATEGORY_LEANBACK_LAUNCHER,
        Intent.CATEGORY_LAUNCHER,
    ).any { category ->
        val intent = Intent(Intent.ACTION_MAIN)
            .addCategory(category)
            .setPackage(applicationId)
        queryIntentActivitiesIncludingHidden(intent).isNotEmpty()
    }

    /**
     * MATCH_UNINSTALLED_PACKAGES est indispensable ici : Android rend un
     * paquet masqué par le DPM invisible aux résolutions ordinaires. Son
     * FLAG_INSTALLED a déjà été contrôlé par [packageInfo].
     */
    @Suppress("DEPRECATION")
    private fun queryIntentActivitiesIncludingHidden(intent: Intent) =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.queryIntentActivities(
                intent,
                PackageManager.ResolveInfoFlags.of(QUERY_ACTIVITY_FLAGS.toLong()),
            )
        } else {
            packageManager.queryIntentActivities(intent, QUERY_ACTIVITY_FLAGS)
        }

    private fun desiredApplicationIds(fallbackManaged: Set<String>): Set<String> =
        if (preferences.contains(KEY_DESIRED_APPLICATION_IDS)) {
            storedApplicationIds(KEY_DESIRED_APPLICATION_IDS)
        } else {
            fallbackManaged
        }

    private fun managedApplicationIds(): Set<String> =
        storedApplicationIds(KEY_MANAGED_APPLICATION_IDS, MAX_APPLICATIONS)

    private fun pendingReleaseApplicationIds(): Set<String> =
        storedApplicationIds(KEY_PENDING_RELEASE_APPLICATION_IDS, MAX_PENDING_RELEASES)

    private fun storedApplicationIds(
        key: String,
        maximum: Int = MAX_APPLICATIONS,
    ): Set<String> {
        val stored = preferences
            .getStringSet(key, emptySet())
            .orEmpty()
            .asSequence()
            .filter(PrivateApplicationPolicy::validIdentifier)
            .toCollection(linkedSetOf())
        check(stored.size <= maximum) {
            "Politique d'applications privées incohérente ($key)"
        }
        return stored
    }

    private fun persistManagedApplicationState(
        desired: Set<String>,
        managed: Set<String>,
        pendingRelease: Set<String>,
    ) {
        check(desired.size <= MAX_APPLICATIONS)
        check(managed.size <= MAX_APPLICATIONS)
        check(pendingRelease.size <= MAX_PENDING_RELEASES)
        check(
            preferences.edit()
                .putStringSet(
                    KEY_DESIRED_APPLICATION_IDS,
                    desired.take(MAX_APPLICATIONS).toSet(),
                )
                .putStringSet(
                    KEY_MANAGED_APPLICATION_IDS,
                    managed.take(MAX_APPLICATIONS).toSet(),
                )
                .putStringSet(
                    KEY_PENDING_RELEASE_APPLICATION_IDS,
                    pendingRelease,
                )
                .commit(),
        ) { "Impossible de conserver la politique des applications privées" }
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(applicationId: String): PackageInfo? = runCatching {
        val flags = PackageManager.MATCH_UNINSTALLED_PACKAGES or
            PackageManager.GET_ACTIVITIES or
            PackageManager.GET_SERVICES or
            PackageManager.GET_RECEIVERS
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageInfo(
                applicationId,
                PackageManager.PackageInfoFlags.of(
                    flags.toLong(),
                ),
            )
        } else {
            packageManager.getPackageInfo(applicationId, flags)
        }
        info.takeIf {
            it.applicationInfo?.flags?.and(ApplicationInfo.FLAG_INSTALLED) != 0
        }
    }.getOrNull()

    private companion object {
        const val MAX_APPLICATIONS = 12
        // Compatibilité avec d'anciennes rotations fautives, sans troncature
        // silencieuse d'un paquet qui pourrait encore être masqué.
        const val MAX_PENDING_RELEASES = 512
        const val MAX_VERSION_NAME_LENGTH = 100
        const val QUERY_ACTIVITY_FLAGS = PackageManager.MATCH_DEFAULT_ONLY or
            PackageManager.MATCH_UNINSTALLED_PACKAGES
        const val PREFERENCES_NAME = "roomframe-private-application-access"
        const val KEY_DESIRED_APPLICATION_IDS = "desired_application_ids"
        const val KEY_MANAGED_APPLICATION_IDS = "managed_application_ids"
        const val KEY_PENDING_RELEASE_APPLICATION_IDS = "pending_release_application_ids"
        val POLICY_LOCK = Any()
        val PROTECTED_COMPONENT_PERMISSIONS = setOf(
            "android.permission.BIND_DEVICE_ADMIN",
            "android.permission.BIND_INPUT_METHOD",
            "android.permission.BIND_ACCESSIBILITY_SERVICE",
            "android.permission.BIND_TV_INPUT",
            "android.permission.BIND_VPN_SERVICE",
        )
    }
}
