FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS frontend-build

WORKDIR /app/frontend
COPY pyproject.toml /app/pyproject.toml
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim@sha256:cea0e6040540fb2b965b6e7fb5ffa00871e632eef63719f0ea54bca189ce14a6 AS runtime
ARG VERSION=dev
COPY --from=ghcr.io/astral-sh/uv:0.11.16@sha256:440fd6477af86a2f1b38080c539f1672cd22acb1b1a47e321dba5158ab08864d /uv /uvx /bin/

LABEL org.opencontainers.image.title="Sangam" \
      org.opencontainers.image.description="A self-hosted document workspace for humans and agents" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="$VERSION"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SANGAM_DATABASE_PATH=/data/database/sangam.sqlite3 \
    SANGAM_WORKSPACE_ROOT=/data/workspace \
    SANGAM_BACKUP_ROOT=/data/backups \
    SANGAM_FRONTEND_DIST=/app/frontend/dist

WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE NOTICE.md ./
COPY src/ ./src/
RUN uv sync --frozen --no-dev
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN groupadd --gid 10001 sangam \
    && useradd --uid 10001 --gid sangam --no-create-home --shell /usr/sbin/nologin sangam \
    && mkdir -p /data/database /data/workspace /data/backups \
    && chown -R sangam:sangam /data
USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/readiness', timeout=2)"]

CMD ["/app/.venv/bin/uvicorn", "sangam.main:app", "--host", "0.0.0.0", "--port", "8000"]
