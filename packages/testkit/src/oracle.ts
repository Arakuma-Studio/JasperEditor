// External oracles for tests: ffmpeg and ffprobe found on the machine, and measurements made with them (EBU R128
// loudness, PSNR / SSIM, packet and frame tables, decoded frames).
//
// Discovery of a tool T (`ffmpeg` or `ffprobe`): `JASPER_FFMPEG` / `JASPER_FFPROBE` (an explicit path; set but wrong
// is an error, never a silent skip), then every directory on PATH, then well-known install directories. A test that
// needs a missing oracle skips with `SKIPPED (<context>): …` — unless `JASPER_REQUIRE_ORACLES=1`, which turns every
// such skip into a failure (CI images that install ffmpeg set it so a broken install cannot pass by skipping).
//
// The oracles are external processes used to generate fixtures and check results; never linked or shipped.
// Ported from FilmCraft's `crates/testkit/src/oracle.rs` (MIT OR Apache-2.0; licenses/ported/golden-fuzz.md).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { envFlag } from './env.ts';
import { type Rgba8, rgba8 } from './image.ts';

export const REQUIRE_ORACLES_ENV = 'JASPER_REQUIRE_ORACLES';

const KNOWN_DIRS = [
	'/opt/homebrew/bin',
	'/usr/local/bin',
	'/usr/bin',
	'/opt/local/bin',
	'/snap/bin',
	'C:\\ffmpeg\\bin',
	'C:\\Program Files\\ffmpeg\\bin',
	'C:\\ProgramData\\chocolatey\\bin',
];

export type OracleTool = 'ffmpeg' | 'ffprobe';

const envVar = (name: string) => `JASPER_${name.toUpperCase()}`;
const isFile = (p: string) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/** Finds `name` given an explicit override, a PATH-style list and extra directories (pure function of its inputs). */
export function findToolIn(
	name: string,
	explicit: string | undefined,
	path: string | undefined,
	extra: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (explicit) {
		if (isFile(explicit)) return explicit;
		throw new Error(`${envVar(name)} is set but ${JSON.stringify(explicit)} is not a file`);
	}
	const names = platform === 'win32' ? [`${name}.exe`, name] : [name, `${name}.exe`];
	const sep = platform === 'win32' ? ';' : delimiter;
	for (const dir of [...(path ?? '').split(sep).filter(Boolean), ...extra])
		for (const n of names) {
			const p = join(dir, n);
			if (isFile(p)) return p;
		}
	return null;
}

const cache = new Map<OracleTool, string | null>();

/** The path of ffmpeg / ffprobe, or null when not installed (cached per process). */
export function findTool(name: OracleTool): string | null {
	if (!cache.has(name))
		cache.set(name, findToolIn(name, process.env[envVar(name)] || undefined, process.env.PATH, KNOWN_DIRS));
	return cache.get(name)!;
}

export const ffmpegPath = () => findTool('ffmpeg');
export const ffprobePath = () => findTool('ffprobe');

/** Whether `JASPER_REQUIRE_ORACLES` forbids skipping. */
export function oraclesRequired(): boolean {
	return envFlag(REQUIRE_ORACLES_ENV);
}

/** The bit of a vitest test context this module uses (`it('…', (ctx) => …)`). */
export type SkipContext = { skip: (note?: string) => void };

/**
 * Reports a skipped oracle check: throws with `JASPER_REQUIRE_ORACLES=1`; otherwise prints `SKIPPED (<context>):
 * <reason>` and, given a vitest context, marks the test skipped (`ctx.skip` throws, ending the test).
 */
export function skipOracle(context: string, reason: string, ctx?: SkipContext): void {
	if (oraclesRequired())
		throw new Error(`${context}: ${reason}, and ${REQUIRE_ORACLES_ENV}=1 forbids skipping oracle tests`);
	console.warn(`SKIPPED (${context}): ${reason}`);
	ctx?.skip(reason);
}

/**
 * The tool's path, or — when it is missing — a skip (see `skipOracle`). With a vitest context the test ends there;
 * without one the caller gets null and must return.
 */
