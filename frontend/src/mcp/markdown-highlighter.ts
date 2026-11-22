import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export { createOnigurumaEngine } from 'shiki/engine/oniguruma'

const markdown = () => import('@shikijs/langs/markdown')
export const bundledLanguages = { markdown, md: markdown }
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: createJavaScriptRegexEngine,
})
export const { codeToHtml } = createSingletonShorthands(createHighlighter)
