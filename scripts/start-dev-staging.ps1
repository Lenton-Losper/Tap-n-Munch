<#
.SYNOPSIS
  Starts the Next.js dev server against STAGING, bound on the LAN IP, for browser testing (#178).

.DESCRIPTION
  Two traps this exists to avoid, both of which have cost time on this project.

  1. A browser cannot reach a dev server started from a Bash sandbox. The server has to be
     started from PowerShell and bound on a real interface, not just loopback. If Playwright or
     Chrome cannot reach localhost, that is the cause — not the test.

  2. `.env.local` in this repo points NEXT_PUBLIC_SUPABASE_URL at PRODUCTION
     (ihlmmpmolnpchzgwyhgh). `next dev` loads it automatically, so the obvious `npm run dev`
     gives you a local UI wired to the production database. This script reads the staging values
     out of `.env.test` and puts them in the process environment first; @next/env does not
     overwrite variables that are already set, so they win over `.env.local`.

  Never point this at production. The guard below refuses.

.EXAMPLE
  powershell -File scripts/start-dev-staging.ps1 -Port 3100
#>
param(
  [int]$Port = 3100,
  [string]$BindHost = '0.0.0.0'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$envTestPath = Join-Path $repo '.env.test'

if (-not (Test-Path $envTestPath)) { throw "Missing $envTestPath" }
$envTest = Get-Content $envTestPath -Raw

function Get-EnvVal([string]$key) {
  $m = [regex]::Match($envTest, "(?m)^$key=(.*)$")
  if (-not $m.Success) { throw "Missing $key in .env.test" }
  return $m.Groups[1].Value.Trim().Trim('"')
}

$supabaseUrl = Get-EnvVal 'SUPABASE_URL'
if ($supabaseUrl -match 'ihlmmpmolnpchzgwyhgh') { throw 'REFUSING: .env.test points at PRODUCTION' }
if ($supabaseUrl -notmatch 'mdqjpxwczrhkxkbqatqa') { throw "REFUSING: expected the staging ref, got $supabaseUrl" }

# The LAN address Playwright/Chrome will actually dial. Hyper-V / WSL / Docker virtual switches
# also present IPv4 addresses and often sort first; binding the announced URL to one of those
# gives an address nothing on the network can reach, which looks exactly like the sandbox trap
# above and wastes the same hour. Prefer a real Wi-Fi/Ethernet adapter explicitly.
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware' -and
    $_.IPAddress -notmatch '^169\.254'
  } |
  Sort-Object { $_.InterfaceAlias -match 'Wi-Fi|Ethernet' } -Descending |
  Select-Object -First 1).IPAddress
if (-not $lanIp) { throw 'No usable LAN IPv4 address found (only virtual adapters).' }

# Set BEFORE next dev so these beat .env.local rather than losing to it.
$env:NEXT_PUBLIC_SUPABASE_URL      = $supabaseUrl
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = Get-EnvVal 'SUPABASE_ANON_KEY'
$env:SUPABASE_URL                  = $supabaseUrl
$env:SUPABASE_ANON_KEY             = Get-EnvVal 'SUPABASE_ANON_KEY'
$env:SUPABASE_SERVICE_ROLE_KEY     = Get-EnvVal 'SUPABASE_SERVICE_ROLE_KEY'
$env:NEXT_PUBLIC_APP_URL           = "http://${lanIp}:${Port}"
$env:NEXT_PUBLIC_BASE_URL          = "http://${lanIp}:${Port}"

Write-Output "Supabase project : mdqjpxwczrhkxkbqatqa (staging)"
Write-Output "Listening on     : http://${lanIp}:${Port}  (bound ${BindHost})"
Write-Output "E2E_BASE_URL     : http://${lanIp}:${Port}"

Set-Location $repo
& npx next dev --hostname $BindHost --port $Port
