// Dev server authentication (security review DEV-1 / AGT-2). Node only: used by vite.config.ts.
//
// A dev engine (`pnpm dev:engine`, JASPER_DEV=1) has a token like every other engine, and the browser never sees it:
// the Vite dev server is the engine's client. It finds the engine's runtime file (`<appdir>/engine/runtime.json`,
// 0600: the path comes from the engine's public `/health`, else from JASPER_APPDIR or the checkout's `.stage`) and
//  - adds `Authorization: Bearer <token>` to every request it proxies (HTTP and the `/agent` WebSocket), re-reading
//    the file when it changes, so a `tsx watch` restart of the engine (a new token) needs no reload;
//  - gives the browser the dev editor key (`<appdir>/engine/editor-key.dev`, 0600, written by dev engines only) as
//    an HttpOnly, SameSite=Strict cookie on page loads. With it the engine knows the editor window from an agent:
//    requests through this proxy without the cookie (a script, a sandboxed motion-graphics page) are an agent's.
//
// What this leaves open, in dev only: the dev server's own port. Whoever can open a page on it is handed the
// editor cookie, and its proxy speaks for the engine's token. A web page cannot (Host and Origin checks, and it
// cannot read the HttpOnly cookie); another process on the machine can. A dev checkout is not a boundary against
// local processes — they can edit the sources — and docs/security-review.md says so. Packaged builds have no dev
// server, and the editor key never touches the disk there.
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
/** Cookie names (packages/api/src/common.ts: EDITOR_COOKIE and portCookieName). */
const EDITOR_COOKIE = 'jasper_editor';
const SECRET_RE = /^[A-Za-z0-9_-]{16,512}$/;

type RuntimeInfo = { token: string | null; port: number; file: string; mtimeMs: number };

export type DevAuth = {
	/** The engine's token (null: not found yet, or an insecure engine). Cheap: re-reads the file only when it changed. */
	token(): string | null;
	/** `Set-Cookie` value that makes the browser the editor, or null when the engine has no dev editor key. */
	editorCookie(): string | null;
	/** Looks for the engine again (after a 401, or when it was not running yet). */
	refresh(): Promise<void>;
};

function readJson(file: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Candidate runtime files when the engine does not answer `/health` yet. */
function fallbackRuntimeFiles(env: NodeJS.ProcessEnv): string[] {
	const out: string[] = [];
	const add = (appdir: string) => {
		const f = join(appdir, 'engine', 'runtime.json');
		if (!out.includes(f)) out.push(f);
	};
	const appdir = env.JASPER_APPDIR;
	if (appdir) {
		if (isAbsolute(appdir)) add(appdir);
		else {
			// `pnpm --filter @jasper/web …` runs in apps/web; the engine command usually ran at the repository root.
			add(resolve(process.cwd(), appdir));
			add(resolve(REPO_ROOT, appdir));
		}
	}
	add(join(REPO_ROOT, '.stage'));
	return out;
}

export function createDevAuth(
	engineUrl: string,
	opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; log?(line: string): void } = {},
): DevAuth {
	const env = opts.env ?? process.env;
	const doFetch = opts.fetch ?? globalThis.fetch;
	const enginePort = Number(new URL(engineUrl).port || 80);
	let runtimeFile: string | null = null;
	let info: RuntimeInfo | null = null;
	let lastLookup = 0;
	let looking: Promise<void> | null = null;
	let warned = false;

	const load = (file: string): RuntimeInfo | null => {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return null;
		}
		if (info && info.file === file && info.mtimeMs === mtimeMs) return info;
		const raw = readJson(file);
		// The file must describe the engine this server proxies to, not another one that shares the appdir name.
		if (!raw || raw.port !== enginePort) return null;
		const token = typeof raw.token === 'string' && raw.token ? raw.token : null;
		return { token, port: enginePort, file, mtimeMs };
	};

	const refresh = (): Promise<void> => {
		looking ??= (async () => {
			lastLookup = Date.now();
			try {
				const res = await doFetch(`${engineUrl.replace(/\/$/, '')}/health`, {
					signal: AbortSignal.timeout(1500),
				});
				const body = (await res.json()) as { runtimeFile?: unknown };
				if (typeof body.runtimeFile === 'string' && isAbsolute(body.runtimeFile))
					runtimeFile = body.runtimeFile;
			} catch {
				// engine not up yet: the fallbacks below
			}
			if (!runtimeFile) runtimeFile = fallbackRuntimeFiles(env).find((f) => load(f) !== null) ?? null;
			if (runtimeFile) info = load(runtimeFile) ?? null;
		})().finally(() => {
			looking = null;
		});
		return looking;
	};
	void refresh();

	const current = (): RuntimeInfo | null => {
		if (runtimeFile) {
			const next = load(runtimeFile);
			if (next) info = next;
			else if (Date.now() - lastLookup > 1000) void refresh(); // the engine restarted or moved
		} else if (Date.now() - lastLookup > 1000) void refresh();
		return info;
	};

	return {
		token() {
			const t = current()?.token ?? null;
			if (!t && runtimeFile && !warned && current() && opts.log) {
				warned = true;
				opts.log('the engine has no token (JASPER_INSECURE_DEV): requests are proxied without one');
			}
			return t;
		},
		editorCookie() {
			const r = current();
			if (!r) return null;
			let key: string;
			try {
				key = readFileSync(join(dirname(r.file), 'editor-key.dev'), 'utf8').trim();
			} catch {
				return null;
			}
			if (!SECRET_RE.test(key)) return null;
			return `${EDITOR_COOKIE}_${r.port}=${key}; Path=/; HttpOnly; SameSite=Strict`;
		},
		refresh,
	};
}

