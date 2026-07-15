import { globSync, readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { default: mermaid } = await import('mermaid')

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })

const files = ['README.md', ...globSync('docs/**/*.md')]
let diagramCount = 0

for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const match of content.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    diagramCount += 1
    try {
      await mermaid.parse(match[1], { suppressErrors: false })
    } catch (error) {
      throw new Error(`Invalid Mermaid diagram ${diagramCount} in ${file}`, { cause: error })
    }
  }
}

console.log(`Parsed ${diagramCount} Mermaid diagrams with securityLevel=strict.`)
