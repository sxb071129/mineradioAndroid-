$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
$jdkZip = Join-Path $tools 'jdk21.zip'
$jdkDir = Join-Path $tools 'jdk21'
$sdkRoot = Join-Path $tools 'android-sdk'
$cmdlineZip = Join-Path $tools 'android-commandlinetools.zip'
$cmdlineTmp = Join-Path $tools 'android-commandlinetools'
$gradleZip = Join-Path $tools 'gradle-8.10.2-bin.zip'
$gradleDir = Join-Path $tools 'gradle'

New-Item -ItemType Directory -Force -Path $tools | Out-Null

if (-not (Get-ChildItem -Directory $jdkDir -Filter 'jdk-*' -ErrorAction SilentlyContinue | Select-Object -First 1)) {
  Write-Output 'Downloading Temurin JDK 21...'
  curl.exe -L 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' -o $jdkZip
  Remove-Item -Recurse -Force $jdkDir -ErrorAction SilentlyContinue
  Expand-Archive -Path $jdkZip -DestinationPath $jdkDir
}

if (-not (Test-Path (Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'))) {
  Write-Output 'Downloading Android command-line tools...'
  curl.exe -L 'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip' -o $cmdlineZip
  Remove-Item -Recurse -Force $cmdlineTmp -ErrorAction SilentlyContinue
  Expand-Archive -Path $cmdlineZip -DestinationPath $cmdlineTmp
  New-Item -ItemType Directory -Force -Path (Join-Path $sdkRoot 'cmdline-tools') | Out-Null
  Remove-Item -Recurse -Force (Join-Path $sdkRoot 'cmdline-tools\latest') -ErrorAction SilentlyContinue
  Move-Item (Join-Path $cmdlineTmp 'cmdline-tools') (Join-Path $sdkRoot 'cmdline-tools\latest')
}

if (-not (Test-Path (Join-Path $gradleDir 'gradle-8.10.2\bin\gradle.bat'))) {
  Write-Output 'Downloading Gradle 8.10.2...'
  curl.exe -L 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip' -o $gradleZip
  Remove-Item -Recurse -Force $gradleDir -ErrorAction SilentlyContinue
  Expand-Archive -Path $gradleZip -DestinationPath $gradleDir
}

$jdkHome = (Get-ChildItem -Directory $jdkDir -Filter 'jdk-*' | Select-Object -First 1).FullName
$env:JAVA_HOME = $jdkHome
$env:ANDROID_SDK_ROOT = (Resolve-Path $sdkRoot).Path
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_SDK_ROOT\cmdline-tools\latest\bin;$env:ANDROID_SDK_ROOT\platform-tools;$env:Path"

Write-Output 'Accepting Android SDK licenses...'
1..20 | ForEach-Object { 'y' } | sdkmanager --licenses | Out-Host

Write-Output 'Installing Android 16 build components...'
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" "cmake;3.22.1" "ndk;28.2.13676358"

Write-Output 'Android build tools are ready.'
