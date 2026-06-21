param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$NotebookId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$SourceId,

    [Parameter(Mandatory = $true)]
    [string]$NotebookLmCommand,

    [Parameter(Mandatory = $true)]
    [string]$NotebookLmHome,

    [string]$TaskName = 'TaskJournal-NotebookLM-Sync'
)

$ErrorActionPreference = 'Stop'
$refreshScript = Join-Path $PSScriptRoot 'notebooklm-refresh.ps1'
$installDirectory = Join-Path $env:LOCALAPPDATA 'TaskJournal\Sync'
$installedRefreshScript = Join-Path $installDirectory 'notebooklm-refresh.ps1'

foreach ($path in @($refreshScript, $NotebookLmCommand, $NotebookLmHome)) {
    if ($path.Contains('"') -or -not (Test-Path -LiteralPath $path)) {
        throw "Required path is invalid or missing: $path"
    }
}

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($account in @("$env:USERDOMAIN\$env:USERNAME", 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $account,
        'FullControl',
        $inheritance,
        $propagation,
        'Allow'
    )
    $acl.AddAccessRule($rule) | Out-Null
}
Set-Acl -LiteralPath $installDirectory -AclObject $acl
Copy-Item -LiteralPath $refreshScript -Destination $installedRefreshScript -Force

$arguments = @(
    '-NoProfile'
    '-NonInteractive'
    '-WindowStyle Hidden'
    '-ExecutionPolicy Bypass'
    "-File `"$installedRefreshScript`""
    "-NotebookId `"$NotebookId`""
    "-SourceId `"$SourceId`""
    "-NotebookLmCommand `"$NotebookLmCommand`""
    "-NotebookLmHome `"$NotebookLmHome`""
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -Hidden `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Refresh the TaskJournal NotebookLM source when its Google Doc changes.' `
    -Force | Out-Null

Write-Output "Scheduled task registered: $TaskName"
