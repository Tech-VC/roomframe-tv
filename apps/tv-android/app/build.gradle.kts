plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseSigningEnvironment = mapOf(
    "store" to providers.environmentVariable("ROOMFRAME_ANDROID_SIGNING_STORE").orNull,
    "storePassword" to providers.environmentVariable("ROOMFRAME_ANDROID_SIGNING_STORE_PASSWORD").orNull,
    "keyAlias" to providers.environmentVariable("ROOMFRAME_ANDROID_SIGNING_KEY_ALIAS").orNull,
    "keyPassword" to providers.environmentVariable("ROOMFRAME_ANDROID_SIGNING_KEY_PASSWORD").orNull,
)
val configuredReleaseSigningValues = releaseSigningEnvironment.values.count { !it.isNullOrBlank() }
if (configuredReleaseSigningValues !in setOf(0, releaseSigningEnvironment.size)) {
    throw GradleException(
        "La signature Android release est partiellement configurée; fournir les quatre variables ROOMFRAME_ANDROID_SIGNING_*",
    )
}

android {
    namespace = "org.roomframe.tv"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "org.roomframe.tv"
        minSdk = 29
        targetSdk = 35
        versionCode = 13
        versionName = "0.3.10"
    }

    signingConfigs {
        if (configuredReleaseSigningValues == releaseSigningEnvironment.size) {
            create("roomframeRelease") {
                storeFile = file(requireNotNull(releaseSigningEnvironment["store"]))
                storePassword = requireNotNull(releaseSigningEnvironment["storePassword"])
                keyAlias = requireNotNull(releaseSigningEnvironment["keyAlias"])
                keyPassword = requireNotNull(releaseSigningEnvironment["keyPassword"])
                storeType = "PKCS12"
                (this as com.android.build.api.dsl.ApkSigningConfig).apply {
                    enableV1Signing = false
                    enableV2Signing = true
                    enableV3Signing = true
                    enableV4Signing = false
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            if (configuredReleaseSigningValues == releaseSigningEnvironment.size) {
                signingConfig = signingConfigs.getByName("roomframeRelease")
            }
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260522")
}
