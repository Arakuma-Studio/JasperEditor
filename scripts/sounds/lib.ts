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
