import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { localBackend } from './server/devPlugin.ts';

export default defineConfig({
  plugins: [react(), localBackend()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
