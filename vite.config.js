import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so a static build works from a subdirectory
  // (GitHub Pages) as well as from a domain root.
  base: './',
  server: { port: 5173 },
});
