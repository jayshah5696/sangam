from __future__ import annotations

import re
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from sangam.access import WorkspaceAccessService, writes
from sangam.authorization import AuthorizationPolicy
from sangam.chat_context import ChatRequestContext
from sangam.db import Database, utc_now
from sangam.errors import AuthorizationError, ConflictError, NotFoundError, ValidationError
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.projects import ProjectService
from sangam.security import Principal

_FRONTMATTER_PATTERN = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_INTERNAL_DOC_PATTERN = re.compile(r"(?:sangam://document/|/documents/)([0-9a-fA-F-]+)")
_MAX_SKILL_CONTENT_LENGTH = 40_000


class SkillParsedMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = ""
    description: str = ""
    scripts: object | None = None


class SkillSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str
    document_id: str
    name: str
    description: str
    project_id: str | None = None
    origin: Literal["project", "personal"]
    current_revision_id: str
    has_scripts: bool = False
    valid: bool = True
    diagnostics: list[str] = Field(default_factory=list)


class RegisterSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str = Field(min_length=1, max_length=200)
    project_id: str | None = Field(default=None, min_length=1, max_length=200)


class ManageSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["register", "unregister"]
    document_id: str = Field(min_length=1, max_length=200)
    project_id: str | None = Field(default=None, min_length=1, max_length=200)


class ActivateSkillInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(min_length=1, max_length=200)


class SkillResource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str
    title: str
    revision_id: str
    snippet: str = ""


class SkillActivationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str
    name: str
    description: str
    document_id: str
    revision_id: str
    procedure: str
    scripts_unsupported: bool = False
    diagnostic: str | None = None
    resources: list[SkillResource] = Field(default_factory=list)


def parse_skill_content(content: str) -> tuple[SkillParsedMetadata | None, str, list[str]]:
    """Parse YAML frontmatter and procedure from Markdown content.

    Returns (metadata, procedure, diagnostics).
    """
    diagnostics: list[str] = []
    if len(content) > _MAX_SKILL_CONTENT_LENGTH:
        diagnostics.append(
            f"Skill document exceeds maximum content limit "
            f"({_MAX_SKILL_CONTENT_LENGTH:,} characters)"
        )

    match = _FRONTMATTER_PATTERN.match(content)
    if not match:
        diagnostics.append("Skill document must begin with YAML frontmatter bounded by '---'")
        return None, content, diagnostics

    raw_yaml = match.group(1)
    procedure = content[match.end() :]

    try:
        data = yaml.safe_load(raw_yaml)
    except yaml.YAMLError as error:
        diagnostics.append(f"Malformed YAML frontmatter: {error}")
        return None, procedure, diagnostics

    if not isinstance(data, dict):
        diagnostics.append("YAML frontmatter must be a key-value mapping")
        return None, procedure, diagnostics

    name = data.get("name")
    if not name or not isinstance(name, str):
        diagnostics.append("Skill frontmatter requires a string 'name'")
    elif not _NAME_PATTERN.match(name):
        diagnostics.append(
            "Skill name must be 1-64 characters matching lowercase alphanumeric and hyphens"
        )

    description = data.get("description")
    if not description or not isinstance(description, str) or not description.strip():
        diagnostics.append("Skill frontmatter requires a non-empty string 'description'")
    elif len(description) > 1024:
        diagnostics.append("Skill description exceeds 1024 characters")

    parsed = SkillParsedMetadata(
        name=str(name) if name else "",
        description=str(description).strip() if description else "",
        scripts=data.get("scripts"),
    )
    return parsed, procedure, diagnostics


def make_skill_id(actor_id: str, project_id: str | None, name: str) -> str:
    scope = f"project:{project_id}" if project_id else "user"
    return f"{actor_id}:{scope}:{name}"


