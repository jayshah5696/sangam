import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pyproject = fs.readFileSync(path.join(projectRoot, 'pyproject.toml'), 'utf8')
const versionMatch = pyproject.match(/^version = "([^"]+)"$/m)

if (!versionMatch) {
  throw new Error('Unable to read the Sangam version from pyproject.toml')
}

const sangamVersion = versionMatch[1]

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    {
      name: 'sangam-version-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: `${JSON.stringify({ version: sangamVersion })}\n`,
        })
      },
    },
  ],
  define: {
    __SANGAM_VERSION__: JSON.stringify(sangamVersion),
  },
  build: {
    // CodeMirror and the complete Mermaid renderer are optional lazy chunks.
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
