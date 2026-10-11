import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
// Security review DEV-1: the dev server authenticates to the engine (token from its runtime file) and hands the
// browser the dev editor key.
import { authenticateProxy, createDevAuth, type DevAuth, editorCookieMiddleware } from './dev-auth.ts';
// gaps (UI-6): UI strings through the active language's catalogue.
import { EDITOR_BOOT, editorBootScript, editorChunks } from './editor-boot.ts';
import { jasperI18n } from './i18n/vite-plugin.mjs';

const ENGINE = process.env.JASPER_ENGINE_URL ?? 'http://127.0.0.1:47900';
const WS_ENGINE = ENGINE.replace(/^http/, 'ws');

// Same-origin in dev: the Vite server proxies every engine path (ARCHITECTURE §4.1). The Host header is
// kept (changeOrigin: false); the dev engine accepts 127.0.0.1:5173 / localhost:5173. The proxy adds the engine's
// token (dev-auth.ts): the engine has no unauthenticated mode.
let devAuth: DevAuth | null = null;
const auth = (): DevAuth => {
	devAuth ??= createDevAuth(ENGINE, { log: (l) => console.warn(`[jasper dev] ${l}`) });
	return devAuth;
};
const configure: NonNullable<ProxyOptions['configure']> = (proxy) => authenticateProxy(auth())(proxy);
const http = { target: ENGINE, changeOrigin: false, configure };

/** Page loads (and the proxied /health poll) give the browser the dev editor key as an HttpOnly cookie. */
function jasperDevAuth(): Plugin {
	return {
		name: 'jasper-dev-auth',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use(editorCookieMiddleware(auth()));
		},
	};
}

// S11:FIX-010: the JavaScript third-party notices (generated at the repo root by `pnpm notices`) ship with the
// web build as /THIRD_PARTY_NOTICES.md (Help ▸ About links to it); the dev server serves the same file.
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';
function thirdPartyNotices(): Plugin {
	const source = () => readFileSync(fileURLToPath(new URL(`../../${NOTICES_FILE}`, import.meta.url)), 'utf8');
	return {
		name: 'jasper-third-party-notices',
		configureServer(server) {
			server.middlewares.use(`/${NOTICES_FILE}`, (_req, res) => {
				res.setHeader('content-type', 'text/markdown; charset=utf-8');
				res.end(source());
			});
		},
		generateBundle() {
			this.emitFile({ type: 'asset', fileName: NOTICES_FILE, source: source() });
		},
	};
}

// polish (project open): `/editor-boot.js` (editor-boot.ts) preloads the editor's chunks and starts fetching the
// project before the bundle has loaded. The build writes the chunk list; the dev server serves an empty one.
function editorBoot(): Plugin {
	return {
		name: 'jasper-editor-boot',
		configureServer(server) {
			server.middlewares.use(`/${EDITOR_BOOT}`, (_req, res) => {
				res.setHeader('content-type', 'text/javascript; charset=utf-8');
				res.end(editorBootScript([]));
			});
		},
		generateBundle(_options, bundle) {
			this.emitFile({
				type: 'asset',
				fileName: EDITOR_BOOT,
				source: editorBootScript(editorChunks(bundle)),
			});
		},
	};
}

/** Vendor chunk of a module id (stable chunks so app changes do not invalidate them, ARCHITECTURE §13). */
function vendorChunk(id: string): string | undefined {
	// The pure model (schema, commands, render snapshot) is the biggest first-party module and changes less
	// often than the app: its own chunk keeps the entry chunk under 500 kB.
	if (/[\\/]packages[\\/]project[\\/]src[\\/]/.test(id)) return 'app-project';
	if (!id.includes('node_modules')) return undefined;
	if (/[\\/](remotion|@remotion)[\\/]/.test(id)) return 'vendor-remotion';
	// S11:ANM-023: anime.js (reached through @jasper/compositions → @jasper/motion) in its own chunk.
	if (/[\\/]animejs[\\/]/.test(id)) return 'vendor-anime';
	if (/[\\/](dockview|dockview-core|dockview-react)[\\/]/.test(id)) return 'vendor-dockview';
	if (/[\\/](@radix-ui|radix-ui|@floating-ui)[\\/]/.test(id)) return 'vendor-radix';
	if (/[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return 'vendor-react';
	if (/[\\/](zod|immer|zustand)[\\/]/.test(id)) return 'vendor-state';
	if (/[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
	return 'vendor';
}

export default defineConfig({
	plugins: [jasperDevAuth(), jasperI18n(), react(), tailwindcss(), thirdPartyNotices(), editorBoot()],
	server: {
		host: '127.0.0.1',
		port: 5173,
		strictPort: true,
		// Transform the app's static module graph when the server starts, not when the first page asks for it: a cold
		// first load was ~hundreds of on-demand transforms long, and on a loaded machine long enough for Chromium to
		// abort it on a host network change (net::ERR_NETWORK_CHANGED; editor-boot.ts reloads it, verify workstream).
		warmup: { clientFiles: ['./index.html', './src/main.tsx'] },
		proxy: {
			'/api': http,
			'/events': http,
			'/media': http,
			'/mg': http,
			'/renders': http,
			'/fonts': http,
			'/health': http,
			'/agent': { target: WS_ENGINE, ws: true, changeOrigin: false, configure },
		},
	},
	preview: { host: '127.0.0.1', port: 4173 },
	build: {
		outDir: 'dist',
		sourcemap: true,
		target: 'es2022',
		rollupOptions: {
			output: {
				manualChunks: vendorChunk,
			},
		},
	},
});