export function requireTool(name: OracleTool, context: string, ctx?: SkipContext): string | null {
	const p = findTool(name);
	if (!p) skipOracle(context, `${name} not found (set ${envVar(name)} or put ${name} on PATH)`, ctx);
	return p;
}

/**
 * For `describe.runIf(...)` / `it.runIf(...)`: true when the tools exist. When they do not and
 * `JASPER_REQUIRE_ORACLES=1`, throws at collection time so the suite fails instead of silently not running.
 */
export function oraclesAvailable(...tools: OracleTool[]): boolean {
	const missing = (tools.length ? tools : (['ffmpeg', 'ffprobe'] as OracleTool[])).filter(
		(t) => !findTool(t),
	);
	if (!missing.length) return true;
	if (oraclesRequired()) throw new Error(`${missing.join(', ')} not found and ${REQUIRE_ORACLES_ENV}=1`);
	return false;
}

function tool(name: OracleTool): string {
	const p = findTool(name);
	if (!p) throw new Error(`${name} not found (set ${envVar(name)} or put ${name} on PATH)`);
	return p;
}

function run(name: OracleTool, args: string[], maxBuffer = 1 << 28): { stdout: Buffer; stderr: string } {
	const r = spawnSync(tool(name), args, { maxBuffer, windowsHide: true });
	if (r.error) throw r.error;
	const stderr = r.stderr?.toString('utf8') ?? '';
	if (r.status !== 0)
		throw new Error(`${name} ${args.join(' ')} exited ${r.status}:\n${stderr.slice(-2000)}`);
	return { stdout: r.stdout, stderr };
}

/** One 100 ms measurement line of ffmpeg's `ebur128` filter. */
export type LoudnessFrame = {
	t: number;
	momentary: number;
	shortTerm: number;
	integrated: number;
	lra: number;
};

export type Loudness = {
	/** Integrated loudness (LUFS). */
	integrated: number;
	/** Loudness range (LU). */
	lra: number;
	/** Gating threshold of the integrated measurement (LUFS). */
	threshold: number;
	/** True peak (dBTP; maximum over channels), when measured. */
	truePeak: number | null;
	/** Momentary / short-term / running values every 100 ms. */
	frames: LoudnessFrame[];
};

const num = (s: string | undefined) =>
	s === undefined ? Number.NaN : s === '-inf' ? Number.NEGATIVE_INFINITY : Number(s);

/** Parses the log of `ffmpeg -af ebur128=framelog=verbose:peak=true` (exported for tests). */
export function parseEbur128(log: string): Loudness {
	const frames: LoudnessFrame[] = [];
	const frameRe =
		/t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)\s+S:\s*(-?[\d.]+|-inf)\s+I:\s*(-?[\d.]+|-inf)\s+LUFS\s+LRA:\s*(-?[\d.]+)/g;
	for (const m of log.matchAll(frameRe))
		frames.push({
			t: num(m[1]),
			momentary: num(m[2]),
			shortTerm: num(m[3]),
			integrated: num(m[4]),
			lra: num(m[5]),
		});
	const summary = log.slice(log.lastIndexOf('Summary:'));
	if (!summary.startsWith('Summary:')) throw new Error('ebur128: no summary in the ffmpeg log');
	const integrated = num(/Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)/.exec(summary)?.[1]);
	const threshold = num(/Integrated loudness:[\s\S]*?Threshold:\s*(-?[\d.]+|-inf)/.exec(summary)?.[1]);
	const lra = num(/Loudness range:\s*LRA:\s*(-?[\d.]+)/.exec(summary)?.[1]);
	const peak = /True peak:\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary)?.[1];
	return { integrated, lra, threshold, truePeak: peak === undefined ? null : num(peak), frames };
}

/** EBU R128 loudness of an audio (or audio+video) file, measured by ffmpeg's `ebur128` filter. */
export function measureLoudness(file: string, opts: { truePeak?: boolean; stream?: number } = {}): Loudness {
	if (!existsSync(file)) throw new Error(`no such file ${file}`);
	const filter = `ebur128=framelog=verbose${opts.truePeak === false ? '' : ':peak=true'}`;
	const { stderr } = run('ffmpeg', [
		'-hide_banner',
		'-nostats',
		'-v',
		'verbose',
		'-i',
		file,
		...(opts.stream !== undefined ? ['-map', `0:a:${opts.stream}`] : []),
		'-af',
		filter,
		'-f',
		'null',
		'-',
	]);
	return parseEbur128(stderr);
}

