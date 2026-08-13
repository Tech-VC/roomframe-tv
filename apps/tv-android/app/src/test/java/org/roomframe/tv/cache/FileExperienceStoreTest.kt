package org.roomframe.tv.cache

import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.roomframe.tv.experience.CanonicalJson

class FileExperienceStoreTest {
    @Test
    fun `corrupted active revision falls back to previous verified revision`() {
        val root = Files.createTempDirectory("roomframe-store-test").toFile()
        try {
            val store = FileExperienceStore(root)
            store.stageAndActivate(revision("sync-1", "Première"))
            store.stageAndActivate(revision("sync-2", "Deuxième"))
            File(root, "revisions/sync-2/scene.json").appendText("corruption")

            val active = store.loadActive()

            assertEquals("sync-1", active?.revisionId)
            assertEquals("sync-1", File(root, "active").readText().trim())
            assertFalse(File(root, "revisions/sync-2.staging").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `staging is idempotent for an already verified revision`() {
        val root = Files.createTempDirectory("roomframe-store-idempotent").toFile()
        try {
            val store = FileExperienceStore(root)
            val revision = revision("sync-3", "Stable")
            store.stageAndActivate(revision)
            val second = store.stageAndActivate(revision)
            assertEquals("sync-3", second.revisionId)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `previously verified revision is available without rehashing every asset`() {
        val root = Files.createTempDirectory("roomframe-store-fast-read").toFile()
        try {
            val store = FileExperienceStore(root)
            store.stageAndActivate(revision("sync-4", "Rapide"))

            assertEquals("sync-4", store.loadPreviouslyVerifiedActive()?.revisionId)
            assertTrue(File(root, "revisions/sync-4/.roomframe-verified").isFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `quick read rejects a revision whose manifest receipt no longer matches`() {
        val root = Files.createTempDirectory("roomframe-store-fast-read-tamper").toFile()
        try {
            val store = FileExperienceStore(root)
            store.stageAndActivate(revision("sync-5", "Protégée"))
            File(root, "revisions/sync-5/manifest.sha256").writeText("${"0".repeat(64)}\n")

            assertEquals(null, store.loadPreviouslyVerifiedActive())
            assertEquals(null, store.loadActive())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `only active and previous verified revisions are retained`() {
        val root = Files.createTempDirectory("roomframe-store-prune").toFile()
        try {
            val store = FileExperienceStore(root)
            store.stageAndActivate(revision("sync-1", "Première"))
            store.stageAndActivate(revision("sync-2", "Deuxième"))
            store.stageAndActivate(revision("sync-3", "Troisième"))

            assertFalse(File(root, "revisions/sync-1").exists())
            assertTrue(File(root, "revisions/sync-2").isDirectory)
            assertTrue(File(root, "revisions/sync-3").isDirectory)
        } finally {
            root.deleteRecursively()
        }
    }

    private fun revision(id: String, name: String): RevisionPackage {
        val scene = JSONObject()
            .put("schemaVersion", 2)
            .put("layoutId", "00000000-0000-4000-8000-000000000100")
            .put("name", name)
            .put(
                "canvas",
                JSONObject()
                    .put("width", 1920)
                    .put("height", 1080)
                    .put("renderTarget", "1080p")
                    .put(
                        "background",
                        JSONObject()
                            .put("type", "color")
                            .put("color", "#132323")
                            .put("mode", "cover"),
                    ),
            )
            .put("nodes", JSONArray())
        val sceneBytes = CanonicalJson.encode(scene)
        val sceneHash = CanonicalJson.sha256(sceneBytes)
        val manifest = JSONObject()
            .put("formatVersion", 1)
            .put("kind", "tv-sync")
            .put("revision", id.removePrefix("sync-").toInt())
            .put("sceneId", "00000000-0000-4000-8000-000000000100")
            .put("sceneRevision", 1)
            .put("generatedAt", "2026-07-28T00:00:00Z")
            .put(
                "documents",
                JSONArray().put(
                    JSONObject()
                        .put("path", "scene.json")
                        .put("sha256", sceneHash)
                        .put("size", sceneBytes.size),
                ),
            )
            .put("assets", JSONArray())
        val manifestBytes = CanonicalJson.encode(manifest)
        return RevisionPackage(
            revisionId = id,
            manifestBytes = manifestBytes,
            manifestSha256 = CanonicalJson.sha256(manifestBytes),
            assets = listOf(RevisionAsset.fromBytes("scene.json", sceneBytes, sceneHash)),
        )
    }
}
