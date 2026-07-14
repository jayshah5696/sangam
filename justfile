set dotenv-load

image := "sangam:phase1"
container := "sangam"
port := "8000"

# Show the available project commands.
default:
    @just --list

# Run the backend tests and frontend verification.
test:
    uv run pytest
    npm --prefix frontend run build
    npm --prefix frontend run lint

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

    npm --prefix frontend run dev

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