export type QualityMetrics = {
	/** PSNR (dB) averaged over frames and planes (`average` of ffmpeg's psnr filter); Infinity when identical. */
	psnr: number;
	/** Minimum per-frame PSNR. */
	psnrMin: number;
	/** SSIM over all planes (`All` of ffmpeg's ssim filter), 0…1. */
	ssim: number;
	/** Per-frame `psnr_avg` and SSIM `All`. */
	frames: { psnr: number; ssim: number }[];
};

const db = (s: string | undefined) => (s === 'inf' ? Number.POSITIVE_INFINITY : num(s));

/** Parses ffmpeg's psnr/ssim summaries and per-frame stats (exported for tests). */
export function parseQuality(stderr: string, psnrStats: string, ssimStats: string): QualityMetrics {
	const p = /PSNR .*?average:\s*(inf|[\d.]+)\s+min:\s*(inf|[\d.]+)/.exec(stderr);
	const s = /SSIM .*?All:\s*([\d.]+)/.exec(stderr);
	if (!p || !s) throw new Error(`psnr/ssim summary missing from the ffmpeg log:\n${stderr.slice(-1000)}`);
	const ps = [...psnrStats.matchAll(/^n:\d+ .*?psnr_avg:(inf|[\d.]+)/gm)].map((m) => db(m[1]));
	const ss = [...ssimStats.matchAll(/^n:\d+ .*?All:([\d.]+)/gm)].map((m) => num(m[1]));
	return {
		psnr: db(p[1]),
		psnrMin: db(p[2]),
		ssim: num(s[1]),
		frames: ps.map((v, i) => ({ psnr: v, ssim: ss[i] ?? Number.NaN })),
	};
}

/**
 * PSNR and SSIM of `distorted` against `reference` (videos or stills), computed by ffmpeg on `pixFmt` (default
 * yuv444p, so chroma is not subsampled before comparison). Both inputs must have the same size and frame count.
 */
