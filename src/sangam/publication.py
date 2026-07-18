from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, IdempotencyError, NotFoundError, ValidationError
from sangam.idempotency import request_hash
from sangam.schemas import (
    Document,
    IssuedPublication,
    Publication,
    PublicationContent,
    PublicationRevision,
    TrustedPreviewGrant,
)
from sangam.service import DocumentService
from sangam.workspace import WorkspaceFilesystem


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@dataclass(frozen=True)
class VerifiedPreview:
    document_id: str
    revision_id: str
    assets: tuple[str, ...]
    expires_at: int


@dataclass(frozen=True)
class PublicationAsset:
    content: bytes
    media_type: str


class PreviewTokenService:
    """Issues fragment-delivered HMAC grants for the isolated preview origin."""

    def __init__(self, *, secret: str, ttl_seconds: int, base_url: str) -> None:
        self.secret = secret.encode("utf-8")
        self.ttl_seconds = ttl_seconds
        self.base_url = base_url.rstrip("/")

    def issue(
        self, *, document_id: str, revision_id: str, assets: tuple[str, ...]
    ) -> TrustedPreviewGrant:
        expires = int(time.time()) + self.ttl_seconds
        payload = {
            "document_id": document_id,
            "revision_id": revision_id,
            "assets": list(assets),
            "exp": expires,
            "nonce": secrets.token_urlsafe(12),
        }
        encoded = _encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
        signature = _encode(hmac.digest(self.secret, f"v1.{encoded}".encode(), "sha256"))
        token = f"v1.{encoded}.{signature}"
        expires_at = datetime.fromtimestamp(expires, UTC).isoformat(timespec="seconds")
        return TrustedPreviewGrant(url=f"{self.base_url}/", token=token, expires_at=expires_at)

    def verify(self, token: str) -> VerifiedPreview:
        try:
            version, encoded, signature = token.split(".", 2)
            if version != "v1":
                raise ValueError
            expected = _encode(hmac.digest(self.secret, f"v1.{encoded}".encode(), "sha256"))
            if not hmac.compare_digest(signature, expected):
                raise ValueError
            payload = json.loads(_decode(encoded))
            document_id = str(payload["document_id"])
            revision_id = str(payload["revision_id"])
            assets = tuple(str(asset) for asset in payload["assets"])
            expires = int(payload["exp"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise NotFoundError("Trusted preview grant was not found") from error
        if expires < int(time.time()):
            raise NotFoundError("Trusted preview grant was not found")
        return VerifiedPreview(
            document_id=document_id,
            revision_id=revision_id,
            assets=assets,
            expires_at=expires,
        )


class PublicationService:
    """Read-only document projections, publication policy, and explicit trust state."""

    def __init__(
        self,
        *,
        database: Database,
        documents: DocumentService,
        preview_tokens: PreviewTokenService,
        workspace: WorkspaceFilesystem,
        max_asset_bytes: int,
        publication_base_url: str,
    ) -> None:
        self.database = database
        self.documents = documents
        self.preview_tokens = preview_tokens
        self.workspace = workspace
        self.max_asset_bytes = max_asset_bytes
        self.publication_base_url = publication_base_url.rstrip("/")

    def list_publications(self) -> list[Publication]:
        with self.database.connection() as connection:
            rows = connection.execute(
                self._publication_query() + " ORDER BY p.updated_at DESC"
            ).fetchall()
        return [self._publication_from_row(row) for row in rows]

    def get_publication(self, publication_id: str) -> Publication:
        with self.database.connection() as connection:
            row = connection.execute(
                self._publication_query() + " WHERE p.publication_id = ?", (publication_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Publication not found: {publication_id}")
        return self._publication_from_row(row)

    def get_document_publication(self, document_id: str) -> Publication | None:
        with self.database.connection() as connection:
            row = connection.execute(
                self._publication_query() + " WHERE p.document_id = ?", (document_id,)
            ).fetchone()
        return self._publication_from_row(row) if row else None

    def create(
        self,
        *,
        document_id: str,
        slug: str,
        access_policy: str,
        actor_id: str,
        idempotency_key: str,
    ) -> IssuedPublication:
        normalized_slug = self._normalize_slug(slug)
        self._validate_policy(access_policy)
        document = self.documents.get_document(document_id)
        fingerprint = request_hash(
            {"document_id": document_id, "slug": normalized_slug, "access_policy": access_policy}
        )
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="publish",
                fingerprint=fingerprint,
            )
            if duplicate:
                publication_id = duplicate
                raw_token = None
            else:
                publication_id = str(uuid.uuid4())
                now = utc_now()
                try:
                    connection.execute(
                        """
                        INSERT INTO publications(
                            publication_id, document_id, slug, access_policy, version, active,
                            created_by, updated_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
                        """,
                        (
                            publication_id,
                            document.document_id,
                            normalized_slug,
                            access_policy,
                            actor_id,
                            actor_id,
                            now,
                            now,
                        ),
                    )
                except sqlite3.IntegrityError as error:
                    raise ConflictError(
                        "That document or publication slug is already published"
                    ) from error
                raw_token = (
                    self._replace_unlisted_token(
                        connection, publication_id=publication_id, actor_id=actor_id
                    )
                    if access_policy == "unlisted"
                    else None
                )
                self._record_event(
                    connection,
                    publication_id=publication_id,
                    actor_id=actor_id,
                    operation="publish",
                    details={"access_policy": access_policy},
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="publish",
                    fingerprint=fingerprint,
                    resource_id=publication_id,
                )
        publication = self.get_publication(publication_id)
        return IssuedPublication(**publication.model_dump(), token=raw_token)

    def update(
        self,
        *,
        publication_id: str,
        expected_version: int,
        slug: str,
        access_policy: str,
        actor_id: str,
        idempotency_key: str,
    ) -> IssuedPublication:
        normalized_slug = self._normalize_slug(slug)
        self._validate_policy(access_policy)
        fingerprint = request_hash(
            {
                "publication_id": publication_id,
                "expected_version": expected_version,
                "slug": normalized_slug,
                "access_policy": access_policy,
            }
        )
        raw_token: str | None = None
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="publication_update",
                fingerprint=fingerprint,
            )
            if duplicate is None:
                current = connection.execute(
                    "SELECT * FROM publications WHERE publication_id = ?", (publication_id,)
                ).fetchone()
                if current is None:
                    raise NotFoundError(f"Publication not found: {publication_id}")
                if current["version"] != expected_version:
                    raise ConflictError(
                        "The publication changed since it was read",
                        details={"current_version": current["version"]},
                    )
                now = utc_now()
                try:
                    connection.execute(
                        """
                        UPDATE publications
                        SET slug = ?, access_policy = ?, version = version + 1,
                            active = 1, updated_by = ?, updated_at = ?
                        WHERE publication_id = ?
                        """,
                        (normalized_slug, access_policy, actor_id, now, publication_id),
                    )
                except sqlite3.IntegrityError as error:
                    raise ConflictError("That publication slug is already in use") from error
                if access_policy == "unlisted" and not self._has_active_token(
                    connection, publication_id
                ):
                    raw_token = self._replace_unlisted_token(
                        connection, publication_id=publication_id, actor_id=actor_id
                    )
                if access_policy != "unlisted":
                    self._revoke_tokens(connection, publication_id)
                self._record_event(
                    connection,
                    publication_id=publication_id,
                    actor_id=actor_id,
                    operation="update" if current["active"] else "republish",
                    details={"access_policy": access_policy, "slug": normalized_slug},
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="publication_update",
                    fingerprint=fingerprint,
                    resource_id=publication_id,
                )
        publication = self.get_publication(publication_id)
        return IssuedPublication(**publication.model_dump(), token=raw_token)

    def unpublish(
        self,
        *,
        publication_id: str,
        expected_version: int,
        actor_id: str,
        idempotency_key: str,
    ) -> Publication:
        fingerprint = request_hash(
            {"publication_id": publication_id, "expected_version": expected_version}
        )
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="unpublish",
                fingerprint=fingerprint,
            )
            if duplicate is None:
                row = connection.execute(
                    "SELECT version FROM publications WHERE publication_id = ?", (publication_id,)
                ).fetchone()
                if row is None:
                    raise NotFoundError(f"Publication not found: {publication_id}")
                if row["version"] != expected_version:
                    raise ConflictError(
                        "The publication changed since it was read",
                        details={"current_version": row["version"]},
                    )
                now = utc_now()
                connection.execute(
                    """
                    UPDATE publications SET active = 0, version = version + 1,
                        updated_by = ?, updated_at = ? WHERE publication_id = ?
                    """,
                    (actor_id, now, publication_id),
                )
                self._revoke_tokens(connection, publication_id)
                self._record_event(
                    connection,
                    publication_id=publication_id,
                    actor_id=actor_id,
                    operation="unpublish",
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="unpublish",
                    fingerprint=fingerprint,
                    resource_id=publication_id,
                )
        return self.get_publication(publication_id)

    def expose_revision(
        self,
        *,
        publication_id: str,
        revision_id: str,
        actor_id: str,
        idempotency_key: str,
    ) -> PublicationRevision:
        publication = self.get_publication(publication_id)
        fingerprint = request_hash({"publication_id": publication_id, "revision_id": revision_id})
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="expose_revision",
                fingerprint=fingerprint,
            )
            if duplicate is None:
                revision = connection.execute(
                    "SELECT 1 FROM revisions WHERE revision_id = ? AND document_id = ?",
                    (revision_id, publication.document_id),
                ).fetchone()
                if revision is None:
                    raise NotFoundError("Revision not found for the published document")
                now = utc_now()
                connection.execute(
                    """
                    INSERT OR IGNORE INTO publication_revision_exposures(
                        publication_id, revision_id, exposed_by, exposed_at
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (publication_id, revision_id, actor_id, now),
                )
                self._record_event(
                    connection,
                    publication_id=publication_id,
                    actor_id=actor_id,
                    operation="expose_revision",
                    details={"revision_id": revision_id},
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="expose_revision",
                    fingerprint=fingerprint,
                    resource_id=revision_id,
                )
            row = connection.execute(
                """
                SELECT * FROM publication_revision_exposures
                WHERE publication_id = ? AND revision_id = ?
                """,
                (publication_id, revision_id),
            ).fetchone()
        if row is None:
            raise RuntimeError("Revision exposure could not be reloaded")
        return PublicationRevision.model_validate(dict(row))

    def rotate_token(
        self,
        *,
        publication_id: str,
        actor_id: str,
        idempotency_key: str,
    ) -> IssuedPublication:
        publication = self.get_publication(publication_id)
        if publication.access_policy != "unlisted" or not publication.active:
            raise ValidationError("Only an active unlisted publication has an access token")
        fingerprint = request_hash({"publication_id": publication_id})
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="rotate_publication_token",
                fingerprint=fingerprint,
            )
            if duplicate is not None:
                raise IdempotencyError(
                    "Publication tokens are disclosed only once; use a new key to rotate again"
                )
            raw_token = self._replace_unlisted_token(
                connection, publication_id=publication_id, actor_id=actor_id
            )
            connection.execute(
                """
                UPDATE publications SET version = version + 1, updated_by = ?, updated_at = ?
                WHERE publication_id = ?
                """,
                (actor_id, utc_now(), publication_id),
            )
            self._record_event(
                connection,
                publication_id=publication_id,
                actor_id=actor_id,
                operation="rotate_token",
            )
            self._record_idempotency(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="rotate_publication_token",
                fingerprint=fingerprint,
                resource_id=publication_id,
            )
        result = self.get_publication(publication_id)
        return IssuedPublication(**result.model_dump(), token=raw_token)

    def update_trust(
        self,
        *,
        document_id: str,
        expected_trust_version: int,
        trust_level: str,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        if trust_level not in {"untrusted", "trusted_interactive"}:
            raise ValidationError("Unsupported document trust level")
        fingerprint = request_hash(
            {
                "document_id": document_id,
                "expected_trust_version": expected_trust_version,
                "trust_level": trust_level,
            }
        )
        with self.database.transaction() as connection:
            duplicate = self._idempotent_resource(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="document_trust",
                fingerprint=fingerprint,
            )
            if duplicate is None:
                row = connection.execute(
                    """
                    SELECT content_type, trust_level, trust_version
                    FROM documents WHERE document_id = ?
                    """,
                    (document_id,),
                ).fetchone()
                if row is None:
                    raise NotFoundError(f"Document not found: {document_id}")
                if row["content_type"] != "text/html":
                    raise ValidationError("Only HTML documents have an interactive trust policy")
                if row["trust_version"] != expected_trust_version:
                    raise ConflictError(
                        "Document trust changed since it was read",
                        details={"current_trust_version": row["trust_version"]},
                    )
                next_version = row["trust_version"] + 1
                connection.execute(
                    """
                    UPDATE documents SET trust_level = ?, trust_version = ?, updated_at = ?
                    WHERE document_id = ?
                    """,
                    (trust_level, next_version, utc_now(), document_id),
                )
                connection.execute(
                    """
                    INSERT INTO document_trust_events(
                        event_id, document_id, actor_id, previous_level,
                        next_level, trust_version, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        document_id,
                        actor_id,
                        row["trust_level"],
                        trust_level,
                        next_version,
                        utc_now(),
                    ),
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="document_trust",
                    fingerprint=fingerprint,
                    resource_id=document_id,
                )
        return self.documents.get_document(document_id)

    def issue_trusted_preview(self, *, document_id: str, revision_id: str) -> TrustedPreviewGrant:
        document = self.documents.get_document(document_id)
        if document.content_type != "text/html" or document.trust_level != "trusted_interactive":
            raise ValidationError("The document is not trusted for interactive preview")
        revision = self._revision_content(document_id=document_id, revision_id=revision_id)
        assets = tuple(sorted(self._relative_asset_references(revision["content"])))
        return self.preview_tokens.issue(
            document_id=document_id, revision_id=revision_id, assets=assets
        )

    def trusted_preview_content(self, raw_token: str) -> str:
        verified = self.preview_tokens.verify(raw_token)
        document = self.documents.get_document(verified.document_id)
        if document.content_type != "text/html" or document.trust_level != "trusted_interactive":
            raise NotFoundError("Trusted preview grant was not found")
        return self._revision_content(
            document_id=verified.document_id, revision_id=verified.revision_id
        )["content"]

    def trusted_preview_asset(self, *, raw_token: str, asset_reference: str) -> PublicationAsset:
        verified = self.preview_tokens.verify(raw_token)
        if asset_reference not in verified.assets:
            raise NotFoundError("Trusted preview asset was not found")
        document = self.documents.get_document(verified.document_id)
        if document.content_type != "text/html" or document.trust_level != "trusted_interactive":
            raise NotFoundError("Trusted preview asset was not found")
        return self._read_document_asset(document=document, asset_reference=asset_reference)

    def get_content(
        self,
        *,
        slug: str,
        revision_id: str | None,
        raw_unlisted_token: str | None,
        administrator: bool,
    ) -> PublicationContent:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT p.*, d.title, d.content_type, d.current_revision_id, d.trust_level,
                    d.deleted
                FROM publications p JOIN documents d ON d.document_id = p.document_id
                WHERE p.slug = ? COLLATE NOCASE AND p.active = 1 AND d.deleted = 0
                """,
                (slug,),
            ).fetchone()
            if row is None:
                raise NotFoundError("Publication not found")
            if row["access_policy"] == "private" and not administrator:
                raise NotFoundError("Publication not found")
            if row["access_policy"] == "unlisted" and not self._valid_unlisted_token(
                connection, row["publication_id"], raw_unlisted_token
            ):
                raise NotFoundError("Publication not found")
            resolved_revision = revision_id or row["current_revision_id"]
            if revision_id is not None and revision_id != row["current_revision_id"]:
                exposed = connection.execute(
                    """
                    SELECT 1 FROM publication_revision_exposures
                    WHERE publication_id = ? AND revision_id = ?
                    """,
                    (row["publication_id"], revision_id),
                ).fetchone()
                if exposed is None:
                    raise NotFoundError("Publication not found")
            revision = connection.execute(
                "SELECT content FROM revisions WHERE revision_id = ? AND document_id = ?",
                (resolved_revision, row["document_id"]),
            ).fetchone()
            if revision is None:
                raise NotFoundError("Publication not found")
        return PublicationContent(
            publication_id=row["publication_id"],
            document_id=row["document_id"],
            title=row["title"],
            slug=row["slug"],
            revision_id=resolved_revision,
            content_type=row["content_type"],
            content=revision["content"],
            trust_level=row["trust_level"],
            is_latest=resolved_revision == row["current_revision_id"],
            asset_base_url=(
                f"/api/v1/publications/{row['slug']}/asset?revision={resolved_revision}&path="
            ),
        )

    def get_asset(
        self,
        *,
        slug: str,
        revision_id: str,
        asset_reference: str,
        raw_unlisted_token: str | None,
        administrator: bool,
    ) -> PublicationAsset:
        publication = self.get_content(
            slug=slug,
            revision_id=revision_id,
            raw_unlisted_token=raw_unlisted_token,
            administrator=administrator,
        )
        references = self._relative_asset_references(publication.content)
        if asset_reference not in references:
            raise NotFoundError("Publication asset not found")
        document = self.documents.get_document(publication.document_id)
        return self._read_document_asset(document=document, asset_reference=asset_reference)

    def _read_document_asset(self, *, document: Document, asset_reference: str) -> PublicationAsset:
        if document.path is None:
            raise NotFoundError("Publication asset not found")
        parsed = urlsplit(unquote(asset_reference))
        if parsed.scheme or parsed.netloc or parsed.path.startswith("/"):
            raise NotFoundError("Publication asset not found")
        document_parent = PurePosixPath(document.path).parent
        candidate = PurePosixPath(document_parent, parsed.path)
        normalized_parts: list[str] = []
        for part in candidate.parts:
            if part in {"", "."}:
                continue
            if part == "..":
                if not normalized_parts:
                    raise NotFoundError("Publication asset not found")
                normalized_parts.pop()
            else:
                normalized_parts.append(part)
        if not normalized_parts:
            raise NotFoundError("Publication asset not found")
        try:
            content, media_type = self.workspace.read_asset(
                "/".join(normalized_parts), max_bytes=self.max_asset_bytes
            )
        except Exception as error:
            raise NotFoundError("Publication asset not found") from error
        return PublicationAsset(content=content, media_type=media_type)

    @staticmethod
    def _relative_asset_references(content: str) -> set[str]:
        import re

        references = set(re.findall(r"!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)", content))
        references.update(
            match[1]
            for match in re.findall(
                r"\b(?:src|href)\s*=\s*(['\"])(.*?)\1", content, flags=re.IGNORECASE
            )
        )
        return {
            reference
            for reference in references
            if reference
            and not urlsplit(reference).scheme
            and not urlsplit(reference).netloc
            and not reference.startswith(("/", "#"))
        }

    def _revision_content(self, *, document_id: str, revision_id: str) -> sqlite3.Row:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT content FROM revisions WHERE document_id = ? AND revision_id = ?",
                (document_id, revision_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Revision not found for document")
        return row

    @staticmethod
    def _normalize_slug(slug: str) -> str:
        normalized = slug.strip().lower()
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", normalized):
            raise ValidationError(
                "Publication slug must contain 1-64 lowercase letters, numbers, or hyphens"
            )
        return normalized

    @staticmethod
    def _validate_policy(access_policy: str) -> None:
        if access_policy not in {"private", "public", "unlisted"}:
            raise ValidationError("Unsupported publication access policy")

    @staticmethod
    def _publication_query() -> str:
        return """
            SELECT p.*, d.title AS document_title,
                EXISTS(
                    SELECT 1 FROM publication_tokens t
                    WHERE t.publication_id = p.publication_id AND t.revoked_at IS NULL
                ) AS has_active_token
            FROM publications p JOIN documents d ON d.document_id = p.document_id
        """

    def _publication_from_row(self, row: sqlite3.Row) -> Publication:
        values = dict(row)
        values["active"] = bool(values["active"])
        values["has_active_token"] = bool(values["has_active_token"])
        values["url"] = f"{self.publication_base_url}/{values['slug']}"
        return Publication.model_validate(values)

    @staticmethod
    def _has_active_token(connection: sqlite3.Connection, publication_id: str) -> bool:
        return (
            connection.execute(
                "SELECT 1 FROM publication_tokens WHERE publication_id = ? AND revoked_at IS NULL",
                (publication_id,),
            ).fetchone()
            is not None
        )

    @staticmethod
    def _revoke_tokens(connection: sqlite3.Connection, publication_id: str) -> None:
        connection.execute(
            """
            UPDATE publication_tokens SET revoked_at = COALESCE(revoked_at, ?)
            WHERE publication_id = ?
            """,
            (utc_now(), publication_id),
        )

    def _replace_unlisted_token(
        self, connection: sqlite3.Connection, *, publication_id: str, actor_id: str
    ) -> str:
        self._revoke_tokens(connection, publication_id)
        token_id = f"pub_{uuid.uuid4()}"
        raw_token = f"sgm_{token_id}.{secrets.token_urlsafe(32)}"
        connection.execute(
            """
            INSERT INTO publication_tokens(
                token_id, publication_id, secret_hash, created_by, created_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (
                token_id,
                publication_id,
                hashlib.sha256(raw_token.encode()).hexdigest(),
                actor_id,
                utc_now(),
            ),
        )
        return raw_token

    @staticmethod
    def _valid_unlisted_token(
        connection: sqlite3.Connection, publication_id: str, raw_token: str | None
    ) -> bool:
        if not raw_token or not raw_token.startswith("sgm_pub_"):
            return False
        token_prefix, separator, _secret = raw_token.partition(".")
        if not separator:
            return False
        token_id = token_prefix.removeprefix("sgm_")
        row = connection.execute(
            """
            SELECT secret_hash FROM publication_tokens
            WHERE token_id = ? AND publication_id = ? AND revoked_at IS NULL
            """,
            (token_id, publication_id),
        ).fetchone()
        return row is not None and hmac.compare_digest(
            row["secret_hash"], hashlib.sha256(raw_token.encode()).hexdigest()
        )

    @staticmethod
    def _record_event(
        connection: sqlite3.Connection,
        *,
        publication_id: str,
        actor_id: str,
        operation: str,
        details: dict[str, object] | None = None,
    ) -> None:
        connection.execute(
            """
            INSERT INTO publication_events(
                event_id, publication_id, actor_id, operation, detail_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                publication_id,
                actor_id,
                operation,
                json.dumps(details or {}, sort_keys=True),
                utc_now(),
            ),
        )

    @staticmethod
    def _idempotent_resource(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        fingerprint: str,
    ) -> str | None:
        for table in ("idempotency_keys", "mutation_idempotency_keys"):
            if connection.execute(
                f"SELECT 1 FROM {table} WHERE actor_id = ? AND idempotency_key = ?",
                (actor_id, key),
            ).fetchone():
                raise IdempotencyError(
                    "Idempotency key was already used for a different mutation",
                    details={"idempotency_key": key},
                )
        row = connection.execute(
            """
            SELECT operation, request_hash, resource_id FROM phase_four_idempotency_keys
            WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if row and (row["operation"] != operation or row["request_hash"] != fingerprint):
            raise IdempotencyError(
                "Idempotency key was already used for a different mutation",
                details={"idempotency_key": key},
            )
        return row["resource_id"] if row else None

    @staticmethod
    def _record_idempotency(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        fingerprint: str,
        resource_id: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO phase_four_idempotency_keys(
                actor_id, idempotency_key, operation, request_hash, resource_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (actor_id, key, operation, fingerprint, resource_id, utc_now()),
        )
