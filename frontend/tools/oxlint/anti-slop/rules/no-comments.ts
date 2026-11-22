import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const ruleDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(ruleDirectory, "../../..");
const defaultRatchetPath = resolve(ruleDirectory, "../../comment-ratchet.json");

const directivePattern =
  /^\s*(?:SAFETY:|eslint-disable|eslint-enable|eslint\b|oxlint-disable|oxlint-enable|@ts-(?:expect-error|ignore|nocheck|check)\b|@vitest-environment\b|@?vite-ignore\b|prettier-ignore\b|(?:istanbul|v8|c8)\s+ignore\b|\/\s*<reference\b)/u;

export type CommentLike = {
  type: "Line" | "Block" | "Shebang";
  value: string;
};

/** Return true when a comment is JSDoc, a shebang, or a supported tool/safety directive. */
export function isAllowedComment(comment: CommentLike): boolean {
  if (comment.type === "Shebang") return true;
  if (
    comment.type === "Block" &&
    comment.value.startsWith("*") &&
    !comment.value.startsWith("**")
  ) {
    return true;
  }
  return directivePattern.test(comment.value);
}

/** Load the per-file comment ratchet map from a JSON file. */
export function loadCommentRatchet(ratchetPath = defaultRatchetPath): Record<string, number> {
  const raw = readFileSync(ratchetPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("files" in parsed) ||
    typeof parsed.files !== "object" ||
    parsed.files === null
  ) {
    throw new Error(`Invalid comment ratchet schema in ${ratchetPath}`);
  }
  const result: Record<string, number> = {};
  for (const [filePath, budget] of Object.entries(parsed.files)) {
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
      throw new Error(`Invalid comment ratchet budget for ${filePath}`);
    }
    result[filePath] = budget;
  }
  return result;
}

/** Evaluate disallowed comments in one file against its ratchet budget. */
export function evaluateCommentsAgainstBudget<T extends CommentLike>(
  comments: readonly T[],
  budget: number,
): { excess: T[]; needsTightening: boolean; disallowedCount: number } {
  const disallowed = comments.filter((comment) => !isAllowedComment(comment));
  return {
    excess: disallowed.slice(budget),
    needsTightening: budget > 0 && disallowed.length < budget,
    disallowedCount: disallowed.length,
  };
}

const cachedRatchet = loadCommentRatchet();

function normalizeRelativePath(filename: string): string {
  return relative(frontendRoot, filename).replaceAll("\\", "/");
}

/** Ban implementation comments while allowing JSDoc, directives, SAFETY notes, and ratcheted legacy counts. */
export const noCommentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban implementation comments while allowing JSDoc, tool directives, SAFETY justifications, and a per-file ratchet baseline.",
    },
    messages: {
      forbiddenComment:
        "Delete implementation comments; record non-obvious decisions in docs/adr/ or file an issue for workarounds.",
      staleRatchet:
        "File '{{file}}' has {{actual}} implementation comments, below ratchet budget {{budget}}; lower or remove its entry in frontend/tools/oxlint/comment-ratchet.json.",
    },
  },
  createOnce(context) {
    return {
      Program(node: ESTree.Program) {
        const relPath = normalizeRelativePath(context.filename);
        const budget = cachedRatchet[relPath] ?? 0;
        const { excess, needsTightening, disallowedCount } = evaluateCommentsAgainstBudget(
          context.sourceCode.getAllComments(),
          budget,
        );

        for (const comment of excess) {
          context.report({
            loc: comment.loc,
            messageId: "forbiddenComment",
          });
        }

        if (needsTightening) {
          context.report({
            node,
            messageId: "staleRatchet",
            data: {
              file: relPath,
              actual: String(disallowedCount),
              budget: String(budget),
            },
          });
        }
      },
    };
  },
});