type ProxyReq = { setHeader(name: string, value: string): void };
type ProxyEvents = {
	on(event: 'proxyReq' | 'proxyReqWs', cb: (proxyReq: ProxyReq, req: IncomingMessage) => void): void;
	on(event: 'proxyRes', cb: (proxyRes: IncomingMessage, req: IncomingMessage) => void): void;
};

/** Paths the dev server forwards to the engine (vite.config.ts `server.proxy`). */
export const ENGINE_PROXY_PATHS = [
	'/api',
	'/events',
	'/media',
	'/mg',
	'/renders',
	'/fonts',
	'/health',
	'/agent',
];

const isProxied = (url: string | undefined): boolean => {
	const path = (url ?? '').split('?')[0]!;
	return ENGINE_PROXY_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
};

/** `configure` of a Vite proxy entry: authenticates what the dev server forwards to the engine. */
export function authenticateProxy(auth: DevAuth) {
	return (proxy: unknown): void => {
		const p = proxy as ProxyEvents;
		const add = (proxyReq: ProxyReq, req: IncomingMessage) => {
			// A client that brings its own credentials (jasper-mcp pointed at the dev server) keeps them.
			if (req.headers.authorization) return;
			const token = auth.token();
			if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
		};
		p.on('proxyReq', add);
		p.on('proxyReqWs', add);
		p.on('proxyRes', (proxyRes, req) => {
			if (proxyRes.statusCode === 401) void auth.refresh();
			// The editor polls /health until the engine is up. A page that was loaded before the engine started (so
			// before there was a key to hand out) becomes the editor here, without a reload.
			if ((req.url ?? '').split('?')[0] === '/health' && proxyRes.statusCode === 200) {
				const cookie = auth.editorCookie();
				if (cookie) proxyRes.headers['set-cookie'] = [cookie];
			}
		});
	};
}

/** Connect middleware: loads of the app's own pages receive the dev editor cookie. */
export function editorCookieMiddleware(auth: DevAuth) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
		const isDocument =
			req.method === 'GET' &&
			!isProxied(req.url) &&
			(req.headers['sec-fetch-dest'] === 'document' ||
				(req.headers['sec-fetch-dest'] === undefined && (req.headers.accept ?? '').includes('text/html')));
		if (isDocument) {
			const cookie = auth.editorCookie();
			if (cookie) res.setHeader('Set-Cookie', cookie);
		}
		next();
	};
}
