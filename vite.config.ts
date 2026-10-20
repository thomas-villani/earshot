import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  // relative base works for both username.github.io/earshot/ and local preview
  base: './',
  plugins: [basicSsl()],
  server: { host: true },
});
