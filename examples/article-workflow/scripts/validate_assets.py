"""Local/static validation only. --schemas downloads public schemas; sends no code."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

import jsonschema
import yaml
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT4

ROOT = Path(__file__).resolve().parents[1]
AZD = "https://raw.githubusercontent.com/Azure/azure-dev/main/"
ARM = "https://raw.githubusercontent.com/Azure/azure-resource-manager-schemas/main/schemas/"


def fetch(url: str) -> dict:
    with urlopen(url, timeout=30) as response:
        return json.load(response)


def retrieve(uri: str) -> Resource:
    return Resource.from_contents(fetch(uri), default_specification=DRAFT4)


def arm_one_of(validator, branches, instance, schema):
    # Official ARM schemas sometimes let an expression ALSO match an ordinary
    # unconstrained string branch (e.g. a container name), making oneOf ambiguous.
    # Select and validate the official expression branch for expression values;
    # all literal values retain the unmodified strict oneOf validation.
    expressions = [b for b in branches if b.get("$ref", "").endswith("#/definitions/expression")]
    if isinstance(instance, str) and instance.startswith("[") and expressions:
        yield from validator.descend(instance, expressions[0])
    else:
        yield from jsonschema.Draft4Validator.VALIDATORS["oneOf"](validator, branches, instance, schema)


ArmValidator = jsonschema.validators.extend(jsonschema.Draft4Validator, {"oneOf": arm_one_of})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schemas", action="store_true")
    args = parser.parse_args()
    config = yaml.safe_load((ROOT / "azure.yaml").read_text(encoding="utf-8"))
    template = json.loads((ROOT / "infra/data.json").read_text(encoding="utf-8"))
    json.loads((ROOT / "infra/data.parameters.example.json").read_text(encoding="utf-8"))
    agent = config["services"]["article-workflow"]
    assert agent["host"] == "azure.ai.agent" and agent["language"] == "docker"
    assert "codeConfiguration" not in agent and agent["docker"]["remoteBuild"] is True
    assert not any(k.startswith("FOUNDRY_") for k in agent["env"])
    assert "APPLICATIONINSIGHTS_CONNECTION_STRING" not in agent["env"]
    assert agent["env"]["ENABLE_SENSITIVE_DATA"] == "false"
    assert template["parameters"]["allowPublicDemoNetworking"]["defaultValue"] is False
    assert template["parameters"]["sqlAllowedIpRanges"]["defaultValue"] == []
    assert template["parameters"]["runtimeObjectId"]["defaultValue"] == ""
    runtime_roles = [r for r in template["resources"] if r["type"] == "Microsoft.Authorization/roleAssignments" and "runtimeObjectId" in r["properties"]["principalId"]]
    assert len(runtime_roles) == 1
    assert runtime_roles[0]["condition"] == "[not(empty(parameters('runtimeObjectId')))]"
    deploy = (ROOT / "scripts/deploy.ps1").read_text(encoding="utf-8")
    bootstrap = (ROOT / "scripts/bootstrap.ps1").read_text(encoding="utf-8")
    assert deploy.index("@('provision'") < deploy.index("@('deploy'") < deploy.index('& "$PSScriptRoot/bootstrap.ps1"')
    assert "setup_data_store.py', '--managed-identity-name'" not in deploy
    assert bootstrap.index("$runtime = Get-HostedRuntimeIdentity") < bootstrap.index("@('deployment', 'group', 'create'") < bootstrap.index("Invoke-Checked python $setup")
    assert "@('ai', 'agent', 'invoke'" not in deploy + bootstrap
    assert "ReuseExistingRuntimeIdentity" not in deploy
    by_type = {r["type"]: r for r in template["resources"]}
    sql = by_type["Microsoft.Sql/servers"]["properties"]
    assert sql["administrators"]["azureADOnlyAuthentication"] is True
    assert "administratorLoginPassword" not in sql
    storage = by_type["Microsoft.Storage/storageAccounts"]["properties"]
    assert storage["allowSharedKeyAccess"] is False
    assert storage["allowBlobPublicAccess"] is False
    assert by_type["Microsoft.Storage/storageAccounts/blobServices/containers"]["properties"]["publicAccess"] == "None"
    if args.schemas:
        schema = fetch(AZD + "schemas/v1.0/azure.yaml.json")
        jsonschema.validate(config, schema)
        for name, relative in (
            ("ai-project", "cli/azd/extensions/azure.ai.projects/schemas/azure.ai.project.json"),
            ("article-workflow", "cli/azd/extensions/azure.ai.agents/schemas/azure.ai.agent.json"),
        ):
            schema = fetch(AZD + relative)
            jsonschema.validate(config["services"][name], schema)
        cache = {}
        for resource in template["resources"]:
            namespace, *types = resource["type"].split("/")
            url = f"{ARM}{resource['apiVersion']}/{namespace}.json"
            if url not in cache:
                cache[url] = fetch(url)
            schema = cache[url]
            definition = "_".join(types)
            # Keep root definitions available for local refs and resolve common
            # ARM expression refs against the original official schema ID.
            schema_id = schema["id"].rstrip("#")
            registry = Registry(retrieve=retrieve).with_resource(schema_id, Resource.from_contents(schema, default_specification=DRAFT4))
            validator = ArmValidator({"$ref": f"{schema_id}#/resourceDefinitions/{definition}"}, registry=registry)
            validator.validate(resource)
        print("Official azd core/project/agent and ARM resource schemas: PASS")
    print("YAML/JSON parsing and infrastructure safety invariants: PASS")


if __name__ == "__main__":
    main()
