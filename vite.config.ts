import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // local development only: `npm run dev:server` in one terminal, `npm run dev` in another
    proxy: { '/api': 'http://localhost:8080' }
  }
});
