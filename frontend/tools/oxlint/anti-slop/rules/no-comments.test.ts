import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  evaluateCommentsAgainstBudget,
  isAllowedComment,
  loadCommentRatchet,
} from "./no-comments.ts";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const oxlintBin = resolve(frontendRoot, "node_modules/.bin/oxlint");

describe("anti-slop/no-comments", () => {
  it("allows JSDoc, shebangs, SAFETY justifications, and tool directives", () => {
    expect(isAllowedComment({ type: "Block", value: "* Documented export. " })).toBe(true);
    expect(isAllowedComment({ type: "Shebang", value: "/usr/bin/env node" })).toBe(true);
    expect(isAllowedComment({ type: "Line", value: " SAFETY: validated by schema" })).toBe(true);
    expect(isAllowedComment({ type: "Line", value: " @vitest-environment jsdom" })).toBe(true);
    expect(isAllowedComment({ type: "Line", value: " eslint-disable-next-line no-console" })).toBe(
      true,
    );
    expect(isAllowedComment({ type: "Line", value: " oxlint-disable-next-line no-comments" })).toBe(
      true,
    );
    expect(isAllowedComment({ type: "Line", value: " @ts-expect-error intentional" })).toBe(true);
    expect(isAllowedComment({ type: "Line", value: " prettier-ignore" })).toBe(true);
    expect(isAllowedComment({ type: "Block", value: " @vite-ignore " })).toBe(true);
    expect(isAllowedComment({ type: "Line", value: '/ <reference types="vite/client" />' })).toBe(
      true,
    );
  });

  it("rejects implementation comments and triple-star block comments", () => {
    expect(isAllowedComment({ type: "Line", value: " explain what the next line does" })).toBe(
      false,
    );
    expect(isAllowedComment({ type: "Block", value: " inline note " })).toBe(false);
    expect(isAllowedComment({ type: "Block", value: "** banner comment " })).toBe(false);
  });

  it("enforces ratchet budgets and forces tightening when comments decrease", () => {
    const comments = [
      { type: "Block" as const, value: "* JSDoc stays exempt " },
      { type: "Line" as const, value: " SAFETY: exempt directive" },
      { type: "Line" as const, value: " first disallowed" },
      { type: "Line" as const, value: " second disallowed" },
    ];

    const zeroBudget = evaluateCommentsAgainstBudget(comments, 0);
    expect(zeroBudget.disallowedCount).toBe(2);
    expect(zeroBudget.excess).toHaveLength(2);
    expect(zeroBudget.needsTightening).toBe(false);

    const exactBudget = evaluateCommentsAgainstBudget(comments, 2);
    expect(exactBudget.excess).toHaveLength(0);
    expect(exactBudget.needsTightening).toBe(false);

    const staleBudget = evaluateCommentsAgainstBudget(comments, 3);
    expect(staleBudget.excess).toHaveLength(0);
    expect(staleBudget.needsTightening).toBe(true);
  });

  it("loads a ratchet JSON file and rejects malformed schemas", () => {
    const dir = mkdtempSync(join(tmpdir(), "sangam-comment-ratchet-"));
    try {
      const valid = join(dir, "valid.json");
      writeFileSync(valid, JSON.stringify({ files: { "src/example.ts": 2 } }), "utf8");
      expect(loadCommentRatchet(valid)).toEqual({ "src/example.ts": 2 });

      const invalid = join(dir, "invalid.json");
      writeFileSync(invalid, JSON.stringify({ files: { "src/example.ts": -1 } }), "utf8");
      expect(() => loadCommentRatchet(invalid)).toThrow(/Invalid comment ratchet budget/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces anti-slop/no-comments through the real oxlint CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "sangam-oxlint-no-comments-"));
    try {
      const cleanFile = join(dir, "clean.ts");
      writeFileSync(
        cleanFile,
        [
          "/** Public contract. */",
          "export function identity(value: string): string {",
          "  return value",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      execFileSync(oxlintBin, [cleanFile], { cwd: frontendRoot, encoding: "utf8" });

      const dirtyFile = join(dir, "dirty.ts");
      writeFileSync(dirtyFile, "// implementation note\nexport const answer = 42\n", "utf8");
      let failureOutput = "";
      try {
        execFileSync(oxlintBin, [dirtyFile], {
          cwd: frontendRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        if (error && typeof error === "object" && "stdout" in error) {
          failureOutput = String(error.stdout);
        }
      }
      expect(failureOutput).toContain("anti-slop(no-comments)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
