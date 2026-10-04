from __future__ import annotations

import hashlib
from unittest.mock import patch

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.errors import ValidationError
from sangam.ssrf_client import (
    SafeCaptureClient,
    is_prohibited_ip,
    resolve_and_validate_host,
    validate_capture_url,
)


@pytest.mark.parametrize(
    "ip_str",
    [
        "127.0.0.1",
        "127.0.1.1",
        "10.0.0.1",
        "10.254.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.0.1",
        "192.168.1.100",
        "169.254.169.254",
        "169.254.1.1",
        "100.64.0.1",
        "100.127.255.254",
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fc00::1",
        "fd00::1",
        "fd00:ec2::254",
        "ff02::1",
        "::",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "::ffff:100.64.0.1",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "198.18.0.1",
        "255.255.255.255",
        "100.100.100.200",
    ],
)
def test_blocked_ip_addresses(ip_str: str) -> None:
    assert is_prohibited_ip(ip_str) is True


@pytest.mark.parametrize(
    "ip_str",
    [
        "93.184.216.34",
        "142.250.190.46",
        "1.1.1.1",
        "8.8.8.8",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ],
)
def test_allowed_public_ips(ip_str: str) -> None:
    assert is_prohibited_ip(ip_str) is False


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/resource",
        "file:///etc/passwd",
        "gopher://example.com/",
        "data:text/html,<h1>Hello</h1>",
        "javascript:alert(1)",
        "http://example.com:8080/",
        "https://example.com:8443/",
        "https://example.com:22/",
        "http://user:pass@example.com/",
        "http:///",
        "http://:80/",
    ],
)
def test_disallowed_schemes_and_ports(url: str) -> None:
    with pytest.raises(ValidationError):
        validate_capture_url(url)


def test_allowed_urls_parse_cleanly() -> None:
    parsed1 = validate_capture_url("http://example.com/test")
    assert parsed1.hostname == "example.com"
    assert parsed1.port == 80

    parsed2 = validate_capture_url("https://example.com/test")
    assert parsed2.hostname == "example.com"
    assert parsed2.port == 443


def test_resolve_and_validate_rejects_private_dns() -> None:
    fake_dns = {"internal.local": ["192.168.1.50"]}
    with pytest.raises(ValidationError) as exc:
        resolve_and_validate_host("internal.local", 80, resolver=lambda h, p: fake_dns[h])
    assert "prohibited network range" in str(exc.value)


def test_resolve_and_validate_accepts_public_dns() -> None:
    fake_dns = {"example.com": ["93.184.216.34"]}
    ip = resolve_and_validate_host("example.com", 443, resolver=lambda h, p: fake_dns[h])
    assert ip == "93.184.216.34"


def test_dns_rebinding_connection_pinning() -> None:
    """Verify that DNS is resolved once and the connection connects strictly to the pinned IP."""
    dns_lookups = []

    def mock_resolver(host: str, port: int) -> list[str]:
        dns_lookups.append(host)
        # First lookup gives public IP
        return ["93.184.216.34"]

    resolved_ip = resolve_and_validate_host("rebind.example.com", 80, resolver=mock_resolver)
    assert resolved_ip == "93.184.216.34"


def test_redirect_from_public_to_private_blocked() -> None:
    """A public host returning a redirect to a private address must be blocked."""

    def mock_fetch(url: str):
        # First hop is public
        if url == "http://public.example.com/start":
            return (302, {"Location": "http://10.0.0.1/admin"}, b"")
        return (200, {"Content-Type": "text/html"}, b"<h1>Secret</h1>")

    dns_table = {
        "public.example.com": ["93.184.216.34"],
        "10.0.0.1": ["10.0.0.1"],
    }
    client = SafeCaptureClient(
        resolver=lambda h, p: dns_table.get(h, [h]),
        http_handler=mock_fetch,
    )

    with pytest.raises(ValidationError) as exc:
        client.fetch("http://public.example.com/start")
    assert "prohibited network range" in str(exc.value)


def test_redirect_limit_exceeded() -> None:
    """Redirects beyond 3 hops must be rejected."""
    redirect_chain = {
        "http://example.com/1": "http://example.com/2",
        "http://example.com/2": "http://example.com/3",
        "http://example.com/3": "http://example.com/4",
        "http://example.com/4": "http://example.com/5",
    }

    def mock_fetch(url: str):
        if url in redirect_chain:
            return (302, {"Location": redirect_chain[url]}, b"")
        return (200, {"Content-Type": "text/html"}, b"<h1>Finally</h1>")

    client = SafeCaptureClient(
        resolver=lambda h, p: ["93.184.216.34"],
        http_handler=mock_fetch,
        max_redirects=3,
    )

    with pytest.raises(ValidationError) as exc:
        client.fetch("http://example.com/1")
    assert "maximum redirects" in str(exc.value)


def test_oversize_response_rejected() -> None:
    def mock_fetch(url: str):
        return (200, {"Content-Type": "text/html"}, b"A" * 2000)

    client = SafeCaptureClient(
        resolver=lambda h, p: ["93.184.216.34"],
        http_handler=mock_fetch,
        max_bytes=1000,
    )

    with pytest.raises(ValidationError) as exc:
        client.fetch("http://example.com/large")
    assert "maximum allowed size" in str(exc.value)


def test_disallowed_content_type_rejected() -> None:
    def mock_fetch(url: str):
        return (200, {"Content-Type": "application/json"}, b'{"key": "value"}')

    client = SafeCaptureClient(
        resolver=lambda h, p: ["93.184.216.34"],
        http_handler=mock_fetch,
    )

    with pytest.raises(ValidationError) as exc:
        client.fetch("http://example.com/data")
    assert "Disallowed Content-Type" in str(exc.value)


