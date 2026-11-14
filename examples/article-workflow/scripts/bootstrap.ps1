#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EnvironmentName,
    [Parameter(Mandatory)][string]$DataParametersPath,
    [switch]$Apply,
    [switch]$SeedSamples
)
. "$PSScriptRoot/common.ps1"
$example = Split-Path $PSScriptRoot -Parent
$DataParametersPath = (Resolve-Path -LiteralPath $DataParametersPath).Path
$parameters = Assert-DemoParameters $DataParametersPath
if (-not $Apply) { throw 'No changes made. -Apply explicitly authorizes runtime Blob/Foundry grants and SQL schema/user bootstrap, not invocation.' }
if ($parameters.parameters.environmentName.value -ne $EnvironmentName) { throw 'Parameter environmentName must match azd.' }
Push-Location $example
try {
    $subscription = Get-AzdValue 'AZURE_SUBSCRIPTION_ID' $EnvironmentName
    $group = Get-AzdValue 'AZURE_RESOURCE_GROUP' $EnvironmentName
    $project = Get-AzdValue 'AZURE_AI_PROJECT_ID' $EnvironmentName
    $tenant = Get-AzdValue 'AZURE_TENANT_ID' $EnvironmentName
    if ($tenant -ne $parameters.parameters.tenantId.value -or (Get-AzdValue 'AZURE_LOCATION' $EnvironmentName) -ne $parameters.parameters.location.value -or $project -notlike "/subscriptions/$subscription/resourceGroups/$group/*") { throw 'Project/group/subscription/tenant/location do not match reviewed parameters.' }
    $runtime = Get-HostedRuntimeIdentity $EnvironmentName $project $tenant
    # Reapply the same incremental data template ONLY after live identity checks.
    # The runtime role is container-scoped; SQL authorization is separate below.
    $output = (Invoke-Checked az @('deployment', 'group', 'create', '--subscription', $subscription, '--resource-group', $group, '--name', 'article-workflow-data', '--mode', 'Incremental', '--template-file', "$example/infra/data.json", '--parameters', "@$DataParametersPath", "runtimeObjectId=$($runtime.PrincipalId)", '--query', 'properties.outputs', '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json -AsHashtable
    if ($output.ARTICLE_RUNTIME_PRINCIPAL_ID.value -ne $runtime.PrincipalId) { throw 'ARM runtime principal output mismatch.' }
    foreach ($key in $output.Keys) { Invoke-Checked azd @('env', 'set', $key, [string]$output[$key].value, '-e', $EnvironmentName, '--no-prompt') | Out-Null }
    Invoke-Checked az @('role', 'assignment', 'create', '--subscription', $subscription, '--assignee-object-id', $runtime.PrincipalId, '--assignee-principal-type', 'ServicePrincipal', '--role', '53ca6127-db72-4b80-b1b0-d745d6d5456d', '--scope', $project, '-o', 'none', '--only-show-errors') | Out-Null
    . "$PSScriptRoot/load-local-env.ps1" -EnvironmentName $EnvironmentName
    $setup = @('setup_data_store.py', '--managed-identity-name', $runtime.SqlAlias, '--managed-identity-object-id', $runtime.PrincipalId)
    if ($SeedSamples) { $setup += '--seed-samples' }
    Invoke-Checked python $setup | Out-Null
    # Detect a concurrent deployment. Do not imply old-version grants authorize it.
    $confirmed = Get-HostedRuntimeIdentity $EnvironmentName $project $tenant
    if ($confirmed.PrincipalId -ne $runtime.PrincipalId -or $confirmed.Version -ne $runtime.Version) { throw 'Hosted version changed during bootstrap. Do not invoke; review and bootstrap the selected version.' }
    Write-Output "Verified hosted version $($runtime.Version); scoped Blob/Foundry grants and explicit SQL bootstrap completed. No invocation performed."
} catch {
    throw "Bootstrap stopped: $($_.Exception.Message) DO NOT INVOKE. Some grants/schema operations may have completed; review before retrying."
} finally { Pop-Location }
