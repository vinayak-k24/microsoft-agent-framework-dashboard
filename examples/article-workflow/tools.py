import json
import logging
import os
from typing import Annotated
from uuid import UUID

from agent_framework import tool
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from mssql_python import connect

logger = logging.getLogger(__name__)


def required_setting(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"The {name} environment variable is required.")
    return value


@tool
def get_hashtags() -> str:
    """Return the deterministic hashtags appended to each article."""
    return "#AI #Research #Technology"


@tool
def claim_next_pending_article() -> str:
    """Atomically claim the oldest Pending SQL article; return ID/topic JSON or {"found": false}."""
    connection = connect(required_setting("AZURE_SQL_CONNECTION_STRING"))
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("""
                ;WITH next_pending AS (
                    SELECT TOP (1) article_id, topic, status, updated_at, error_message
                    FROM dbo.Articles WITH (UPDLOCK, READPAST, READCOMMITTEDLOCK)
                    WHERE status = N'Pending'
                    ORDER BY created_at, article_id
                )
                UPDATE next_pending
                SET status = N'Processing', updated_at = SYSUTCDATETIME(), error_message = NULL
                OUTPUT CONVERT(nvarchar(36), INSERTED.article_id), INSERTED.topic;
            """)
            row = cursor.fetchone()
            connection.commit()
        finally:
            cursor.close()
    finally:
        connection.close()
    if row is None:
        logger.info("No pending article is available.")
        return json.dumps({"found": False})
    logger.info("Claimed article %s.", row[0])
    return json.dumps({"found": True, "article_id": str(row[0]), "topic": row[1]}, ensure_ascii=False)


@tool
def save_article_and_complete(
    article_id: Annotated[str, "The article UUID returned by claim_next_pending_article."],
    article_markdown: Annotated[str, "The complete final article in Markdown format."],
) -> str:
    """Upload {article_id}.md to private Blob storage, then mark its Processing SQL row Completed."""
    parsed_id = str(UUID(article_id))
    if not article_markdown.strip():
        raise ValueError("The article Markdown must not be empty.")
    credential = DefaultAzureCredential()
    try:
        service = BlobServiceClient(required_setting("AZURE_STORAGE_ACCOUNT_URL"), credential=credential)
        try:
            blob = service.get_blob_client(container=os.getenv("AZURE_STORAGE_CONTAINER") or "articles", blob=f"{parsed_id}.md")
            blob.upload_blob(article_markdown.encode("utf-8"), overwrite=True,
                             content_settings=ContentSettings(content_type="text/markdown; charset=utf-8"))
            url = blob.url
        finally:
            service.close()
    finally:
        credential.close()
    connection = connect(required_setting("AZURE_SQL_CONNECTION_STRING"))
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("""
                UPDATE dbo.Articles
                SET status = N'Completed', article_blob_url = ?, updated_at = SYSUTCDATETIME(), error_message = NULL
                OUTPUT CONVERT(nvarchar(36), INSERTED.article_id)
                WHERE article_id = CONVERT(uniqueidentifier, ?) AND status = N'Processing';
            """, (url, parsed_id))
            if cursor.fetchone() is None:
                connection.rollback()
                raise RuntimeError(f"Article {parsed_id} was not in Processing status; the Blob was uploaded but SQL was not updated.")
            connection.commit()
        finally:
            cursor.close()
    finally:
        connection.close()
    logger.info("Saved article %s and marked it Completed.", parsed_id)
    return json.dumps({"status": "Completed", "article_id": parsed_id, "article_blob_url": url})


@tool
def mark_article_failed(
    article_id: Annotated[str, "The article UUID returned by claim_next_pending_article."],
    error_message: Annotated[str, "A concise explanation of why processing could not be completed."],
) -> str:
    """Mark a claimed Processing article Failed."""
    parsed_id = str(UUID(article_id))
    connection = connect(required_setting("AZURE_SQL_CONNECTION_STRING"))
    try:
        cursor = connection.cursor()
        try:
            cursor.execute("""
                UPDATE dbo.Articles SET status = N'Failed', error_message = ?, updated_at = SYSUTCDATETIME()
                OUTPUT CONVERT(nvarchar(36), INSERTED.article_id)
                WHERE article_id = CONVERT(uniqueidentifier, ?) AND status = N'Processing';
            """, (error_message[:4000], parsed_id))
            if cursor.fetchone() is None:
                connection.rollback()
                raise RuntimeError(f"Article {parsed_id} was not in Processing status.")
            connection.commit()
        finally:
            cursor.close()
    finally:
        connection.close()
    # Reasons may contain article/model content; do not log them by default.
    logger.error("Marked article %s Failed.", parsed_id)
    return json.dumps({"status": "Failed", "article_id": parsed_id})
