from __future__ import annotations

import hashlib
import ipaddress
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx
from httpcore._backends.sync import SyncBackend

from sangam.errors import ValidationError

# Additional reserved/special networks not fully covered by basic stdlib is_private
_ADDITIONAL_PROHIBITED_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),  # Carrier-Grade NAT (CGNAT)
    ipaddress.ip_network("192.0.0.0/24"),  # IETF Protocol Assignments
    ipaddress.ip_network("192.0.2.0/24"),  # TEST-NET-1
    ipaddress.ip_network("198.51.100.0/24"),  # TEST-NET-2
    ipaddress.ip_network("203.0.113.0/24"),  # TEST-NET-3
    ipaddress.ip_network("198.18.0.0/15"),  # Network Interconnect Device Benchmark
    ipaddress.ip_network("255.255.255.255/32"),  # Limited Broadcast
    ipaddress.ip_network("2001:db8::/32"),  # IPv6 Documentation
    ipaddress.ip_network("100::/64"),  # IPv6 Discard Prefix
)

_SPECIFIC_METADATA_IPS = {
    ipaddress.ip_address("169.254.169.254"),  # AWS/GCP/Azure/OpenStack metadata
    ipaddress.ip_address("169.254.169.253"),  # AWS DNS
    ipaddress.ip_address("169.254.169.123"),  # AWS Time
    ipaddress.ip_address("100.100.100.200"),  # Alibaba Cloud metadata
    ipaddress.ip_address("fd00:ec2::254"),  # AWS IPv6 metadata
}

ALLOWED_MEDIA_TYPES = {"text/html", "text/plain", "application/pdf"}


