#Requires -Version 7.2
[CmdletBinding()]
param([switch]$Schemas)
. "$PSScriptRoot/common.ps1"
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "$($file.Name) has PowerShell parse errors: $errors" }
}
$arguments = @("$PSScriptRoot/validate_assets.py")
if ($Schemas) { $arguments += '--schemas' }
Invoke-Checked python $arguments
Write-Output 'PowerShell syntax: PASS. No Azure authentication or deployment performed.'
