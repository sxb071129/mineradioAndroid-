param(
  [switch]$InfoOnly
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

function Get-LanIPv4Addresses {
  $addresses = @(
    Get-NetIPConfiguration -ErrorAction SilentlyContinue |
      Where-Object {
        $_.NetAdapter.Status -eq "Up" -and
        $_.IPv4Address -and
        $_.IPv4DefaultGateway
      } |
      ForEach-Object { $_.IPv4Address.IPAddress } |
      Where-Object {
        $_ -and
        $_ -notlike "127.*" -and
        $_ -notlike "169.254.*"
      }
  )

  if (-not $addresses.Count) {
    $addresses = @(
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
          $_.AddressState -eq "Preferred" -and
          $_.IPAddress -notlike "127.*" -and
          $_.IPAddress -notlike "169.254.*"
        } |
        ForEach-Object { $_.IPAddress }
    )
  }

  return @($addresses | Sort-Object -Unique)
}

$LanAddresses = @(Get-LanIPv4Addresses)

Clear-Host
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host "  MR//ROOM LAN PLAYER" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Web port  : $WebPort" -ForegroundColor Cyan
Write-Host "Sync port : $RelayPort" -ForegroundColor Cyan
Write-Host "Music API : $MusicPort (NetEase + Kugou adapters)" -ForegroundColor Cyan
Write-Host "This PC   : http://localhost:$WebPort" -ForegroundColor Green
Write-Host ""

if ($LanAddresses.Count) {
  Write-Host "LAN access addresses:" -ForegroundColor White
  foreach ($Address in $LanAddresses) {
    Write-Host "  Web  http://${Address}:$WebPort" -ForegroundColor Green
    Write-Host "  Sync ws://${Address}:$RelayPort/ws" -ForegroundColor DarkCyan
    Write-Host "  API  http://${Address}:$MusicPort" -ForegroundColor DarkCyan
  }
} else {
  Write-Host "No active LAN IPv4 address was detected. Check the network connection." -ForegroundColor Yellow
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

Push-Location $ProjectRoot
try {
  Write-Host ""
  Write-Host "Starting the live server, sync relay, and restricted music API." -ForegroundColor Green
  Write-Host "Close this window or press Ctrl+C to stop." -ForegroundColor Green
  Write-Host ""
  & $Npm.Source run start:lan
  exit $LASTEXITCODE
} catch {
  Write-Host ""
  Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Pop-Location
}
