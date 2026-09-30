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
	build: {
		outDir: 'dist',
		sourcemap: true,
		target: 'es2022',
		rollupOptions: {
			output: {
				// Stable vendor chunks so app changes do not invalidate them (ARCHITECTURE §13 startup).
				manualChunks(id) {
					// The pure model (schema, commands, render snapshot) is the biggest first-party module and
					// changes less often than the app: its own chunk keeps the entry chunk under 500 kB.
					if (/[\\/]packages[\\/]project[\\/]src[\\/]/.test(id)) return 'app-project';
					if (!id.includes('node_modules')) return undefined;
					if (/[\\/](remotion|@remotion)[\\/]/.test(id)) return 'vendor-remotion';
					if (/[\\/](dockview|dockview-core|dockview-react)[\\/]/.test(id)) return 'vendor-dockview';
					if (/[\\/](@radix-ui|radix-ui|@floating-ui)[\\/]/.test(id)) return 'vendor-radix';
					if (/[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'vendor-react';
					if (/[\\/](zod|immer|zustand)[\\/]/.test(id)) return 'vendor-state';
					if (/[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
					return 'vendor';
				},
			},
		},
	},
});
