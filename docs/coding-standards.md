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

The [Google Python style guide](https://google.github.io/styleguide/pyguide.html)
is a reference for readable code and exception handling. We adopt selected rules,
not the entire guide. Prefer simple comprehensions and clear loops. Use
`is not None` when zero or an empty value is valid. These decisions need review.

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
`just test-frontend` runs frontend format, build, lint, and unit tests. CI runs
both recipes. Browser behavior also requires `just test-e2e`.

Use a local suppression only when the rule rejects necessary behavior. Explain
the invariant next to it and name the exact rule. Do not disable a rule across a
file or weaken a type just to pass CI. For new custom rules, write failure cases
before implementing the rule and prove that valid code still passes.
