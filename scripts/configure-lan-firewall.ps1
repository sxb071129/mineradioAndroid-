param(
  [switch]$Remove,
  [switch]$NoElevation
)

$ErrorActionPreference = "Stop"
$RuleName = "MR//ROOM LAN Player (Private)"
$Ports = @(3000, 3080, 3443, 8787, 8790)

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  if ($NoElevation) {
    throw "Administrator privileges are required to configure the Windows firewall."
  }
  $arguments = @(
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
  )
  if ($Remove) {
    $arguments += "-Remove"
  }
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList ($arguments -join " ") `
    -Verb RunAs `
    -Wait `
    -PassThru
  exit $process.ExitCode
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Remove-NetFirewallRule
}

if ($Remove) {
  Write-Host "Removed the MR//ROOM private-LAN firewall rule." -ForegroundColor Yellow
  exit 0
}

New-NetFirewallRule `
  -DisplayName $RuleName `
  -Group "MR//ROOM" `
  -Description "Allows MR//ROOM web, HTTPS gateway, sync relay, and music adapter only from the local subnet on Private networks." `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Protocol TCP `
  -LocalPort $Ports `
  -RemoteAddress LocalSubnet | Out-Null

Write-Host "MR//ROOM LAN access is allowed on Private networks." -ForegroundColor Green
Write-Host "Ports: $($Ports -join ', ') / Remote addresses: LocalSubnet" -ForegroundColor Cyan
