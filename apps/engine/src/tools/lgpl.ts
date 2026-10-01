// Where the LGPL FFmpeg lives (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md). One directory per platform
// holds our LGPL ffmpeg/ffprobe, their shared libraries and Remotion's own compositor binary — the layout
// Remotion expects for `binariesDirectory`. `pnpm ffmpeg:lgpl` creates it under
// vendor/ffmpeg-lgpl/<platform>/ (dev); packaged builds ship it as `<resources>/ffmpeg-lgpl/`.
//
// Resolution (Remotion and the native path share it):
//   1. env JASPER_REMOTION_BIN_DIR (legacy name JASPER_REMOTION_BINARIES_DIR)
//   2. packaged resources: <resourcesDir>/ffmpeg-lgpl
//   3. dev checkout: vendor/ffmpeg-lgpl/<platform> found above the engine module (JASPER_FFMPEG_VENDOR=0
//      skips it)
//   4. nothing: dev engines let Remotion use its bundled (GPL) FFmpeg with a loud capability warning;
//      packaged/server engines (strict) refuse the Remotion path.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMOTION_BIN_DIR_ENV = 'JASPER_REMOTION_BIN_DIR';
/** Older name (wp-3l); still honoured. */
export const REMOTION_BIN_DIR_ENV_LEGACY = 'JASPER_REMOTION_BINARIES_DIR';
/** `0` disables the dev vendor directory lookup (use PATH ffmpeg and Remotion's bundled one). */
const FFMPEG_VENDOR_ENV = 'JASPER_FFMPEG_VENDOR';
/** Name of the LGPL binaries directory inside packaged resources. */
export const RESOURCES_LGPL_DIR = 'ffmpeg-lgpl';

export const BUNDLED_GPL_WARNING = 'Remotion is using its bundled GPL FFmpeg (dev only)';
export const STRICT_MISSING_MESSAGE =
	'Remotion rendering is disabled: the LGPL FFmpeg binaries directory is missing ' +
	`(<resources>/${RESOURCES_LGPL_DIR}, or vendor/ffmpeg-lgpl/<platform> from \`pnpm ffmpeg:lgpl\`, or ` +
	`${REMOTION_BIN_DIR_ENV}). Packaged and built engines never use Remotion's bundled GPL FFmpeg.`;

type Env = Record<string, string | undefined>;
type Exists = (p: string) => boolean;

/** `linux-x64`, `darwin-arm64`, `win32-x64` … (musl Linux: `linux-x64-musl`). */
export function platformKey(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	musl = isMusl(platform),
): string {
	return `${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

function isMusl(platform: NodeJS.Platform): boolean {
	if (platform !== 'linux' || platform !== process.platform) return false;
	const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return !!report && typeof report === 'object' && !report.header?.glibcVersionRuntime;
}

export function binaryNames(platform: NodeJS.Platform = process.platform): {
	compositor: string;
	ffmpeg: string;
	ffprobe: string;
} {
	const exe = platform === 'win32' ? '.exe' : '';
	return { compositor: `remotion${exe}`, ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}` };
}

/** A directory Remotion accepts as `binariesDirectory`: compositor + ffmpeg + ffprobe. */
export function isBinariesDir(
	dir: string,
	platform: NodeJS.Platform = process.platform,
	exists: Exists = existsSync,
): boolean {
	const n = binaryNames(platform);
	return exists(join(dir, n.compositor)) && exists(join(dir, n.ffmpeg)) && exists(join(dir, n.ffprobe));
}

/**
 * The dev vendor directory: walks up from `from` (default: this module) looking for
 * `vendor/ffmpeg-lgpl/<platformKey>` with a BUILDINFO.json (written by `pnpm ffmpeg:lgpl` after its checks).
 */
export function findVendorDir(
	opts: { from?: string; key?: string; env?: Env; exists?: Exists; maxDepth?: number } = {},
): string | null {
	const env = opts.env ?? process.env;
	if (env[FFMPEG_VENDOR_ENV] === '0') return null;
	const exists = opts.exists ?? existsSync;
	const key = opts.key ?? platformKey();
	let dir = opts.from ?? dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < (opts.maxDepth ?? 8); i++) {
		const cand = join(dir, 'vendor', 'ffmpeg-lgpl', key);
		if (exists(join(cand, 'BUILDINFO.json'))) return cand;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

type BinariesSource = 'env' | 'resources' | 'vendor' | 'bundled' | 'missing';

export type RemotionBinaries = {
	/** `binariesDirectory` for Remotion; null = Remotion's own compositor package (or nothing, if strict). */
	dir: string | null;
	source: BinariesSource;
	/** The directory is expected to hold our LGPL FFmpeg (confirmed later by the license probe). */
	lgpl: boolean;
	/** Remotion may render: false only in strict mode without an LGPL directory. */
	allowed: boolean;
	/** Capability / log message (warnings and refusals). */
	message?: string;
};

/**
 * Picks the Remotion binaries directory (see the resolution order at the top of this file). `strict` is
 * true for packaged and server engines: they never fall back to Remotion's bundled GPL FFmpeg.
 */
export function resolveRemotionBinaries(opts: {
	env?: Env;
	resourcesDir?: string | null;
	vendorDir?: string | null;
	strict: boolean;
	platform?: NodeJS.Platform;
	exists?: Exists;
}): RemotionBinaries {
	const env = opts.env ?? process.env;
	const exists = opts.exists ?? existsSync;
	const platform = opts.platform ?? process.platform;
	const valid = (d: string) => isBinariesDir(d, platform, exists);
	const refuse = (message: string): RemotionBinaries =>
		opts.strict
			? { dir: null, source: 'missing', lgpl: false, allowed: false, message }
			: {
					dir: null,
					source: 'bundled',
					lgpl: false,
					allowed: true,
					message: `${BUNDLED_GPL_WARNING}: ${message}`,
				};

	const explicitName = env[REMOTION_BIN_DIR_ENV] ? REMOTION_BIN_DIR_ENV : REMOTION_BIN_DIR_ENV_LEGACY;
	const explicit = env[explicitName];
	if (explicit) {
		if (valid(explicit)) return { dir: explicit, source: 'env', lgpl: true, allowed: true };
		// A configured but broken directory is an error, never a silent switch to another FFmpeg.
		return refuse(
			`${explicitName}=${explicit} is not a Remotion binaries directory (remotion, ffmpeg, ffprobe)`,
		);
	}
	if (opts.resourcesDir) {
		const d = join(opts.resourcesDir, RESOURCES_LGPL_DIR);
		if (valid(d)) return { dir: d, source: 'resources', lgpl: true, allowed: true };
	}
	if (opts.vendorDir && valid(opts.vendorDir)) {
		return { dir: opts.vendorDir, source: 'vendor', lgpl: true, allowed: true };
	}
	return opts.strict
		? { dir: null, source: 'missing', lgpl: false, allowed: false, message: STRICT_MISSING_MESSAGE }
		: {
				dir: null,
				source: 'bundled',
				lgpl: false,
				allowed: true,
				message: `${BUNDLED_GPL_WARNING}. Run \`pnpm ffmpeg:lgpl\` to use the LGPL build.`,
			};
}
