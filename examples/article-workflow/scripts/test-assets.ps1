#Requires -Version 7.2
# Fully synthetic fixtures. Never calls Azure, azd, SQL, storage or Docker.
. "$PSScriptRoot/common.ps1"
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected $Message
}
# Confirm original native command wrapper does not ignore nonzero exit codes.
Assert-Rejected { Invoke-Checked python @('-c', 'raise SystemExit(11)') } 'Native nonzero exit must stop execution.'

$script:tenant = '11111111-1111-4111-8111-111111111111'
$script:principalId = '22222222-2222-4222-8222-222222222222'
$script:clientId = '33333333-3333-4333-8333-333333333333'
$script:projectId = '/subscriptions/44444444-4444-4444-8444-444444444444/resourceGroups/rg-fixture/providers/Microsoft.CognitiveServices/accounts/fixture/projects/fixture'
$script:values = @{
    AZURE_AI_PROJECT_ID = $projectId
    FOUNDRY_PROJECT_ENDPOINT = 'https://fixture.services.ai.azure.com/api/projects/fixture'
    AGENT_ARTICLE_WORKFLOW_PROJECT_ENDPOINT = 'https://fixture.services.ai.azure.com/api/projects/fixture'
    AGENT_ARTICLE_WORKFLOW_NAME = 'article-workflow'
    AGENT_ARTICLE_WORKFLOW_VERSION = '1'
    AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_PRINCIPAL_ID = $principalId
    AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_CLIENT_ID = $clientId
}
$script:agent = @{
    name = 'article-workflow'; version = '1'; status = 'active'
    definition = @{ kind = 'hosted' }
    instance_identity = @{ principal_id = $principalId; client_id = $clientId }
}
$script:principal = @{ id = $principalId; appId = $clientId; displayName = 'Synthetic hosted identity' }
$script:cliTenant = $tenant
function Get-AzdValue([string]$Name, [string]$EnvironmentName) {
    if ($EnvironmentName -ne 'fixture' -or -not $script:values.ContainsKey($Name)) { throw 'Unexpected environment/key.' }
    return $script:values[$Name]
}
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    # ONLY the three expected read shapes are supported; all writes are rejected.
    if ($Command -eq 'azd' -and ($Arguments[0..3] -join ' ') -eq 'ai agent show article-workflow') { return ConvertTo-Json -Depth 8 -InputObject $script:agent }
    if ($Command -eq 'az' -and ($Arguments[0..1] -join ' ') -eq 'account show') { return $script:cliTenant }
    if ($Command -eq 'az' -and ($Arguments[0..2] -join ' ') -eq 'ad sp show') { return ConvertTo-Json -InputObject $script:principal }
    throw 'Unexpected native command. Synthetic tests prohibit all cloud calls/writes.'
}
$runtime = Get-HostedRuntimeIdentity 'fixture' $projectId $tenant
Assert-True ($runtime.PrincipalId -eq $principalId -and $runtime.SqlAlias.EndsWith($principalId) -and $runtime.SqlAlias.Length -le 128) 'Valid identity/unique SQL alias must pass.'
$script:agent.status = 'idle'
Get-HostedRuntimeIdentity 'fixture' $projectId $tenant | Out-Null
$script:agent.status = 'failed'
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Inactive version must fail.'
$script:agent.status = 'active'
$script:agent.version = '2'
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Stale version must fail.'
$script:agent.version = '1'
$script:values.AGENT_ARTICLE_WORKFLOW_PROJECT_ENDPOINT = 'https://other.services.ai.azure.com/api/projects/fixture'
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Foreign project marker must fail.'
$script:values.AGENT_ARTICLE_WORKFLOW_PROJECT_ENDPOINT = $script:values.FOUNDRY_PROJECT_ENDPOINT
$script:values.AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_PRINCIPAL_ID = $clientId
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Recorded/live principal mismatch must fail.'
$script:values.AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_PRINCIPAL_ID = $principalId
$script:agent.instance_identity.principal_id = [guid]::Empty.ToString()
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Empty live GUID must fail.'
$script:agent.instance_identity.principal_id = $principalId
$savedIdentity = $script:agent.instance_identity
$script:agent.Remove('instance_identity')
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Missing live identity must fail.'
$script:agent.instance_identity = $savedIdentity
$script:cliTenant = $clientId
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Wrong Graph tenant must fail.'
$script:cliTenant = $tenant
$script:principal.appId = $principalId
Assert-Rejected { Get-HostedRuntimeIdentity 'fixture' $projectId $tenant } 'Graph/live client mismatch must fail.'
$script:principal.appId = $clientId
$script:principal.displayName = 'x' * 180
$runtime = Get-HostedRuntimeIdentity 'fixture' $projectId $tenant
Assert-True ($runtime.SqlAlias.Length -eq 128 -and $runtime.SqlAlias.EndsWith($principalId)) 'Long display name must retain full GUID within SQL limit.'

# Mock the JSON input instead of writing credentials/identifiers to a fixture file.
$script:data = @{ parameters = @{
    tenantId = @{ value=$tenant }; developerObjectId = @{ value=$clientId }
    developerAdminName = @{ value='Synthetic developer' }
    environmentName = @{ value='fixture' }; location = @{ value='eastus' }
    allowPublicDemoNetworking = @{ value=$true }
    sqlAllowedIpRanges = @{ value=@(@{startIpAddress='198.51.100.10';endIpAddress='198.51.100.10'}) }
} }
function Get-Content { return ConvertTo-Json -Depth 8 -InputObject $script:data }
Assert-DemoParameters 'synthetic-only' | Out-Null
foreach ($ip in @('0.0.0.0', '127.0.0.1', '224.0.0.1', '198.051.100.10')) {
    $script:data.parameters.sqlAllowedIpRanges.value = @(@{startIpAddress=$ip;endIpAddress=$ip})
    Assert-Rejected { Assert-DemoParameters 'synthetic-only' } 'Unsafe SQL firewall address must fail.'
}
$script:data.parameters.sqlAllowedIpRanges.value = @(@{startIpAddress='198.51.100.0';endIpAddress='198.51.101.1'})
Assert-Rejected { Assert-DemoParameters 'synthetic-only' } 'Broad SQL range must fail.'
$script:data.parameters.sqlAllowedIpRanges.value = @(@{startIpAddress='198.51.100.10';endIpAddress='198.51.100.10'})
$script:data.parameters.runtimeObjectId = @{ value=$principalId }
Assert-Rejected { Assert-DemoParameters 'synthetic-only' } 'Operator-supplied runtime identity must fail.'
Write-Output 'Synthetic identity, native-error and network safety tests: PASS. No cloud calls performed.'
exit 0
