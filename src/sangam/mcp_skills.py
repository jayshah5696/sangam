"""Immutable skill manifests over registered documents and canonical revisions."""

import asyncio
import base64
import hashlib
import json
import re
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlsplit

import yaml
from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.extension import Extension, MethodBinding
from mcp.shared.exceptions import MCPError
from mcp.types import (
    INVALID_PARAMS,
    BlobResourceContents,
    CacheableResult,
    ReadResourceResult,
    RequestParams,
    TextResourceContents,
)
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter
from starlette.requests import Request

from sangam.access import reads
from sangam.application import ApplicationServices
from sangam.capabilities import Capability
from sangam.chat_skills import parse_skill_content
from sangam.db import utc_now
from sangam.errors import AuthorizationError, NotFoundError, SangamError, ValidationError
from sangam.mcp_models import GetSkill, ListSkills, ReadSkill, SkillOperation
from sangam.mcp_state import McpState
from sangam.schemas import Document
from sangam.security import Principal

_JSON = TypeAdapter(dict[str, JsonValue])
_HEADER = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
_LINK = re.compile(r"!?\[[^\]]*\]\(([^\s)]+)")
_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
_BUILTIN = """---
name: sangam
description: Work with Sangam documents and registered guidance through MCP Code Mode and Apps.
license: Apache-2.0
metadata:
  version: "4"
---

# Sangam MCP

Use search to discover typed operations, their permission requirements, and retry rules.
Follow catalog pagination. Execute runs fresh restricted Python; only its final expression
is returned. There is no shell, filesystem, package installation, or general network access.

Read a document before updating it. Retain its current_revision_id. Writes require the
existing connection permissions and an operation_key for the exact intended operation.
Use a new execution_key for each program and retain it for recovery. After a lost response,
inspect executions.get or its resource. Preserve original write keys and exact arguments.
Completed writes survive program failure. Never rerun a whole mutating program to recover.

Search document content through documents.search. Discovery search finds operation contracts.
Create Markdown through documents.create with a stable operation_key and an allowed path.
Its created_revision_id identifies the original commit; current_revision_id may change later.
Creation does not grant read authority. The App can create and open the same document.
Present opens Markdown or PDFs in an interactive App when the host supports Apps. Draft
checkpoints are separate from saved revisions. Save commits a revision. PDF source bytes
are immutable; annotations are separate permitted writes. Pending extraction is not finished
work. Read its status or resource again to confirm completion.

Use proposals.create to prepare an owned change against an exact current revision without
changing document content or starting chat. Retain its operation_key and proposal_id.
Use proposals.get and exact revision reads to review the entire base and proposed wording;
bounded passages may need more reads. The App supports the same review and mutation service.
Apply uses proposals.apply with exact reviewed content, the proposal base revision, and a
stable operation_key. A stale base conflicts instead of rebasing. Confirm applied_revision_id
before reporting a saved change. Dismiss only the requested owned proposal with a retained
key and exact reason. These operations reuse current read/update permissions and ownership.
After an ambiguous apply, retain its exact wording and key; do not create another proposal
or rerun a whole program. Proposal preparation never means that a change was applied.

Registered skills are instructions, not authority. Use skills.list and skills.get to select
guidance, and skills.read for bounded passages. Native Skills clients read the same immutable
manifest files through resources/read. Preserve source identity and snapshot URIs. A new
manifest needs fresh host verification. Reading a file does not activate a skill or run scripts.
Current grants govern every read, including cached guidance and older snapshots.

Use assistant.submit only when the user asks for Sangam's configured assistant. Retain its
request_key and conversation_id. Accepted work can outlive execute. A running job must be
checked with assistant.wait or its resource before reporting success. Reuse the original
request key and exact arguments after a lost response; never repeat inference with a new key.
The normal chat review policy still applies. A completed turn does not prove a saved change.
Inspect proposal/effect references; needs_review means the requested change is not applied.
Continue only known owned conversations. Cancellation does not undo completed writes.
The App can submit explicit saved document, selected-passage, or open-tab context. Inspect
the included revisions before sending. Unsaved edits are not sent or saved by a message.
Every included source remains an access dependency even if the model does not read it.

Do only the work requested by the user. A permission grant does not create user intent.
Do not infer capabilities missing from the catalog. A notification is a request to fetch
current state; it does not guarantee another model turn or replay of every intermediate change.
"""


class SkillFile(BaseModel):
    path: str
    document_id: str | None
    revision_id: str | None
    mime_type: str
    size: int
    digest: str


