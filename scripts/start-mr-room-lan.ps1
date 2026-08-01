param(
  [switch]$InfoOnly,
  [switch]$Https
)

$ErrorActionPreference = "Stop"
$WebPort = 3000
$MusicPort = if ($env:MINERADIO_MUSIC_PORT -match '^\d+$') {
  [int]$env:MINERADIO_MUSIC_PORT
} else {
  8790
}
$RelayPort = if ($env:MINERADIO_SYNC_PORT -match '^\d+$') {
  [int]$env:MINERADIO_SYNC_PORT
} else {
  8787
}
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$FirewallRuleName = "MR//ROOM LAN Player (Private)"
$FirewallScript = Join-Path $PSScriptRoot "configure-lan-firewall.ps1"
$HttpsPort = if ($env:MINERADIO_HTTPS_PORT -match '^\d+$') {
  [int]$env:MINERADIO_HTTPS_PORT
} else {
  3443
}
$EnrollPort = if ($env:MINERADIO_ENROLL_PORT -match '^\d+$') {
  [int]$env:MINERADIO_ENROLL_PORT
} else {
  3080
}
$TlsDir = if ($env:MINERADIO_TLS_DIR) {
  $env:MINERADIO_TLS_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Mineradio\tls"
}
$TlsReady = (
  (Test-Path -LiteralPath (Join-Path $TlsDir "server.pfx")) -and
  (Test-Path -LiteralPath (Join-Path $TlsDir "server.pass")) -and
  (Test-Path -LiteralPath (Join-Path $TlsDir "mineradio-root-ca.cer")) -and
  (Test-Path -LiteralPath (Join-Path $TlsDir "metadata.json"))
)

function Get-AddressKind {
  param(
    [string]$Alias,
    [string]$Description
  )
  $label = "$Alias $Description"
  if ($label -match "(?i)vpn|wireguard|wintun|tunnel|tailscale|zerotier|proton|vgate") {
    return "VPN"
  }
  if ($label -match "(?i)vethernet|hyper-v|virtual|vmware|virtualbox|loopback") {
    return "VIRTUAL"
  }
  if ($label -match "(?i)wi-?fi|wlan|wireless") {
    return "WLAN"
  }
  if ($label -match "(?i)ethernet") {
    return "ETHERNET"
  }
  return "OTHER"
}

function Get-LanConnections {
  $connections = @()
  $configurations = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)
  foreach ($configuration in $configurations) {
    if (-not $configuration.NetAdapter -or $configuration.NetAdapter.Status -ne "Up") {
      continue
    }
    $alias = [string]$configuration.InterfaceAlias
    $description = [string]$configuration.InterfaceDescription
    $kind = Get-AddressKind -Alias $alias -Description $description
    $category = if ($configuration.NetProfile) {
      [string]$configuration.NetProfile.NetworkCategory
    } else {
      "Unknown"
    }
    foreach ($entry in @($configuration.IPv4Address)) {
      $address = [string]$entry.IPAddress
      if (-not $address -or $address -like "127.*" -or $address -like "169.254.*") {
        continue
      }
      $score = 0
      if ($kind -eq "WLAN") { $score += 1000 }
      elseif ($kind -eq "ETHERNET") { $score += 900 }
      elseif ($kind -eq "OTHER") { $score += 400 }
      elseif ($kind -eq "VIRTUAL") { $score += 100 }
      elseif ($kind -eq "VPN") { $score -= 500 }
      if ($configuration.IPv4DefaultGateway) { $score += 200 }
      if ($category -eq "Private") { $score += 100 }
      if ($address -like "192.168.*") { $score += 80 }
      elseif ($address -like "10.*") { $score += 60 }
      elseif ($address -match "^172\.(1[6-9]|2\d|3[01])\.") { $score += 40 }

      $connections += [pscustomobject]@{
        Address = $address
        Alias = $alias
        Description = $description
        Kind = $kind
        Category = $category
        Score = $score
      }
    }
  }
  return @($connections | Sort-Object -Property @{Expression="Score";Descending=$true},Address -Unique)
}

