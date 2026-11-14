#Requires -Version 7.2
# Dot-source in the intended local shell. Never writes credentials/settings to disk.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$EnvironmentName)
. "$PSScriptRoot/common.ps1"
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    foreach ($key in @('FOUNDRY_PROJECT_ENDPOINT', 'AZURE_AI_MODEL_DEPLOYMENT_NAME', 'AZURE_SQL_CONNECTION_STRING', 'AZURE_STORAGE_ACCOUNT_URL', 'AZURE_APPLICATION_INSIGHTS_APP_ID', 'AZURE_AI_PROJECT_ID')) {
        [Environment]::SetEnvironmentVariable($key, (Get-AzdValue $key $EnvironmentName), 'Process')
    }
    $insights = Get-AzdValue 'AZURE_APPLICATION_INSIGHTS_RESOURCE_ID' $EnvironmentName
    $value = (Invoke-Checked az @('resource', 'show', '--ids', $insights, '--api-version', '2020-02-02', '--query', 'properties.ConnectionString', '-o', 'tsv', '--only-show-errors')) -join "`n"
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Application Insights connection string unavailable.' }
    $env:APPLICATIONINSIGHTS_CONNECTION_STRING = $value.Trim()
    $env:AZURE_STORAGE_CONTAINER = 'articles'
    $env:OTEL_SERVICE_NAME = 'article-workflow'
    $env:ENABLE_SENSITIVE_DATA = 'false'
} finally { Pop-Location }
