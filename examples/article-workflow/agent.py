# Adapted from the supplied Microsoft Agent Framework workflow sample.
import os
from collections.abc import Callable, Sequence
from functools import lru_cache
from typing import Any

from agent_framework import Agent, ToolTypes
from agent_framework.foundry import FoundryChatClient
from azure.identity import DefaultAzureCredential


@lru_cache(maxsize=1)
def _get_client() -> FoundryChatClient:
    return FoundryChatClient(
        project_endpoint=os.environ["FOUNDRY_PROJECT_ENDPOINT"],
        model=os.environ["AZURE_AI_MODEL_DEPLOYMENT_NAME"],
        credential=DefaultAzureCredential(),
    )


def create_web_search_tool() -> ToolTypes:
    return _get_client().get_web_search_tool(search_context_size="high")


def create_agent(
    *, name: str, instructions: str,
    tools: Sequence[ToolTypes | Callable[..., Any]] | None = None,
) -> Agent:
    return Agent(client=_get_client(), name=name, instructions=instructions, tools=tools)
