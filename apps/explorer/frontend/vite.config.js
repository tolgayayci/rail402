import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port 4091: outside the upstream e2e suite's 4022-4030 allocator band (repo convention).
export default defineConfig({
  plugins: [react()],
  server: { port: 4091 },
  preview: { port: 4091 },
});