export function compareVideos(
	reference: string,
	distorted: string,
	opts: { pixFmt?: string; frames?: number } = {},
): QualityMetrics {
	const fmt = opts.pixFmt ?? 'yuv444p';
	const dir = mkdtempSync(join(tmpdir(), 'jasper-quality-'));
	try {
		const esc = (p: string) => p.replace(/\\/g, '/').replace(/([:'])/g, '\\$1');
		const psnrFile = join(dir, 'psnr.log');
		const ssimFile = join(dir, 'ssim.log');
		const graph =
			`[0:v]format=${fmt},setpts=PTS-STARTPTS,split[r1][r2];[1:v]format=${fmt},setpts=PTS-STARTPTS,split[d1][d2];` +
			`[d1][r1]psnr=stats_file='${esc(psnrFile)}';[d2][r2]ssim=stats_file='${esc(ssimFile)}'`;
		const r = run('ffmpeg', [
			'-hide_banner',
			'-nostats',
			'-i',
			reference,
			'-i',
			distorted,
			...(opts.frames ? ['-frames:v', String(opts.frames)] : []),
			'-filter_complex',
			graph,
			'-f',
			'null',
			'-',
		]);
		return parseQuality(r.stderr, readFileSync(psnrFile, 'utf8'), readFileSync(ssimFile, 'utf8'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export type ProbePacket = {
	stream: number;
	pts: number | null;
	dts: number | null;
	duration: number | null;
	size: number;
	key: boolean;
};

export type ProbeFrame = {
	stream: number;
	pts: number | null;
	duration: number | null;
	key: boolean;
	pictType?: string;
	width?: number;
	height?: number;
	sampleCount?: number;
};

const intOrNull = (v: unknown) => (v === undefined || v === null || v === 'N/A' ? null : Number(v));

function probeJson(file: string, args: string[]): Record<string, unknown> {
	const { stdout } = run('ffprobe', ['-v', 'error', '-of', 'json', ...args, file]);
	return JSON.parse(stdout.toString('utf8')) as Record<string, unknown>;
}

/** `ffprobe -show_streams` as parsed JSON objects. */
export function probeStreams(file: string): Record<string, unknown>[] {
	return (probeJson(file, ['-show_streams', '-show_format']).streams ?? []) as Record<string, unknown>[];
}

/** Every packet (`ffprobe -show_packets`), optionally of one stream specifier (e.g. `v:0`). */
export function probePackets(file: string, select?: string): ProbePacket[] {
	const j = probeJson(file, [...(select ? ['-select_streams', select] : []), '-show_packets']);
	return ((j.packets ?? []) as Record<string, unknown>[]).map((p) => ({
		stream: Number(p.stream_index),
		pts: intOrNull(p.pts),
		dts: intOrNull(p.dts),
		duration: intOrNull(p.duration),
		size: Number(p.size),
		key: String(p.flags ?? '').includes('K'),
	}));
}

/** Every decoded frame (`ffprobe -show_frames`), optionally of one stream specifier. */
export function probeFrames(file: string, select?: string): ProbeFrame[] {
	const j = probeJson(file, [...(select ? ['-select_streams', select] : []), '-show_frames']);
	return ((j.frames ?? []) as Record<string, unknown>[]).map((f) => ({
		stream: Number(f.stream_index),
		pts: intOrNull(f.pts ?? f.pkt_pts),
		duration: intOrNull(f.duration ?? f.pkt_duration),
		key: Number(f.key_frame) === 1,
		...(f.pict_type !== undefined ? { pictType: String(f.pict_type) } : {}),
		...(f.width !== undefined ? { width: Number(f.width), height: Number(f.height) } : {}),
		...(f.nb_samples !== undefined ? { sampleCount: Number(f.nb_samples) } : {}),
	}));
}

/**
 * Compares two packet or frame tables field by field (same length, same values for `fields`); returns the
 * differences as readable strings (empty when equal).
 */
export function compareTables<T extends object>(
	want: readonly T[],
	got: readonly T[],
	fields: readonly (keyof T)[],
	limit = 20,
): string[] {
	const out: string[] = [];
	if (want.length !== got.length) out.push(`count ${got.length}, expected ${want.length}`);
	for (let i = 0; i < Math.min(want.length, got.length) && out.length < limit; i++)
		for (const f of fields)
			if (want[i]![f] !== got[i]![f])
				out.push(`#${i}.${String(f)}: ${String(got[i]![f])}, expected ${String(want[i]![f])}`);
	return out;
}

/** Decodes video frames (or a still) to RGBA8 through ffmpeg, optionally scaled; `frames` limits the count. */
export function decodeFrames(
	file: string,
	opts: { frames?: number; width?: number; height?: number; start?: number } = {},
): Rgba8[] {
	let w = opts.width;
	let h = opts.height;
	if (!w || !h) {
		const v = probeStreams(file).find((s) => s.codec_type === 'video');
		if (!v) throw new Error(`${file}: no video stream`);
		w = Number(v.width);
		h = Number(v.height);
	}
	const { stdout } = run('ffmpeg', [
		'-v',
		'error',
		...(opts.start ? ['-ss', String(opts.start)] : []),
		'-i',
		file,
		...(opts.frames ? ['-frames:v', String(opts.frames)] : []),
		'-vf',
		`scale=${w}:${h}:flags=bicubic`,
		'-f',
		'rawvideo',
		'-pix_fmt',
		'rgba',
		'-',
	]);
	const size = w * h * 4;
	const out: Rgba8[] = [];
	for (let o = 0; o + size <= stdout.length; o += size)
		out.push(rgba8(w, h, new Uint8Array(stdout.subarray(o, o + size))));
	return out;
}

/** Runs ffmpeg with `args` (throws with the log tail on failure); for fixture generation. */
export function ffmpeg(args: string[]): Buffer {
	return execFileSync(tool('ffmpeg'), ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 });
}
