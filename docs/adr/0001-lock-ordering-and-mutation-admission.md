# ADR 0001: Lock ordering, audit admission backpressure, and shutdown draining

## Status

Accepted

## Context

Sangam coordinates a single SQLite database, a materialized workspace file tree, paired backups, background PDF extraction, chat runs, MCP execution threads, and an append-only activity audit ledger inside one process. Deadlocks, unbounded memory growth, or premature thread cancellation during shutdown can corrupt paired state or drop committed audit records.

## Decision

1. **Canonical document and generation lock ordering (`access.py`, `mutations.py`)**
   - Never hold a document lock while waiting for a mutation generation; an active pipeline may need that document lock to finish before a queued backup starts.
   - Re-entrant nested storage calls inside a thread that already owns a mutation generation reuse that generation rather than waiting again and deadlocking against a queued backup.
   - Never acquire an arbitrary idempotency replay target lock while holding the source document lock. Instead, unwind all locks, release any unused admission ticket, and re-enter with all required document locks acquired in one canonical order.
   - Never expand an audit byte reservation inside a committing transaction or wait for audit capacity while holding document locks. Retry from the outer boundary with the larger reservation bound.
   - Evaluate idempotency replay before HTTP precondition checks, but never before authorization.
   - Validate HTTP conditional mutation guards before any filesystem side effect, then validate again inside the committing storage transaction through the replay lookup.

2. **Audit ledger admission, backpressure, and failure propagation (`activity.py`, `access.py`)**
   - Any audit worker startup failure marks audit admission unhealthy immediately.
   - Every commit failure in the audit worker is delivered back to producers through their futures.
   - When a producer cannot expand its byte reservation immediately, it releases its provisional byte credits to break circular wait and waits fairly in FIFO order at the head of the expansion queue.
   - When an operation fails and recording the failure audit event also raises, chain the audit error onto the original operation error instead of masking it.

3. **Separate-connection read audits vs. SQLite writer locks (`chat_profiles.py`, `chat_skills.py`, `mcp_skills.py`)**
   - Agent document reads enqueue an audit record on another SQLite connection. Complete audited reads before taking a SQLite writer lock (such as pinning a profile, registering a skill, or exporting a skill bundle).
   - Skill manifest builds use `BEGIN IMMEDIATE` transactions so source revisions and the published manifest come from one consistent snapshot.

4. **Storage ownership locks (`storage_ownership.py`)**
   - Combine path locks (which cover first boot before files exist) with an inode lock on the opened SQLite file descriptor so hard-link aliases under different workspace roots cannot bypass single-owner enforcement.

5. **Ordered shutdown draining (`api.py`, `chat.py`, `chat_runtime.py`, `chat_store.py`, `pdf_runtime.py`, `mcp_server.py`)**
   - A cancelled `asyncio` await cannot cancel a committing SQLite or parser thread. Request slots and transactions remain owned by the worker until the thread completes.
   - Shutdown drains owned in-flight writes (assignments, backups, PDF scheduler, chat admission/store, MCP pending commits, and activity worker) within their bounded deadlines instead of cancelling committed work.
   - `api.py` defers individual shutdown errors until every writer has stopped, retains storage ownership lock on any unsafe shutdown, and then raises the first captured failure.
   - Spooled PDF uploads wait for in-flight disk writes to finish before closing temporary files on cancellation.
   - MCP execution callbacks left finishing on a thread after a cancelled host wait stay counted against the same admission bound and are drained before `api.py` closes services or releases storage ownership.

## Consequences

- Every new write surface must obey the lock hierarchy: generation lock before document locks, audited reads before SQLite writer locks, and outer-boundary retries for expanded audit budgets.
- Shutdown handlers must bound draining without abruptly cancelling thread-pool commits.
