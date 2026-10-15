from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from conftest import headers
from fastapi.testclient import TestClient

VALID_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15c4\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x03\x00\x05\x00\x01\x0d\x0a-\xb4\x00\x00"
    b"\x00\x00IEND\xaeB`\x82"
)


def test_concurrent_asset_attachment(client: TestClient) -> None:
    # 1. Create a document
    doc_res = client.post(
        "/api/v1/documents",
        json={
            "title": "Asset Concurrency Test",
            "path": "docs/asset_concurrency.md",
            "content": "# Test Asset Concurrency\n",
            "content_type": "text/markdown",
        },
        headers=headers("create-asset-doc"),
    )
    assert doc_res.status_code == 201, doc_res.text
    document_id = doc_res.json()["document_id"]

    # 2. Simulate concurrent asset attachment requests across 10 worker threads
    num_threads = 10
    results: list[dict] = []
    errors: list[Exception] = []

    def upload_asset(worker_id: int):
        try:
            res = client.post(
                f"/api/v1/documents/{document_id}/assets?filename=diagram.png",
                content=VALID_PNG,
                headers={
                    **headers(f"upload-asset-worker-{worker_id}"),
                    "Content-Type": "image/png",
                },
            )
            assert res.status_code == 201, f"Worker {worker_id} failed: {res.text}"
            return res.json()
        except Exception as exc:
            errors.append(exc)
            raise

    with ThreadPoolExecutor(max_workers=num_threads) as executor:
        futures = [executor.submit(upload_asset, i) for i in range(num_threads)]
        for f in futures:
            results.append(f.result())

    assert len(errors) == 0, f"Encountered errors during concurrent upload: {errors}"
    assert len(results) == num_threads

    # 3. Verify all workers received valid references to the same content-addressed asset
    reference = results[0]["reference"]
    for res in results:
        assert res["reference"] == reference
        assert res["media_type"] == "image/png"
        assert res["size_bytes"] == len(VALID_PNG)

    # 4. Read the stored asset and confirm data integrity
    get_res = client.get(
        f"/api/v1/documents/{document_id}/assets",
        params={"path": reference},
        headers=headers("read-asset"),
    )
    assert get_res.status_code == 200
    assert get_res.content == VALID_PNG
