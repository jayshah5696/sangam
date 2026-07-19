set dotenv-load

image := "sangam:phase6"
container := "sangam"
port := "8000"

# Show the available project commands.
default:
    @just --list

# Run the complete fast local verification suite.
test:
    uv run ruff check .
    uv run ruff format --check .
    uv run pytest
    npm --prefix frontend run format:check
    npm --prefix frontend run build
    npm --prefix frontend run lint
    npm --prefix frontend run test

# Run only the Python service and API tests.
test-backend:
    uv run pytest

# Run only the browser client build, lint, and unit tests.
test-frontend:
    npm --prefix frontend run build
    npm --prefix frontend run lint
    npm --prefix frontend run test

# Format Python sources and tests.
format:
    uv run ruff format .
    npm --prefix frontend run format

# Verify documentation links, Markdown style, and Mermaid fences.
test-docs:
    uv run python scripts/verify-docs.py
    node frontend/scripts/verify-mermaid.mjs
    npm --prefix frontend exec markdownlint-cli2 "README.md" "docs/**/*.md"

# Serve the API and frontend development server with live reload.
serve:
    #!/usr/bin/env bash
    set -Eeuo pipefail

    uv run uvicorn sangam.main:app --reload &
    backend_pid=$!

    cleanup() {
      kill "$backend_pid" 2>/dev/null || true
      wait "$backend_pid" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    npm --prefix frontend run dev -- --host 127.0.0.1

# Build the production Docker image.
docker-build:
    docker build --tag "{{ image }}" .

# Build and serve the production container with persistent local data.
docker-serve: docker-build
    docker run --rm --init --name "{{ container }}" \
      --publish "127.0.0.1:{{ port }}:8000" \
      --volume "{{ justfile_directory() }}/data/database:/data/database" \
      --volume "{{ justfile_directory() }}/data/workspace:/data/workspace" \
      --volume "{{ justfile_directory() }}/data/backups:/data/backups" \
      "{{ image }}"

# Build and exercise the production image with persistent state and restart recovery.
docker-smoke:
    ./scripts/docker-smoke.sh
