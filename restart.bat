@echo off
rem ===========================================================================
rem  jimeng-free-api restart.bat
rem  Stop this folder's running service, rebuild safely, and start with pool key
rem
rem  Usage:
rem    restart.bat             rebuild, restart in background, open browser
rem    restart.bat --no-build  skip build, fast restart using existing dist/
rem    restart.bat --no-open   do not open browser after readiness check
rem    restart.bat --serve     run in current console window (Ctrl+C to stop)
rem    restart.bat --stop      stop this folder's running service and exit
rem ===========================================================================
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title jimeng-free-api restart

set "__RESTART_BAT=%~f0"
set "__RESTART_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath $env:__RESTART_BAT -Encoding UTF8; $idx = [Array]::IndexOf($lines, ':: --- PS ---'); & ([ScriptBlock]::Create(($lines[($idx + 1)..($lines.Length - 1)] -join \"`n\")))"
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
  echo %CMDCMDLINE% | findstr /i /c:" /c " >nul && pause
)
exit /b %EC%
:: --- PS ---
$ErrorActionPreference = 'Stop'
$root = (Split-Path -Parent $env:__RESTART_BAT).TrimEnd('\')
Set-Location -LiteralPath $root

$rawArgs = [string]$env:__RESTART_ARGS
$tokens = if ([string]::IsNullOrWhiteSpace($rawArgs)) { @() } else { $rawArgs -split '\s+' | Where-Object { $_ -ne '' } }

$doBuild = $true
$openBrowser = $true
$serveForeground = $false
$stopOnly = $false

foreach ($arg in $tokens) {
  switch ($arg.ToLowerInvariant()) {
    '--no-build' { $doBuild = $false }
    '--no-open'  { $openBrowser = $false }
    '--serve'    { $serveForeground = $true; $openBrowser = $false }
    '--stop'     { $stopOnly = $true; $doBuild = $false; $openBrowser = $false }
    '--help'     { $showHelp = $true }
    '-h'         { $showHelp = $true }
    default {
      Write-Host "[restart] unknown argument: $arg" -ForegroundColor Red
      $showHelp = $true
      $badArg = $true
    }
  }
}

if ($showHelp) {
  Write-Host 'Usage: restart.bat [--no-build] [--no-open] [--serve] [--stop]'
  Write-Host '  (no flag)    rebuild into staging, restart in background, open browser'
  Write-Host '  --no-build   restart immediately using existing dist/index.js'
  Write-Host '  --no-open    do not open browser after startup'
  Write-Host '  --serve      run in foreground console (Ctrl+C stops it)'
  Write-Host '  --stop       stop this folder''s running instance and exit'
  exit $(if ($badArg) { 2 } else { 0 })
}

# ---- 1. Resolve port (SERVER_PORT > configs/<env>/service.yml > 8000) --------
$serverEnv = if ($env:SERVER_ENV) { $env:SERVER_ENV } else { 'dev' }
$port = 0
if ($env:SERVER_PORT -and [int]::TryParse($env:SERVER_PORT, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
  # keep $port
} else {
  $port = 8000
  $ymlPath = Join-Path $root "configs\$serverEnv\service.yml"
  if (Test-Path -LiteralPath $ymlPath -PathType Leaf) {
    $yml = Get-Content -Raw -LiteralPath $ymlPath -Encoding UTF8
    if ($yml -match '(?m)^\s*port\s*:\s*(\d+)') {
      $port = [int]$Matches[1]
    }
  }
}

$dataDir = Join-Path $root 'data'
$logsDir = Join-Path $root 'logs'
$distDir = Join-Path $root 'dist'
$entryJs = Join-Path $distDir 'index.js'
$pidFile = Join-Path $dataDir 'service.pid'
$keyFile = Join-Path $dataDir 'account-pool.key'
$stdoutLog = Join-Path $logsDir 'restart.stdout.log'
$stderrLog = Join-Path $logsDir 'restart.stderr.log'
$workDir = Join-Path $env:TEMP 'jimeng-free-api-restart'
$stageDist = Join-Path $workDir 'dist'
$buildLog = Join-Path $workDir 'build.log'

New-Item -ItemType Directory -Force -Path $dataDir, $logsDir, $workDir | Out-Null

$savedPid = 0
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
  [void][int]::TryParse((Get-Content -Raw -LiteralPath $pidFile -ErrorAction SilentlyContinue).Trim(), [ref]$savedPid)
}

function Test-IsOurNodeProcess($procId) {
  if (-not $procId -or $procId -le 4) { return $false }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
  if (-not $cim) { return $false }
  if ($cim.Name -notmatch '^node(\.exe)?$') { return $false }
  $cmd = [string]$cim.CommandLine
  if ($cmd.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  if ($savedPid -gt 0 -and $procId -eq $savedPid -and $cmd -match 'dist[/\\]index\.js') { return $true }
  return $false
}

Write-Host "[restart] jimeng-free-api"
Write-Host "[restart]   folder : $root"
Write-Host "[restart]   port   : $port"

# ---- 2. Check who holds the port ---------------------------------------------
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 4 })
$ourPids = New-Object System.Collections.Generic.List[int]

foreach ($lpid in $listeners) {
  if (Test-IsOurNodeProcess $lpid) {
    $ourPids.Add([int]$lpid)
  } else {
    $foreign = Get-Process -Id $lpid -ErrorAction SilentlyContinue
    $foreignDesc = if ($foreign) { "$($foreign.ProcessName) ($($foreign.Path))" } else { "PID $lpid" }
    Write-Host ""
    Write-Host "[restart] ERROR: port $port is held by another program: PID $lpid - $foreignDesc" -ForegroundColor Red
    Write-Host "[restart]        Nothing was stopped. Close that program or set SERVER_PORT to another port."
    exit 1
  }
}

