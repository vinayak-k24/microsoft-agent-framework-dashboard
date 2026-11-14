# Definitions only when dot-sourced. Read-only identity checks run on explicit calls.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @())
    $result = & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE). Stopping; no subsequent deployment step will run." }
    return $result
}

function Get-AzdValue {
    param([string]$Name, [string]$EnvironmentName)
    $value = (Invoke-Checked azd @('env', 'get-value', $Name, '-e', $EnvironmentName, '--no-prompt')) -join "`n"
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing azd environment value: $Name" }
    return $value.Trim()
}

function Assert-DemoParameters {
    param([string]$Path)
    $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    $p = $document.parameters
    foreach ($key in @('tenantId', 'developerObjectId')) {
        $id = [guid]::Empty
        if (-not [guid]::TryParse($p[$key].value, [ref]$id) -or $id -eq [guid]::Empty) { throw "Provide a real GUID for $key locally." }
    }
    if ($p.ContainsKey('runtimeObjectId') -and -not [string]::IsNullOrEmpty($p.runtimeObjectId.value)) { throw 'Do not supply runtimeObjectId. Bootstrap discovers and verifies the deployed instance identity.' }
    if ($p.environmentName.value -notmatch '^[a-z0-9][a-z0-9-]{1,19}$') { throw 'environmentName must be 2-20 lowercase alphanumeric/hyphen characters.' }
    if ($p.location.value -notmatch '^[a-z][a-z0-9]+$') { throw 'Provide an approved Azure region, not a placeholder.' }
    if (-not $p.developerAdminName.value -or $p.developerAdminName.value -like 'REPLACE*') { throw 'Provide the developer Entra display name locally.' }
    if ($p.allowPublicDemoNetworking.value -ne $true) { throw 'This bounded example has no private endpoints. Deployment requires explicit allowPublicDemoNetworking=true after network review.' }
    if ($p.sqlAllowedIpRanges.value.Count -eq 0) { throw 'Supply scoped developer and verified hosted-runtime SQL egress IPv4 ranges.' }
    if ($p.sqlAllowedIpRanges.value.Count -gt 32) { throw 'At most 32 reviewed IP ranges are allowed.' }
    foreach ($range in $p.sqlAllowedIpRanges.value) {
        $numbers = @()
        foreach ($key in @('startIpAddress', 'endIpAddress')) {
            $address = [System.Net.IPAddress]::None
            if (-not [System.Net.IPAddress]::TryParse($range[$key], [ref]$address) -or $address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw "Invalid IPv4 $key." }
            $b = $address.GetAddressBytes()
            # Reject unspecified, loopback, multicast/reserved, and non-canonical syntax.
            if ($b[0] -eq 0 -or $b[0] -eq 127 -or $b[0] -ge 224 -or $address.ToString() -ne $range[$key]) { throw 'SQL firewall requires canonical, non-reserved IPv4 addresses; 0.0.0.0 Azure-wide bypass is prohibited.' }
            $numbers += [uint64]$b[0] * 16777216 + [uint64]$b[1] * 65536 + [uint64]$b[2] * 256 + [uint64]$b[3]
        }
        if ($numbers[1] -lt $numbers[0] -or ($numbers[1] - $numbers[0]) -gt 255) { throw 'Each SQL range must be ordered and contain at most 256 addresses. No broad allow-Azure rule.' }
    }
    return $document
}

