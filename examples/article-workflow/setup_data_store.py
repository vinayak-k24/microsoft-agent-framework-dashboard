"""Explicit SQL/Blob bootstrap; never run automatically during agent startup."""
import argparse
from pathlib import Path
from uuid import UUID

from azure.core.exceptions import ResourceExistsError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv
from mssql_python import connect

from tools import required_setting

SCHEMA = """
IF OBJECT_ID(N'dbo.Articles', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Articles (
        article_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_Articles PRIMARY KEY DEFAULT NEWID(),
        topic NVARCHAR(2000) NOT NULL,
        status NVARCHAR(20) NOT NULL CONSTRAINT DF_Articles_Status DEFAULT N'Pending',
        article_blob_url NVARCHAR(2048) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_Articles_Created DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NOT NULL CONSTRAINT DF_Articles_Updated DEFAULT SYSUTCDATETIME(),
        error_message NVARCHAR(4000) NULL,
        CONSTRAINT CK_Articles_Status CHECK (status IN (N'Pending', N'Processing', N'Completed', N'Failed'))
    );
END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Articles') AND name = N'IX_Articles_Status_Created')
    CREATE INDEX IX_Articles_Status_Created ON dbo.Articles(status, created_at, article_id);
"""
SAMPLES = (
    ("11111111-1111-4111-8111-111111111111", "How OpenTelemetry helps diagnose multi-agent workflows"),
    ("22222222-2222-4222-8222-222222222222", "Best practices for accessible web application interfaces"),
)


def setup_sql(*, seed_samples: bool, identity_name: str | None, identity_object_id: str | None) -> None:
    if bool(identity_name) != bool(identity_object_id):
        raise ValueError("Managed identity name and object ID must be provided together.")
    object_id = str(UUID(identity_object_id)) if identity_object_id else None
    if identity_name and (len(identity_name) > 128 or not identity_name.strip()):
        raise ValueError("Managed identity name must be nonempty and at most 128 characters.")
    connection = connect(required_setting("AZURE_SQL_CONNECTION_STRING"))
    try:
        cursor = connection.cursor()
        try:
            cursor.execute(SCHEMA)
            if identity_name:
                identifier = identity_name.replace("]", "]]")
                literal = identity_name.replace("'", "''")
                cursor.execute(f"""
                    IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{literal}'
                               AND (type <> 'E' OR sid <> CONVERT(binary(16), CONVERT(uniqueidentifier, '{object_id}'))))
                        THROW 50001, 'Existing SQL principal does not match the requested managed identity.', 1;
                    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{literal}')
                        CREATE USER [{identifier}] FROM EXTERNAL PROVIDER WITH OBJECT_ID = '{object_id}';
                    GRANT SELECT, UPDATE ON OBJECT::dbo.Articles TO [{identifier}];
                """)
            if seed_samples:
                for article_id, topic in SAMPLES:
                    cursor.execute("""
                        IF NOT EXISTS (SELECT 1 FROM dbo.Articles WITH (UPDLOCK, HOLDLOCK)
                                       WHERE article_id = CONVERT(uniqueidentifier, ?))
                            INSERT INTO dbo.Articles(article_id, topic) VALUES (CONVERT(uniqueidentifier, ?), ?);
                    """, (article_id, article_id, topic))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-samples", action="store_true", help="Insert two synthetic demo topics without resetting existing rows.")
    parser.add_argument("--managed-identity-name")
    parser.add_argument("--managed-identity-object-id")
    args = parser.parse_args()
    load_dotenv(Path(__file__).with_name(".env"), override=False)
    setup_sql(seed_samples=args.seed_samples, identity_name=args.managed_identity_name,
              identity_object_id=args.managed_identity_object_id)
    with DefaultAzureCredential() as credential:
        with BlobServiceClient(required_setting("AZURE_STORAGE_ACCOUNT_URL"), credential=credential) as service:
            try:
                service.create_container(required_setting("AZURE_STORAGE_CONTAINER"))
            except ResourceExistsError:
                print("Blob container already exists; access settings were not changed.")
    print("SQL schema and Blob container ready. Existing article states were preserved.")


if __name__ == "__main__":
    main()
