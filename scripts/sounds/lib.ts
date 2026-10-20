// Shared helpers of the starter-kit tools (spec 12 §2.1, P1-R4; wp-note "WP1.2b starter kit"): find an LGPL ffmpeg,
// decode a sound the way the engine's index job does (f32, at most 48 kHz), and measure it with the same
// `analyzeSound` + `judgeSound` + `SOUND_TYPE_PROFILES` the library uses.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	analyzeSound,
	type JudgeResult,
	judgeSound,
	type SoundDescriptors,
} from '../../packages/audio-fx/src/index.ts';
import { SOUND_TYPE_PROFILES, type SoundTypeId } from '../../packages/project/src/sound/index.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STARTER_DIR = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
/** P1-R4: the bundled kit stays under this many bytes (audio files, manifest excluded). */
export const STARTER_BUDGET_BYTES = 8 * 1024 * 1024;
/** Output format of the kit: 48 kHz OGG Vorbis (the engine's media rate; decodable by the LGPL FFmpeg). */
export const OUTPUT_RATE = 48_000;

const platformKey = () => `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;

/**
 * The FFmpeg used to convert and measure: `JASPER_FFMPEG`, else the dev checkout's LGPL build
 * (`vendor/ffmpeg-lgpl/<platform>/ffmpeg`, searched upwards so worktrees find the main checkout's), else `ffmpeg`.
 */
export function findFfmpeg(): string {
	if (process.env.JASPER_FFMPEG) return process.env.JASPER_FFMPEG;
	let dir = ROOT;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, 'vendor', 'ffmpeg-lgpl', platformKey(), 'ffmpeg');
		if (existsSync(candidate)) return candidate;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return 'ffmpeg';
}

export function ffmpegBuildConf(ffmpeg: string): string {
	const r = spawnSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
	return `${r.stdout}${r.stderr}`;
}

/** Refuses a GPL/non-free build (AGENTS.md §2) and one without the libvorbis encoder. */
export function assertLgplVorbis(ffmpeg: string): void {
	const conf = ffmpegBuildConf(ffmpeg);
	if (/--enable-(gpl|nonfree)\b/.test(conf))
		throw new Error(`${ffmpeg} is a GPL/non-free build; set JASPER_FFMPEG to an LGPL one (pnpm ffmpeg:lgpl)`);
	if (!/--enable-libvorbis\b/.test(conf)) throw new Error(`${ffmpeg} has no libvorbis encoder`);
}

export function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Runs ffmpeg; throws with its stderr on failure. */
export function runFfmpeg(ffmpeg: string, args: string[]): Buffer {
	const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...args], {
		maxBuffer: 512 * 1024 * 1024,
	});
	if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr?.toString() ?? r.error}`);
	return r.stdout;
}

export type Decoded = { channels: Float32Array[]; rate: number };

/** Decodes to planar f32 at `rate` with the file's channel count (≤ 2 here), like the engine's analysis. */
export function decode(ffmpeg: string, path: string, rate = OUTPUT_RATE): Decoded {
	const probe = spawnSync(
		ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'),
		['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', path],
		{ encoding: 'utf8' },
	);
	const nch = Math.min(2, Math.max(1, Number.parseInt(probe.stdout, 10) || 2));
	const raw = runFfmpeg(ffmpeg, [
		'-i',
		path,
		'-vn',
		'-f',
		'f32le',
		'-ac',
		String(nch),
		'-ar',
		String(rate),
		'-',
	]);
	const frames = Math.floor(raw.length / 4 / nch);
	const view = new Float32Array(raw.buffer, raw.byteOffset, frames * nch);
	const channels = Array.from({ length: nch }, () => new Float32Array(frames));
	for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) channels[c]![i] = view[i * nch + c]!;
	return { channels, rate };
}

export function measure(d: Decoded): SoundDescriptors {
	return analyzeSound(d.channels, d.rate);
}

/** Seconds of a file the engine's index analyses (`SOUND_ANALYSIS_SECONDS` of @jasper/api). */
export const ENGINE_ANALYSIS_SECONDS = 30;

export type Probed = { durationSec: number; rate: number; channels: number };

