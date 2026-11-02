$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pythonPath = Join-Path $repoPath 'backend/app/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) { throw 'Backend Python is missing.' }
$normalizedPythonPath = $pythonPath.Replace('/', '\')
$backendProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object {
    $_.CommandLine -like ('*' + $normalizedPythonPath + '*') -and
    $_.CommandLine -match '-m uvicorn backend\.app\.main:app ' -and
    $_.CommandLine -match '--host 127\.0\.0\.1 --port 8080 '
})
if ($backendProcesses.Count -eq 0) { throw 'The expected local backend was not found; nothing was stopped.' }
$listeners = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -notin $backendProcesses.ProcessId }).Count -gt 0) {
    throw 'Port 8080 does not belong exclusively to this repository backend; nothing was stopped.'
}
foreach ($backendProcess in $backendProcesses) {
    Stop-Process -Id $backendProcess.ProcessId -ErrorAction SilentlyContinue
}
$released = $false
for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) { $released = $true; break }
    Start-Sleep -Milliseconds 200
}
if (-not $released) { throw 'Port 8080 was not released.' }
$logPrefix = Join-Path $repoPath ('tmp/outline-backend-v6-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$started = Start-Process -FilePath $pythonPath -WorkingDirectory $repoPath -WindowStyle Hidden -PassThru `
    -ArgumentList @('-m', 'uvicorn', 'backend.app.main:app', '--env-file', 'backend/app/.env', '--host', '127.0.0.1',
        '--port', '8080', '--workers', '1', '--no-proxy-headers', '--no-access-log') `
    -RedirectStandardOutput ($logPrefix + '.stdout.log') -RedirectStandardError ($logPrefix + '.stderr.log')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/roi/v1/health' -TimeoutSec 1
        [pscustomobject]@{ process_id = $started.Id; status = $health.status; model = $health.model; mode = $health.mode } | ConvertTo-Json
        exit 0
    } catch { Start-Sleep -Milliseconds 500 }
}
throw ('Backend did not become healthy. Inspect ' + $logPrefix + '.stderr.log')