function Test-LanFirewallRule {
  $rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
  if (-not $rule -or $rule.Enabled -ne "True" -or $rule.Action -ne "Allow") {
    return $false
  }
  $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
  $addressFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
  $ports = @($portFilter.LocalPort | ForEach-Object { @($_) }) -join ","
  $valid = (
    $rule.Profile -match "Private" -and
    $ports -match "3000" -and
    $ports -match "8787" -and
    $ports -match "8790" -and
    [string]$addressFilter.RemoteAddress -match "LocalSubnet"
  )
  if ($Https) {
    $valid = $valid -and $ports -match "3080" -and $ports -match "3443"
  }
  return $valid
}

$LanConnections = @(Get-LanConnections)
$PrimaryConnection = $LanConnections | Where-Object {
  $_.Kind -eq "WLAN" -or $_.Kind -eq "ETHERNET"
} | Select-Object -First 1
if (-not $PrimaryConnection) {
  $PrimaryConnection = $LanConnections | Select-Object -First 1
}
$OtherConnections = @($LanConnections | Where-Object {
  -not $PrimaryConnection -or $_.Address -ne $PrimaryConnection.Address
})
$FirewallReady = Test-LanFirewallRule

Clear-Host
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "  MR//ROOM LAN PLAYER" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Web port  : $WebPort" -ForegroundColor Cyan
Write-Host "Sync port : $RelayPort" -ForegroundColor Cyan
Write-Host "Music API : $MusicPort (NetEase + Kugou adapters)" -ForegroundColor Cyan
if ($Https) {
  Write-Host "HTTPS port: $HttpsPort / certificate setup: $EnrollPort" -ForegroundColor Cyan
}
Write-Host "This PC   : http://localhost:$WebPort" -ForegroundColor Green
if ($Https -and $TlsReady) {
  Write-Host "Secure PC : https://localhost:$HttpsPort" -ForegroundColor Green
}
Write-Host ""

if ($PrimaryConnection) {
  Write-Host "Recommended for phones and tablets:" -ForegroundColor White
  Write-Host "  [$($PrimaryConnection.Kind)] $($PrimaryConnection.Alias) / $($PrimaryConnection.Category)" -ForegroundColor Cyan
  Write-Host "  http://$($PrimaryConnection.Address):$WebPort" -ForegroundColor Green
  Write-Host "  Sync ws://$($PrimaryConnection.Address):$RelayPort/ws" -ForegroundColor DarkCyan
  Write-Host "  API  http://$($PrimaryConnection.Address):$MusicPort" -ForegroundColor DarkCyan
  if ($Https -and $TlsReady) {
    Write-Host "  Secure player https://$($PrimaryConnection.Address):$HttpsPort" -ForegroundColor Green
    Write-Host "  Certificate   http://$($PrimaryConnection.Address):$EnrollPort" -ForegroundColor Yellow
  }
  if ($PrimaryConnection.Category -ne "Private") {
    Write-Host "  WARNING: this Windows network is not Private; the LAN firewall rule may not apply." -ForegroundColor Yellow
  }
} else {
  Write-Host "No active LAN IPv4 address was detected. Check the Wi-Fi or Ethernet connection." -ForegroundColor Yellow
}

if ($OtherConnections.Count) {
  Write-Host ""
  Write-Host "Other adapters (usually not reachable from your phone):" -ForegroundColor DarkGray
  foreach ($connection in $OtherConnections) {
    Write-Host "  [$($connection.Kind)] $($connection.Alias): http://$($connection.Address):$WebPort" -ForegroundColor DarkGray
  }
}