/** Duration, sample rate and channel count of the first audio stream (ffprobe). */
export function probe(ffmpeg: string, path: string): Probed {
	const r = spawnSync(
		ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'),
		[
			'-v',
			'error',
			'-select_streams',
			'a:0',
			'-show_entries',
			'stream=sample_rate,channels:format=duration',
			'-of',
			'json',
			path,
		],
		{ encoding: 'utf8' },
	);
	const j = JSON.parse(r.stdout || '{}') as {
		streams?: { sample_rate?: string; channels?: number }[];
		format?: { duration?: string };
	};
	const s = j.streams?.[0];
	return {
		durationSec: Number(j.format?.duration) || 0,
		rate: Number(s?.sample_rate) || OUTPUT_RATE,
		channels: s?.channels ?? 2,
	};
}

/** Decodes `[startSec, startSec + seconds)` at `rate` (planar f32, ≤ 2 channels). */
function decodeRange(
	ffmpeg: string,
	path: string,
	rate: number,
	nch: number,
	startSec: number,
	seconds: number,
) {
	const raw = runFfmpeg(ffmpeg, [
		...(startSec > 0 ? ['-ss', String(startSec)] : []),
		'-t',
		String(seconds),
		'-i',
		path,
		'-vn',
		'-f',
		'f32le',
		'-ac',
		String(nch),
		'-ar',
		String(rate),
		'-',
	]);
	const frames = Math.floor(raw.length / 4 / nch);
	const view = new Float32Array(raw.buffer, raw.byteOffset, frames * nch);
	const channels = Array.from({ length: nch }, () => new Float32Array(frames));
	for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) channels[c]![i] = view[i * nch + c]!;
	return channels;
}

/**
 * Descriptors the way the engine's index computes them (apps/engine/src/sounds/decode.ts + analysis-core.ts): the
 * first {@link ENGINE_ANALYSIS_SECONDS} at the file's own rate (at most 48 kHz), with `durationSec` the whole file's.
 * Plus `loopableWhole`: whether the WHOLE file loops (its first and last second joined end to end are measured by the
 * same `loopable` rule; the engine's own `loopable` only sees the analysed excerpt).
 */
export function measureLikeEngine(
	ffmpeg: string,
	path: string,
): { desc: SoundDescriptors; probed: Probed; loopableWhole: boolean } {
	const probed = probe(ffmpeg, path);
	const rate = Math.min(OUTPUT_RATE, probed.rate);
	const nch = Math.min(2, Math.max(1, probed.channels));
	let desc = analyzeSound(decodeRange(ffmpeg, path, rate, nch, 0, ENGINE_ANALYSIS_SECONDS), rate);
	if (probed.durationSec > desc.durationSec + 0.05) desc = { ...desc, durationSec: probed.durationSec };
	let loopableWhole = desc.loopable && probed.durationSec <= ENGINE_ANALYSIS_SECONDS;
	if (probed.durationSec > 2.5) {
		const head = decodeRange(ffmpeg, path, rate, nch, 0, 1);
		const tail = decodeRange(ffmpeg, path, rate, nch, Math.max(0, probed.durationSec - 1), 1);
		// head ‖ tail starts like the file and ends like it: exactly what `loopable` compares (levels of the first and
		// last 100 ms, fades, the click at the wrap from the last sample to the first).
		const headTail = head.map((h, c) => {
			const t = tail[c]!;
			const out = new Float32Array(h.length + t.length);
			out.set(h, 0);
			out.set(t, h.length);
			return out;
		});
		loopableWhole = analyzeSound(headTail, rate).loopable;
	}
	return { desc, probed, loopableWhole };
}

export function judge(desc: SoundDescriptors, type: SoundTypeId): JudgeResult {
	return judgeSound(desc, SOUND_TYPE_PROFILES[type]);
}

/** The 19 effect types of the taxonomy (beds are out of scope for the kit). */
export const EFFECT_TYPES: SoundTypeId[] = [
	'hit',
	'boom',
	'riser',
	'reverse',
	'transition',
	'whoosh',
	'swish',
	'glitch',
	'ui',
	'click',
	'key',
	'tick',
	'tap',
	'pop',
	'thump',
	'paper',
	'chime',
	'shimmer',
	'zap',
];

export function describeRow(d: SoundDescriptors): string {
	return [
		`dur ${d.durationSec.toFixed(3)}`,
		`peak ${d.peakSec.toFixed(3)}`,
		`rise ${d.riseMs}`,
		`dec ${d.decays ? 'y' : 'n'}`,
		`<150 ${d.below150Share}`,
		`>6k ${d.above6kShare}`,
		`flat ${d.flatness}`,
		`on ${d.onsetCount}`,
		`maxM ${d.maxMomentaryLufs}`,
		`tp ${d.truePeakDb}`,
		`c ${d.centroidHz}`,
		`midi ${d.pitchMidi}`,
	].join(' ');
}
