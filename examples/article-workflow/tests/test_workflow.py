import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
import setup_data_store
import tools

ARTICLE_ID = "11111111-1111-4111-8111-111111111111"


class ToolsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.connection = MagicMock()
        self.cursor = self.connection.cursor.return_value
        self.sql = patch.object(tools, "connect", return_value=self.connection)
        self.sql.start()
        self.addCleanup(self.sql.stop)
        self.environment = patch.dict("os.environ", {"AZURE_SQL_CONNECTION_STRING": "mock-only"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    async def test_claim_returns_id_or_empty_queue_and_commits(self):
        for row, expected in [(None, {"found": False}), ((ARTICLE_ID, "Synthetic topic"),
                                {"found": True, "article_id": ARTICLE_ID, "topic": "Synthetic topic"})]:
            with self.subTest(row=row):
                self.connection.reset_mock()
                self.cursor.fetchone.return_value = row
                result = await tools.claim_next_pending_article.invoke(arguments={})
                self.assertEqual(json.loads(result[0].text), expected)
                self.connection.commit.assert_called_once()
                self.connection.close.assert_called_once()

    async def test_blob_upload_precedes_conditional_sql_completion(self):
        events = []
        blob = MagicMock(url="https://example.blob.core.windows.net/articles/article.md")
        blob.upload_blob.side_effect = lambda *args, **kwargs: events.append("upload")
        self.cursor.execute.side_effect = lambda *args, **kwargs: events.append("sql")
        self.cursor.fetchone.return_value = (ARTICLE_ID,)
        credential = MagicMock()
        service = MagicMock()
        service.get_blob_client.return_value = blob
        with patch.object(tools, "DefaultAzureCredential", return_value=credential), \
             patch.object(tools, "BlobServiceClient", return_value=service), \
             patch.dict("os.environ", {"AZURE_STORAGE_ACCOUNT_URL": "https://example.blob.core.windows.net"}):
            result = await tools.save_article_and_complete.invoke(arguments={"article_id": ARTICLE_ID, "article_markdown": "# Sample"})
            self.assertEqual(json.loads(result[0].text)["status"], "Completed")
            self.assertEqual(events, ["upload", "sql"])
            self.connection.commit.assert_called_once()
            self.cursor.fetchone.return_value = None
            self.connection.reset_mock()
            with self.assertRaisesRegex(RuntimeError, "Blob was uploaded"):
                await tools.save_article_and_complete.invoke(arguments={"article_id": ARTICLE_ID, "article_markdown": "# Sample"})
            self.connection.rollback.assert_called_once()
            self.connection.commit.assert_not_called()
            self.connection.reset_mock()
            blob.upload_blob.side_effect = RuntimeError("Upload failed")
            with self.assertRaisesRegex(RuntimeError, "Upload failed"):
                await tools.save_article_and_complete.invoke(arguments={"article_id": ARTICLE_ID, "article_markdown": "# Sample"})
            self.connection.cursor.assert_not_called()
            service.close.assert_called()
            credential.close.assert_called()

    async def test_invalid_articles_never_connect_to_sql(self):
        for args in [{"article_id": "invalid", "article_markdown": "# Sample"},
                     {"article_id": ARTICLE_ID, "article_markdown": " "}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                await tools.save_article_and_complete.invoke(arguments=args)
        tools.connect.assert_not_called()

    async def test_failed_transition_rejects_missing_processing_article(self):
        self.cursor.fetchone.return_value = None
        with self.assertRaisesRegex(RuntimeError, "Processing status"):
            await tools.mark_article_failed.invoke(arguments={"article_id": ARTICLE_ID, "error_message": "Synthetic failure"})
        self.connection.rollback.assert_called_once()
        self.connection.commit.assert_not_called()


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_factory_builds_independent_workflow_agents(self):
        with patch.dict("os.environ", {"FOUNDRY_PROJECT_ENDPOINT": "https://example.services.ai.azure.com/api/projects/demo",
                                       "AZURE_AI_MODEL_DEPLOYMENT_NAME": "gpt-4.1"}):
            self.assertIsNot(main.create_workflow_agent(), main.create_workflow_agent())

    async def test_host_preserves_telemetry_provider_and_request_isolation(self):
        with patch.object(main, "configure_telemetry"), patch.object(main, "load_dotenv"), \
             patch("agent_framework_foundry_hosting.ResponsesHostServer") as host:
            main.main()
            host.assert_called_once_with(agent=main.create_workflow_agent, configure_observability=None)
            host.return_value.run.assert_called_once()

    async def test_bootstrap_rejects_partial_identity_inputs_before_connecting(self):
        with patch.object(setup_data_store, "connect") as connect:
            for name, object_id in [("identity", None), (None, ARTICLE_ID), ("", ARTICLE_ID), ("identity", "invalid")]:
                with self.subTest(name=name, object_id=object_id), self.assertRaises(ValueError):
                    setup_data_store.setup_sql(seed_samples=False, identity_name=name, identity_object_id=object_id)
            connect.assert_not_called()

    async def test_bootstrap_rolls_back_identity_failure_without_seeding(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value
        cursor.execute.side_effect = [None, RuntimeError("Existing SQL principal does not match")]
        with patch.object(setup_data_store, "connect", return_value=connection), \
             patch.dict("os.environ", {"AZURE_SQL_CONNECTION_STRING": "mock-only"}):
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                setup_data_store.setup_sql(seed_samples=True, identity_name="hosted-agent", identity_object_id=ARTICLE_ID)
        self.assertEqual(cursor.execute.call_count, 2)
        connection.rollback.assert_called_once()
        connection.commit.assert_not_called()
        cursor.close.assert_called_once()
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
