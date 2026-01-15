import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  build: {
    ssr: true,
    target: 'node16', // VS Code uses a recent Node version
    lib: {
      entry: path.resolve(__dirname, 'src/backend/extension.ts'),
      fileName: () => 'extension.js',
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        'vscode',
        'fs',
        'path',
        'os',
        'util',
        'assert',
        'child_process',
        'crypto',
        'tty',
        'worker_threads',
        'module',
        'url',
        'net',
        'events',
        'stream',
        'http',
        'https',
        'zlib',
        'constants',
        'buffer',
      ],
      output: {
        dir: 'out',
        entryFileNames: 'extension.js',
        // Preserve module structure if needed, or bundle to single file
        // For simple extensions, single file is fine.
      },
    },
    outDir: 'out',
    emptyOutDir: false, // Don't clear out (frontend might be writing there too or we want to keep assets)
    sourcemap: true,
    minify: false, // Useful for debugging
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, './src'),
    },
  },
})