def is_prohibited_ip(ip_input: str | ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if the address belongs to loopback, private, link-local, multicast,
    CGNAT, reserved, documentation, or cloud metadata ranges."""
    try:
        ip = ipaddress.ip_address(ip_input) if isinstance(ip_input, str) else ip_input
    except ValueError:
        return True

    # Check for IPv4-mapped IPv6 (::ffff:127.0.0.1, etc.)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        return is_prohibited_ip(ip.ipv4_mapped)

    # Check 6to4 embedded IPv4 addresses (2002::/16)
    if isinstance(ip, ipaddress.IPv6Address) and ip in ipaddress.ip_network("2002::/16"):
        # The 32 bits following 2002:: contain the IPv4 address
        embedded_ipv4 = ipaddress.IPv4Address(ip.packed[2:6])
        if is_prohibited_ip(embedded_ipv4):
            return True

    if ip in _SPECIFIC_METADATA_IPS:
        return True

    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True

    return any(ip in network for network in _ADDITIONAL_PROHIBITED_NETWORKS)


@dataclass(frozen=True)
class ValidatedCaptureUrl:
    scheme: str
    hostname: str
    port: int
    netloc: str
    path: str
    query: str
    fragment: str


def validate_capture_url(url: str) -> ValidatedCaptureUrl:
    """Validate that the capture URL uses http/https, standard ports, and has a host."""
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValidationError(
            f"Disallowed URL scheme '{parsed.scheme}'. Only http and https are allowed."
        )

    if not parsed.hostname:
        raise ValidationError("URL must contain a valid hostname.")

    if parsed.username or parsed.password:
        raise ValidationError("Credentials in URLs are not permitted.")

    port = parsed.port
    if port is not None:
        expected_port = 80 if scheme == "http" else 443
        if port != expected_port:
            raise ValidationError(
                f"Disallowed port '{port}'. Only standard ports (80, 443) are allowed."
            )
    else:
        port = 80 if scheme == "http" else 443

    return ValidatedCaptureUrl(
        scheme=scheme,
        hostname=parsed.hostname,
        port=port,
        netloc=parsed.netloc,
        path=parsed.path,
        query=parsed.query,
        fragment=parsed.fragment,
    )


def resolve_and_validate_host(
    hostname: str,
    port: int,
    resolver: Callable[[str, int], list[str]] | None = None,
) -> str:
    """Resolve the hostname and verify that no resolved IP falls within a prohibited range.
    Returns the first verified IP address for connection pinning."""
    # If hostname is already a raw IP literal:
    try:
        raw_ip = ipaddress.ip_address(hostname)
        if is_prohibited_ip(raw_ip):
            raise ValidationError(f"Target address '{raw_ip}' is in a prohibited network range.")
        return str(raw_ip)
    except ValueError:
        pass

    resolved_ips: list[str] = []
    if resolver is not None:
        try:
            resolved_ips = resolver(hostname, port)
        except Exception as exc:
            raise ValidationError(f"DNS resolution failed for '{hostname}': {exc}") from exc
    else:
        try:
            addr_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
            resolved_ips = [info[4][0] for info in addr_info]
        except socket.gaierror as exc:
            raise ValidationError(f"DNS resolution failed for '{hostname}': {exc}") from exc

    if not resolved_ips:
        raise ValidationError(f"No IP addresses resolved for '{hostname}'.")

    for ip_str in resolved_ips:
        if is_prohibited_ip(ip_str):
            raise ValidationError(f"Target address '{ip_str}' is in a prohibited network range.")

    return resolved_ips[0]


class _PinnedBackend(SyncBackend):
    def __init__(self, pinned_ip: str) -> None:
        super().__init__()
        self.pinned_ip = pinned_ip

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> Any:
        return super().connect_tcp(self.pinned_ip, port, timeout, local_address, socket_options)


class PinnedTransport(httpx.HTTPTransport):
    """Transport that pins the underlying TCP connection to a specific pre-validated IP,
    completely preventing DNS rebinding while preserving SNI and Host headers."""

    def __init__(self, pinned_ip: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._pool = httpcore.ConnectionPool(
            ssl_context=self._pool._ssl_context,
            network_backend=_PinnedBackend(pinned_ip),
            http1=True,
            http2=False,
            retries=0,
        )


@dataclass(frozen=True)
class SafeCaptureResponse:
    original_url: str
    final_url: str
    content_type: str
    body: bytes
    title: str | None
    content_hash: str
    fetch_time: str


class SafeCaptureClient:
    """SSRF-guarded HTTP client with IP range checks, connection pinning, manual redirect following,
    content-type allowlisting, and byte limit enforcement."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 15.0,
        max_bytes: int = 10_000_000,
        max_redirects: int = 3,
        resolver: Callable[[str, int], list[str]] | None = None,
        http_handler: Callable[[str], tuple[int, dict[str, str], bytes]] | None = None,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes
        self.max_redirects = max_redirects
        self.resolver = resolver
        self.http_handler = http_handler

    def fetch(self, initial_url: str) -> SafeCaptureResponse:
        current_url = initial_url.strip()
        redirect_count = 0
        fetch_time = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

        while True:
            parsed = validate_capture_url(current_url)
            port = parsed.port or (80 if parsed.scheme == "http" else 443)
            hostname = parsed.hostname or ""

            pinned_ip = resolve_and_validate_host(hostname, port, resolver=self.resolver)

            if self.http_handler is not None:
                status_code, headers, body = self.http_handler(current_url)
                if status_code in (301, 302, 303, 307, 308):
                    if redirect_count >= self.max_redirects:
                        raise ValidationError(f"Exceeded maximum redirects ({self.max_redirects}).")
                    location = headers.get("Location") or headers.get("location")
                    if not location:
                        raise ValidationError("Redirect response missing Location header.")
                    current_url = urljoin(current_url, location)
                    redirect_count += 1
                    continue

                if status_code != 200:
                    raise ValidationError(f"Capture failed with HTTP {status_code}.")

                raw_content_type = headers.get("Content-Type") or headers.get("content-type") or ""
                media_type = raw_content_type.split(";")[0].strip().lower()
                if media_type not in ALLOWED_MEDIA_TYPES:
                    allowed = ", ".join(sorted(ALLOWED_MEDIA_TYPES))
                    raise ValidationError(
                        f"Disallowed Content-Type '{media_type}'. Allowed: {allowed}."
                    )

                if len(body) > self.max_bytes:
                    raise ValidationError(
                        f"Response exceeds max allowed size of {self.max_bytes} bytes."
                    )

                title = self._extract_title(body) if media_type == "text/html" else None
                content_hash = hashlib.sha256(body).hexdigest()
                return SafeCaptureResponse(
                    original_url=initial_url,
                    final_url=current_url,
                    content_type=media_type,
                    body=body,
                    title=title,
                    content_hash=content_hash,
                    fetch_time=fetch_time,
                )

            # Live network fetch using PinnedTransport
            transport = PinnedTransport(pinned_ip)
            try:
                with (
                    httpx.Client(
                        transport=transport,
                        timeout=self.timeout_seconds,
                        follow_redirects=False,
                        headers={
                            "Accept": "text/html, text/plain, application/pdf",
                            "User-Agent": "Sangam/1.0 (+https://sangam.local)",
                        },
                    ) as client,
                    client.stream("GET", current_url) as response,
                ):
                    if response.status_code in (301, 302, 303, 307, 308):
                        if redirect_count >= self.max_redirects:
                            raise ValidationError(
                                f"Exceeded maximum redirects ({self.max_redirects})."
                            )
                        location = response.headers.get("location")
                        if not location:
                            raise ValidationError("Redirect response missing Location header.")
                        current_url = urljoin(current_url, location)
                        redirect_count += 1
                        continue

                    if response.status_code != 200:
                        raise ValidationError(f"Capture failed with HTTP {response.status_code}.")

                    raw_content_type = response.headers.get("content-type", "")
                    media_type = raw_content_type.split(";")[0].strip().lower()
                    if media_type not in ALLOWED_MEDIA_TYPES:
                        allowed = ", ".join(sorted(ALLOWED_MEDIA_TYPES))
                        raise ValidationError(
                            f"Disallowed Content-Type '{media_type}'. Allowed: {allowed}."
                        )

                    # Read stream with byte limit enforcement
                    chunks = []
                    total_bytes = 0
                    for chunk in response.iter_bytes():
                        total_bytes += len(chunk)
                        if total_bytes > self.max_bytes:
                            raise ValidationError(
                                f"Response exceeds max allowed size of {self.max_bytes} bytes."
                            )
                        chunks.append(chunk)

                    body = b"".join(chunks)
                    title = self._extract_title(body) if media_type == "text/html" else None
                    content_hash = hashlib.sha256(body).hexdigest()
                    return SafeCaptureResponse(
                        original_url=initial_url,
                        final_url=current_url,
                        content_type=media_type,
                        body=body,
                        title=title,
                        content_hash=content_hash,
                        fetch_time=fetch_time,
                    )
            except httpx.TimeoutException as exc:
                msg = f"Capture request timed out after {self.timeout_seconds}s."
                raise ValidationError(msg) from exc
            except httpx.RequestError as exc:
                raise ValidationError(f"Capture network request failed: {exc}") from exc

    def _extract_title(self, html_bytes: bytes) -> str | None:
        try:
            # Decode prefix to find <title>
            sample = html_bytes[:65536].decode("utf-8", errors="ignore")
            match = re.search(r"<title\b[^>]*>(.*?)</title>", sample, re.IGNORECASE | re.DOTALL)
            if match:
                title = re.sub(r"\s+", " ", match.group(1)).strip()
                return title if title else None
        except Exception:
            pass
        return None
