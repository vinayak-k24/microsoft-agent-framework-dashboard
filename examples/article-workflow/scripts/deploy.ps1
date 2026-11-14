#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$EnvironmentName,
    [Parameter(Mandatory)][string]$DataParametersPath,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$ModelName,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$ModelVersion,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')][string]$ModelDeploymentName,
    [Parameter(Mandatory)][ValidateSet('Standard', 'GlobalStandard', 'DataZoneStandard')][string]$ModelSku,
    [ValidateRange(1, 1000)][int]$ModelCapacity = 10,
    [switch]$Apply,
    [switch]$BootstrapSchema,
    [switch]$SeedSamples
)
. "$PSScriptRoot/common.ps1"
$example = Split-Path $PSScriptRoot -Parent
$DataParametersPath = (Resolve-Path -LiteralPath $DataParametersPath).Path
$parameters = Assert-DemoParameters $DataParametersPath
if ($parameters.parameters.environmentName.value -ne $EnvironmentName) { throw 'Parameter environmentName must match the selected azd environment.' }
if (-not $Apply -or -not $BootstrapSchema) {
    throw 'No changes made. Explicit -Apply -BootstrapSchema required for provision -> deploy (no invocation) -> verified identity -> data grants/schema.'
}
foreach ($file in @('Dockerfile', '.dockerignore', 'setup_data_store.py')) {
    if (-not (Test-Path "$example/$file")) { throw "Missing parent-owned $file. No changes made." }
}
# No user-agent value is persisted or committed; callers configure their process.
Push-Location $example
try {
    $subscription = Get-AzdValue 'AZURE_SUBSCRIPTION_ID' $EnvironmentName
    $location = Get-AzdValue 'AZURE_LOCATION' $EnvironmentName
    if ($location -ne $parameters.parameters.location.value) { throw 'Azure location and data parameters disagree.' }
    $tenant = Get-AzdValue 'AZURE_TENANT_ID' $EnvironmentName
    if ($tenant -ne $parameters.parameters.tenantId.value) { throw 'Tenant and data parameters disagree.' }
    $account = (Invoke-Checked az @('account', 'show', '--subscription', $subscription, '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json
    if ($account.tenantId -ne $tenant -or $account.id -ne $subscription) { throw 'Selected subscription/tenant do not match the authenticated Azure account.' }

    # Require an existing catalog entry in the requested region, including SKU.
    $catalog = (Invoke-Checked az @('cognitiveservices', 'model', 'list', '--location', $location, '--subscription', $subscription, '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json
    $matches = @($catalog | Where-Object { $_.kind -eq 'AIServices' -and $_.model.name -eq $ModelName -and $_.model.version -eq $ModelVersion -and $_.model.format -eq 'OpenAI' })
    if ($matches.Count -ne 1 -or $ModelSku -notin @($matches[0].model.skus.name)) { throw 'Model/version/SKU not uniquely available in region. Quota and hosted support still require operator review.' }
    if ($matches[0].model.lifecycleStatus -in @('Deprecated', 'Deprecating')) { throw 'Choose a model version that is not deprecated or deprecating.' }
    $sku = @($matches[0].model.skus | Where-Object name -eq $ModelSku)[0]
    $capacity = $sku.capacity
    if ($ModelCapacity -lt $capacity.minimum -or $ModelCapacity -gt $capacity.maximum -or (($ModelCapacity - $capacity.minimum) % $capacity.step) -ne 0) { throw 'Requested model capacity does not match the catalog minimum/maximum/step.' }
    foreach ($pair in @(
        @('AZURE_AI_MODEL_DEPLOYMENT_NAME', $ModelDeploymentName), @('ARTICLE_MODEL_NAME', $ModelName),
        @('ARTICLE_MODEL_VERSION', $ModelVersion), @('ARTICLE_MODEL_SKU', $ModelSku)
    )) { Invoke-Checked azd @('env', 'set', $pair[0], $pair[1], '-e', $EnvironmentName, '--no-prompt') | Out-Null }
    $deployments = ConvertTo-Json -Depth 8 -Compress -InputObject @(@{name=$ModelDeploymentName; model=@{format='OpenAI';name=$ModelName;version=$ModelVersion};sku=@{name=$ModelSku;capacity=$ModelCapacity}})
    Invoke-Checked azd @('env', 'set', 'AI_PROJECT_DEPLOYMENTS', $deployments, '-e', $EnvironmentName, '--no-prompt') | Out-Null

    # Supported separate flow, intentionally not azd up. No tool calls or invoke.
    Invoke-Checked azd @('provision', '-e', $EnvironmentName, '--no-prompt') | Out-Null
    $project = Get-AzdValue 'AZURE_AI_PROJECT_ID' $EnvironmentName
    $group = Get-AzdValue 'AZURE_RESOURCE_GROUP' $EnvironmentName
    if ($project -notlike "/subscriptions/$subscription/resourceGroups/$group/*") { throw 'Foundry project is outside the selected subscription/group.' }
    $insights = Get-AzdValue 'AZURE_APPLICATION_INSIGHTS_RESOURCE_ID' $EnvironmentName
    $appId = Get-AzdValue 'AZURE_APPLICATION_INSIGHTS_APP_ID' $EnvironmentName
    $connection = Get-AzdValue 'AZURE_AI_PROJECT_APPINSIGHTS_CONNECTION_NAME' $EnvironmentName
    $connectionResource = (Invoke-Checked az @('resource', 'show', '--ids', "$project/connections/$connection", '--api-version', '2025-06-01', '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json
    if ($connectionResource.properties.category -ne 'AppInsights') { throw 'Project monitoring connection is not category AppInsights.' }

    # runtimeObjectId defaults empty: the conditional runtime role is NOT created.
    $output = (Invoke-Checked az @('deployment', 'group', 'create', '--subscription', $subscription, '--resource-group', $group, '--name', 'article-workflow-data', '--mode', 'Incremental', '--template-file', "$example/infra/data.json", '--parameters', "@$DataParametersPath", '--query', 'properties.outputs', '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json -AsHashtable
    foreach ($key in $output.Keys | Where-Object { $_ -ne 'ARTICLE_RUNTIME_PRINCIPAL_ID' }) { Invoke-Checked azd @('env', 'set', $key, [string]$output[$key].value, '-e', $EnvironmentName, '--no-prompt') | Out-Null }
    # Azure RBAC is not SQL data authorization. SQL grants happen in setup below.
    foreach ($grant in @(
        @($parameters.parameters.developerObjectId.value, 'User', '53ca6127-db72-4b80-b1b0-d745d6d5456d', $project),
        @($parameters.parameters.developerObjectId.value, 'User', '73c42c96-874c-492b-b04d-ab87d138a893', $insights)
    )) { Invoke-Checked az @('role', 'assignment', 'create', '--subscription', $subscription, '--assignee-object-id', $grant[0], '--assignee-principal-type', $grant[1], '--role', $grant[2], '--scope', $grant[3], '-o', 'none', '--only-show-errors') | Out-Null }

    # Startup must not touch SQL/Blob; only manual tool invocations do so.
    Invoke-Checked azd @('deploy', 'article-workflow', '-e', $EnvironmentName, '--no-prompt') | Out-Null
    & "$PSScriptRoot/bootstrap.ps1" -EnvironmentName $EnvironmentName -DataParametersPath $DataParametersPath -Apply -SeedSamples:$SeedSamples
    Write-Output "Deployment and explicit bootstrap completed. Invocation remains MANUAL; live tool access/trace ingestion not verified. Insights App ID: $appId"
} catch {
    throw "Stopped: $($_.Exception.Message) An agent version may already be deployed. DO NOT INVOKE until bootstrap and network review succeed; bootstrap.ps1 can resume without creating another version."
} finally { Pop-Location }
