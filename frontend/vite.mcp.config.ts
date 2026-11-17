import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: new URL('./src/mcp/markdown-highlighter.ts', import.meta.url).pathname,
      },
    ],
  },
  build: {
    outDir: 'dist/mcp-app',
    rollupOptions: { input: 'mcp-app.html' },
    assetsInlineLimit: 100_000_000,
  },
})