if ($savedPid -gt 4 -and -not $ourPids.Contains($savedPid) -and (Test-IsOurNodeProcess $savedPid)) {
  $ourPids.Add($savedPid)
}

if ($stopOnly) {
  if ($ourPids.Count -eq 0) {
    Write-Host "[restart] no running service found for this folder."
  } else {
    foreach ($opid in $ourPids) {
      Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
      Write-Host "[restart] stopped PID $opid"
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---- 3. Build into staging before stopping running instance ------------------
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  Write-Host "[restart] ERROR: node.exe not found on PATH (requires Node.js >= 22)." -ForegroundColor Red
  exit 1
}

if ($doBuild) {
  $tsupCli = Join-Path $root 'node_modules\tsup\dist\cli-default.js'
  if (-not (Test-Path -LiteralPath $tsupCli -PathType Leaf)) {
    Write-Host "[restart] ERROR: node_modules missing ($tsupCli). Run 'npm install' first." -ForegroundColor Red
    exit 1
  }
  if (Test-Path -LiteralPath $stageDist) {
    Remove-Item -LiteralPath $stageDist -Recurse -Force
  }
  Write-Host "[restart] building into staging (existing service stays online if build fails) ..."
  $p = Start-Process -FilePath $nodeExe -WorkingDirectory $root -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $buildLog -RedirectStandardError "$buildLog.err" `
    -ArgumentList @($tsupCli, 'src/index.ts', '--format', 'cjs,esm', '--sourcemap', '--dts', '--clean', '--publicDir', 'public', '--external', 'playwright-core', '--outDir', $stageDist)
  if ($p.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $stageDist 'index.js') -PathType Leaf)) {
    Write-Host "[restart] ERROR: build failed; existing service (if any) was left untouched." -ForegroundColor Red
    if (Test-Path -LiteralPath "$buildLog.err") { Get-Content -LiteralPath "$buildLog.err" -Tail 20 }
    if (Test-Path -LiteralPath $buildLog) { Get-Content -LiteralPath $buildLog -Tail 20 }
    exit 1
  }
  Write-Host "[restart] build succeeded."
} elseif (-not (Test-Path -LiteralPath $entryJs -PathType Leaf)) {
  Write-Host "[restart] ERROR: $entryJs does not exist; run restart.bat without --no-build first." -ForegroundColor Red
  exit 1
}

# ---- 4. Stop old instance & swap staging dist into place ---------------------
if ($ourPids.Count -gt 0) {
  foreach ($opid in $ourPids) {
    Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
    Write-Host "[restart] stopped old PID $opid"
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 4 })
    if ($still.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  $still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 4 })
  if ($still.Count -gt 0) {
    Write-Host "[restart] ERROR: port $port is still busy 15s after stopping old process." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "[restart] port $port is free."
}

if ($doBuild) {
  New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  $null = & robocopy $stageDist $distDir /MIR /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) {
    Write-Host "[restart] ERROR: failed to copy staged build into dist/ (robocopy code $LASTEXITCODE)." -ForegroundColor Red
    exit 1
  }
}

# ---- 5. Load or initialize persistent JIMENG_ACCOUNT_POOL_KEY ----------------
$poolKey = [string]$env:JIMENG_ACCOUNT_POOL_KEY
if ([string]::IsNullOrWhiteSpace($poolKey)) {
  $poolKey = [string]$env:ACCOUNT_POOL_ENCRYPTION_KEY
}
if ([string]::IsNullOrWhiteSpace($poolKey)) {
  if (Test-Path -LiteralPath $keyFile -PathType Leaf) {
    $poolKey = (Get-Content -Raw -LiteralPath $keyFile -Encoding UTF8).Trim()
    $keySource = "data\account-pool.key"
  } else {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $poolKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Set-Content -LiteralPath $keyFile -Value $poolKey -NoNewline -Encoding ASCII
    $keySource = "generated -> data\account-pool.key"
  }
} else {
  $keySource = "environment variable"
}

$env:JIMENG_ACCOUNT_POOL_KEY = $poolKey
$env:SERVER_PORT = [string]$port
Write-Host "[restart]   key    : loaded ($keySource)"

# ---- 6. Start new service ----------------------------------------------------
if ($serveForeground) {
  Write-Host "[restart] running in foreground on http://127.0.0.1:$port/ (Ctrl+C stops it)"
  Write-Host ""
  & $nodeExe --enable-source-maps --no-node-snapshot $entryJs
  exit $LASTEXITCODE
}

Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $nodeExe `
  -ArgumentList @('--enable-source-maps', '--no-node-snapshot', $entryJs) `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

Set-Content -LiteralPath $pidFile -Value $proc.Id -NoNewline -Encoding ASCII

Write-Host "[restart] waiting for http://127.0.0.1:$port/ping (PID $($proc.Id)) ..."
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/ping" -TimeoutSec 2 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}

if (-not $ready) {
  Write-Host ""
  Write-Host "[restart] ERROR: service failed to answer on http://127.0.0.1:$port/ping" -ForegroundColor Red
  if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Tail 25 }
  if (Test-Path -LiteralPath $stdoutLog) { Get-Content -LiteralPath $stdoutLog -Tail 25 }
  exit 1
}

$url = "http://localhost:$port/"
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "[restart] ready : $url  (PID $($proc.Id))" -ForegroundColor Green
Write-Host "[restart] key   : $keyFile"
Write-Host "[restart] logs  : $stdoutLog"
Write-Host "[restart] stop  : restart.bat --stop"
Write-Host "============================================================" -ForegroundColor Green

if ($openBrowser) {
  Start-Process $url | Out-Null
}
exit 0
