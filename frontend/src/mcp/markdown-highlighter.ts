import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export { createOnigurumaEngine } from 'shiki/engine/oniguruma'

// Only the self-contained MCP build uses this bundle. Its review files are Markdown;
// Pierre supplies the shared themes. The main app keeps the complete Shiki bundle.
// https://shiki.style/guide/bundles#fine-grained-bundle
const markdown = () => import('@shikijs/langs/markdown')
export const bundledLanguages = { markdown, md: markdown }
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: createJavaScriptRegexEngine,
})
export const { codeToHtml } = createSingletonShorthands(createHighlighter)
