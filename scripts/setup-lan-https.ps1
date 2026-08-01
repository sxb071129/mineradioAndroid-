param(
  [switch]$TrustOnThisPC,
  [switch]$RotateRoot,
  [switch]$InfoOnly
)

$ErrorActionPreference = "Stop"
$TlsDir = if ($env:MINERADIO_TLS_DIR) {
  $env:MINERADIO_TLS_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Mineradio\tls"
}
$RootPfxPath = Join-Path $TlsDir "root-ca.pfx"
$RootCerPath = Join-Path $TlsDir "mineradio-root-ca.cer"
$ServerPfxPath = Join-Path $TlsDir "server.pfx"
$PasswordPath = Join-Path $TlsDir "server.pass"
$MetadataPath = Join-Path $TlsDir "metadata.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-LanIPv4Addresses {
  return @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.AddressState -eq "Preferred" -and
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.IPAddress -notlike "0.*"
      } |
      ForEach-Object { $_.IPAddress } |
      Sort-Object -Unique
  )
}

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  $generator = New-Object Security.Cryptography.RNGCryptoServiceProvider
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Protect-TlsDirectory {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $TlsDir "/inheritance:r" "/grant:r" "${identity}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to restrict the TLS directory permissions."
  }
}

if ($InfoOnly) {
  $metadata = $null
  if (Test-Path -LiteralPath $MetadataPath) {
    try {
      $metadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
    } catch {}
  }
  [pscustomobject]@{
    Ready = (
      (Test-Path -LiteralPath $RootCerPath) -and
      (Test-Path -LiteralPath $ServerPfxPath) -and
      (Test-Path -LiteralPath $PasswordPath)
    )
    Directory = $TlsDir
    RootCertificate = $RootCerPath
    ServerCertificate = $ServerPfxPath
    ExpiresAt = if ($metadata) { $metadata.expiresAt } else { $null }
    Hosts = if ($metadata) { @($metadata.hosts) -join ", " } else { "" }
  } | Format-List
  exit 0
}

New-Item -ItemType Directory -Path $TlsDir -Force | Out-Null

$password = if ((Test-Path -LiteralPath $PasswordPath) -and -not $RotateRoot) {
  (Get-Content -Raw -LiteralPath $PasswordPath).Trim()
} else {
  New-RandomPassword
}
if (-not $password) {
  throw "The TLS password file is empty."
}
[IO.File]::WriteAllText($PasswordPath, $password, $Utf8NoBom)
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force

$rootCertificate = $null
$serverCertificate = $null
try {
  if ($RotateRoot) {
    if (Test-Path -LiteralPath $MetadataPath) {
      try {
        $oldMetadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
        if ($oldMetadata.caThumbprint -match "^[A-Fa-f0-9]{40}$") {
          Remove-Item `
            -LiteralPath "Cert:\CurrentUser\Root\$($oldMetadata.caThumbprint)" `
            -Force `
            -ErrorAction SilentlyContinue
        }
      } catch {}
    }
    Remove-Item -LiteralPath $RootPfxPath,$RootCerPath -Force -ErrorAction SilentlyContinue
  }

  if (Test-Path -LiteralPath $RootPfxPath) {
    $rootCertificate = Import-PfxCertificate `
      -FilePath $RootPfxPath `
      -Password $securePassword `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -Exportable
  } else {
    $rootCertificate = New-SelfSignedCertificate `
      -Type Custom `
      -Subject "CN=MR ROOM Local Root CA" `
      -FriendlyName "MR ROOM Local Root CA" `
      -KeyAlgorithm RSA `
      -KeyLength 3072 `
      -KeyExportPolicy Exportable `
      -KeyUsage CertSign,CRLSign `
      -HashAlgorithm SHA256 `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -NotAfter (Get-Date).AddYears(8) `
      -TextExtension @(
        "2.5.29.19={critical}{text}ca=1&pathlength=1"
      )
    Export-PfxCertificate `
      -Cert $rootCertificate `
      -FilePath $RootPfxPath `
      -Password $securePassword | Out-Null
    Export-Certificate `
      -Cert $rootCertificate `
      -FilePath $RootCerPath `
      -Type CERT | Out-Null
  }

  if (-not (Test-Path -LiteralPath $RootCerPath)) {
    Export-Certificate `
      -Cert $rootCertificate `
      -FilePath $RootCerPath `
      -Type CERT | Out-Null
  }

  $lanAddresses = @(Get-LanIPv4Addresses)
  $hosts = @("localhost", "127.0.0.1", "::1")
  if ($env:COMPUTERNAME) {
    $hosts += $env:COMPUTERNAME.ToLowerInvariant()
  }
  $hosts += $lanAddresses
  $hosts = @($hosts | Sort-Object -Unique)

  $sanEntries = @("dns=localhost")
  if ($env:COMPUTERNAME) {
    $sanEntries += "dns=$($env:COMPUTERNAME)"
  }
  foreach ($hostValue in $hosts) {
    if ($hostValue -match "^\d{1,3}(?:\.\d{1,3}){3}$" -or $hostValue -eq "::1") {
      $sanEntries += "ipaddress=$hostValue"
    }
  }
  $sanExtension = "{text}" + ($sanEntries -join "&")

  $serverCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=MR ROOM LAN" `
    -FriendlyName "MR ROOM LAN Server" `
    -Signer $rootCertificate `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature,KeyEncipherment `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddDays(397) `
    -TextExtension @(
      "2.5.29.17=$sanExtension",
      "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
    )

  Export-PfxCertificate `
    -Cert $serverCertificate `
    -FilePath $ServerPfxPath `
    -Password $securePassword `
    -Force | Out-Null

  $metadata = [ordered]@{
    version = 1
    hosts = $hosts
    caThumbprint = $rootCertificate.Thumbprint
    serverThumbprint = $serverCertificate.Thumbprint
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    expiresAt = $serverCertificate.NotAfter.ToUniversalTime().ToString("o")
  }
  [IO.File]::WriteAllText(
    $MetadataPath,
    ($metadata | ConvertTo-Json -Depth 4),
    $Utf8NoBom
  )

  if ($TrustOnThisPC) {
    $trusted = Get-ChildItem "Cert:\CurrentUser\Root" |
      Where-Object { $_.Thumbprint -eq $rootCertificate.Thumbprint } |
      Select-Object -First 1
    if (-not $trusted) {
      Import-Certificate `
        -FilePath $RootCerPath `
        -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    }
  }
} finally {
  if ($serverCertificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($serverCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
  }
  if ($rootCertificate) {
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($rootCertificate.Thumbprint)" -Force -ErrorAction SilentlyContinue
  }
}

Protect-TlsDirectory

Write-Host "MR//ROOM HTTPS certificate files are ready." -ForegroundColor Green
Write-Host "TLS directory : $TlsDir" -ForegroundColor Cyan
Write-Host "Root CA file  : $RootCerPath" -ForegroundColor Cyan
Write-Host "Server expires: $($metadata.expiresAt)" -ForegroundColor Cyan
if ($TrustOnThisPC) {
  Write-Host "The dedicated MR//ROOM root CA is trusted for the current Windows user." -ForegroundColor Green
} else {
  Write-Host "The root CA was not added to Windows trust. Run with -TrustOnThisPC when ready." -ForegroundColor Yellow
}
