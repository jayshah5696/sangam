FROM node:26-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /bin/

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

RUN mkdir -p /data/database /data/workspace /data/backups
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2)"]

CMD ["uv", "run", "--no-sync", "uvicorn", "sangam.main:app", "--host", "0.0.0.0", "--port", "8000"]
