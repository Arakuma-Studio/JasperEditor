// Media paths and file URLs (POSIX, Windows drive and UNC paths), without any file-system access.

function isWindowsAbs(p: string): boolean {
	return /^[A-Za-z]:[/\\]/.test(p);
}

export function isAbsolutePath(p: string): boolean {
	return p.startsWith('/') || p.startsWith('\\\\') || isWindowsAbs(p);
}

function percentDecode(s: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < s.length; ) {
		if (s[i] === '%' && i + 2 < s.length + 0 && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
			bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
			i += 3;
			continue;
		}
		const cp = s.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		for (const b of utf8(ch)) bytes.push(b);
		i += ch.length;
	}
	return decodeUtf8Lossy(Uint8Array.from(bytes));
}

function utf8(s: string): number[] {
	const out: number[] = [];
	for (const ch of s) {
		const c = ch.codePointAt(0)!;
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return out;
}

/** UTF-8 decoding that replaces malformed sequences with U+FFFD (never throws). */
export function decodeUtf8Lossy(b: Uint8Array): string {
	let out = '';
	for (let i = 0; i < b.length; ) {
		const c = b[i]!;
		let cp = -1;
		let n = 0;
		if (c < 0x80) [cp, n] = [c, 1];
		else if (c >= 0xc2 && c < 0xe0) [cp, n] = [c & 31, 2];
		else if (c >= 0xe0 && c < 0xf0) [cp, n] = [c & 15, 3];
		else if (c >= 0xf0 && c < 0xf5) [cp, n] = [c & 7, 4];
		if (cp < 0 || i + n > b.length) {
			out += '\uFFFD';
			i++;
			continue;
		}
		let ok = true;
		for (let k = 1; k < n; k++) {
			const x = b[i + k]!;
			if ((x & 0xc0) !== 0x80) {
				ok = false;
				break;
			}
			cp = (cp << 6) | (x & 63);
		}
		if (
			!ok ||
			(n === 3 && cp < 0x800) ||
			(n === 4 && (cp < 0x10000 || cp > 0x10ffff)) ||
			(cp >= 0xd800 && cp <= 0xdfff)
		) {
			out += '\uFFFD';
			i++;
			continue;
		}
		out += String.fromCodePoint(cp);
		i += n;
	}
	return out;
}

export function encodeUtf8(s: string): Uint8Array {
	return Uint8Array.from(utf8(s));
}

const SAFE = /[A-Za-z0-9/\-._~!$&'()*+,;=:@]/;

function percentEncodePath(s: string): string {
	let out = '';
	for (const ch of s) {
		if (ch.length === 1 && SAFE.test(ch)) out += ch;
		else for (const b of utf8(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
	}
	return out;
}

/**
 * `file://` URL → path (`file:///a/b`, `file://localhost/a/b`, `file:///C:/x`, `file://server/share` → UNC).
 * Anything that is not a file URL is returned unchanged.
 */
export function fileUrlToPath(url: string): string {
	if (url.slice(0, 7).toLowerCase() !== 'file://') {
		// `file:/a/b` (one slash, some Resolve exports).
		if (/^file:\/[^/]/i.test(url)) return percentDecode(url.slice(5));
		return url;
	}
	let rest = url.slice(7);
	if (rest.slice(0, 9).toLowerCase() === 'localhost') rest = rest.slice(9);
	const decoded = percentDecode(rest);
	if (decoded.length >= 3 && decoded.startsWith('/') && isWindowsAbs(decoded.slice(1)))
		return decoded.slice(1);
	if (!decoded.startsWith('/')) return `//${decoded}`;
	return decoded;
}

/** Absolute path → `file://` URL (`localhost` form for FCP7 XML). */
export function pathToFileUrl(path: string, localhost = false): string {
	const p = path.replace(/\\/g, '/');
	const host = localhost ? 'localhost' : '';
	if (isWindowsAbs(p)) return `file://${host}/${percentEncodePath(p)}`;
	if (p.startsWith('//')) return `file://${percentEncodePath(p.slice(2))}`;
	return `file://${host}${percentEncodePath(p)}`;
}

function join(base: string, rel: string): string {
	const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	const parts = base.split(/[/\\]/);
	if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
	for (const seg of rel.split(/[/\\]/)) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (parts.length > 1) parts.pop();
		} else parts.push(seg);
	}
	return parts.join(sep);
}

/** A media reference from a document: file URLs become paths; relative paths are joined to `baseDir`. */
export function resolvePath(reference: string, baseDir?: string | null): string {
	const p = fileUrlToPath(reference.trim());
	if (isAbsolutePath(p)) return p;
	if (baseDir) return join(baseDir, p);
	return p;
}

/** `path` relative to directory `base` when they share a root (else null). */
export function relativePath(path: string, base: string): string | null {
	if (!isAbsolutePath(path) || !isAbsolutePath(base)) return null;
	const a = path.split(/[/\\]/).filter(Boolean);
	const b = base.split(/[/\\]/).filter(Boolean);
	let common = 0;
	while (common < a.length && common < b.length && a[common] === b[common]) common++;
	if (common === 0) return null;
	return [...Array(b.length - common).fill('..'), ...a.slice(common)].join('/');
}

export function fileName(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] ?? path;
}

export function fileStem(path: string): string {
	const n = fileName(path);
	const i = n.lastIndexOf('.');
	return i > 0 ? n.slice(0, i) : n;
}

export function extension(path: string): string {
	const n = fileName(path);
	const i = n.lastIndexOf('.');
	return i > 0 ? n.slice(i + 1).toLowerCase() : '';
}

const AUDIO_EXT = new Set(['wav', 'aif', 'aiff', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'bwf', 'wma']);
const IMAGE_EXT = new Set([
	'png',
	'jpg',
	'jpeg',
	'tif',
	'tiff',
	'psd',
	'bmp',
	'webp',
	'exr',
	'dpx',
	'tga',
	'heic',
	'avif',
]);
const ANIMATED_EXT = new Set(['gif', 'apng']);

/** Media kind guessed from a file extension. */
export function kindFromExtension(path: string): 'video' | 'audio' | 'image' | 'animated-image' {
	const e = extension(path);
	if (AUDIO_EXT.has(e)) return 'audio';
	if (IMAGE_EXT.has(e)) return 'image';
	if (ANIMATED_EXT.has(e)) return 'animated-image';
	return 'video';
}
