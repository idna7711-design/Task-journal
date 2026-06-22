param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$NotebookId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$SourceId,

    [string]$NotebookLmCommand = "notebooklm",

    [string]$NotebookLmHome = "",

    [int]$MaxAttempts = 4,

    [int]$RetrySeconds = 15
)

$ErrorActionPreference = "Stop"

if ($NotebookLmHome) {
    $env:NOTEBOOKLM_HOME = $NotebookLmHome
}

if (-not (Get-Command $NotebookLmCommand -ErrorAction SilentlyContinue)) {
    throw "The notebooklm command was not found. Install notebooklm-py or pass its full path."
}

function Invoke-NotebookLmHidden {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $NotebookLmCommand
    $startInfo.Arguments = $Arguments -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start the NotebookLM command."
    }

    $standardOutput = $process.StandardOutput.ReadToEndAsync()
    $standardError = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()

    [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = $standardOutput.Result.Trim()
        Error = $standardError.Result.Trim()
    }
}

$authRefresh = Invoke-NotebookLmHidden -Arguments @('auth', 'refresh', '--quiet')
if ($authRefresh.ExitCode -ne 0) {
    throw "Failed to refresh NotebookLM authentication. Run 'notebooklm login' once. $($authRefresh.Error)"
}

$freshnessResult = Invoke-NotebookLmHidden -Arguments @(
    'source', 'stale', $SourceId, '-n', $NotebookId, '--json'
)
if ($freshnessResult.ExitCode -ne 0) {
    throw "Failed to check the NotebookLM source freshness. $($freshnessResult.Error)"
}

try {
    $freshness = $freshnessResult.Output | ConvertFrom-Json
} catch {
    throw "NotebookLM returned an invalid freshness response."
}

if (-not $freshness.stale) {
    Write-Output "NotebookLM source is already fresh."
    exit 0
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $refreshResult = Invoke-NotebookLmHidden -Arguments @(
        'source', 'refresh', $SourceId, '-n', $NotebookId
    )
    if ($refreshResult.ExitCode -eq 0) {
        Write-Output "NotebookLM source refresh succeeded."
        exit 0
    }

    if ($attempt -lt $MaxAttempts) {
        Start-Sleep -Seconds $RetrySeconds
    }
}

throw "NotebookLM source refresh failed after $MaxAttempts attempts. Check authentication and the source ID."
