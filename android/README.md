# Mineradio Android 16 Release Source

This Android project wraps the existing Mineradio web UI and Node.js HTTP API.

- Target Android version: Android 16 / API 36
- Package id: `com.mineradio.android`
- Runtime: Android WebView + embedded Node.js Mobile `v18.20.4`
- Release APK task: `gradle -p android assembleRelease`

Before building from a clean checkout, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap-android-tools.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\sync-android-assets.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-android-release.ps1
```

The sync script prepares `libnode.so`, Node headers, the app icon, and the compressed
`nodejs-project.zip` asset containing `server.js`, `public/`, `build/`,
`node_modules/`, and `android-main.js`.

Release signing keys are intentionally not committed. To produce a signed release
APK, set these environment variables or equivalent Gradle properties before
running the release script:

- `MINERADIO_RELEASE_STORE_FILE`
- `MINERADIO_RELEASE_STORE_PASSWORD`
- `MINERADIO_RELEASE_KEY_ALIAS`
- `MINERADIO_RELEASE_KEY_PASSWORD`
