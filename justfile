set dotenv-load

image := "sangam:dev"
container := "sangam"
port := "8000"

# Show the available project commands.
default:
    @just --list

# Run the complete fast local verification suite.
test:
    uv run ruff check .
    uv run ruff format --check .
    just typecheck
    uv run python scripts/verify_openapi_contract.py
    uv run pytest
    npm --prefix frontend run format:check
    npm --prefix frontend run build
    npm --prefix frontend run lint
    npm --prefix frontend run test

# Run source, documentation, version, configuration, and distribution gates.
check: test test-docs validate-compose
    uv run python scripts/verify-release-config.py
    uv run python scripts/verify-version.py --frontend-dist
    ./scripts/audit-dependencies.sh
    ./scripts/smoke-package.sh

# Run only the Python service and API tests.
test-backend:
    uv run pytest

# Type-check the provider and chat boundary introduced by the architecture foundation.
typecheck:
    uv run mypy \
        src/sangam/provider_connections.py \
        src/sangam/chat_models.py \
        src/sangam/chat_context.py \
        src/sangam/chat.py \
        src/sangam/chat_tools.py

# Run only the browser client build, lint, and unit tests.
test-frontend:
    npm --prefix frontend run build
    npm --prefix frontend run lint
    npm --prefix frontend run test

# Run the review-mode chat agent eval suite (requires SANGAM_OPENROUTER_API_KEY).
eval-chat model="openai/gpt-5.6-sol" reasoning="medium" output="test-results/chat-evals-review.json":
    mkdir -p test-results
    uv run python scripts/run_chat_evals.py --model "{{ model }}" --reasoning-effort "{{ reasoning }}" --autonomy-mode review --output "{{ output }}"

# Run the same live evals under bounded private-workspace YOLO policy.
eval-chat-yolo model="openai/gpt-5.6-sol" reasoning="medium" output="test-results/chat-evals-yolo.json":
    mkdir -p test-results
    uv run python scripts/run_chat_evals.py --model "{{ model }}" --reasoning-effort "{{ reasoning }}" --autonomy-mode workspace --output "{{ output }}"

# Verify deterministic approval, permission, cancellation, replay, and plan policy.
eval-chat-policy:
    uv run pytest tests/test_chat_capability_lifecycle.py tests/test_organization_plans.py

# Run the chat eval suite against another checkout's code for before/after comparison.
eval-chat-against source model="openai/gpt-5.6-sol" reasoning="medium" output="test-results/chat-evals-baseline.json":
    mkdir -p test-results
    cd "{{ source }}" && uv run python "{{ justfile_directory() }}/scripts/run_chat_evals.py" --model "{{ model }}" --reasoning-effort "{{ reasoning }}" --autonomy-mode review --output "{{ output }}"

# Exercise desktop and narrow browser interactions against isolated data.
test-e2e:
    npm --prefix frontend run test:e2e

# Update verified Playwright screenshot baselines.
update-screenshots:
    npm --prefix frontend run update:screenshots

# Run oxlint with anti-slop rules to reject low-evidence TypeScript and JavaScript patterns.
anti-slop:
    npm --prefix frontend run anti-slop

# Check Python and frontend code style, anti-slop rules, and linting.
lint:
    uv run ruff check .
    npm --prefix frontend run lint

# Validate development and production Compose configurations.
validate-compose:
    ./scripts/validate-compose.sh

# Format Python sources and tests.
format:
    uv run ruff format .
    npm --prefix frontend run format

# Verify documentation links, Markdown style, and Mermaid fences.
test-docs:
    uv run python scripts/verify-docs.py
    node frontend/scripts/verify-mermaid.mjs
    npm --prefix frontend exec markdownlint-cli2 "README.md" "SECURITY.md" "docs/**/*.md"

# Serve the API and frontend development server with live reload.
serve backend_port="8000" frontend_port="5173":
    #!/usr/bin/env bash
    set -Eeuo pipefail

    export SANGAM_DEV_BACKEND_URL="http://127.0.0.1:{{ backend_port }}"
    uv run uvicorn sangam.main:app --reload --port "{{ backend_port }}" &
    backend_pid=$!

    cleanup() {
      kill "$backend_pid" 2>/dev/null || true
      wait "$backend_pid" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    npm --prefix frontend run dev -- --host 127.0.0.1 --port "{{ frontend_port }}" --strictPort

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

# Run the release checklist's automatable gates for a SemVer version.
release-check version:
    ./scripts/release-preflight.sh "{{ version }}"
