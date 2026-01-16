import { defineConfig } from 'vitest/config'
// @ts-ignore
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      vscode: path.resolve(__dirname, './src/test/vscode-mock.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
  server: {
    port: 9099,
    cors: true,
    hmr: {
      host: 'localhost',
    },
  },
  build: {
    outDir: 'out',
    emptyOutDir: false, // Don't wipe out extension build
    rollupOptions: {
      input: {
        SearchReplaceView: path.resolve(
          __dirname,
          'src/frontend/views/SearchReplace/SearchReplaceViewEntry.tsx'
        ),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
})
