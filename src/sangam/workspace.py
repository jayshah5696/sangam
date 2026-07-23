from __future__ import annotations

import hashlib
import mimetypes
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path, PurePosixPath
from typing import Protocol

from sangam.errors import InvalidPathError


def canonicalize_document_path(raw_path: str) -> str:
    """Validate document-path syntax without consulting the filesystem."""
    normalized = _canonicalize_relative_path(raw_path, kind="Document")
    if PurePosixPath(normalized).suffix.lower() not in {".md", ".html", ".htm", ".pdf"}:
        raise InvalidPathError("Sangam document paths must end in .md, .html, .htm, or .pdf")
    return normalized


def _canonicalize_relative_path(
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
    return path.as_posix()


class WorkspaceFilesystem(Protocol):
    def normalize_document_path(self, raw_path: str) -> str: ...

    def normalize_folder_path(self, raw_path: str) -> str: ...

    def write_atomic(self, path: str, content: str) -> str: ...

    def write_atomic_bytes(self, path: str, content: bytes, *, overwrite: bool = False) -> str: ...

    def delete_document(self, path: str) -> None: ...

    def scan_documents(self) -> dict[str, str]: ...

    def is_document_file(self, path: str) -> bool: ...

    def read_document(self, path: str) -> str: ...

    def read_binary(self, path: str) -> bytes: ...

    def binary_size(self, path: str) -> int: ...

    def binary_hash(self, path: str) -> str: ...

    def iter_binary(
        self, path: str, *, start: int = 0, end: int | None = None, chunk_size: int = 1024 * 1024
    ) -> Iterator[bytes]: ...

    def title_from_path(self, path: str) -> str: ...

    def create_folder(self, path: str) -> None: ...

    def read_asset(self, path: str, *, max_bytes: int) -> tuple[bytes, str]: ...


class DiskWorkspaceFilesystem:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def normalize_document_path(self, raw_path: str) -> str:
        normalized = canonicalize_document_path(raw_path)
        self._require_inside_workspace(normalized, noun="Path")
        return normalized

    def normalize_folder_path(self, raw_path: str) -> str:
        normalized = _canonicalize_relative_path(raw_path, kind="Folder", strip_outer_slashes=True)
        self._require_inside_workspace(normalized, noun="Folder path")
        return normalized

    def _require_inside_workspace(self, normalized: str, *, noun: str) -> None:
        root = self.root.resolve()
        candidate = (root / normalized).resolve(strict=False)
        if not candidate.is_relative_to(root):
            raise InvalidPathError(f"{noun} escapes the configured workspace root")

    def _document_path(self, path: str) -> Path:
        normalized = self.normalize_document_path(path)
        return self.root.resolve() / normalized

    def _folder_path(self, path: str) -> Path:
        normalized = self.normalize_folder_path(path)
        return self.root.resolve() / normalized

    def write_atomic(self, path: str, content: str) -> str:
        return self.write_atomic_bytes(path, content.encode("utf-8"), overwrite=True)

    def write_atomic_bytes(self, path: str, content: bytes, *, overwrite: bool = False) -> str:
        destination = self._document_path(path)
        if destination.exists() and not overwrite:
            raise InvalidPathError("A workspace file already exists at that path")
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.sangam-", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            self._fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)
        actual_hash = hashlib.sha256(destination.read_bytes()).hexdigest()
        expected_hash = hashlib.sha256(content).hexdigest()
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
            if file_path.suffix.lower() not in {".md", ".html", ".htm", ".pdf"}:
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

    def read_binary(self, path: str) -> bytes:
        return self._document_path(path).read_bytes()

    def binary_size(self, path: str) -> int:
        return self._document_path(path).stat().st_size

    def binary_hash(self, path: str) -> str:
        digest = hashlib.sha256()
        with self._document_path(path).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def iter_binary(
        self, path: str, *, start: int = 0, end: int | None = None, chunk_size: int = 1024 * 1024
    ) -> Iterator[bytes]:
        document = self._document_path(path)
        remaining = None if end is None else end - start + 1
        with document.open("rb") as handle:
            handle.seek(start)
            while remaining is None or remaining > 0:
                size = chunk_size if remaining is None else min(chunk_size, remaining)
                chunk = handle.read(size)
                if not chunk:
                    break
                yield chunk
                if remaining is not None:
                    remaining -= len(chunk)

    def title_from_path(self, path: str) -> str:
        document = self._document_path(path)
        return document.stem.replace("-", " ").strip().title() or document.name

    def create_folder(self, path: str) -> None:
        self._folder_path(path).mkdir(parents=True, exist_ok=True)

    def read_asset(self, path: str, *, max_bytes: int) -> tuple[bytes, str]:
        normalized = _canonicalize_relative_path(path, kind="Asset")
        self._require_inside_workspace(normalized, noun="Asset path")
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
