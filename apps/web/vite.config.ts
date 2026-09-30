import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ENGINE = process.env.JASPER_ENGINE_URL ?? 'http://127.0.0.1:47900';
const WS_ENGINE = ENGINE.replace(/^http/, 'ws');

// Same-origin in dev: the Vite server proxies every engine path (ARCHITECTURE §4.1). The Host header is
// kept (changeOrigin: false); the dev engine accepts 127.0.0.1:5173 / localhost:5173.
const http = { target: ENGINE, changeOrigin: false };

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
		proxy: {
			'/api': http,
			'/events': http,
			'/media': http,
			'/mg': http,
			'/renders': http,
			'/fonts': http,
			'/health': http,
			'/agent': { target: WS_ENGINE, ws: true, changeOrigin: false },
		},
	},
	preview: { host: '127.0.0.1', port: 4173 },
	build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
