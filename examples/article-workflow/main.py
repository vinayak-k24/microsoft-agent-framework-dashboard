# Copyright (c) Microsoft. All rights reserved.
# Adapted from agent-framework-workflows-responses for trace replay.
from pathlib import Path
import os

from dotenv import load_dotenv


def configure_telemetry() -> None:
    from agent_framework.observability import configure_otel_providers
    from azure.monitor.opentelemetry.exporter import AzureMonitorTraceExporter

    connection_string = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING")
    if not connection_string:
        raise RuntimeError("APPLICATIONINSIGHTS_CONNECTION_STRING is required to generate replay traces.")
    # One provider setup also retains framework OTLP/Inspector exporters, when configured.
    configure_otel_providers(
        exporters=[AzureMonitorTraceExporter(connection_string=connection_string)],
        enable_sensitive_data=os.getenv("ENABLE_SENSITIVE_DATA", "false").lower() == "true",
    )


def create_workflow_agent():
    from agent import create_agent, create_web_search_tool
    from agent_framework import AgentExecutor, WorkflowBuilder
    from tools import claim_next_pending_article, get_hashtags, mark_article_failed, save_article_and_complete

    research_agent = create_agent(
        name="topic_researcher",
        instructions=(
            "You are stage 1 of a SQL-backed article workflow. First call claim_next_pending_article exactly once. "
            "If it reports found=false, return exactly NO_PENDING_ARTICLES and do not search. Otherwise research only "
            "the returned topic using web search. Cite factual claims inline with actual source titles and URLs "
            "returned by search, and finish with a Sources section. Your response must begin with the exact line "
            "ARTICLE_ID: <article_id> using the ID returned by SQL, followed by a blank line and the research brief. "
            "Preserve the ID exactly; do not use a topic from the user's message instead. If you cannot complete "
            "research after claiming an article, call mark_article_failed with its ID and a concise reason, "
            "then return exactly ARTICLE_FAILED."
        ),
        tools=[claim_next_pending_article, create_web_search_tool(), mark_article_failed],
    )
    organization_agent = create_agent(
        name="content_organizer",
        instructions=(
            "Turn the research brief into a well-organized Markdown article with a descriptive title, overview, "
            "meaningful sections and subsections. Preserve qualifications, uncertainty, inline citations and the "
            "Sources section. Do not add unsupported claims or remove URLs. If input is exactly NO_PENDING_ARTICLES "
            "or ARTICLE_FAILED, pass it through unchanged and do not call tools. Otherwise preserve the first "
            "ARTICLE_ID: ... line exactly. Call get_hashtags exactly once and append its exact output after Sources. "
            "If you cannot organize the article, call mark_article_failed with that ID and a concise reason, "
            "then return exactly ARTICLE_FAILED."
        ),
        tools=[get_hashtags, mark_article_failed],
    )
    faq_agent = create_agent(
        name="faq_writer",
        instructions=(
            "If input is exactly NO_PENDING_ARTICLES or ARTICLE_FAILED, return it unchanged and do not call tools. "
            "Otherwise read and preserve the ARTICLE_ID: ... ID. Reproduce the entire organized Markdown article "
            "and append a Frequently Asked Questions section. Preserve citations and uncertainty; do not invent "
            "sources. Legal answers must be general information, not advice, and note jurisdictional differences. "
            "Remove the internal ARTICLE_ID line from the document. Call save_article_and_complete exactly once "
            "with the ID and complete final Markdown. It uploads first, then updates SQL. If processing fails, "
            "call mark_article_failed with the ID and a concise reason. After successful save, include the returned "
            "Blob URL after the article without changing the saved document."
        ),
        tools=[create_web_search_tool(), save_article_and_complete, mark_article_failed],
    )
    researcher = AgentExecutor(research_agent, context_mode="last_agent")
    organizer = AgentExecutor(organization_agent, context_mode="last_agent")
    faq = AgentExecutor(faq_agent, context_mode="last_agent")
    return (
        WorkflowBuilder(start_executor=researcher, output_from=[faq])
        .add_edge(researcher, organizer)
        .add_edge(organizer, faq)
        .build()
        .as_agent()
    )


def main() -> None:
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    os.environ.setdefault("OTEL_SERVICE_NAME", "article-workflow")
    configure_telemetry()
    from agent_framework_foundry_hosting import ResponsesHostServer

    ResponsesHostServer(agent=create_workflow_agent, configure_observability=None).run()


if __name__ == "__main__":
    main()
