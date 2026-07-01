$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$jdkHome = Get-ChildItem -Directory (Join-Path $root 'tools\jdk21') -Filter 'jdk-*' | Select-Object -First 1
$sdkRoot = Join-Path $root 'tools\android-sdk'
$gradleBat = Join-Path $root 'tools\gradle\gradle-8.10.2\bin\gradle.bat'

if (-not $jdkHome) {
  throw 'Missing portable JDK. Run scripts\bootstrap-android-tools.ps1 first.'
}
if (-not (Test-Path $sdkRoot)) {
  throw 'Missing Android SDK. Run scripts\bootstrap-android-tools.ps1 first.'
}
if (-not (Test-Path $gradleBat)) {
  throw 'Missing Gradle. Run scripts\bootstrap-android-tools.ps1 first.'
}

& (Join-Path $PSScriptRoot 'sync-android-assets.ps1')

$env:JAVA_HOME = $jdkHome.FullName
$env:ANDROID_SDK_ROOT = (Resolve-Path $sdkRoot).Path
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_SDK_ROOT\cmdline-tools\latest\bin;$env:ANDROID_SDK_ROOT\platform-tools;$env:Path"

& $gradleBat -p (Join-Path $root 'android') assembleRelease

$sourceApk = Join-Path $root 'android\app\build\outputs\apk\release\app-release-unsigned.apk'
if (-not (Test-Path $sourceApk)) {
  $sourceApk = Join-Path $root 'android\app\build\outputs\apk\release\app-release.apk'
}

$outputDir = Join-Path $root 'outputs'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force $sourceApk (Join-Path $outputDir 'Mineradio-Android16-release.apk')
Write-Output "APK: $outputDir\Mineradio-Android16-release.apk"
