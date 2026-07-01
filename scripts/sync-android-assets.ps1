$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$android = Join-Path $root 'android'
$app = Join-Path $android 'app'
$assets = Join-Path $app 'src\main\assets'
$libnodeSource = Join-Path $root 'tools\nodejs-mobile-v18.20.4-android'
$libnodeZip = Join-Path $root 'tools\nodejs-mobile-v18.20.4-android.zip'
$libnodeUrl = 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip'
$stage = Join-Path $root 'work\android-nodejs-project'
$zipPath = Join-Path $assets 'nodejs-project.zip'
$versionPath = Join-Path $assets 'nodejs-project.version'
$androidSdk = $env:ANDROID_SDK_ROOT
if (-not $androidSdk) {
  $androidSdk = Join-Path $root 'tools\android-sdk'
}
$ndkRoot = $env:ANDROID_NDK_HOME
if (-not $ndkRoot) {
  $ndkRoot = Get-ChildItem -Directory (Join-Path $androidSdk 'ndk') |
    Sort-Object Name -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
$llvmPrebuilt = Get-ChildItem -Directory (Join-Path $ndkRoot 'toolchains\llvm\prebuilt') |
  Select-Object -First 1 -ExpandProperty FullName
$cxxRuntimeTriples = @{
  'arm64-v8a' = 'aarch64-linux-android'
  'x86_64' = 'x86_64-linux-android'
}

if (-not (Test-Path $libnodeSource)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $libnodeZip) | Out-Null
  if (-not (Test-Path $libnodeZip)) {
    Write-Output "Downloading nodejs-mobile Android runtime..."
    curl.exe -L $libnodeUrl -o $libnodeZip
  }
  Expand-Archive -Force -Path $libnodeZip -DestinationPath $libnodeSource
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Output "Installing production Node dependencies..."
  & npm.cmd ci --ignore-scripts --omit=dev
}

New-Item -ItemType Directory -Force -Path $assets | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $app 'libnode') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $app 'src\main\jniLibs') | Out-Null

Remove-Item -Recurse -Force (Join-Path $app 'libnode\include') -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force (Join-Path $libnodeSource 'include') (Join-Path $app 'libnode\include')

foreach ($abi in @('arm64-v8a', 'x86_64')) {
  $abiDir = Join-Path $app "src\main\jniLibs\$abi"
  New-Item -ItemType Directory -Force -Path $abiDir | Out-Null
  Copy-Item -Force (Join-Path $libnodeSource "bin\$abi\libnode.so") (Join-Path $abiDir 'libnode.so')
  $cxxRuntime = Join-Path $llvmPrebuilt "sysroot\usr\lib\$($cxxRuntimeTriples[$abi])\libc++_shared.so"
  if (-not (Test-Path $cxxRuntime)) {
    throw "Missing C++ shared runtime for $abi at $cxxRuntime"
  }
  Copy-Item -Force $cxxRuntime (Join-Path $abiDir 'libc++_shared.so')
}

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($item in @('public', 'build', 'node_modules')) {
  Copy-Item -Recurse -Force (Join-Path $root $item) (Join-Path $stage $item)
}

foreach ($file in @('server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json', 'android-main.js')) {
  Copy-Item -Force (Join-Path $root $file) (Join-Path $stage $file)
}

Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stageRoot = (Resolve-Path $stage).Path.TrimEnd('\') + '\'
$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $stage -Recurse -Force |
    Where-Object { -not $_.PSIsContainer } |
    ForEach-Object {
      $entryName = $_.FullName.Substring($stageRoot.Length).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $_.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLowerInvariant()
Set-Content -Path $versionPath -Value $hash -Encoding ASCII

$iconSource = Join-Path $root 'build\icon.png'
$iconTarget = Join-Path $app 'src\main\res\drawable\icon.png'
if (Test-Path $iconSource) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $iconTarget) | Out-Null
  Copy-Item -Force $iconSource $iconTarget
}

Write-Output "Synced Android assets: $zipPath"
Write-Output "Asset version: $hash"
