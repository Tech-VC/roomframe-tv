plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.roomframe.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.roomframe.tv"
        minSdk = 29
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
    }

    buildFeatures { viewBinding = true }
    buildTypes { release { isMinifyEnabled = true } }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
