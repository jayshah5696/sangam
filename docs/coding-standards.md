# Coding standards

Sangam uses automated checks for rules that tools can enforce reliably. Reviewers
must still check domain logic, error recovery, and whether an abstraction is needed.

## Python

- Annotate function parameters and return values. `just typecheck` checks all of
  `src/sangam` with mypy, including untyped definitions and returns of `Any` from
  typed functions. Missing third-party stubs remain allowed.
- Use `Literal` or enums for fixed sets of values. Handle every variant in a
  `match` statement. Mypy enables `exhaustive-match`. A catch-all still counts as
  handling every case, so avoid one when a new variant needs explicit behavior.
- Catch specific exceptions. A broad catch must preserve the traceback through
  re-raising or exception logging. Ruff checks this with `BLE001`. Recovery at an
  application boundary can require a documented, local exception to the rule.
- Use explicit timezones. Ruff checks datetime operations with `DTZ`.
- Pass logging values as arguments rather than formatting the message first.
  Ruff checks this with `G`.
- Do not use `eval`, unsafe YAML loading, or `subprocess` with `shell=True`.
  Ruff checks these patterns with `S307`, `S506`, and `S602`.
- Keep the existing Ruff checks for imports, likely bugs, simplifications, and
  modern Python syntax. Format Python with Ruff.
- Include an error code in each `type: ignore`. Remove unused ignores and
  redundant casts. Mypy checks these requirements.

### Published guidance and enforcement

The Python policy follows the
[Google Python style guide](https://google.github.io/styleguide/pyguide.html),
[PEP 8](https://peps.python.org/pep-0008/), and the correctness checks in
[Ruff](https://docs.astral.sh/ruff/rules/) and
[mypy strict mode](https://mypy.readthedocs.io/en/stable/existing_code.html#introduce-stricter-options).
The checks apply to application code, scripts, and tests unless a scope is named
below. We keep stable rule families enabled as a unit so new checks in a reviewed
Ruff upgrade also apply.

- Use PEP 8 names and avoid shadowing builtins. Ruff enables `N` and `A`. Use
  Pydantic aliases when an external JSON field uses a different naming convention.
- Keep imports at module scope. Ruff enables Pylint's `PLC` checks. A local
  import needs a specific reason, such as an unavoidable import cycle or an
  optional dependency. Do not move a cycle to startup just to satisfy the rule.
- Do not share mutable defaults accidentally. Existing Bugbear checks cover
  function defaults; `RUF008` and `RUF012` cover dataclasses and class attributes.
  Use an instance factory, an immutable value, or an explicit `ClassVar` as appropriate.
- Keep comprehensions simple. `GPC001` rejects multiple `for` clauses, multiple
  filter clauses, and nested comprehensions, including generator expressions.
  This implements Google's section 2.7. Use an ordinary loop when logic is complex.
  Ruff's `C4` checks unnecessary comprehensions and container conversions.
- Use complete branches for complicated choices. `GPC002` rejects conditional
  expressions nested in another conditional expression. This is Sangam's explicit
  interpretation of Google's section 2.11, not a rule quoted from Google.
- Make return and exception flow clear. Ruff enables `RET`, `PLE`, `PLW`,
  `TRY002`, `TRY203`, `TRY400`, and `TRY401`. These catch inconsistent returns,
  control-flow mistakes, generic exceptions, redundant handlers, and lost or
  duplicated exception information. Bugbear already checks control flow in `finally`.
- Use standard constructs instead of redundant code. Ruff's `PIE` checks cover
  duplicate definitions and unnecessary constructs. `LOG` checks logging API use.
- Do not block the event loop with synchronous HTTP, subprocess, filesystem,
  or sleep calls. Ruff enables `ASYNC`. Use an async API or offload blocking work
  with the existing bounded runner or `asyncio.to_thread`. These checks identify
  known APIs; review must still catch blocking calls hidden inside project helpers.
- Write existing docstrings in Google's format. Ruff enables `D2`, `D3`, and
  `D4` with `convention = "google"`. Explain parameters, meaningful return values,
  side effects, and expected failures. The linter checks formatting and documented
  parameters; it does not prove that a description is accurate or require a
  boilerplate docstring on every function.
- Use strict types throughout `src/sangam`. Mypy strict mode checks generic
  arguments, untyped calls and decorators, and invalid equality comparisons in
  addition to the earlier annotation checks. Optional checks reject potentially
  undefined variables and unused awaitables. Imported libraries without stubs
  remain allowed; this is an explicit limit on what type checking can prove.
- Remove obsolete lint exceptions. Ruff's `RUF100` checks that `noqa` comments
  still suppress a diagnostic.

### Rules that need review

Follow Google's guidance on focused functions, resource cleanup, and shared
mutable state. A long function needs a review of its responsibilities. Google
suggests reconsidering functions above about 40 lines but explicitly sets no hard
limit, so CI does not impose one. Use context managers to close resources and
locks to protect shared state. A type or syntax check cannot prove thread safety.

Use `is not None` when zero or an empty value is valid. Prefer simple loops and
comprehensions over `map` or `filter` with a lambda. A callable's return type should
describe its domain result; validate external data before using it internally.
Review error paths for retries, cleanup, and preserved failures.

Sangam keeps its 100-column formatter setting and existing direct symbol imports.
These differ from Google's exact layout and import conventions. We do not ban
FastAPI dependency defaults, Pydantic models, nested transaction callbacks, or
necessary exception boundaries merely because a general rule has exceptions.
Document each necessary suppression locally with its exact rule code.

## TypeScript

- Keep strict compilation and unchecked indexed access checks enabled.
- Preserve type evidence. The existing vendored
  [anti-slop rules](https://github.com/dmmulroy/anti-slop) reject unsafe assertions
  and widening. Non-const assertions need a preceding `SAFETY` comment.
- Handle every union or enum member in a `switch`. Type-aware ESLint enables
  `switch-exhaustiveness-check` for application sources. A default branch does
  not excuse missing members of a union.
- Await, return, or handle promises. ESLint enables `no-floating-promises` for
  application sources, including colocated tests. An explicit `void` marks
  intentional detachment but does not handle rejection. Detached work still
  needs error handling or an API that guarantees it.
- Validate external data with Zod at the boundary. Internal operations should
  use the resulting domain types.

The type-aware ESLint rules use the application TypeScript project. Browser test
drivers and tooling keep their existing lint coverage; they are outside that
project. The anti-slop plugin permits module mocking in test files only.

## Enforcement

Run `just lint`, `just typecheck`, and `just test` before submitting changes.
`just test-python` runs Python lint, format, types, API-contract checks, and tests.
`just lint-python` includes `just python-standards`, which checks the Google-derived
expression rules. `just test-python-standards` checks accepted and rejected syntax
and the checker's CLI failure behavior. Both are part of `just test-python` in CI.
`just test-frontend` runs frontend format, build, lint, and unit tests. CI runs
both recipes. Browser behavior also requires `just test-e2e`.

Use a local suppression only when the rule rejects necessary behavior. Explain
the invariant next to it and name the exact rule. Do not disable a rule across a
file or weaken a type just to pass CI. For new custom rules, write failure cases
before implementing the rule and prove that valid code still passes.
