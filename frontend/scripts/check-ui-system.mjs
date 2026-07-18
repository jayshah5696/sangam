import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const stylesDirectory = new URL('../src/styles/', import.meta.url)
const files = (await readdir(stylesDirectory)).filter((file) => file.endsWith('.css'))
const violations = []
const forbidden = [
  [/font-size:\s*(?:8|9|10|11|12|13|14)px\b/g, 'use a semantic text token'],
  [/font-family:\s*(?:Inter|Georgia|"SFMono-Regular")/g, 'use a semantic font token'],
  [/border-radius:\s*(?:5|6|7|8|9|10|11|12|99|999)px\b/g, 'use a semantic radius token'],
]

for (const file of files) {
  if (file === 'tokens.css') continue
  const source = await readFile(new URL(file, stylesDirectory), 'utf8')
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const [pattern, guidance] of forbidden) {
      pattern.lastIndex = 0
      if (pattern.test(line)) violations.push(`${join('src/styles', file)}:${index + 1}: ${guidance}`)
    }
  }
}

if (violations.length) {
  console.error(`UI system violations:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('UI system token check passed.')
}
