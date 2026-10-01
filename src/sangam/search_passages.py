"""Locate the passages behind a full-text search hit.

The FTS index stores one row per document, so it can say *that* a document
matched but not *where*. After FTS has chosen and ranked the documents, this
module rescans only those documents' sources (current text, PDF pages and
annotations) with the same prefix semantics and returns a few passages with
exact locations. Matching here is a presentation concern; FTS stays the
authority on which documents match.
"""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from sangam.schemas import DocumentSummary, SearchMatch

WINDOW = 160
CONTEXT_BEFORE = 60
MAX_MATCHES = 3
# Enough to find the densest window; repetitive documents stop scanning early.
MAX_HITS_PER_SOURCE = 200
MAX_CANDIDATE_PAGES = 50
_HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^ {0,3}(```|~~~)")
_HTML_HIDDEN = re.compile(r"<(script|style)\b.*?</\1\s*>|<[^>]*>", re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True)
class _Hit:
    start: int
    end: int
    term: int


@dataclass(frozen=True)
class _Passage:
    distinct_terms: int
    anchor: _Hit
    snippet: str


@dataclass(frozen=True)
class Term:
    pattern: re.Pattern[str]
    # First literal part, used to prefilter PDF pages in SQL.
    prefix: str


def query_terms(query: str) -> list[Term]:
    """Mirror `SearchIndex.compile_expression`: every term is a word-start prefix."""
    terms: list[Term] = []
    for raw in re.findall(r"[\w-]+", query, flags=re.UNICODE):
        parts = [part for part in re.split(r"[-_]", raw) if part]
        if not parts:
            continue
        body = r"[\W_]+".join(re.escape(part) for part in parts)
        pattern = re.compile(rf"(?<![^\W_]){body}[^\W_]*", re.IGNORECASE)
        terms.append(Term(pattern=pattern, prefix=parts[0].lower()))
    return terms


def _hits(text: str, terms: Sequence[Term]) -> list[_Hit]:
    hits: list[_Hit] = []
    for index, term in enumerate(terms):
        for count, match in enumerate(term.pattern.finditer(text)):
            if count >= MAX_HITS_PER_SOURCE:
                break
            hits.append(_Hit(match.start(), match.end(), index))
    hits.sort(key=lambda hit: (hit.start, hit.term))
    return hits


def _snippet(text: str, hits: Sequence[_Hit], anchor: _Hit) -> str:
    # Stay inside the passage's paragraph; its heading is reported separately.
    paragraph_start = text.rfind("\n\n", 0, anchor.start)
    paragraph_start = 0 if paragraph_start < 0 else paragraph_start + 2
    paragraph_end = text.find("\n\n", anchor.end)
    paragraph_end = len(text) if paragraph_end < 0 else paragraph_end
    start = max(paragraph_start, anchor.start - CONTEXT_BEFORE)
    end = min(paragraph_end, anchor.start + WINDOW)
    if start > paragraph_start:
        boundary = text.find(" ", start, anchor.start)
        start = boundary + 1 if boundary >= 0 else start
    if end < paragraph_end:
        boundary = text.rfind(" ", anchor.end, end)
        end = boundary if boundary >= 0 else end
    pieces: list[str] = []
    cursor = start
    for hit in hits:
        if hit.start < cursor or hit.end > end:
            continue
        pieces.append(_plain(text[cursor : hit.start]))
        pieces.append(f"[[{_plain(text[hit.start : hit.end])}]]")
        cursor = hit.end
    pieces.append(_plain(text[cursor:end]))
    body = re.sub(r"\s+", " ", "".join(pieces)).strip()
    return f"{'… ' if start > paragraph_start else ''}{body}{' …' if end < paragraph_end else ''}"


def _plain(value: str) -> str:
    # Literal brackets would be read as highlight markers by clients.
    return value.replace("[[", "[ [").replace("]]", "] ]")


def best_passages(text: str, terms: Sequence[Term], *, limit: int) -> list[_Passage]:
    """Pick non-overlapping windows that cover the most distinct query terms."""
    hits = _hits(text, terms)
    if not hits:
        return []
    scored: list[tuple[int, int]] = []
    right = 0
    counts: dict[int, int] = {}
    for left, anchor in enumerate(hits):
        while right < len(hits) and hits[right].start < anchor.start + WINDOW:
            counts[hits[right].term] = counts.get(hits[right].term, 0) + 1
            right += 1
        scored.append((len(counts), left))
        counts[anchor.term] -= 1
        if counts[anchor.term] == 0:
            del counts[anchor.term]
    scored.sort(key=lambda item: (-item[0], hits[item[1]].start))
    chosen: list[_Passage] = []
    for distinct, index in scored:
        anchor = hits[index]
        if any(abs(anchor.start - passage.anchor.start) < WINDOW for passage in chosen):
            continue
        chosen.append(_Passage(distinct, anchor, _snippet(text, hits, anchor)))
        if len(chosen) == limit:
            break
    return chosen


def _visible_html(content: str) -> str:
    """Blank out markup while keeping every offset and line break in place."""
    return _HTML_HIDDEN.sub(lambda match: re.sub(r"[^\n]", " ", match.group()), content)


def _heading_before(content: str, offset: int) -> str | None:
    heading: str | None = None
    position = 0
    fenced = False
    for line in content.splitlines(keepends=True):
        if position > offset:
            break
        if _FENCE.match(line):
            fenced = not fenced
        elif not fenced and (match := _HEADING.match(line.rstrip("\n"))):
            heading = match.group(2)
        position += len(line)
    return heading


def _content_matches(
    content: str, content_type: str, terms: Sequence[Term]
) -> list[tuple[int, SearchMatch]]:
    searchable = _visible_html(content) if content_type == "text/html" else content
    matches: list[tuple[int, SearchMatch]] = []
    for passage in best_passages(searchable, terms, limit=MAX_MATCHES):
        anchor = passage.anchor
        matches.append(
            (
                passage.distinct_terms,
                SearchMatch(
                    source="content",
                    snippet=passage.snippet,
                    exact=content[anchor.start : anchor.end],
                    line=content.count("\n", 0, anchor.start) + 1,
                    heading=(
                        _heading_before(content, anchor.start)
                        if content_type == "text/markdown"
                        else None
                    ),
                ),
            )
        )
    return matches


def _pdf_matches(
    connection: sqlite3.Connection, document_id: str, terms: Sequence[Term]
) -> list[tuple[int, SearchMatch]]:
    # SQLite's lower() folds ASCII only, so this is a prefilter; the regex decides.
    clauses = " OR ".join("instr(lower(text), ?) > 0" for _term in terms)
    page_rows = connection.execute(
        f"SELECT page_number, text FROM pdf_pages WHERE document_id = ? AND ({clauses})"
        " ORDER BY page_number LIMIT ?",
        (document_id, *[term.prefix for term in terms], MAX_CANDIDATE_PAGES),
    ).fetchall()
    matches: list[tuple[int, SearchMatch]] = []
    for row in page_rows:
        for passage in best_passages(row["text"], terms, limit=1):
            matches.append(
                (
                    passage.distinct_terms,
                    SearchMatch(
                        source="pdf_page",
                        snippet=passage.snippet,
                        exact=row["text"][passage.anchor.start : passage.anchor.end],
                        page_number=row["page_number"],
                    ),
                )
            )
    annotation_rows = connection.execute(
        """
        SELECT annotation_id, page_number, selected_text, note FROM annotations
        WHERE document_id = ? AND deleted = 0 ORDER BY page_number, created_at
        """,
        (document_id,),
    ).fetchall()
    for row in annotation_rows:
        text = " — ".join(value for value in (row["selected_text"], row["note"]) if value)
        for passage in best_passages(text, terms, limit=1):
            matches.append(
                (
                    passage.distinct_terms,
                    SearchMatch(
                        source="annotation",
                        snippet=passage.snippet,
                        exact=text[passage.anchor.start : passage.anchor.end],
                        page_number=row["page_number"],
                        annotation_id=row["annotation_id"],
                    ),
                )
            )
    return matches


def _label_match(
    source: Literal["title", "path"], value: str | None, terms: Sequence[Term]
) -> SearchMatch | None:
    if not value:
        return None
    hits = _hits(value, terms)
    if not hits:
        return None
    return SearchMatch(
        source=source,
        snippet=_snippet(value, hits, hits[0]),
        exact=value[hits[0].start : hits[0].end],
    )


def _metadata_snippets(
    connection: sqlite3.Connection, expression: str, document_ids: list[str]
) -> dict[str, str]:
    """FTS snippets for documents that matched only tags, category, or authors."""
    if not document_ids:
        return {}
    placeholders = ",".join("?" for _ in document_ids)
    return {
        row["document_id"]: row["snippet"]
        for row in connection.execute(
            f"""
            SELECT document_id, snippet(document_search, -1, '[[', ']]', ' … ', 24) AS snippet
            FROM document_search
            WHERE document_search MATCH ? AND document_id IN ({placeholders})
            """,
            (expression, *document_ids),
        )
    }


def attach_search_matches(
    connection: sqlite3.Connection,
    documents: list[DocumentSummary],
    query: str,
    expression: str,
) -> list[DocumentSummary]:
    """Return the documents with up to three located passages each.

    `search_snippet` becomes the best passage's snippet, so older clients keep
    a highlighted excerpt without FTS computing one for every match.
    """
    terms = query_terms(query)
    if not terms or not documents:
        return documents
    text_ids = [doc.document_id for doc in documents if doc.content_type != "application/pdf"]
    contents: dict[str, str] = {}
    if text_ids:
        placeholders = ",".join("?" for _ in text_ids)
        contents = {
            row["document_id"]: row["content"]
            for row in connection.execute(
                f"""
                SELECT d.document_id, r.content FROM documents d
                JOIN revisions r ON r.revision_id = d.current_revision_id
                WHERE d.document_id IN ({placeholders})
                """,
                text_ids,
            )
        }
    located: list[tuple[DocumentSummary, list[SearchMatch]]] = []
    for document in documents:
        if document.content_type == "application/pdf":
            candidates = _pdf_matches(connection, document.document_id, terms)
        else:
            candidates = _content_matches(
                contents.get(document.document_id, ""), document.content_type, terms
            )
        # Stable sort keeps source order (text, pages, annotations) within a score.
        candidates.sort(key=lambda item: -item[0])
        matches = [match for _score, match in candidates[:MAX_MATCHES]]
        if not matches:
            fallback = _label_match("title", document.title, terms) or _label_match(
                "path", document.path, terms
            )
            matches = [fallback or SearchMatch(source="metadata", snippet="", exact=None)]
        located.append((document, matches))
    snippets = _metadata_snippets(
        connection,
        expression,
        [document.document_id for document, matches in located if matches[0].source == "metadata"],
    )
    results: list[DocumentSummary] = []
    for document, matches in located:
        if matches[0].source == "metadata":
            matches = [
                matches[0].model_copy(update={"snippet": snippets.get(document.document_id, "")})
            ]
        results.append(
            document.model_copy(
                update={"search_matches": matches, "search_snippet": matches[0].snippet or None}
            )
        )
    return results
