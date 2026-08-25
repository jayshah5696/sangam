import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const stylesDirectory = new URL('../src/styles/', import.meta.url)
const sourceDirectory = new URL('../src/', import.meta.url)
const files = (await readdir(stylesDirectory)).filter((file) => file.endsWith('.css'))
const violations = []
const definedVariables = new Set()
const forbidden = [
  [/font-size:\s*[\d.]+px\b/g, 'use a semantic text token (raw px font sizes are only allowed in tokens.css)'],
  [/font-size:\s*[\d.]+rem\b/g, 'use a semantic text token (raw rem font sizes are only allowed in tokens.css)'],
  [/font-size:\s*clamp\(/g, 'use a display text token defined in tokens.css'],
  [/font-family:\s*(?:Inter|Georgia|"SFMono-Regular")/g, 'use a semantic font token'],
  [/font:\s*[^;]*(?:Inter|Georgia|"SFMono-Regular")/g, 'use semantic font tokens in font shorthand'],
  [/border-radius:\s*(?:5|6|7|8|9|10|11|12|99|999)px\b/g, 'use a semantic radius token'],
  [
    /transition(?:-duration|-delay)?:\s*[^;]*\b(?:\d+(?:\.\d+)?m?s|\.\d+s)\b/g,
    'use a semantic motion token (raw transition durations and delays are only allowed in tokens.css)',
  ],
  [/cubic-bezier\(/g, 'use a semantic easing token defined in tokens.css'],
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

const sourceFiles = (await readdir(sourceDirectory, { recursive: true })).filter((file) =>
  file.endsWith('.tsx'),
)
for (const file of sourceFiles) {
  const source = await readFile(new URL(file, sourceDirectory), 'utf8')
  for (const [index, line] of source.split('\n').entries()) {
    if (/\bsize=\{[^}\n]*\b\d+(?:\.\d+)?\b[^}\n]*\}/.test(line)) {
      violations.push(
        `${join('src', file)}:${index + 1}: use a semantic icon size token instead of a raw number`,
      )
    }
  }
}

if (violations.length) {
  console.error(`UI system violations:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('UI system token check passed.')
}