function Get-HostedRuntimeIdentity {
    param([string]$EnvironmentName, [string]$ExpectedProjectId, [string]$ExpectedTenantId)
    $projectId = Get-AzdValue 'AZURE_AI_PROJECT_ID' $EnvironmentName
    if ($projectId -ne $ExpectedProjectId) { throw 'Selected project changed. Do not invoke or grant access.' }
    $projectEndpoint = Get-AzdValue 'FOUNDRY_PROJECT_ENDPOINT' $EnvironmentName
    $agentEndpoint = Get-AzdValue 'AGENT_ARTICLE_WORKFLOW_PROJECT_ENDPOINT' $EnvironmentName
    $uri = [uri]$projectEndpoint
    if ($projectId -notmatch '^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.CognitiveServices/accounts/(?<account>[a-z0-9-]+)/projects/(?<project>[A-Za-z0-9-]+)$') { throw 'Unexpected Foundry project resource ID.' }
    $expectedHost = "$($Matches.account).services.ai.azure.com"
    $expectedPath = "/api/projects/$($Matches.project)"
    if ($uri.Scheme -ne 'https' -or -not $uri.IsDefaultPort -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.Host -ne $expectedHost -or $uri.AbsolutePath.TrimEnd('/') -ne $expectedPath -or $agentEndpoint.TrimEnd('/') -ne $projectEndpoint.TrimEnd('/')) { throw 'Hosted agent/project endpoint binding does not match the provisioned project.' }
    $name = Get-AzdValue 'AGENT_ARTICLE_WORKFLOW_NAME' $EnvironmentName
    $version = Get-AzdValue 'AGENT_ARTICLE_WORKFLOW_VERSION' $EnvironmentName
    if ($name -ne 'article-workflow' -or $version -notmatch '^[1-9][0-9]*$') { throw 'Unexpected deployed agent name/version.' }
    # show performs a live version GET; verified official JSON keys are not guessed.
    $agent = (Invoke-Checked azd @('ai', 'agent', 'show', 'article-workflow', '-e', $EnvironmentName, '--output', 'json', '--no-prompt')) -join "`n" | ConvertFrom-Json -AsHashtable
    if ($agent.name -ne $name -or [string]$agent.version -ne $version -or $agent.status -notin @('active', 'idle') -or $agent.definition.kind -ne 'hosted') { throw 'Live agent name/version/status/kind does not match the deployed hosted service. No grants made.' }
    if (-not $agent.ContainsKey('instance_identity') -or -not $agent.instance_identity) { throw 'Live hosted version has no instance_identity. Never substitute blueprint/project/ACR identity.' }
    $principalId = [string]$agent.instance_identity.principal_id
    $clientId = [string]$agent.instance_identity.client_id
    foreach ($value in @($principalId, $clientId)) {
        $id = [guid]::Empty
        if (-not [guid]::TryParseExact($value, 'D', [ref]$id) -or $id -eq [guid]::Empty) { throw 'Live runtime principal/client ID is missing or malformed. No grants made.' }
    }
    if ((Get-AzdValue 'AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_PRINCIPAL_ID' $EnvironmentName) -ne $principalId -or (Get-AzdValue 'AGENT_ARTICLE_WORKFLOW_INSTANCE_IDENTITY_CLIENT_ID' $EnvironmentName) -ne $clientId) { throw 'Live identity disagrees with deployment output. No grants made.' }
    $cliTenant = (Invoke-Checked az @('account', 'show', '--query', 'tenantId', '-o', 'tsv', '--only-show-errors')) -join "`n"
    if ($cliTenant.Trim() -ne $ExpectedTenantId) { throw 'Azure CLI Graph identity lookup is authenticated to a different tenant.' }
    $principal = (Invoke-Checked az @('ad', 'sp', 'show', '--id', $principalId, '-o', 'json', '--only-show-errors')) -join "`n" | ConvertFrom-Json -AsHashtable
    # Graph is queried in the checked CLI tenant. appOwnerOrganizationId is NOT
    # the local directory tenant and can be null for managed identities.
    if ($principal.id -ne $principalId -or $principal.appId -ne $clientId -or [string]::IsNullOrWhiteSpace($principal.displayName)) { throw 'Entra service principal in the checked tenant does not match the live runtime principal/client. No grants made.' }
    # Unique SQL alias based on the real display name plus full object ID. Avoid
    # silently reusing an older version's same-name database principal.
    $displayName = [string]$principal.displayName
    if ($displayName -match '[\x00-\x1f\x7f]') { throw 'Runtime display name contains control characters.' }
    $sqlAlias = $displayName.Substring(0, [Math]::Min(91, $displayName.Length)) + '-' + $principalId
    return @{ PrincipalId=$principalId; ClientId=$clientId; SqlAlias=$sqlAlias; Version=$version; ProjectId=$projectId }
}