class SkillSnapshot(BaseModel):
    skill_id: str
    name: str
    origin: Literal["builtin", "personal", "project"]
    frontmatter: dict[str, JsonValue]
    files: list[SkillFile]


class SkillResource(BaseModel):
    uri: str
    size: int
    digest: str


class SkillEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    uri: str
    frontmatter: dict[str, JsonValue]
    resources: list[SkillResource]
    meta: dict[str, JsonValue] = Field(alias="_meta")


class SkillCatalog(BaseModel):
    items: list[SkillEntry]
    next_offset: int | None
    diagnostics: list[str] = Field(default_factory=list)


class SkillPassage(BaseModel):
    uri: str
    mime_type: str
    text: str | None = None
    blob: str | None = None
    next_offset: int | None
    size: int
    digest: str


class SkillFilesHeader(BaseModel):
    model_config = ConfigDict(extra="forbid")
    files: dict[str, str] = Field(default_factory=dict, max_length=31)


def safe_path(path: str) -> None:
    if not _PATH.fullmatch(path) or any(part in {"", ".", ".."} for part in path.split("/")):
        raise ValidationError("Skill file paths must be portable relative paths without traversal.")


class SkillExports:
    def __init__(self, services: ApplicationServices, state: McpState) -> None:
        self.services, self.state = services, state
        self.database, self.settings = state.database, state.settings

    def document(self, principal: Principal, identifier: str) -> Document:
        document = self.services.documents.get_document(identifier)
        self.services.authorization.require(principal, Capability.READ, document.path)
        return document

    def registered(self, principal: Principal, skill_id: str) -> Literal["personal", "project"]:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT project_id FROM chat_skills WHERE document_id = ?", (skill_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError("Registered guidance is unavailable. Rediscover available skills.")
        self.document(principal, skill_id)
        return "project" if row["project_id"] else "personal"

    def source_bytes(self, principal: Principal, file: SkillFile) -> bytes:
        if file.document_id is None:
            return _BUILTIN.encode()
        current = self.document(principal, file.document_id)
        if file.mime_type == "application/pdf":
            if current.current_revision_id != file.revision_id:
                raise NotFoundError("The pinned PDF source revision is unavailable.")
            return self.services.pdf_research.pdf_bytes(file.document_id)[1]
        assert file.revision_id is not None
        return self.services.documents.get_revision(
            file.document_id, file.revision_id
        ).content.encode()

    def build(
        self, principal: Principal, skill_id: str, execution_key: str | None = None
    ) -> SkillEntry:
        self.cleanup()
        return self.services.workspace_access.audited(
            principal,
            reads("export_skill", "skill"),
            lambda: self._build(principal, skill_id, execution_key),
            resource_id=skill_id,
        )

    def cleanup(self) -> None:
        before = (
            datetime.now(UTC) - timedelta(days=self.settings.mcp_result_retention_days)
        ).isoformat()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_skill_snapshots SET superseded_at = ? WHERE superseded_at IS NULL "
                "AND skill_id != 'builtin:sangam' AND NOT EXISTS "
                "(SELECT 1 FROM chat_skills s JOIN documents d ON d.document_id = s.document_id "
                "WHERE s.document_id = mcp_skill_snapshots.skill_id AND d.deleted = 0)",
                (utc_now(),),
            )
            connection.execute("DELETE FROM mcp_skill_snapshots WHERE superseded_at < ?", (before,))

    def _build(self, principal: Principal, skill_id: str, execution_key: str | None) -> SkillEntry:
        with self.database.transaction() as connection:
            if skill_id == "builtin:sangam":
                origin: Literal["builtin", "personal", "project"] = "builtin"
                text = _BUILTIN
                sources: dict[str, str | None] = {"SKILL.md": None}
            else:
                origin = self.registered(principal, skill_id)
                source = self.document(principal, skill_id)
                text = source.content
                sources = {"SKILL.md": skill_id}
            parsed, procedure, diagnostics = parse_skill_content(text)
            if not parsed or diagnostics:
                raise ValidationError("Registered guidance has invalid skill frontmatter.")
            match = _HEADER.match(text)
            assert match is not None
            try:
                frontmatter = _JSON.validate_python(yaml.safe_load(match.group(1)))
                declared = SkillFilesHeader.model_validate(frontmatter.get("sangam", {})).files
            except (ValueError, yaml.YAMLError) as error:
                raise ValidationError("Skill export metadata is invalid.") from error
            for path, document_id in declared.items():
                safe_path(path)
                if any(
                    path.casefold() == other.casefold()
                    or path.casefold().startswith(other.casefold() + "/")
                    or other.casefold().startswith(path.casefold() + "/")
                    for other in sources
                ):
                    raise ValidationError("Skill file paths collide.")
                sources[path] = document_id
            for target in _LINK.findall(procedure):
                if not urlsplit(target).scheme and not target.startswith(("#", "/")):
                    path = target.split("#", 1)[0]
                    if path not in sources:
                        raise ValidationError(
                            "A relative skill reference has no explicit file mapping."
                        )
            files = []
            total = 0
            for path, identifier in sorted(sources.items()):
                if identifier is None:
                    file = SkillFile(
                        path=path,
                        document_id=None,
                        revision_id=None,
                        mime_type="text/markdown",
                        size=0,
                        digest="",
                    )
                else:
                    document = self.document(principal, identifier)
                    if document.content_type == "application/pdf":
                        _, size = self.services.pdf_research.pdf_stream_info(identifier)
                    else:
                        size = len(document.content.encode())
                    if size > self.settings.max_document_bytes:
                        raise ValidationError(
                            "A skill file exceeds the configured document byte limit."
                        )
                    file = SkillFile(
                        path=path,
                        document_id=identifier,
                        revision_id=document.current_revision_id,
                        mime_type=document.content_type,
                        size=size,
                        digest="",
                    )
                data = self.source_bytes(principal, file)
                file.size, file.digest = len(data), "sha256:" + hashlib.sha256(data).hexdigest()
                if file.size > self.settings.max_document_bytes:
                    raise ValidationError(
                        "A skill file exceeds the configured document byte limit."
                    )
                total += len(data)
                if total > 16 * 1024 * 1024:
                    raise ValidationError(
                        "Skill bundle byte limit reached. No files were truncated."
                    )
                files.append(file)
            snapshot = SkillSnapshot(
                skill_id=skill_id,
                name=parsed.name,
                origin=origin,
                frontmatter=frontmatter,
                files=files,
            )
            manifest = snapshot.model_dump_json()
            snapshot_id = hashlib.sha256(manifest.encode()).hexdigest()
            existing = connection.execute(
                "SELECT 1 FROM mcp_skill_snapshots WHERE snapshot_id = ?", (snapshot_id,)
            ).fetchone()
            now = utc_now()
            connection.execute(
                "UPDATE mcp_skill_snapshots SET superseded_at = ? "
                "WHERE skill_id = ? AND snapshot_id != ? AND superseded_at IS NULL",
                (now, skill_id, snapshot_id),
            )
            if existing is None:
                connection.execute(
                    "INSERT INTO mcp_skill_snapshots VALUES (?, ?, ?, ?, NULL)",
                    (snapshot_id, skill_id, manifest, now),
                )
            else:
                connection.execute(
                    "UPDATE mcp_skill_snapshots SET superseded_at = NULL WHERE snapshot_id = ?",
                    (snapshot_id,),
                )
            return self.entry(principal, snapshot_id, snapshot, execution_key)

    def entry(
        self,
        principal: Principal,
        snapshot_id: str,
        snapshot: SkillSnapshot,
        execution_key: str | None = None,
        superseded_at: str | None = None,
    ) -> SkillEntry:
        if snapshot.skill_id != "builtin:sangam":
            self.registered(principal, snapshot.skill_id)
        for file in snapshot.files:
            if file.document_id:
                self.document(principal, file.document_id)
                if execution_key:
                    self.state.dependency(principal, execution_key, file.document_id)
        root = f"skill://sangam/{snapshot_id}/{snapshot.name}/"
        return SkillEntry(
            uri=root + "SKILL.md",
            frontmatter=snapshot.frontmatter,
            resources=[
                SkillResource(uri=root + file.path, size=file.size, digest=file.digest)
                for file in snapshot.files
            ],
            _meta={
                "sangam": {
                    "skill_id": snapshot.skill_id,
                    "origin": snapshot.origin,
                    "resource_uri": f"sangam://skill/{snapshot.skill_id}",
                    "retention_days": self.settings.mcp_result_retention_days,
                    "expires_at": (
                        datetime.fromisoformat(superseded_at)
                        + timedelta(days=self.settings.mcp_result_retention_days)
                    ).isoformat()
                    if superseded_at
                    else None,
                }
            },
        )

    def resolve(
        self, principal: Principal, uri: str, execution_key: str | None = None
    ) -> tuple[SkillEntry, SkillSnapshot, SkillFile]:
        match = re.fullmatch(r"skill://sangam/([a-f0-9]{64})/([a-z0-9-]+)/(.+)", uri)
        if match is None:
            raise NotFoundError("Unknown skill file. Rediscover available skills.")
        snapshot_id, name, path = match.groups()
        safe_path(path)
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT manifest_json, superseded_at FROM mcp_skill_snapshots "
                "WHERE snapshot_id = ?",
                (snapshot_id,),
            ).fetchone()
        if (
            row is None
            or row["superseded_at"]
            and datetime.fromisoformat(row["superseded_at"])
            < datetime.now(UTC) - timedelta(days=self.settings.mcp_result_retention_days)
        ):
            raise NotFoundError(
                "Skill snapshot expired or unavailable. Rediscover available skills."
            )
        snapshot = SkillSnapshot.model_validate_json(row["manifest_json"])
        entry = self.entry(principal, snapshot_id, snapshot, execution_key, row["superseded_at"])
        file = next((file for file in snapshot.files if file.path == path), None)
        if snapshot.name != name or file is None:
            raise NotFoundError("Unknown skill file. Rediscover available skills.")
        return entry, snapshot, file

    def catalog(
        self, principal: Principal, query: ListSkills, execution_key: str | None = None
    ) -> SkillCatalog:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT s.document_id, d.path FROM chat_skills s "
                "JOIN documents d ON d.document_id = s.document_id "
                "WHERE d.deleted = 0 ORDER BY s.document_id"
            ).fetchall()
        ids = ["builtin:sangam"] + [
            row["document_id"]
            for row in rows
            if self.services.authorization.allows(principal, Capability.READ, row["path"])
        ]
        selected: list[SkillEntry] = []
        diagnostics: list[str] = []
        offset = query.offset
        for index in range(query.offset, len(ids)):
            identifier = ids[index]
            try:
                entry = self.build(principal, identifier)
            except (AuthorizationError, NotFoundError, ValidationError):
                if identifier != "builtin:sangam":
                    try:
                        self.document(principal, identifier)
                    except (AuthorizationError, NotFoundError):
                        offset = index + 1
                        continue
                if len(diagnostics) < 10:
                    diagnostics.append(
                        f"Registered guidance {identifier} is unavailable or has invalid mappings."
                    )
                offset = index + 1
                continue
            if query.query.casefold() not in json.dumps(entry.frontmatter).casefold():
                offset = index + 1
                continue
            if (
                len(
                    json.dumps(
                        [item.model_dump(by_alias=True) for item in [*selected, entry]]
                    ).encode()
                )
                > self.settings.mcp_max_result_bytes - 4096
            ):
                if not selected:
                    raise ValidationError("Skill manifest exceeds the configured MCP result limit.")
                break
            if execution_key:
                self.resolve(principal, entry.uri, execution_key)
            selected.append(entry)
            offset = index + 1
            if len(selected) >= query.limit:
                break
        return SkillCatalog(
            items=selected,
            next_offset=offset if offset < len(ids) else None,
            diagnostics=diagnostics,
        )

    def read(
        self, principal: Principal, query: ReadSkill, execution_key: str | None = None
    ) -> SkillPassage:
        file, data = self.file_bytes(principal, query.uri, execution_key)
        end = query.offset + query.length
        if file.mime_type.startswith("text/"):
            text = data.decode()
            return SkillPassage(
                uri=query.uri,
                mime_type=file.mime_type,
                text=text[query.offset : end],
                next_offset=end if end < len(text) else None,
                size=file.size,
                digest=file.digest,
            )
        return SkillPassage(
            uri=query.uri,
            mime_type=file.mime_type,
            blob=base64.b64encode(data[query.offset : end]).decode(),
            next_offset=end if end < len(data) else None,
            size=file.size,
            digest=file.digest,
        )

    def file_bytes(
        self, principal: Principal, uri: str, execution_key: str | None = None
    ) -> tuple[SkillFile, bytes]:
        return self.services.workspace_access.audited(
            principal,
            reads("read_skill_file", "skill"),
            lambda: self._file_bytes(principal, uri, execution_key),
            resource_id=uri,
        )

    def _file_bytes(
        self, principal: Principal, uri: str, execution_key: str | None
    ) -> tuple[SkillFile, bytes]:
        _, _, file = self.resolve(principal, uri, execution_key)
        data = self.source_bytes(principal, file)
        if len(data) != file.size or "sha256:" + hashlib.sha256(data).hexdigest() != file.digest:
            raise NotFoundError("Pinned skill bytes are unavailable. Rediscover available skills.")
        return file, data

    def invoke(
        self, principal: Principal, query: SkillOperation, execution_key: str | None = None
    ) -> dict[str, JsonValue]:
        if isinstance(query, ListSkills):
            result: BaseModel = self.catalog(principal, query, execution_key)
        elif isinstance(query, GetSkill):
            result = self.build(principal, query.skill_id, execution_key)
        else:
            result = self.read(principal, query, execution_key)
        return _JSON.validate_python(result.model_dump(mode="json", by_alias=True))


