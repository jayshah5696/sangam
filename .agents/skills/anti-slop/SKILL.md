---
name: anti-slop
description: Reject low-evidence TypeScript and JavaScript patterns ("code slop") and maintain opinionated Oxlint anti-slop rules in Sangam.
---

# Anti-Slop Guidelines for Sangam

Sangam uses opinionated Oxlint rules vendored in `frontend/tools/oxlint/anti-slop/` to enforce high-evidence, high-signal TypeScript and JavaScript practices.

## Core Rules and Principles

1. **No Chained Type Assertions (`no-chained-type-assertions`)**:
   - Never write `as unknown as T` or double type assertions to bypass the type system.
   - Fix the underlying type signature, create an adapter, or parse the data at the boundary.

2. **Mandatory Safety Justifications (`require-safety-comment-for-type-assertion`)**:
   - Every non-const `as T` type assertion must have an immediately preceding `// SAFETY: <justification>` comment explaining why the invariant holds.
   - Const assertions (`as const`) do not require safety comments.

3. **No Known Value Widening (`no-known-value-widening`)**:
   - Do not annotate object literals or dictionary variables with wide open types (e.g. `Record<string, ...>` or wide interfaces) when exact literal inference is available.
   - Use TypeScript's `satisfies` operator to validate shape while preserving exact type evidence:
     ```ts
     export const baseThemeColors = { ... } satisfies Record<ThemeId, Record<ThemeColorKey, string>>
     ```

4. **Parse, Don't Cast at I/O Boundaries (`no-unsafe-dictionary-type`, `no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`)**:
   - Avoid `Record<string, unknown>` or loose `typeof x === 'string'` checks on untyped data.
   - Use Zod schemas (e.g., `schema.safeParse(json)`) to establish concrete domain contracts at I/O and storage boundaries.

5. **No Conditional Empty Object Spread (`no-conditional-empty-object-spread`)**:
   - Avoid `...(condition ? { key: value } : {})`.
   - Prefer explicit property assignments or structured construction.

6. **No Module Mocking in Application Code (`no-module-mocking`)**:
   - Do not use runtime module mocking hacks in production source code.

## Verification Workflow

Run the canonical just recipe:

```bash
just anti-slop
```

Or run the complete lint gate:

```bash
just lint
```
