package org.roomframe.tv.sync

import org.roomframe.tv.cache.RevisionPackage

sealed interface SyncResult {
    data object UpToDate : SyncResult
    data class RevisionAvailable(val revision: RevisionPackage) : SyncResult
    data class Failed(val reason: String) : SyncResult
}

interface ExperienceSyncClient {
    /**
     * L'implémentation HTTPS future devra utiliser le certificat individuel de la TV
     * et ne retourner une révision qu'après validation stricte de la réponse.
     */
    fun fetchAfter(activeRevisionId: String?): SyncResult
}

interface ManifestVerifier {
    fun verifyCanonicalManifest(manifestBytes: ByteArray, expectedSha256: String): Boolean
}
