import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(frontendRoot, 'dist')
const manifest = JSON.parse(fs.readFileSync(path.join(distRoot, '.vite', 'manifest.json'), 'utf8'))

function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function assetSize(file) {
  const content = fs.readFileSync(path.join(distRoot, file))
  return { raw: content.length, gzip: gzipSync(content).length }
}

function graphFrom(entries) {
  const pending = [...entries]
  const seen = new Set()
  while (pending.length) {
    const key = pending.pop()
    if (!key || seen.has(key)) continue
    seen.add(key)
    for (const imported of manifest[key]?.imports ?? []) pending.push(imported)
  }
  return [...seen]
}

function summarize(keys) {
  return keys.reduce(
    (total, key) => {
      const file = manifest[key]?.file
      if (!file) return total
      const size = assetSize(file)
      return { raw: total.raw + size.raw, gzip: total.gzip + size.gzip }
    },
    { raw: 0, gzip: 0 },
  )
}

const entryKeys = Object.keys(manifest).filter((key) => manifest[key].isEntry)
const initialKeys = graphFrom(entryKeys)
const initial = summarize(initialKeys)

console.log('Initial entry graph')
console.log(`  ${formatBytes(initial.raw)} raw · ${formatBytes(initial.gzip)} gzip`)
for (const key of initialKeys) {
  const file = manifest[key].file
  const size = assetSize(file)
  console.log(`  ${file}: ${formatBytes(size.raw)} raw · ${formatBytes(size.gzip)} gzip`)
}

const featureChunks = [
  ['Editor', 'src/components/MarkdownEditor.tsx'],
  ['PDF research', 'src/components/PdfResearchWorkspace.tsx'],
  ['Markdown and Mermaid', '_MarkdownPreview-'],
  ['Revision diff', 'src/components/PierreRevisionDiff.tsx'],
  ['Chat', 'src/components/ChatPanel.tsx'],
]

console.log('\nFeature chunks')
for (const [label, source] of featureChunks) {
  const key = Object.keys(manifest).find((candidate) => candidate.includes(source))
  if (!key) {
    console.log(`  ${label}: not present in this production build`)
    continue
  }
  const file = manifest[key].file
  const size = assetSize(file)
  console.log(`  ${label} (${file}): ${formatBytes(size.raw)} raw · ${formatBytes(size.gzip)} gzip`)
}
