# ADR 0002: Security boundaries, secret redaction, CSP isolation, and SSRF controls

## Status

Accepted

## Context

Sangam stores user and agent documents, renders Markdown/HTML/PDF previews, embeds an MCP App frame, calls external LLM providers, and fetches user-supplied URLs. Secrets, scripts, reverse proxies, and untrusted URLs must not cross privilege boundaries or leak into audit logs and prompts.

## Decision

1. **Secret redaction before diffing and logging (`access.py`, `security.py`, `service.py`)**
   - Redact sensitive values from old and new content before computing audit diffs so a diff hunk inside a PEM block cannot lose its identifying delimiters; line-added and line-removed counts still describe the actual edit.
   - Redact private PEM blocks across unified diff `+/-` line prefixes.
   - Interpolate log record format arguments before sanitizing the message so redaction cannot corrupt format placeholders.
   - Because stored audit strings can be redacted, duplicate-document idempotency replay validates exact arguments by hashing against the immutable source revision rather than the document's current head.

2. **Browser origin, CSP, and iframe isolation (`api.py`, `api_chat.py`, `SelectableHtmlText.tsx`)**
   - `iframe srcdoc` inherits its host document's Content-Security-Policy. The MCP local host computes SHA-256 hashes for only the compiled MCP App's exact inline scripts, keeping the main application's strict CSP intact.
   - Loopback detection for same-origin browser requests prefers the `Origin` header over `request.base_url` so a reverse proxy cannot make a public browser appear to be localhost.
   - `GET /api/v1/chat/models` is readable by authenticated chat clients because the catalog contains no credentials; mutations remain administrator-only.
   - Provider connection probes spend external credentials outside Sangam and are ledgered like writes.
   - `SelectableHtmlText` renders plain selectable text outside article iframes so users can select passages without granting the iframe same-origin access, script privileges, or selection-submission authority.

3. **Path scope, attachments, prompt framing, and one-time tokens (`authorization.py`, `document_assets.py`, `chat_profiles.py`, `chat_effects.py`)**
   - Path-prefix authorization queries SQLite with binary range bounds (`d.path = ? OR (d.path >= prefix/ AND d.path < prefix0)`) to avoid SQL `LIKE` wildcard escaping issues.
   - SVG is intentionally excluded from image uploads because it is script-capable content. Uploaded attachment filenames append 16 hex digits of SHA-256 so names remain unguessable without the image bytes.
   - Saved chat profiles serialize to JSON and escape `<` and `>` as `\u003c` and `\u003e` so saved text cannot impersonate surrounding prompt XML delimiters.
   - Capability tokens for unlisted publications are returned once to the approving client and stripped before storing effect outcomes in SQLite.

4. **Outbound SSRF and worker isolation (`ssrf_client.py`, `monty_worker.py`)**
   - Beyond Python stdlib `is_private`, outbound URL capture explicitly blocks CGNAT (`100.64.0.0/10`), IETF protocol assignments (`192.0.0.0/24`), TEST-NET-1/2/3, benchmark (`198.18.0.0/15`), limited broadcast (`255.255.255.255/32`), IPv6 documentation (`2001:db8::/32`), IPv6 discard (`100::/64`), and cloud metadata IPs (`169.254.169.254`, `169.254.169.253`, `169.254.169.123`, `100.100.100.200`, `fd00:ec2::254`).
   - Prohibited IP checks recursively inspect IPv4-mapped IPv6 addresses (`::ffff:0:0/96`) and 6to4 embedded IPv4 addresses (`2002::/16`, bytes `2:6`).
   - `monty_worker.py` enforces Unix `RLIMIT_AS`, `RLIMIT_CPU`, and `RLIMIT_CORE` directly and refuses unsupported platforms explicitly.

## Consequences

- Any change to diffing, logging, attachment types, CSP headers, or outbound HTTP fetchers must preserve these security invariants and their regression tests.
