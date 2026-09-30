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

/** 32 random bytes, base64url (the per-launch engine token, ARCHITECTURE §4.2). */
export function makeToken(randomBytes: (n: number) => Uint8Array): string {
	return Buffer.from(randomBytes(32)).toString('base64url');
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
