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

export type WindowAction = 'minimize' | 'toggleMaximize' | 'close';
export function isWindowAction(a: unknown): a is WindowAction {
	return a === 'minimize' || a === 'toggleMaximize' || a === 'close';
}