Write-Host ""
if ($FirewallReady) {
  $firewallPorts = if ($Https) { "3000/3080/3443/8787/8790" } else { "3000/8787/8790" }
  Write-Host "[OK] Windows firewall: Private + LocalSubnet + TCP $firewallPorts" -ForegroundColor Green
} elseif ($InfoOnly) {
  Write-Host "[WARN] Windows firewall rule is missing. Normal startup will request one UAC approval." -ForegroundColor Yellow
} else {
  Write-Host "[SETUP] Windows will ask once for permission to allow Private-LAN access." -ForegroundColor Yellow
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $FirewallScript
  $FirewallReady = Test-LanFirewallRule
  if ($FirewallReady) {
    Write-Host "[OK] Windows firewall rule installed." -ForegroundColor Green
  } else {
    Write-Host "[WARN] Firewall permission was not granted. This PC can still open the site, but phones may be blocked." -ForegroundColor Yellow
  }
}

if ($LanConnections | Where-Object { $_.Kind -eq "VPN" }) {
  Write-Host "[NOTE] A VPN adapter is active. If the phone still cannot connect, enable the VPN's 'Allow LAN connections' option or pause its kill switch." -ForegroundColor Yellow
}

if ($Https) {
  if ($TlsReady) {
    Write-Host "[OK] HTTPS certificate bundle is ready outside the project folder." -ForegroundColor Green
  } else {
    Write-Host "[FAIL] HTTPS certificate bundle is missing." -ForegroundColor Red
    Write-Host "Run: npm.cmd run setup:https" -ForegroundColor Yellow
    if (-not $InfoOnly) {
      exit 1
    }
  }
}

Write-Host ""
Write-Host "Web listener  : 0.0.0.0:$WebPort" -ForegroundColor DarkGray
Write-Host "Sync listener : 0.0.0.0:$RelayPort" -ForegroundColor DarkGray
Write-Host "Music listener: 0.0.0.0:$MusicPort" -ForegroundColor DarkGray
Write-Host "Trusted home LAN room: no PIN or device approval." -ForegroundColor DarkYellow
Write-Host "============================================================" -ForegroundColor DarkGray

if ($InfoOnly) {
  exit 0
}

$Node = Get-Command node.exe -ErrorAction SilentlyContinue
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $Node -or -not $Npm) {
  Write-Host "Node.js or npm.cmd was not found. Install Node.js 22.13 or newer." -ForegroundColor Red
  exit 1
}

$NodeVersion = (& $Node.Source --version) -replace "^v", ""
try {
  $parsedNodeVersion = [version]$NodeVersion
  if ($parsedNodeVersion -lt [version]"22.13.0") {
    Write-Host "Node.js $NodeVersion is too old. MR//ROOM requires 22.13.0 or newer." -ForegroundColor Red
    exit 1
  }
} catch {
  Write-Host "Unable to verify Node.js version: $NodeVersion" -ForegroundColor Yellow
}

$BusyListeners = @(
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object {
      $expectedPorts = @($WebPort,$RelayPort,$MusicPort)
      if ($Https) { $expectedPorts += @($HttpsPort,$EnrollPort) }
      $expectedPorts -contains $_.LocalPort
    }
)
if ($BusyListeners.Count) {
  Write-Host ""
  Write-Host "MR//ROOM ports are already listening; another copy is probably running." -ForegroundColor Yellow
  $BusyListeners |
    Sort-Object LocalPort |
    Select-Object LocalAddress,LocalPort,OwningProcess |
    Format-Table -AutoSize
  if ($PrimaryConnection) {
    if ($Https -and $TlsReady) {
      Write-Host "Open: https://$($PrimaryConnection.Address):$HttpsPort" -ForegroundColor Green
    } else {
      Write-Host "Open: http://$($PrimaryConnection.Address):$WebPort" -ForegroundColor Green
    }
  }
  exit 0
}

Push-Location $ProjectRoot
try {
  Write-Host ""
  Write-Host "Starting the live server, sync relay, and restricted music API." -ForegroundColor Green
  Write-Host "Close this window or press Ctrl+C to stop." -ForegroundColor Green
  Write-Host ""
  if ($Https) {
    & $Npm.Source run start:lan:https
  } else {
    & $Npm.Source run start:lan
  }
  exit $LASTEXITCODE
} catch {
  Write-Host ""
  Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Pop-Location
}
