import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? './',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:3100' },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '**/.git/**', '**/.runtime/**', '**/backups/**'] },
  },
  build: { rolldownOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), product: resolve(import.meta.dirname, 'product.html') } } },
})