class NativeListParams(RequestParams):
    cursor: str | None = Field(default=None, max_length=100)


class NativeGetParams(RequestParams):
    uri: str = Field(min_length=1, max_length=2048)


class NativeListResult(CacheableResult):
    result_type: Literal["complete"] = "complete"
    skills: list[SkillEntry]
    next_cursor: str | None = None


class NativeGetResult(CacheableResult):
    result_type: Literal["complete"] = "complete"
    skill: SkillEntry


class SkillsExtension(Extension):
    """SEP-2640 adapter for the pinned SDK, which has no packaged Skills helper."""

    identifier = "io.modelcontextprotocol/skills"

    def __init__(self, exports: SkillExports, authenticate: Callable[[str], Principal]) -> None:
        self.exports, self.authenticate = exports, authenticate

    def methods(self) -> Sequence[MethodBinding]:
        versions = frozenset({"2026-07-28"})
        return (
            MethodBinding("skills/list", NativeListParams, self.list_skills, versions),
            MethodBinding("skills/get", NativeGetParams, self.get_skill, versions),
        )

    def principal(self, ctx: ServerRequestContext[Any, Any]) -> Principal:
        if not isinstance(ctx.request, Request):
            raise MCPError(INVALID_PARAMS, "An authenticated HTTP connection is required")
        return self.authenticate(
            ctx.request.headers.get("authorization", "").partition(" ")[2].strip()
        )

    async def list_skills(
        self, ctx: ServerRequestContext[Any, Any], params: NativeListParams
    ) -> HandlerResult:
        try:
            offset = int(params.cursor) if params.cursor is not None else 0
            result = await asyncio.to_thread(
                self.exports.catalog, self.principal(ctx), ListSkills(offset=offset)
            )
            return NativeListResult(
                skills=result.items,
                next_cursor=str(result.next_offset) if result.next_offset is not None else None,
                _meta={"sangam": {"diagnostics": result.diagnostics}},
            )
        except (SangamError, ValueError) as error:
            raise MCPError(
                INVALID_PARAMS, "Skill catalog unavailable or cursor invalid."
            ) from error

    async def get_skill(
        self, ctx: ServerRequestContext[Any, Any], params: NativeGetParams
    ) -> HandlerResult:
        try:
            entry, _, file = await asyncio.to_thread(
                self.exports.resolve, self.principal(ctx), params.uri
            )
            if file.path != "SKILL.md":
                raise NotFoundError("A skill URI must identify SKILL.md.")
            return NativeGetResult(skill=entry)
        except SangamError as error:
            raise MCPError(
                INVALID_PARAMS, "Skill snapshot unavailable. Rediscover available skills."
            ) from error

    async def __call__(
        self, ctx: ServerRequestContext[Any, Any], call_next: CallNext
    ) -> HandlerResult:
        if (
            ctx.method != "resources/read"
            or not ctx.params
            or not str(ctx.params.get("uri", "")).startswith("skill://")
        ):
            return await call_next(ctx)
        try:
            params = NativeGetParams.model_validate(ctx.params)
            principal = self.principal(ctx)
            file, data = await asyncio.to_thread(self.exports.file_bytes, principal, params.uri)
            content: TextResourceContents | BlobResourceContents
            if file.mime_type.startswith("text/"):
                content = TextResourceContents(
                    uri=params.uri, mime_type=file.mime_type, text=data.decode()
                )
            else:
                content = BlobResourceContents(
                    uri=params.uri, mime_type=file.mime_type, blob=base64.b64encode(data).decode()
                )
            return ReadResourceResult(contents=[content])
        except (SangamError, ValueError) as error:
            raise MCPError(
                INVALID_PARAMS, "Skill file unavailable. Rediscover available skills."
            ) from error
