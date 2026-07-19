# Phase 4 operations

## Local security modes

`single_user` remains the loopback-only development default. Do not expose it
to an untrusted network.

Production Cloudflare deployment uses:

```bash
SANGAM_AUTH_MODE=cloudflare_access
SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
SANGAM_CLOUDFLARE_ACCESS_AUDIENCE=your-access-application-aud
SANGAM_CLOUDFLARE_ACCESS_EMAIL=jay@example.com
SANGAM_TRUSTED_HUMAN_ACTOR_ID=human:jay
SANGAM_TRUSTED_HUMAN_DISPLAY_NAME=Jay
SANGAM_PUBLICATION_BASE_URL=https://docs.example.com/p
SANGAM_TRUSTED_PREVIEW_BASE_URL=https://preview.example.com/trusted-preview
SANGAM_TRUSTED_PREVIEW_HOST=preview.example.com
SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS='["https://sangam.example.com"]'
SANGAM_TRUSTED_PREVIEW_CONNECT_SRC='[]'
SANGAM_PREVIEW_HMAC_SECRET='replace-with-at-least-32-random-characters'
```

Generate the HMAC secret with a password manager or:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Changing the secret immediately invalidates every outstanding trusted-preview
grant. Grants otherwise expire after 120 seconds by default.

## Cloudflare Tunnel

Copy [`deploy/cloudflared/config.example.yml`](../../deploy/cloudflared/config.example.yml)
to the host's cloudflared configuration directory. Replace the tunnel UUID,
credentials path, and all three hostnames.

Validate routing before starting the tunnel:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://sangam.example.com
cloudflared tunnel ingress rule https://docs.example.com/p/example
cloudflared tunnel ingress rule https://preview.example.com/trusted-preview/
```

The final catch-all rule must remain `http_status:404`. Sangam stays bound to
`127.0.0.1:8000`; do not add a router port-forward.

## Cloudflare Access

Create one self-hosted Access application for only the application hostname.
Use a deny-by-default Allow policy for the configured email. Enable **Protect
with Access** on that tunnel route so cloudflared also rejects invalid tokens.
Record the application AUD value in
`SANGAM_CLOUDFLARE_ACCESS_AUDIENCE`.

Do not apply Access to the publication or preview hostname. If account-wide
Access protection is enabled, create explicit Bypass applications for those
two hostnames. Sangam still enforces publication credentials and preview HMAC
grants at the origin.

Verify from outside the home network:

1. The application hostname redirects to Access and accepts only the configured
   identity.
2. Removing or corrupting `Cf-Access-Jwt-Assertion` at an origin test returns
   `401`.
3. A public publication opens without Access.
4. An unlisted publication fails without its fragment credential and opens with
   the copied link.
5. The preview hostname root does not expose an application session.

## Publish and expose a revision

The browser inspector is the normal human workflow. The CLI is also complete:

```bash
sangam create \
  --title "Interactive report" \
  --content-type text/html \
  --path reports/interactive.html \
  --file report.html

sangam publish DOCUMENT_ID interactive-report --access unlisted
sangam publications
sangam expose-revision PUBLICATION_ID REVISION_ID
sangam rotate-publication-token PUBLICATION_ID
sangam unpublish PUBLICATION_ID --expected-version VERSION
```

An unlisted token is shown once. Store the complete fragment URL, not the raw
token in a query parameter. Query parameters may appear in request logs and
referrers; fragments are not sent to the server.

## Trusted HTML review

Before selecting **Trust interactive HTML**:

1. Read the complete HTML and every inline script.
2. Confirm the document needs JavaScript. Static HTML should remain safe.
3. Keep `SANGAM_TRUSTED_PREVIEW_CONNECT_SRC` empty unless a reviewed document
   needs a specific network endpoint.
4. Add the narrowest explicit HTTPS origin, never `*`.
5. Return the document to safe HTML after the interactive need ends.

Published HTML remains sanitized. Trust affects only the isolated preview
origin.

## Incident response

For a leaked unlisted link, rotate the publication token. For a document that
should no longer be reachable, unpublish it; this revokes active unlisted
tokens in the same transaction. For suspect trusted HTML, return it to safe
HTML and rotate the preview HMAC secret if an outstanding grant must be
invalidated immediately.

After any incident, review publication events, document trust events, document
revisions, and agent activity in the canonical SQLite backup.

## Manual release gate

Local automation does not own Cloudflare DNS or credentials. Before calling an
external deployment complete, manually record evidence for:

- Tunnel ingress validation for all three hostnames and the catch-all.
- Access login, denial, JWT audience, and configured email.
- Public, private, unlisted, rotated, and unpublished behavior off-tailnet.
- Trusted iframe origin isolation and denied application DOM/cookie access.
- Allowed and denied preview network requests.
- Publication and trusted-preview asset requests through the real route.
- No direct WAN/router exposure of port 8000.
