// Window security helpers (ARCHITECTURE §12, R-OMS §8.5/§9): pure functions, unit-tested without Electron.

/** Only web links and mail leave the app; file:, custom schemes and javascript: are dropped. */
export function isExternalUrlAllowed(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
	} catch {
		return false;
	}
}

/** In-app navigation must stay on the app origin (engine origin or the dev server). */
export function isSameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === new URL(origin).origin;
	} catch {
		return false;
	}
}

/** Media file extensions offered by the native import dialog (S04 ingest formats). */
export const MEDIA_EXTENSIONS = [
	'mp4',
	'mov',
	'm4v',
	'mkv',
	'webm',
	'avi',
	'mxf',
	'mts',
	'm2ts',
	'mp3',
	'wav',
	'aac',
	'm4a',
	'flac',
	'ogg',
	'opus',
	'png',
	'jpg',
	'jpeg',
	'webp',
	'gif',
	'tif',
	'tiff',
	'bmp',
	'svg',
] as const;

/** `revealInFolder` accepts only absolute paths without NUL bytes. */
export function isRevealablePath(p: unknown): p is string {
	return (
		typeof p === 'string' &&
		p.length > 0 &&
		p.length < 4096 &&
		!p.includes('\0') &&
		(p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
	);
}

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close' | 'focus';
export function isWindowAction(a: unknown): a is WindowAction {
	return a === 'minimize' || a === 'toggleMaximize' || a === 'close' || a === 'focus';
}

/** How an MCP client launches the jasper-mcp stdio server that ships with the app. */
export type McpLaunchInfo = { entry: string | null; command: string; env: Record<string, string> };

/**
 * Packaged builds have no `node`: the app binary runs the bundle as Node (ELECTRON_RUN_AS_NODE=1).
 * From a checkout (dev / packaged-like) plain `node` is used. `entry` is null when the bundle is missing.
 */
export function mcpLaunchInfo(opts: {
	packaged: boolean;
	entry: string;
	exists: boolean;
	execPath: string;
}): McpLaunchInfo {
	return {
		entry: opts.exists ? opts.entry : null,
		command: opts.packaged ? opts.execPath : 'node',
		env: opts.packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {},
	};
}

// ---------------------------------------------------------------- clipboard (wp-clipboard, S01:CLB-002/009)

/** The custom clipboard format next to `text/html` and `text/plain`. */
export const CLIPBOARD_CUSTOM_FORMAT = 'application/x-jasper-clipboard';
/** How Electron's clipboard addresses that raw OS format. */
export const ELECTRON_CLIPBOARD_FORMAT = `electron application/osclipboard;format="${CLIPBOARD_CUSTOM_FORMAT}"`;
/** Same cap as the payload parser (S01:CLB-009). */
export const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

export type ClipboardWrite = { json: string; html: string; text: string };

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * `jasper:clipboard-write` arguments: three strings within the caps, the JSON a JasperEditor clipboard object
 * (the renderer is not trusted to put anything else on the OS clipboard under our format).
 */
export function isClipboardWrite(v: unknown): v is ClipboardWrite {
	if (!v || typeof v !== 'object') return false;
	const { json, html, text } = v as Record<string, unknown>;
	if (typeof json !== 'string' || typeof html !== 'string' || typeof text !== 'string') return false;
	if (html.length > 2 * CLIPBOARD_MAX_BYTES || text.length > CLIPBOARD_MAX_BYTES) return false;
	if (utf8Bytes(json) > CLIPBOARD_MAX_BYTES) return false;
	return isJasperClipboardJson(json);
}

/** A JSON object with `format: "jasper-clipboard"` (the full schema check happens in the renderer on paste). */
function isJasperClipboardJson(json: string): boolean {
	try {
		const o = JSON.parse(json) as { format?: unknown } | null;
		return !!o && typeof o === 'object' && o.format === 'jasper-clipboard';
	} catch {
		return false;
	}
}

/** What `jasper:clipboard-read` hands back: the custom format's JSON when sane, else null. */
export function clipboardReadResult(raw: unknown): string | null {
	if (typeof raw !== 'string' || utf8Bytes(raw) > CLIPBOARD_MAX_BYTES) return null;
	return isJasperClipboardJson(raw) ? raw : null;
}

// ---------------------------------------------------------------- external files (wp-clipboard-2, S01:CLB-010)

/** Clipboard types that carry the files copied in a file manager (Electron exposes `text/uri-list`). */
export const CLIPBOARD_FILE_LIST_TYPE =
	/(^|")(text\/uri-list|public\.file-url|x-special\/gnome-copied-files)("|$)/;
/** At most this many pasted files are handed to the renderer. */
export const CLIPBOARD_MAX_FILES = 500;

/**
 * Absolute local paths of a clipboard file list: `text/uri-list` / `public.file-url` lines (`#` comments) or
 * GNOME's `copy\nfile://…` form. Only `file:` URLs on the local host count; other URLs and bad escapes are
 * dropped, and every path must pass `isRevealablePath`.
 */
export function parseClipboardFileList(raw: unknown, platform: string = process.platform): string[] {
	if (typeof raw !== 'string' || raw.length > CLIPBOARD_MAX_BYTES) return [];
	const out: string[] = [];
	for (const line of raw.split(/\r?\n|\0/)) {
		const s = line.trim();
		if (!s || s.startsWith('#')) continue;
		let url: URL;
		try {
			url = new URL(s);
		} catch {
			continue;
		}
		if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) continue;
		let path: string;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			continue;
		}
		// file:///C:/x → C:\x on Windows.
		if (platform === 'win32' && /^\/[A-Za-z]:\//.test(path)) path = path.slice(1).replace(/\//g, '\\');
		if (isRevealablePath(path) && !out.includes(path)) out.push(path);
		if (out.length >= CLIPBOARD_MAX_FILES) break;
	}
	return out;
}
