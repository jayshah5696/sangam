from __future__ import annotations

import hashlib
import mimetypes
import os
import tempfile
from pathlib import Path, PurePosixPath
from typing import Protocol

from sangam.errors import InvalidPathError


class WorkspaceFilesystem(Protocol):
    def normalize_document_path(self, raw_path: str) -> str: ...

    def normalize_folder_path(self, raw_path: str) -> str: ...

    def write_atomic(self, path: str, content: str) -> str: ...

    def delete_document(self, path: str) -> None: ...

    def scan_documents(self) -> dict[str, str]: ...

    def is_document_file(self, path: str) -> bool: ...

    def read_document(self, path: str) -> str: ...

    def title_from_path(self, path: str) -> str: ...

    def create_folder(self, path: str) -> None: ...

    def read_asset(self, path: str, *, max_bytes: int) -> tuple[bytes, str]: ...


class DiskWorkspaceFilesystem:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def normalize_document_path(self, raw_path: str) -> str:
        normalized = self._normalize_relative_path(raw_path, kind="Document")
        if PurePosixPath(normalized).suffix.lower() not in {".md", ".html", ".htm"}:
            raise InvalidPathError("Sangam document paths must end in .md, .html, or .htm")
        return normalized

    def normalize_folder_path(self, raw_path: str) -> str:
        return self._normalize_relative_path(raw_path, kind="Folder", strip_outer_slashes=True)

    def _normalize_relative_path(
        self,
        raw_path: str,
        *,
        kind: str,
        strip_outer_slashes: bool = False,
    ) -> str:
        if "\\" in raw_path:
            raise InvalidPathError(f"{kind} paths must use forward slashes")
        if kind == "Folder" and raw_path.strip().startswith("/"):
            raise InvalidPathError("Folder path must stay inside the workspace")
        stripped_path = raw_path.strip()
        if strip_outer_slashes:
            stripped_path = stripped_path.strip("/")
        raw_parts = stripped_path.split("/")
        path = PurePosixPath(stripped_path)
        if (
            not stripped_path
            or path.is_absolute()
            or any(part in {"", ".", ".."} for part in raw_parts)
        ):
            message = (
                "Path must be a relative path inside the workspace"
                if kind == "Document"
                else "Folder path must stay inside the workspace"
            )
            raise InvalidPathError(message)
        normalized = path.as_posix()
        root = self.root.resolve()
        candidate = (root / normalized).resolve(strict=False)
        if not candidate.is_relative_to(root):
            noun = "Path" if kind == "Document" else "Folder path"
            raise InvalidPathError(f"{noun} escapes the configured workspace root")
        return normalized

    def _document_path(self, path: str) -> Path:
        normalized = self.normalize_document_path(path)
        return self.root.resolve() / normalized

    def _folder_path(self, path: str) -> Path:
        normalized = self.normalize_folder_path(path)
        return self.root.resolve() / normalized

    def write_atomic(self, path: str, content: str) -> str:
        destination = self._document_path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.sangam-", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content.encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            self._fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)
        actual_hash = hashlib.sha256(destination.read_bytes()).hexdigest()
        expected_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if actual_hash != expected_hash:
            raise OSError("Materialized file hash does not match the committed revision")
        return actual_hash

    def delete_document(self, path: str) -> None:
        document = self._document_path(path)
        if document.exists():
            document.unlink()
            self._fsync_directory(document.parent)

    def scan_documents(self) -> dict[str, str]:
        files: dict[str, str] = {}
        root = self.root.resolve()
        for file_path in root.rglob("*"):
            if file_path.suffix.lower() not in {".md", ".html", ".htm"}:
                continue
            if file_path.is_file() and ".sangam-" not in file_path.name:
                relative = file_path.relative_to(root).as_posix()
                files[relative] = hashlib.sha256(file_path.read_bytes()).hexdigest()
        return files

    def scan_markdown(self) -> dict[str, str]:
        """Compatibility alias for older clients; Phase 4 scans every text document."""
        return self.scan_documents()

    def is_document_file(self, path: str) -> bool:
        return self._document_path(path).is_file()

    def read_document(self, path: str) -> str:
        return self._document_path(path).read_text(encoding="utf-8")

    def title_from_path(self, path: str) -> str:
        document = self._document_path(path)
        return document.stem.replace("-", " ").strip().title() or document.name

    def create_folder(self, path: str) -> None:
        self._folder_path(path).mkdir(parents=True, exist_ok=True)

    def read_asset(self, path: str, *, max_bytes: int) -> tuple[bytes, str]:
        normalized = self._normalize_relative_path(path, kind="Asset")
        candidate = self.root.resolve() / normalized
        if not candidate.is_file():
            raise InvalidPathError("Publication asset was not found")
        size = candidate.stat().st_size
        if size > max_bytes:
            raise InvalidPathError("Publication asset exceeds the configured size limit")
        media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        return candidate.read_bytes(), media_type

    @staticmethod
    def _fsync_directory(directory: Path) -> None:
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
