param(
    [Parameter(Mandatory = $true)]
    [string]$NotebookId,

    [Parameter(Mandatory = $true)]
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

$freshnessJson = & $NotebookLmCommand source stale $SourceId -n $NotebookId --json
if ($LASTEXITCODE -ne 0) {
    throw "Failed to check the NotebookLM source freshness."
}

try {
    $freshness = $freshnessJson | ConvertFrom-Json
} catch {
    throw "NotebookLM returned an invalid freshness response."
}

if (-not $freshness.stale) {
    Write-Output "NotebookLM source is already fresh."
    exit 0
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    & $NotebookLmCommand source refresh $SourceId -n $NotebookId
    if ($LASTEXITCODE -eq 0) {
        Write-Output "NotebookLM source refresh succeeded."
        exit 0
    }

    if ($attempt -lt $MaxAttempts) {
        Start-Sleep -Seconds $RetrySeconds
    }
}

throw "NotebookLM source refresh failed after $MaxAttempts attempts. Check authentication and the source ID."
