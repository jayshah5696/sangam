"""Search results say where they matched so a reader can judge them before opening."""

from __future__ import annotations

from conftest import headers
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf


def create(client: TestClient, key: str, **body: object) -> dict:
    response = client.post("/api/v1/documents", json=body, headers=headers(key))
    assert response.status_code == 201, response.text
    return response.json()


def search(client: TestClient, query: str, **params: str) -> list[dict]:
    response = client.get("/api/v1/search", params={"q": query, **params})
    assert response.status_code == 200, response.text
    return response.json()


def test_markdown_match_reports_passage_heading_and_line(client: TestClient) -> None:
    content = (
        "# Evaluation\n\nIntro paragraph.\n\n"
        "## Hardware requirements\n\n"
        "The model fits the target machine; peak memory reached 6.2 GB during runs.\n"
    )
    document = create(client, "passage-md", title="Evaluation", content=content)

    [result] = search(client, "memory")
    assert result["document_id"] == document["document_id"]
    [match] = result["search_matches"]
    assert match["source"] == "content"
    assert match["heading"] == "Hardware requirements"
    assert match["line"] == 7
    assert match["exact"] == "memory"
    assert "[[memory]]" in match["snippet"]
    assert match["page_number"] is None


def test_passage_with_every_term_ranks_before_partial_passages(client: TestClient) -> None:
    filler = "unrelated words " * 40
    content = (
        f"peak alone here.\n\n{filler}\n\nmemory alone here.\n\n{filler}\n\npeak memory together.\n"
    )
    create(client, "passage-rank", title="Rank", content=content)

    [result] = search(client, "peak memory")
    first = result["search_matches"][0]
    assert first["line"] == 9
    assert "[[peak]] [[memory]]" in first["snippet"]


def test_prefix_terms_match_like_full_text_search(client: TestClient) -> None:
    create(client, "passage-prefix", title="Prefix", content="Benchmarking notes.\n")
    [result] = search(client, "bench")
    [match] = result["search_matches"]
    assert match["exact"] == "Benchmarking"
    assert "[[Benchmarking]]" in match["snippet"]


def test_title_only_match_says_it_matched_the_title(client: TestClient) -> None:
    create(client, "passage-title", title="Quarterly zephyr review", content="Nothing here.\n")
    [result] = search(client, "zephyr")
    assert [match["source"] for match in result["search_matches"]] == ["title"]


def test_pdf_page_and_annotation_matches_carry_exact_locations(client: TestClient) -> None:
    imported = import_pdf(
        client, content=text_pdf("peak memory reached six gigabytes"), key="passage-pdf"
    ).json()
    document_id = imported["document_id"]
    annotation = client.post(
        f"/api/v1/pdfs/{document_id}/annotations",
        json={"page_number": 1, "annotation_type": "page_note", "note": "quokka observation"},
        headers=headers("passage-annotation"),
    )
    assert annotation.status_code == 201, annotation.text

    [page_result] = search(client, "gigabytes")
    [page_match] = page_result["search_matches"]
    assert page_match["source"] == "pdf_page"
    assert page_match["page_number"] == 1
    assert "[[gigabytes]]" in page_match["snippet"]

    [note_result] = search(client, "quokka")
    [note_match] = note_result["search_matches"]
    assert note_match["source"] == "annotation"
    assert note_match["annotation_id"] == annotation.json()["annotation_id"]
    assert note_match["page_number"] == 1


def test_content_type_filter_narrows_results(client: TestClient) -> None:
    markdown = create(client, "filter-md", title="Shared walrus", content="walrus\n")
    create(
        client,
        "filter-html",
        title="Shared walrus page",
        content="<p>walrus</p>",
        content_type="text/html",
    )
    results = search(client, "walrus", content_type="text/markdown")
    assert [item["document_id"] for item in results] == [markdown["document_id"]]


def test_snippet_is_the_best_passage_and_metadata_matches_keep_an_fts_snippet(
    client: TestClient,
) -> None:
    create(client, "snippet-passage", title="Snippet", content="peak memory reached 6.2 GB\n")
    [passage] = search(client, "memory")
    assert passage["search_snippet"] == passage["search_matches"][0]["snippet"]

    tag = client.post(
        "/api/v1/tags",
        json={"name": "zebrafinch", "color": "#336699"},
        headers=headers("snippet-tag-create"),
    ).json()
    tagged = create(client, "snippet-tag", title="Tagged", content="nothing relevant\n")
    response = client.patch(
        f"/api/v1/documents/{tagged['document_id']}/metadata",
        json={"expected_metadata_version": 0, "category": None, "tag_ids": [tag["tag_id"]]},
        headers=headers("snippet-tag-metadata"),
    )
    assert response.status_code == 200, response.text
    [result] = search(client, "zebrafinch")
    [match] = result["search_matches"]
    assert match["source"] == "metadata"
    assert "[[zebrafinch]]" in match["snippet"]
    assert result["search_snippet"] == match["snippet"]
