import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      // ダッシュボード (index.html) と W-SSO のログイン画面 (sso.html) の 2 ページ (web フォルダからの相対パス)
      input: { main: 'index.html', sso: 'sso.html' },
    },
  },
});
