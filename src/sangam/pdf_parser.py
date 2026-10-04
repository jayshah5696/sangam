"""Extract bounded page text in a disposable process, isolated from API workers."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from pypdf import PdfReader


def main() -> None:
    source, output, raw_pages, raw_bytes = sys.argv[1:]
    max_pages, max_bytes = int(raw_pages), int(raw_bytes)
    output_path = Path(output)
    with Path(source).open("rb") as content:
        reader = PdfReader(content, strict=False)
        if len(reader.pages) > max_pages:
            raise ValueError("PDF exceeds the extraction page limit")
        pages: list[str] = []
        total = 0
        for page in reader.pages:
            text = page.extract_text() or ""
            total += len(text.encode("utf-8"))
            if total > max_bytes:
                raise ValueError("PDF exceeds the extracted text byte limit")
            pages.append(text)

    output_bytes = json.dumps(pages, ensure_ascii=False).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.sangam-", dir=output_path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(output_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
