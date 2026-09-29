from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from sangam.application import (
    build_application_services,
    initialize_application_state,
)
from sangam.config import Settings
from sangam.schemas import (
    AddProjectDocument,
    CreateProject,
    UpdateProject,
)
from sangam.security import Principal


def test_project_query_plan_uses_indexes(settings: Settings) -> None:
    """Verify that SQLite EXPLAIN QUERY PLAN confirms indexes are utilized."""
    database = initialize_application_state(settings)
    with database.connection() as conn:
        # 1. Projects listing ordered by updated_at
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT project_id, name, updated_at "
            "FROM projects ORDER BY updated_at DESC"
        ).fetchall()
        plan_text = " ".join(row["detail"] for row in plan)
        assert "projects_updated_at_idx" in plan_text, (
            f"Expected projects_updated_at_idx: {plan_text}"
        )

        # 2. Projects listing ordered by created_at
        plan_created = conn.execute(
            "EXPLAIN QUERY PLAN SELECT project_id, name, created_at "
            "FROM projects ORDER BY created_at DESC"
        ).fetchall()
        plan_created_text = " ".join(row["detail"] for row in plan_created)
        assert "projects_created_at_idx" in plan_created_text, (
            f"Expected projects_created_at_idx: {plan_created_text}"
        )

        # 3. Project documents reverse lookup by document_id
        plan_doc_lookup = conn.execute(
            "EXPLAIN QUERY PLAN SELECT project_id, role "
            "FROM project_documents WHERE document_id = ?",
            ("doc-123",),
        ).fetchall()
        plan_doc_text = " ".join(row["detail"] for row in plan_doc_lookup)
        assert "project_documents_doc_idx" in plan_doc_text, (
            f"Expected project_documents_doc_idx: {plan_doc_text}"
        )

        # 4. Project threads reverse lookup by thread_id
        plan_thread_lookup = conn.execute(
            "EXPLAIN QUERY PLAN SELECT project_id FROM project_threads WHERE thread_id = ?",
            ("thread-123",),
        ).fetchall()
        plan_thread_text = " ".join(row["detail"] for row in plan_thread_lookup)
        assert "project_threads_thread_idx" in plan_thread_text, (
            f"Expected project_threads_thread_idx: {plan_thread_text}"
        )


def test_project_scale_and_latency_benchmarks(settings: Settings) -> None:
    """Benchmark high-cardinality project operations for sub-millisecond response times."""
    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name=settings.trusted_human_display_name,
        operation_id="perf-scale",
    )

    # 1. Seed 50 documents
    doc_ids: list[str] = []
    for i in range(50):
        doc = services.documents.create_document(
            title=f"Research Subject {i}",
            path=f"research/doc_{i:03d}.md",
            content=f"# Research Subject {i}\nContent for document {i}.",
            actor_id=principal.actor_id,
            idempotency_key=f"perf-seed-doc-{i}",
        )
        doc_ids.append(doc.document_id)

    # 2. Seed 200 projects and link multiple documents to each (membership by reference)
    project_ids: list[str] = []
    for p_idx in range(200):
        proj = services.projects.create_project(
            principal,
            CreateProject(
                name=f"Project Initiative {p_idx:03d}",
                description=f"Automated benchmark project number {p_idx}",
                create_brief=False,
            ),
        )
        project_ids.append(proj.project_id)

        # Attach 5 documents to each project
        for d_offset in range(5):
            target_doc_id = doc_ids[(p_idx + d_offset) % len(doc_ids)]
            services.projects.add_document(
                principal,
                proj.project_id,
                AddProjectDocument(
                    document_id=target_doc_id,
                    role="source" if d_offset > 0 else "draft",
                    notes=f"Reference note {d_offset}",
                ),
            )

    # Total memberships created = 200 * 5 = 1,000 memberships

    # 3. Benchmark list_projects latency over 100 runs
    list_latencies: list[float] = []
    for _ in range(100):
        t0 = time.perf_counter()
        projects = services.projects.list_projects()
        t1 = time.perf_counter()
        list_latencies.append((t1 - t0) * 1000.0)  # ms

    list_latencies.sort()
    p95_list = list_latencies[95]
    avg_list = sum(list_latencies) / len(list_latencies)

    # Ensure list query across 200 projects with aggregations is fast (p95 < 25ms, average < 15ms)
    assert len(projects) == 200
    assert avg_list < 15.0, f"Average list_projects latency too high: {avg_list:.2f}ms"
    assert p95_list < 25.0, f"p95 list_projects latency too high: {p95_list:.2f}ms"

    # 4. Benchmark get_project latency over 200 runs across project IDs
    get_latencies: list[float] = []
    for p_id in project_ids:
        t0 = time.perf_counter()
        detail = services.projects.get_project(p_id)
        t1 = time.perf_counter()
        assert detail is not None
        assert len(detail.documents) == 5
        get_latencies.append((t1 - t0) * 1000.0)

    get_latencies.sort()
    p95_get = get_latencies[190]
    avg_get = sum(get_latencies) / len(get_latencies)

    # Ensure get_project with document resolution is fast (p95 < 15ms, average < 5ms)
    assert avg_get < 5.0, f"Average get_project latency too high: {avg_get:.2f}ms"
    assert p95_get < 15.0, f"p95 get_project latency too high: {p95_get:.2f}ms"


def test_concurrent_project_mutations(settings: Settings) -> None:
    """Validate project layout snapshots and document memberships under concurrent access."""
    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name=settings.trusted_human_display_name,
        operation_id="perf-concurrency",
    )

    # Create project
    proj = services.projects.create_project(
        principal,
        CreateProject(
            name="Concurrent Project",
            description="Testing concurrency",
            create_brief=False,
        ),
    )

    # Create 20 documents
    docs = [
        services.documents.create_document(
            title=f"Concurrent doc {i}",
            path=f"concurrent/doc_{i}.md",
            content=f"Concurrent doc {i}",
            actor_id=principal.actor_id,
            idempotency_key=f"concurrent-doc-{i}",
        )
        for i in range(20)
    ]

    # Concurrently add documents and update workbench state
    errors: list[Exception] = []

    def add_doc_worker(doc_id: str, idx: int) -> None:
        try:
            services.projects.add_document(
                principal,
                proj.project_id,
                AddProjectDocument(
                    document_id=doc_id,
                    role="source",
                    pinned_page=idx + 1,
                ),
            )
        except Exception as e:
            errors.append(e)

    def update_layout_worker(worker_idx: int) -> None:
        try:
            services.projects.update_project(
                principal,
                proj.project_id,
                UpdateProject(
                    workbench_state_json=f'{{"activeWorker": {worker_idx}}}',
                ),
            )
        except Exception as e:
            errors.append(e)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = []
        for i, doc in enumerate(docs):
            futures.append(executor.submit(add_doc_worker, doc.document_id, i))
            futures.append(executor.submit(update_layout_worker, i))
        for f in futures:
            f.result()

    assert not errors, f"Errors during concurrent mutations: {errors}"

    detail = services.projects.get_project(proj.project_id)
    assert detail is not None
    assert len(detail.documents) == 20