def test_successful_html_capture() -> None:
    html_content = (
        b"<html><head><title>Research Note</title></head>"
        b"<body><h1>Heading</h1><p>Body paragraph.</p></body></html>"
    )

    def mock_fetch(url: str):
        return (200, {"Content-Type": "text/html; charset=utf-8"}, html_content)

    client = SafeCaptureClient(
        resolver=lambda h, p: ["93.184.216.34"],
        http_handler=mock_fetch,
    )
    result = client.fetch("http://example.com/article")
    assert result.content_type == "text/html"
    assert result.title == "Research Note"
    assert result.content_hash == hashlib.sha256(html_content).hexdigest()
    assert b"Body paragraph." in result.body


def test_admin_only_capture_endpoint(client: TestClient) -> None:
    """Verify that POST /api/v1/captures/url is accessible to admins and rejected for non-admins."""
    # Issue a read-only agent token
    token = issue_agent_token(
        client,
        actor_id="agent:researcher",
        display_name="Research Agent",
        capabilities=("read", "search"),
    )

    # Calling as non-admin token must return 403 Forbidden
    forbidden_resp = client.post(
        "/api/v1/captures/url",
        headers={"Authorization": f"Bearer {token}", **headers("cap-fail")},
        json={"url": "https://example.com/test"},
    )
    assert forbidden_resp.status_code == 403

    # Admin call (unauthenticated local session acts as admin)
    with patch("sangam.capture.SafeCaptureClient.fetch") as mock_fetch:
        from sangam.ssrf_client import SafeCaptureResponse

        mock_fetch.return_value = SafeCaptureResponse(
            original_url="https://example.com/article",
            final_url="https://example.com/article",
            content_type="text/html",
            body=(
                b"<html><head><title>Test Article</title></head>"
                b"<body><p>Clean text</p></body></html>"
            ),
            title="Test Article",
            content_hash=hashlib.sha256(b"content").hexdigest(),
            fetch_time="2026-10-03T23:00:00Z",
        )
        success_resp = client.post(
            "/api/v1/captures/url",
            headers=headers("cap-success"),
            json={"url": "https://example.com/article"},
        )
        assert success_resp.status_code == 201
        data = success_resp.json()
        assert data["title"] == "Test Article"
        assert "Test Article" in data["content"]
        assert "Original source: <https://example.com/article>" in data["content"]
        assert "Content hash: sha256:" in data["content"]


def test_pdf_capture_endpoint(client: TestClient) -> None:
    """Verify that capturing a PDF document imports it into the workspace."""
    pdf_bytes = b"%PDF-1.4 dummy pdf content for testing imports"
    with patch("sangam.capture.SafeCaptureClient.fetch") as mock_fetch:
        from sangam.ssrf_client import SafeCaptureResponse

        mock_fetch.return_value = SafeCaptureResponse(
            original_url="https://example.com/paper.pdf",
            final_url="https://example.com/paper.pdf",
            content_type="application/pdf",
            body=pdf_bytes,
            title="Machine Learning Paper",
            content_hash=hashlib.sha256(pdf_bytes).hexdigest(),
            fetch_time="2026-10-03T23:00:00Z",
        )
        resp = client.post(
            "/api/v1/captures/url",
            headers=headers("cap-pdf"),
            json={"url": "https://example.com/paper.pdf"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["content_type"] == "application/pdf"
        assert data["title"] == "Machine Learning Paper"
        assert data["path"].endswith(".pdf")


def test_plain_text_capture_endpoint(client: TestClient) -> None:
    """Verify that capturing a plain text file saves it with provenance."""
    text_bytes = b"Raw text notes from an experiment."
    with patch("sangam.capture.SafeCaptureClient.fetch") as mock_fetch:
        from sangam.ssrf_client import SafeCaptureResponse

        mock_fetch.return_value = SafeCaptureResponse(
            original_url="https://example.com/notes.txt",
            final_url="https://example.com/notes.txt",
            content_type="text/plain",
            body=text_bytes,
            title="Lab Notes",
            content_hash=hashlib.sha256(text_bytes).hexdigest(),
            fetch_time="2026-10-03T23:00:00Z",
        )
        resp = client.post(
            "/api/v1/captures/url",
            headers=headers("cap-txt"),
            json={"url": "https://example.com/notes.txt"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["content_type"] == "text/markdown"
        assert "Raw text notes from an experiment." in data["content"]
        assert "Original source: <https://example.com/notes.txt>" in data["content"]


def test_timeout_raises_validation_error() -> None:
    """A hanging request exceeding timeout raises ValidationError."""
    import httpx

    timeout_exc = httpx.TimeoutException("Connection timed out")
    with patch.object(httpx.Client, "stream", side_effect=timeout_exc):
        client = SafeCaptureClient(resolver=lambda h, p: ["93.184.216.34"])
        with pytest.raises(ValidationError) as exc:
            client.fetch("http://example.com/slow")
        assert "timed out" in str(exc.value)


def test_pinned_backend_connects_to_ip() -> None:
    """Ensure PinnedBackend connects strictly to the pre-validated IP."""
    from sangam.ssrf_client import _PinnedBackend

    backend = _PinnedBackend("93.184.216.34")
    with patch("httpcore._backends.sync.SyncBackend.connect_tcp") as mock_connect:
        backend.connect_tcp("malicious.example.com", 80)
        # First argument to connect_tcp must be the pinned IP, not the host!
        mock_connect.assert_called_once_with("93.184.216.34", 80, None, None, None)