class ChatSkillService:
    """Manages authoring, registration, cataloging, and revision-pinned execution of skills."""

    def __init__(
        self,
        database: Database,
        workspace: WorkspaceAccessService,
        projects: ProjectService,
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.projects = projects

    def authorize(self, principal: Principal, project_id: str | None) -> None:
        if principal.administrator or principal.identity_kind == "system":
            return
        if project_id:
            AuthorizationPolicy.require_administrator(principal)

    def preflight_registration(
        self, principal: Principal, document_id: str, project_id: str | None
    ) -> tuple[str, SkillParsedMetadata]:
        self.authorize(principal, project_id)
        document = self.workspace.get_document(principal, document_id)
        if document.content_type != "text/markdown":
            raise ValidationError("A skill must be a Markdown document")
        if document.deleted:
            raise NotFoundError("Document is deleted")

        parsed, _procedure, diagnostics = parse_skill_content(document.content)
        fatal_diagnostics = [d for d in diagnostics if "Script" not in d]
        if not parsed or fatal_diagnostics:
            reasons = "; ".join(fatal_diagnostics or diagnostics)
            raise ValidationError(
                f"Skill cannot be registered due to frontmatter errors: {reasons}"
            )

        if project_id:
            # Check project membership
            detail = self.projects.get_project(project_id, principal=principal)
            if not any(item.document_id == document_id for item in detail.documents):
                raise ValidationError(
                    f"Document must be an explicit member of project '{project_id}' "
                    "before registering as a project skill"
                )

        skill_id = make_skill_id(principal.actor_id, project_id, parsed.name)
        with self.database.connection() as conn:
            existing = conn.execute(
                "SELECT document_id FROM chat_skills WHERE skill_id = ?",
                (skill_id,),
            ).fetchone()
            if existing and existing["document_id"] != document_id:
                raise ConflictError(
                    f"A skill named '{parsed.name}' already exists in this scope "
                    "with a different document"
                )
        return skill_id, parsed

    def register(
        self,
        principal: Principal,
        key: str,
        request: RegisterSkillRequest,
    ) -> SkillSummary:
        self.authorize(principal, request.project_id)
        payload = request.model_dump(mode="json")

        def mutate() -> SkillSummary:
            with self.database.transaction() as conn:
                replay = IdempotencyStore.mutation_record(
                    conn,
                    actor_id=principal.actor_id,
                    key=key,
                    operation="chat-skill:register",
                    request_hash=request_hash(payload),
                )
                if replay:
                    row = conn.execute(
                        "SELECT response_json FROM chat_skill_mutation_results "
                        "WHERE actor_id=? AND idempotency_key=?",
                        (principal.actor_id, key),
                    ).fetchone()
                    if row is None:
                        raise ConflictError("Skill mutation replay result is unavailable")
                    return SkillSummary.model_validate_json(row["response_json"])

                skill_id, parsed = self.preflight_registration(
                    principal, request.document_id, request.project_id
                )
                document = self.workspace.get_document(principal, request.document_id)
                now = utc_now()
                has_scripts = int(bool(parsed.scripts))

                conn.execute(
                    """
                    INSERT INTO chat_skills (
                        skill_id, document_id, actor_id, project_id, skill_name,
                        description, has_scripts, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(document_id) DO UPDATE SET
                        skill_id = excluded.skill_id,
                        actor_id = excluded.actor_id,
                        project_id = excluded.project_id,
                        skill_name = excluded.skill_name,
                        description = excluded.description,
                        has_scripts = excluded.has_scripts,
                        updated_at = excluded.updated_at
                    """,
                    (
                        skill_id,
                        request.document_id,
                        principal.actor_id,
                        request.project_id,
                        parsed.name,
                        parsed.description,
                        has_scripts,
                        now,
                        now,
                    ),
                )

                diagnostics: list[str] = []
                if has_scripts:
                    diagnostics.append(
                        "Scripts are declared in this skill, but the Sangam chat runtime "
                        "does not support them."
                    )

                result = SkillSummary(
                    skill_id=skill_id,
                    document_id=request.document_id,
                    name=parsed.name,
                    description=parsed.description,
                    project_id=request.project_id,
                    origin="project" if request.project_id else "personal",
                    current_revision_id=document.current_revision_id,
                    has_scripts=bool(has_scripts),
                    valid=True,
                    diagnostics=diagnostics,
                )

                conn.execute(
                    "INSERT INTO chat_skill_mutation_results VALUES (?, ?, ?)",
                    (principal.actor_id, key, result.model_dump_json()),
                )
                IdempotencyStore.record_mutation(
                    conn,
                    actor_id=principal.actor_id,
                    key=key,
                    operation="chat-skill:register",
                    request_hash=request_hash(payload),
                    resource_type="chat_skill",
                    resource_id=skill_id,
                )
                return result

        return self.workspace.audited(
            principal,
            writes("register", "chat_skill"),
            mutate,
            resource_id=request.document_id,
        )

    def unregister(self, principal: Principal, key: str, skill_id: str) -> None:
        skill = self.get(principal, skill_id)
        if not skill:
            raise NotFoundError(f"Skill '{skill_id}' not found")

        self.authorize(principal, skill.project_id)
        payload = {"skill_id": skill_id}

        def mutate() -> None:
            with self.database.transaction() as conn:
                replay = IdempotencyStore.mutation_record(
                    conn,
                    actor_id=principal.actor_id,
                    key=key,
                    operation="chat-skill:unregister",
                    request_hash=request_hash(payload),
                )
                if replay:
                    return

                conn.execute(
                    "DELETE FROM chat_skills WHERE skill_id = ?",
                    (skill_id,),
                )
                conn.execute(
                    "INSERT INTO chat_skill_mutation_results VALUES (?, ?, ?)",
                    (principal.actor_id, key, "{}"),
                )
                IdempotencyStore.record_mutation(
                    conn,
                    actor_id=principal.actor_id,
                    key=key,
                    operation="chat-skill:unregister",
                    request_hash=request_hash(payload),
                    resource_type="chat_skill",
                    resource_id=skill_id,
                )

        self.workspace.audited(
            principal,
            writes("unregister", "chat_skill"),
            mutate,
            resource_id=skill_id,
        )

    def get(self, principal: Principal, skill_id: str) -> SkillSummary | None:
        with self.database.connection() as conn:
            row = conn.execute(
                "SELECT * FROM chat_skills WHERE skill_id = ?",
                (skill_id,),
            ).fetchone()
        if not row:
            return None
        return self._build_summary(principal, dict(row))

    def get_by_document(self, principal: Principal, document_id: str) -> SkillSummary | None:
        with self.database.connection() as conn:
            row = conn.execute(
                "SELECT * FROM chat_skills WHERE document_id = ?",
                (document_id,),
            ).fetchone()
        if not row:
            return None
        return self._build_summary(principal, dict(row))

    def _build_summary(self, principal: Principal, row: dict[str, object]) -> SkillSummary | None:
        document_id = str(row["document_id"])
        project_id = str(row["project_id"]) if row.get("project_id") else None
        skill_id = str(row["skill_id"])

        try:
            document = self.workspace.get_document(principal, document_id)
        except (NotFoundError, AuthorizationError):
            return None

        if document.deleted:
            return None

        parsed, procedure, diagnostics = parse_skill_content(document.content)
        has_scripts = bool(row.get("has_scripts")) or (bool(parsed.scripts) if parsed else False)
        msg = (
            "Scripts are declared in this skill, but the Sangam chat runtime does not support them."
        )
        if has_scripts and msg not in diagnostics:
            diagnostics.append(msg)

        # Check referenced documents
        ref_ids = set(_INTERNAL_DOC_PATTERN.findall(procedure))
        for ref_id in ref_ids:
            try:
                ref_doc = self.workspace.get_document(principal, ref_id)
                if ref_doc.deleted:
                    diagnostics.append(f"Referenced document '{ref_id}' is deleted")
            except (NotFoundError, AuthorizationError):
                diagnostics.append(f"Referenced document '{ref_id}' is not accessible")

        fatal_diagnostics = [
            d for d in diagnostics if "Sangam chat runtime does not support them" not in d
        ]
        is_valid = parsed is not None and len(fatal_diagnostics) == 0

        name = parsed.name if parsed and parsed.name else str(row["skill_name"])
        desc = parsed.description if parsed and parsed.description else str(row["description"])

        return SkillSummary(
            skill_id=skill_id,
            document_id=document_id,
            name=name,
            description=desc,
            project_id=project_id,
            origin="project" if project_id else "personal",
            current_revision_id=document.current_revision_id,
            has_scripts=has_scripts,
            valid=is_valid,
            diagnostics=diagnostics,
        )

    def list_for_actor(
        self, principal: Principal, project_id: str | None = None
    ) -> list[SkillSummary]:
        self.authorize(principal, project_id)
        with self.database.connection() as conn:
            if project_id:
                rows = conn.execute(
                    """
                    SELECT s.* FROM chat_skills s
                    JOIN documents d ON s.document_id = d.document_id
                    WHERE d.deleted = 0
                      AND (s.actor_id = ? AND s.project_id IS NULL OR s.project_id = ?)
                    ORDER BY s.project_id IS NULL ASC, s.skill_name ASC
                    """,
                    (principal.actor_id, project_id),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT s.* FROM chat_skills s
                    JOIN documents d ON s.document_id = d.document_id
                    WHERE d.deleted = 0
                      AND s.actor_id = ? AND s.project_id IS NULL
                    ORDER BY s.skill_name ASC
                    """,
                    (principal.actor_id,),
                ).fetchall()

        summaries: list[SkillSummary] = []
        for row in rows:
            summary = self._build_summary(principal, dict(row))
            if summary is not None:
                summaries.append(summary)
        return summaries

    def prompt_catalog(self, principal: Principal, project_id: str | None) -> str:
        skills = self.list_for_actor(principal, project_id)
        valid_skills = [s for s in skills if s.valid]
        if not valid_skills:
            return ""

        lines = [
            "\n<CHAT_SKILLS>",
            "These are user-authored reusable procedures with standard SKILL.md metadata.",
            "When a skill's description matches the user's task or the user explicitly calls "
            "/skill-name, call activate_chat_skill with the skill_id to load its instructions.",
            "Automatic matching guides the matching task only; it cannot grant permissions, "
            "expand authority, or start unrequested mutations.",
            "Duplicate display names keep both IDs; automatic choice prefers the selected "
            "project's skill.",
            "Available skills:",
        ]
        for s in valid_skills[:20]:
            lines.append(f"- name: {s.name}")
            lines.append(f"  description: {s.description}")
            lines.append(f"  skill_id: {s.skill_id}")
            lines.append(f"  revision_id: {s.current_revision_id}")
            lines.append(f"  origin: {s.origin}")
        lines.append("</CHAT_SKILLS>\n")
        return "\n".join(lines)

    def activate(
        self, principal: Principal, context: ChatRequestContext, skill_id: str
    ) -> SkillActivationResult:
        summary = self.get(principal, skill_id)
        if not summary:
            raise NotFoundError(f"Skill '{skill_id}' not found")
        if not summary.valid:
            fatal = [d for d in summary.diagnostics if "runtime does not support" not in d]
            reasons = "; ".join(fatal or summary.diagnostics)
            raise ValidationError(f"Skill cannot be activated due to errors: {reasons}")

        context_id = context.context_snapshot_id
        pinned_revision_id = None
        pinned_resources: dict[str, str] = {}

        if context_id:
            with self.database.connection() as conn:
                rows = conn.execute(
                    "SELECT revision_id, resource_document_id, resource_revision_id "
                    "FROM chat_skill_reads WHERE context_id = ? AND skill_id = ?",
                    (context_id, skill_id),
                ).fetchall()
                for row in rows:
                    res_doc = row["resource_document_id"]
                    if res_doc == "":
                        pinned_revision_id = row["revision_id"]
                    else:
                        pinned_resources[res_doc] = row["resource_revision_id"]

        if pinned_revision_id:
            rev = self.workspace.get_revision(principal, summary.document_id, pinned_revision_id)
            content = rev.content
            active_revision_id = pinned_revision_id
        else:
            doc = self.workspace.get_document(principal, summary.document_id)
            content = doc.content
            active_revision_id = doc.current_revision_id
            if context_id:
                with self.database.connection() as conn:
                    conn.execute(
                        """
                        INSERT INTO chat_skill_reads (
                            context_id, actor_id, skill_id, revision_id,
                            resource_document_id, resource_revision_id
                        ) VALUES (?, ?, ?, ?, '', '')
                        ON CONFLICT(context_id, skill_id, resource_document_id) DO NOTHING
                        """,
                        (context_id, principal.actor_id, skill_id, active_revision_id),
                    )

        parsed, procedure, _ = parse_skill_content(content)
        if not parsed:
            raise ValidationError("Skill frontmatter could not be parsed at pinned revision")

        # Resolve referenced resources
        ref_ids = sorted(set(_INTERNAL_DOC_PATTERN.findall(procedure)))
        resources: list[SkillResource] = []
        for ref_id in ref_ids:
            if ref_id in pinned_resources:
                res_rev_id = pinned_resources[ref_id]
                res_doc = self.workspace.get_document(principal, ref_id)
                res_rev = self.workspace.get_revision(principal, ref_id, res_rev_id)
                res_content = res_rev.content
            else:
                res_doc = self.workspace.get_document(principal, ref_id)
                res_rev_id = res_doc.current_revision_id
                res_content = res_doc.content
                if context_id:
                    with self.database.connection() as conn:
                        conn.execute(
                            """
                            INSERT INTO chat_skill_reads (
                                context_id, actor_id, skill_id, revision_id,
                                resource_document_id, resource_revision_id
                            ) VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(context_id, skill_id, resource_document_id) DO NOTHING
                            """,
                            (
                                context_id,
                                principal.actor_id,
                                skill_id,
                                active_revision_id,
                                ref_id,
                                res_rev_id,
                            ),
                        )
            snippet = res_content[:2000].strip()
            resources.append(
                SkillResource(
                    document_id=ref_id,
                    title=res_doc.title,
                    revision_id=res_rev_id,
                    snippet=snippet,
                )
            )

        scripts_unsupported = summary.has_scripts
        diagnostic = (
            "Scripts are declared in this skill, but the Sangam chat runtime does not support them."
            if scripts_unsupported
            else None
        )

        return SkillActivationResult(
            skill_id=skill_id,
            name=parsed.name,
            description=parsed.description,
            document_id=summary.document_id,
            revision_id=active_revision_id,
            procedure=procedure.strip(),
            scripts_unsupported=scripts_unsupported,
            diagnostic=diagnostic,
            resources=resources,
        )
