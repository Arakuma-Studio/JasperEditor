import type {
	DesktopCaptureRect,
	DesktopClipboardWrite,
	DesktopMcpInfo,
	DesktopWindowAction,
} from '@jasper/api';
import { isOpenableFile } from '@jasper/config';

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
	'srt',
	'vtt',
	'scc',
	'mcc',
	'stl',
	'ttml',
	'dfxp',
	'xml',
	'fcpxml',
	'otio',
	'edl',
	'aaf',
	'omf',
	'ale',
	'glb',
	'gltf',
	'obj',
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

export function isWindowAction(a: unknown): a is DesktopWindowAction {
	return a === 'minimize' || a === 'toggleMaximize' || a === 'close' || a === 'focus';
}

/**
 * From a checkout (dev / packaged-like) plain `node` runs the bundle. A packaged build has no `node` on its own:
 *  - when it ships a Node runtime (`<resources>/node/node`, `bundledNode`), that runs it, like any other program;
 *  - otherwise the app binary runs the bundle as Node (ELECTRON_RUN_AS_NODE=1), which is what keeps the `runAsNode`
 *    fuse enabled (docs/security-review.md §8, RUN-1: the engine's worker programs need the same).
 * `entry` is null when the bundle is missing.
 */
export function mcpLaunchInfo(opts: {
	packaged: boolean;
	entry: string;
	exists: boolean;
	execPath: string;
	/** Path of the Node runtime shipped with the app, when there is one. */
	bundledNode?: string | null;
}): DesktopMcpInfo {
	const entry = opts.exists ? opts.entry : null;
	if (!opts.packaged) return { entry, command: 'node', env: {} };
	if (opts.bundledNode) return { entry, command: opts.bundledNode, env: {} };
	return { entry, command: opts.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * The cookies the window needs for the engine it started (ARCH §4.2; security review AGT-2): the session token and
 * the editor key, under per-port names (cookies are shared by every port of 127.0.0.1; `portCookieName` in
 * @jasper/api — the engine accepts these names). Both are set HttpOnly and SameSite=Strict by the caller.
 */
export function sessionCookies(
	port: string | number,
	token: string,
	editorKey: string,
): Record<string, string> {
	return { [`jasper_session_${port}`]: token, [`jasper_editor_${port}`]: editorKey };
}

/** The custom clipboard format next to `text/html` and `text/plain`. */
export const CLIPBOARD_CUSTOM_FORMAT = 'application/x-jasper-clipboard';
/** How Electron's clipboard addresses that raw OS format. */
export const ELECTRON_CLIPBOARD_FORMAT = `electron application/osclipboard;format="${CLIPBOARD_CUSTOM_FORMAT}"`;
/** Same cap as the payload parser (S01:CLB-009). */
const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * `jasper:clipboard-write` arguments: three strings within the caps, the JSON a JasperEditor clipboard object
 * (the renderer is not trusted to put anything else on the OS clipboard under our format).
 */
export function isClipboardWrite(v: unknown): v is DesktopClipboardWrite {
	if (!v || typeof v !== 'object' || !('json' in v) || !('html' in v) || !('text' in v)) return false;
	const { json, html, text } = v;
	if (typeof json !== 'string' || typeof html !== 'string' || typeof text !== 'string') return false;
	if (html.length > 2 * CLIPBOARD_MAX_BYTES || text.length > CLIPBOARD_MAX_BYTES) return false;
	if (json.length > CLIPBOARD_MAX_BYTES || utf8Bytes(json) > CLIPBOARD_MAX_BYTES) return false;
	return isJasperClipboardJson(json);
}

/** A JSON object with `format: "jasper-clipboard"` (the full schema check happens in the renderer on paste). */
function isJasperClipboardJson(json: string): boolean {
	try {
		const o: unknown = JSON.parse(json);
		return !!o && typeof o === 'object' && 'format' in o && o.format === 'jasper-clipboard';
	} catch {
		return false;
	}
}

/** What `jasper:clipboard-read` hands back: the custom format's JSON when sane, else null. */
export function clipboardReadResult(raw: unknown): string | null {
	if (typeof raw !== 'string' || raw.length > CLIPBOARD_MAX_BYTES || utf8Bytes(raw) > CLIPBOARD_MAX_BYTES)
		return null;
	return isJasperClipboardJson(raw) ? raw : null;
}

/** Clipboard types that carry the files copied in a file manager (Electron exposes `text/uri-list`). */
export const CLIPBOARD_FILE_LIST_TYPE =
	/(^|")(text\/uri-list|public\.file-url|x-special\/gnome-copied-files)("|$)/;
/** At most this many pasted files are handed to the renderer. */
const CLIPBOARD_MAX_FILES = 500;

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

/**
 * A path the renderer may ask the OS to open in its default application — absolute, sane,
 * and of a media or document type (never a program, a launcher, or a file without an extension).
 */
export function isOpenablePath(p: unknown): p is string {
	return isRevealablePath(p) && isOpenableFile(p);
}

/** A CSS-pixel rectangle from the renderer (validated before it reaches capturePage). */
export function isCaptureRect(v: unknown): v is DesktopCaptureRect {
	if (!v || typeof v !== 'object') return false;
	return (
		'x' in v &&
		typeof v.x === 'number' &&
		Number.isFinite(v.x) &&
		v.x >= 0 &&
		'y' in v &&
		typeof v.y === 'number' &&
		Number.isFinite(v.y) &&
		v.y >= 0 &&
		'width' in v &&
		typeof v.width === 'number' &&
		Number.isFinite(v.width) &&
		v.width >= 1 &&
		v.width <= 16384 &&
		'height' in v &&
		typeof v.height === 'number' &&
		Number.isFinite(v.height) &&
		v.height >= 1 &&
		v.height <= 16384
	);
}

/**
 * Voice-over recording needs the microphone (`media` with
 * audio only) and Preferences ▸ Audio lists the inputs (`mediaKeySystem` is never needed); only frames on the app
 * origin may ask. Everything else (camera, geolocation, notifications, MIDI, HID…) is denied.
 */
export function isPermissionAllowed(
	permission: string,
	requestingUrl: string,
	appOrigin: string | null,
	mediaTypes: readonly string[] = [],
): boolean {
	if (!appOrigin || !isSameOrigin(requestingUrl, appOrigin)) return false;
	if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');
	return (
		permission === 'clipboard-read' ||
		permission === 'clipboard-sanitized-write' ||
		permission === 'fullscreen'
	);
}
