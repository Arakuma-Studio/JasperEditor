// Link Media path model (docs/wp-notes/link-media.md §2): media paths from any operating system, parsed without
// file-system access, so a project made on Windows (`D:\Media\a.mov`, `\\server\share\a.mov`) opens on macOS or Linux
// with its paths recognised as absolute paths of another computer — never resolved against the engine's working
// directory — and a POSIX path stays foreign on a Windows engine.

/** `posix` `/a/b`; `windows` `D:\a` or `D:/a`; `unc` `\\server\share\a` or `//server/share/a`; else `relative`. */
export type PathStyle = 'posix' | 'windows' | 'unc' | 'relative';

/** The operating-system family of the machine that reads the path (Node `process.platform === 'win32'`). */
export type HostPlatform = 'posix' | 'win32';

export type ParsedPath = {
	style: PathStyle;
	/** `D:` (upper-case drive), `\\server\share` (UNC, as written), `` (POSIX root or relative). */
	root: string;
	/** Folder and file names after the root; `..` only at the start of a relative path. */
	segments: string[];
};

const DRIVE = /^[A-Za-z]:[/\\]/;
/** Longest path accepted (characters); longer input is not a media path. */
export const MAX_PATH_CHARS = 32_767;
const MAX_SEGMENTS = 4096;

export function classifyPath(p: string): PathStyle {
	if (DRIVE.test(p)) return 'windows';
	if (/^[/\\]{2}[^/\\]/.test(p)) return 'unc';
	if (p.startsWith('/')) return 'posix';
	return 'relative';
}

/** Absolute on some operating system (the style is not `relative`). */
export function isAbsoluteAnywhere(p: string): boolean {
	return classifyPath(p) !== 'relative';
}

/** An absolute path the host can open as written: POSIX on macOS/Linux, drive letter or UNC on Windows. */
export function isHostAbsolute(p: string, host: HostPlatform): boolean {
	const s = classifyPath(p);
	return host === 'win32' ? s === 'windows' || s === 'unc' : s === 'posix';
}

/** An absolute path of another operating system (kept as the media's original path, relinkable, never opened). */
export function isForeignPath(p: string, host: HostPlatform): boolean {
	const s = classifyPath(p);
	return s !== 'relative' && !isHostAbsolute(p, host);
}

function splitSegments(rest: string, style: PathStyle): string[] {
	// A backslash is a legal POSIX file-name character: only Windows-style paths split on it. A relative path uses
	// both separators (Premiere writes `..\..\Media\a.mov`).
	const parts = style === 'posix' ? rest.split('/') : rest.split(/[/\\]/);
	const out: string[] = [];
	for (const seg of parts) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (out.length && out[out.length - 1] !== '..') out.pop();
			else if (style === 'relative') out.push('..');
			// `..` above an absolute root stays at the root
			continue;
		}
		out.push(seg);
		if (out.length > MAX_SEGMENTS) break;
	}
	return out;
}

export function parsePath(input: string): ParsedPath {
	const p = input.length > MAX_PATH_CHARS ? input.slice(0, MAX_PATH_CHARS) : input;
	const style = classifyPath(p);
	switch (style) {
		case 'windows':
			return { style, root: `${p[0]!.toUpperCase()}:`, segments: splitSegments(p.slice(2), style) };
		case 'unc': {
			const parts = p
				.slice(2)
				.split(/[/\\]/)
				.filter((s) => s !== '');
			const server = parts[0] ?? '';
			const share = parts[1] ?? '';
			const root = share ? `\\\\${server}\\${share}` : `\\\\${server}`;
			return { style, root, segments: splitSegments(parts.slice(2).join('/'), style) };
		}
		case 'posix':
			return { style, root: '', segments: splitSegments(p, style) };
		default:
			return { style, root: '', segments: splitSegments(p, style) };
	}
}

/** The path written the way its own operating system writes it (`D:\a\b`, `\\srv\share\a`, `/a/b`, `../a`). */
export function formatPath(p: ParsedPath): string {
	switch (p.style) {
		case 'windows':
			return `${p.root}\\${p.segments.join('\\')}`;
		case 'unc':
			return p.segments.length ? `${p.root}\\${p.segments.join('\\')}` : p.root;
		case 'posix':
			return `/${p.segments.join('/')}`;
		default:
			return p.segments.join('/');
	}
}

/** A path for display: normalised separators of its own style (a Windows path keeps backslashes on a Mac). */
export function displayPath(p: string): string {
	return formatPath(parsePath(p));
}

/** Comparison key of one name: Unicode NFC, case-folded (Windows and default macOS volumes ignore case). */
export function segmentKey(s: string): string {
	return s.normalize('NFC').toLowerCase();
}

export function sameSegment(a: string, b: string): boolean {
	return a === b || segmentKey(a) === segmentKey(b);
}

/** The file name (last segment) of any style of path. */
export function pathBaseName(p: string): string {
	const segs = parsePath(p).segments;
	return segs[segs.length - 1] ?? '';
}

/** `name` without its extension (`a.b.mov` → `a.b`; a leading dot is not an extension). */
export function fileStemOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i > 0 ? name.slice(0, i) : name;
}

/** Lower-case extension without the dot ('' when none). */
export function fileExtensionOf(name: string): string {
	const i = name.lastIndexOf('.');
	return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/** `parent` with `names` appended, in `parent`'s style. */
export function joinSegments(parent: ParsedPath, names: readonly string[]): ParsedPath {
	return { style: parent.style, root: parent.root, segments: [...parent.segments, ...names] };
}

/** Same style and root (roots compare without case: `d:` = `D:`, UNC server names ignore case). */
export function sameRoot(a: ParsedPath, b: ParsedPath): boolean {
	return a.style === b.style && segmentKey(a.root) === segmentKey(b.root);
}
