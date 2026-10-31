import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Fixed port: it must match CORS_ORIGIN in backend/.env. Fail instead of silently using another port.
  server: { port: 5173, strictPort: true },
});
