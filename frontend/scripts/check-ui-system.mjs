import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const stylesDirectory = new URL('../src/styles/', import.meta.url)
const files = (await readdir(stylesDirectory)).filter((file) => file.endsWith('.css'))
const violations = []
const definedVariables = new Set()
const forbidden = [
  [/font-size:\s*(?:8|9|10|11|12|13|14)px\b/g, 'use a semantic text token'],
  [/font-family:\s*(?:Inter|Georgia|"SFMono-Regular")/g, 'use a semantic font token'],
  [/font:\s*[^;]*(?:Inter|Georgia|"SFMono-Regular")/g, 'use semantic font tokens in font shorthand'],
  [/border-radius:\s*(?:5|6|7|8|9|10|11|12|99|999)px\b/g, 'use a semantic radius token'],
]

const sources = new Map()
for (const file of files) {
  const source = await readFile(new URL(file, stylesDirectory), 'utf8')
  sources.set(file, source)
  for (const match of source.matchAll(/--[a-zA-Z0-9_-]+\s*:/g)) {
    definedVariables.add(match[0].slice(0, -1).trim())
  }
}

for (const [file, source] of sources) {
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    if (file !== 'tokens.css') {
      for (const [pattern, guidance] of forbidden) {
        pattern.lastIndex = 0
        if (pattern.test(line)) violations.push(`${join('src/styles', file)}:${index + 1}: ${guidance}`)
      }
    }
    for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      if (!definedVariables.has(match[1])) {
        violations.push(`${join('src/styles', file)}:${index + 1}: define ${match[1]} before using it`)
      }
    }
  }
}

if (violations.length) {
  console.error(`UI system violations:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('UI system token check passed.')
}
