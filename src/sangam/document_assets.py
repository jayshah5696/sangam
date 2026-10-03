"""Images stored once for the whole workspace and referenced from the workspace root.

An uploaded image is written to `attachments/<name>-<sha16>.<ext>` and referenced
as `/attachments/<name>-<sha16>.<ext>`. The reference never depends on where
the document lives, so moving a document or renaming its folder cannot break
it, and drafts without a location can hold images too. Root-relative links
render in GitHub, VS Code, and static-site tools that open the workspace folder
as their root. Names are content addressed, which makes repeated uploads harmless.

Relative references (`diagram.png` beside a document) are still resolved for
hand-written Markdown, but Sangam never creates them.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from sangam.errors import NotFoundError, ValidationError, validate_metadata_text
from sangam.schemas import Document, DocumentAsset
from sangam.workspace import WorkspaceFilesystem

ATTACHMENTS_FOLDER = "attachments"

# SVG is excluded on purpose: it is a script-capable document, not a picture.
_SIGNATURES: dict[str, tuple[str, tuple[bytes, ...]]] = {
    "image/png": (".png", (b"\x89PNG\r\n\x1a\n",)),
    "image/jpeg": (".jpg", (b"\xff\xd8\xff",)),
    "image/gif": (".gif", (b"GIF87a", b"GIF89a")),
    "image/webp": (".webp", (b"RIFF",)),
}

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp"})


@dataclass(frozen=True)
class StoredAsset:
    content: bytes
    media_type: str


def resolve_asset_reference(document_path: str | None, reference: str) -> str:
    """Resolve an image reference to a workspace path.

    `/attachments/<file>` resolves to the shared attachments folder; a relative
    reference resolves inside the document's own folder. Anything else, including
    other root paths, schemes, and `..` escapes, raises NotFoundError so callers
    cannot tell a forbidden path from a missing one.
    """
    parsed = urlsplit(unquote(reference))
    if parsed.scheme or parsed.netloc:
        raise NotFoundError("Document asset not found")
    if parsed.path.startswith("/"):
        parts = parsed.path.split("/")
        if (
            len(parts) != 3
            or parts[1] != ATTACHMENTS_FOLDER
            or parts[2] in {"", ".", ".."}
            or parts[2].startswith(".")
        ):
            raise NotFoundError("Document asset not found")
        return f"{ATTACHMENTS_FOLDER}/{parts[2]}"
    if document_path is None:
        raise NotFoundError("Document asset not found")
    document_parent = PurePosixPath(document_path).parent
    parent_parts = [part for part in document_parent.parts if part not in {"", "."}]
    normalized_parts: list[str] = []
    for part in PurePosixPath(document_parent, parsed.path).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not normalized_parts:
                raise NotFoundError("Document asset not found")
            normalized_parts.pop()
        else:
            normalized_parts.append(part)
    if (
        len(normalized_parts) <= len(parent_parts)
        or normalized_parts[: len(parent_parts)] != parent_parts
    ):
        raise NotFoundError("Document asset not found")
    return "/".join(normalized_parts)


def _matches_signature(media_type: str, content: bytes) -> bool:
    signatures = _SIGNATURES[media_type][1]
    if not any(content.startswith(signature) for signature in signatures):
        return False
    return media_type != "image/webp" or content[8:12] == b"WEBP"


def _stem(filename: str) -> str:
    raw = PurePosixPath(filename.replace("\\", "/")).stem
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    return slug[:60].strip("-") or "image"


def _alt_text(filename: str) -> str:
    raw = PurePosixPath(filename.replace("\\", "/")).stem
    return re.sub(r"[\[\]\r\n]+", " ", raw).strip() or "Image"


class DocumentAssetService:
    def __init__(self, *, workspace: WorkspaceFilesystem, max_bytes: int) -> None:
        self.workspace = workspace
        self.max_bytes = max_bytes

    def store(
        self, *, document: Document, filename: str, media_type: str, content: bytes
    ) -> DocumentAsset:
        validate_metadata_text(filename, "Image filename")
        if document.content_type == "application/pdf":
            raise ValidationError("Images can be added to Markdown and HTML documents only")
        if media_type not in _SIGNATURES:
            raise ValidationError("Images must be PNG, JPEG, GIF, or WebP")
        if len(content) > self.max_bytes:
            raise ValidationError(
                "Image exceeds the configured size limit", details={"max_bytes": self.max_bytes}
            )
        if not _matches_signature(media_type, content):
            raise ValidationError("The uploaded bytes are not a valid image of the declared type")
        extension = _SIGNATURES[media_type][0]
        # 16 hex digits keep names unguessable without the image itself.
        digest = hashlib.sha256(content).hexdigest()[:16]
        name = f"{_stem(filename)}-{digest}{extension}"
        self.workspace.write_asset(f"{ATTACHMENTS_FOLDER}/{name}", content)
        reference = f"/{ATTACHMENTS_FOLDER}/{name}"
        return DocumentAsset(
            reference=reference,
            markdown=f"![{_alt_text(filename)}]({reference})",
            media_type=media_type,
            size_bytes=len(content),
        )

    def read(self, *, document: Document, reference: str) -> StoredAsset:
        """Serve images only; sibling documents stay behind their own read checks."""
        workspace_path = resolve_asset_reference(document.path, reference)
        if PurePosixPath(workspace_path).suffix.lower() not in IMAGE_EXTENSIONS:
            raise NotFoundError("Document asset not found")
        try:
            content, media_type = self.workspace.read_asset(
                workspace_path, max_bytes=self.max_bytes
            )
        except Exception as error:
            raise NotFoundError("Document asset not found") from error
        return StoredAsset(content=content, media_type=media_type)
