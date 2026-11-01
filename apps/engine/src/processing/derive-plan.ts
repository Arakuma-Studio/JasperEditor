// Media derivation ops (spec 18 AF-OPS-001; wp-note agent-footage-ops): the FFmpeg argument plans of conform-cfr,
// reverse, denoise-audio, extract-audio, time-stretch and range. Pure: no I/O. `DeriveService` (derive.ts) runs them.
//
// Outputs follow the processing outputs (S07): video → QuickTime ProRes 422 HQ (4444 with alpha) + 24-bit PCM, the
// picture decoded with the matrix every export path assumes for the original (`inColor`) and written as BT.709
// limited range with the original's primaries/transfer tags; audio → 24-bit PCM WAV (RF64 past 4 GB) or FLAC.
// Every filter text is checked by `assertLgplFilters`; every input is opened with LOCAL_PROTOCOLS.
import { createHash } from 'node:crypto';
import type { AudioStream, DeriveRecipe, VideoStream } from '@jasper/project';
import { FLICKS_PER_SECOND, rangeFrames } from '@jasper/project';
import { LOCAL_PROTOCOLS } from '../tools/protocols.ts';
import { assertLgplFilters } from './proc/filters.ts';

/** Bump when an op's output changes for the same recipe (old outputs are then not reused). */
export const DERIVE_RECIPE_VERSION = 1;

/**
 * reverse: the `reverse` / `areverse` filters hold a whole segment in memory, so long media are reversed in segments
 * (each reversed, then joined last-first). A video segment holds at most this many bytes of decoded frames
 * (estimated at 4 B/pixel up to 8-bit, 8 B/pixel above) and at most REVERSE_MAX_SEGMENT_SEC.
 */
export const REVERSE_VIDEO_BUDGET_BYTES = 512 * 1024 * 1024;
export const REVERSE_MAX_SEGMENT_SEC = 10;
/** Audio-only reverse: at most this many bytes of samples per segment (8 B/sample, double precision worst case). */
export const REVERSE_AUDIO_BUDGET_BYTES = 64 * 1024 * 1024;
export const REVERSE_MAX_AUDIO_SEGMENT_SEC = 60;
/** Seconds decoded before a seek point so `trim` sees the exact boundary frame (input seeking lands on a keyframe). */
const PREROLL_SEC = 2;
/** time-stretch with pitch: silence appended before `atempo` so its end-of-stream flush loses no content. */
const ATEMPO_PAD_SEC = 0.25;

/** What the planner needs to know about the source (from the engine's probe and a start-time probe). */
export type DeriveSource = {
	path: string;
	kind: 'video' | 'audio';
	/** First video stream (video media). */
	video: VideoStream | null;
	/** Audio streams carried: every audio stream of a video; the first one of an audio media. */
	audio: AudioStream[];
	durationSec: number;
	hasAlpha: boolean;
	variableFrameRate: boolean;
	/** `:in_color_matrix=…:in_range=…` of the original (export/native.ts `inColor`). */
	inColor: string;
	/** ffprobe start times (seconds, as FFmpeg sees them with `-copyts`): the container and each stream by index. */
	start: { format: number; streams: Record<number, number> };
};

export type DeriveOutput = { ext: '.mov' | '.wav' | '.flac'; kind: 'video' | 'audio' };

/** One FFmpeg run: arguments (without the output path) and the seconds of output it writes (progress). */
export type FfmpegPass = { args: string[]; outSec: number; out: string };

/** A derivation plan: passes run in order; a reverse also joins its segments (`concat`) into the output. */
export type DerivePlan = {
	output: DeriveOutput;
	passes: FfmpegPass[];
	/** reverse: the segment files to join last-first (already in output order), else null. */
	concat: string[] | null;
	/** range of a constant-frame-rate video: the source frames the file holds. */
	range?: { startFrame: number; endFrame: number };
	notes: string[];
};

/** Canonical JSON: object keys sorted, so the hash does not depend on key order. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object')
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v);
}

/** sha256 of the canonical `{fromFingerprint, recipe, recipeVersion}` (S01:AST-020), hex. */
export function deriveRecipeHash(fingerprint: string, recipe: DeriveRecipe): string {
	return createHash('sha256')
		.update(canonical({ fromFingerprint: fingerprint, recipe, recipeVersion: DERIVE_RECIPE_VERSION }))
		.digest('hex');
}

const r6 = (v: number) => {
	const r = Math.round(v * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};

/**
 * `atempo` factors whose product is `rate`, each within 0.5…2 (one instance outside that range skips or repeats
 * samples instead of overlapping them, so it is chained), e.g. 0.25 → [0.5, 0.5], 3 → [2, 1.5].
 */
export function atempoFactors(rate: number): number[] {
	if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`invalid tempo ${rate}`);
	const out: number[] = [];
	let r = rate;
	while (r > 2 + 1e-12) {
		out.push(2);
		r /= 2;
	}
	while (r < 0.5 - 1e-12) {
		out.push(0.5);
		r /= 0.5;
	}
	if (Math.abs(r - 1) > 1e-9 || out.length === 0) out.push(r);
	return out;
}

/**
 * denoise-audio: `afftdn` (FFT spectral denoiser) with strength s ∈ 0…1 mapped to the noise reduction
 * `nr = 6 + 30·s` dB (6…36; FFmpeg's default 12 dB ≈ s 0.2) and the noise floor `nf = −50 + 20·s` dB (−50…−30:
 * stronger settings treat louder hiss as noise). The floor is fixed (`tn=0`): adaptive tracking (`tn=1`) followed
 * sustained tones as if they were noise and left white hiss almost untouched in our measurements (wp-note).
 */
export function denoiseAudioFilter(strength: number): string {
	const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0));
	return `afftdn=nr=${r6(6 + 30 * s)}:nf=${r6(-50 + 20 * s)}:tn=0`;
}

function videoFps(v: VideoStream): { num: number; den: number; fps: number } {
	const num = v.frameRate.num;
	const den = v.frameRate.den;
	const fps = num > 0 && den > 0 ? num / den : 0;
	if (!(fps > 0) || !Number.isFinite(fps)) throw new Error('The video stream has no frame rate');
	return { num, den, fps };
}

/** Video encode options of a derived file (ProRes 422 HQ, 4444 with alpha). */
function videoEncode(src: DeriveSource): { tail: string; args: string[] } {
	const alpha = src.hasAlpha;
	const pix = alpha ? 'yuva444p10le' : 'yuv422p10le';
	const vs = src.video;
	const known = (v: string | undefined): v is string => !!v && v !== 'unknown' && v !== 'unspecified';
	return {
		tail: `scale=flags=bicubic${src.inColor}:out_color_matrix=bt709:out_range=tv,format=${pix}`,
		args: [
			'-c:v',
			'prores_ks',
			'-profile:v',
			alpha ? '4' : '3',
			'-vendor',
			'apl0',
			'-pix_fmt',
			pix,
			...(vs && known(vs.color.primaries) ? ['-color_primaries', vs.color.primaries] : []),
			...(vs && known(vs.color.transfer) ? ['-color_trc', vs.color.transfer] : []),
			'-colorspace',
			'bt709',
			'-color_range',
			'tv',
		],
	};
}

const PCM = ['-c:a', 'pcm_s24le'];
const MOV = ['-movflags', '+write_colr', '-f', 'mov'];
const WAV = ['-rf64', 'auto', '-f', 'wav'];

function input(src: DeriveSource, opts: { seekSec?: number; copyts?: boolean } = {}): string[] {
	return [
		...LOCAL_PROTOCOLS,
		...(opts.copyts ? ['-copyts'] : []),
		...(opts.seekSec && opts.seekSec > 0 ? ['-ss', r6(opts.seekSec)] : []),
		'-i',
		src.path,
	];
}

function checked(graph: string): string {
	assertLgplFilters(graph);
	return graph;
}

/** Simple per-stream filters: `-map` of the video (when any) and the audio streams with `-vf` / `-af`. */
function simplePass(
	src: DeriveSource,
	out: string,
	outSec: number,
	opts: { vf?: string; af?: string; videoArgs?: string[]; inputArgs?: string[]; audioOnly?: AudioStream },
): FfmpegPass {
	const args: string[] = [...(opts.inputArgs ?? input(src))];
	if (opts.audioOnly) {
		args.push('-map', `0:${opts.audioOnly.index}`, '-vn', '-sn', '-dn');
		if (opts.af) args.push('-af', checked(opts.af));
		return { args, outSec, out };
	}
	if (src.video) {
		const enc = videoEncode(src);
		args.push('-map', `0:${src.video.index}`);
		args.push('-vf', checked([opts.vf, enc.tail].filter(Boolean).join(',')));
		args.push(...enc.args, ...(opts.videoArgs ?? []));
	}
	for (const a of src.audio) args.push('-map', `0:${a.index}`);
	if (src.audio.length && opts.af) args.push('-af', checked(opts.af));
	if (src.audio.length) args.push(...PCM);
	args.push('-sn', '-dn');
	return { args, outSec, out };
}

/** The output container of `recipe` for `src`. */
export function deriveOutput(src: Pick<DeriveSource, 'kind'>, recipe: DeriveRecipe): DeriveOutput {
	if (recipe.op === 'extract-audio')
		return { kind: 'audio', ext: recipe.format === 'flac' ? '.flac' : '.wav' };
	if (recipe.op === 'denoise-audio') return { kind: 'audio', ext: '.wav' };
	return src.kind === 'video' ? { kind: 'video', ext: '.mov' } : { kind: 'audio', ext: '.wav' };
}

function containerArgs(output: DeriveOutput): string[] {
	if (output.ext === '.mov') return MOV;
	if (output.ext === '.flac') return ['-c:a', 'flac', '-f', 'flac'];
	return [...PCM, ...WAV];
}

/** Video frames of a reverse segment: the memory budget and REVERSE_MAX_SEGMENT_SEC, at least one. */
export function reverseSegmentFrames(
	v: Pick<VideoStream, 'width' | 'height' | 'bitDepth'>,
	fps: number,
): number {
	const bytesPerFrame = v.width * v.height * (v.bitDepth > 8 ? 8 : 4);
	const byBudget = Math.floor(REVERSE_VIDEO_BUDGET_BYTES / Math.max(1, bytesPerFrame));
	return Math.max(1, Math.min(byBudget, Math.round(REVERSE_MAX_SEGMENT_SEC * fps)));
}

/** Seconds of an audio-only reverse segment: the memory budget and REVERSE_MAX_AUDIO_SEGMENT_SEC, at least 1 s. */
export function reverseAudioSegmentSec(a: Pick<AudioStream, 'sampleRate' | 'channels'>): number {
	const bytesPerSec = Math.max(1, a.sampleRate) * Math.max(1, a.channels) * 8;
	return Math.max(
		1,
		Math.min(REVERSE_MAX_AUDIO_SEGMENT_SEC, Math.floor(REVERSE_AUDIO_BUDGET_BYTES / bytesPerSec)),
	);
}

/** `-ss` (container-relative, before `-copyts` timestamps) that decodes PREROLL_SEC before absolute time `t`. */
function seekFor(src: DeriveSource, t: number): number {
	return Math.max(0, t - src.start.format - PREROLL_SEC);
}

/*
 * Trimmed and reversed pictures end with `fps=fps=<rate>` after `setpts`: it gives every frame its duration. Without it
 * the last frame has duration 0 and FFmpeg 7.1's mov muxer leaves it outside the edit list, so players and decoders
 * drop it (measured: 99 of 100 frames after `reverse`, 49 of 50 after `trim`).
 */
const startOf = (src: DeriveSource, index: number) => src.start.streams[index] ?? src.start.format;

/**
 * The plan of `recipe` on `src`, writing `out` (the partial output) and, for reverse, segment files in
 * `scratch`. Throws on inputs the caller should have refused (`deriveProblems`).
 */
export function planDerive(
	src: DeriveSource,
	recipe: DeriveRecipe,
	out: string,
	scratch: string,
	/** Smaller reverse segments than the memory budget gives (tests). */
	opts: { reverseSegmentFrames?: number; reverseAudioSegmentSec?: number } = {},
): DerivePlan {
	const output = deriveOutput(src, recipe);
	const tail = containerArgs(output);
	const withTail = (p: FfmpegPass): FfmpegPass => ({ ...p, args: [...p.args, ...tail] });
	const D = src.durationSec;
	switch (recipe.op) {
		case 'conform-cfr': {
			if (!src.video) throw new Error('conform-cfr needs a video stream');
			const rate = `${recipe.frameRate.num}/${recipe.frameRate.den}`;
			// `fps` places frames on the new grid by timestamp (duplicating or dropping), so the audio keeps its
			// timing; `aresample=async=1` fills timestamp gaps in the audio so it stays continuous.
			return {
				output,
				passes: [
					withTail(
						simplePass(src, out, D, {
							vf: `fps=fps=${rate}`,
							af: 'aresample=async=1',
							videoArgs: ['-r', rate, '-fps_mode', 'cfr'],
						}),
					),
				],
				concat: null,
				notes: [`constant ${r6(recipe.frameRate.num / recipe.frameRate.den)} fps`],
			};
		}
		case 'denoise-audio': {
			const a = src.audio[0];
			if (!a) throw new Error('denoise-audio needs an audio stream');
			const af = denoiseAudioFilter(recipe.strength);
			return {
				output,
				passes: [withTail(simplePass(src, out, D, { audioOnly: a, af }))],
				concat: null,
				notes: [`${af} on audio stream ${a.index}`],
			};
		}
		case 'extract-audio': {
			const a = src.audio.find((s) => s.index === recipe.streamIndex);
			if (!a) throw new Error(`stream ${recipe.streamIndex} is not an audio stream`);
			return {
				output,
				passes: [withTail(simplePass(src, out, D, { audioOnly: a }))],
				concat: null,
				notes: [`audio stream ${a.index} as ${recipe.format === 'flac' ? 'FLAC' : '24-bit WAV'}`],
			};
		}
		case 'time-stretch': {
			const r = recipe.rate;
			const outSec = D / r;
			const factors = atempoFactors(r);
			// With pitch: `atempo` (WSOLA) chained within 0.5…2, after padding so its flush keeps the last samples,
			// cut to the exact new length. Without: the samples played at rate·sr and resampled back (pitch follows).
			// Every stream starts at the earliest stream start (T0): a later start becomes leading silence (audio) or a
			// later first timestamp (video) before the retime, so an offset of o seconds comes out as o/r.
			const t0 = Math.min(
				...(src.kind === 'video' && src.video ? [startOf(src, src.video.index)] : []),
				...src.audio.map((a) => startOf(src, a.index)),
			);
			const lead = (a: AudioStream) => {
				const n = Math.round(Math.max(0, startOf(src, a.index) - t0) * a.sampleRate);
				return n > 0 ? [`adelay=delays=${n}S:all=1`] : [];
			};
			const audioChain = (a: AudioStream) =>
				(recipe.preservePitch
					? [
							'asetpts=PTS-STARTPTS',
							...lead(a),
							`apad=pad_dur=${ATEMPO_PAD_SEC}`,
							...factors.map((f) => `atempo=${r6(f)}`),
							`atrim=end=${r6(outSec)}`,
						]
					: [
							'asetpts=PTS-STARTPTS',
							...lead(a),
							`asetrate=${Math.round(a.sampleRate * r)}`,
							`aresample=${a.sampleRate}`,
						]
				).join(',');
			const notes = [
				recipe.preservePitch
					? `speed ${r6(r)}× keeping pitch (${factors.map((f) => `atempo ${r6(f)}`).join(' · ')})`
					: `speed ${r6(r)}× (resampled: pitch follows the speed)`,
			];
			if (src.kind === 'audio') {
				const a = src.audio[0]!;
				return {
					output,
					passes: [withTail(simplePass(src, out, outSec, { audioOnly: a, af: audioChain(a) }))],
					concat: null,
					notes,
				};
			}
			const v = src.video!;
			const { num, den } = videoFps(v);
			const enc = videoEncode(src);
			// The picture is retimed and put back on the source's frame grid (frames dropped or repeated).
			const graph = [
				`[0:${v.index}]setpts=(PTS-STARTPTS)/${r6(r)}+${r6((startOf(src, v.index) - t0) / r)}/TB,fps=fps=${num}/${den},${enc.tail}[v]`,
				...src.audio.map((a, i) => `[0:${a.index}]${audioChain(a)}[a${i}]`),
			].join(';');
			return {
				output,
				passes: [
					{
						args: [
							...input(src),
							'-filter_complex',
							checked(graph),
							'-map',
							'[v]',
							...enc.args,
							'-r',
							`${num}/${den}`,
							'-fps_mode',
							'cfr',
							...src.audio.flatMap((_, i) => ['-map', `[a${i}]`]),
							...(src.audio.length ? PCM : []),
							'-sn',
							'-dn',
							...tail,
						],
						outSec,
						out,
					},
				],
				concat: null,
				notes,
			};
		}
		case 'range': {
			const inSec = recipe.inFlicks / FLICKS_PER_SECOND;
			const outSecAbs = recipe.outFlicks / FLICKS_PER_SECOND;
			if (src.kind === 'audio') {
				const a = src.audio[0]!;
				const as = startOf(src, a.index);
				return {
					output,
					passes: [
						withTail(
							simplePass(src, out, outSecAbs - inSec, {
								audioOnly: a,
								inputArgs: input(src, { copyts: true, seekSec: seekFor(src, as + inSec) }),
								af: `atrim=start=${r6(as + inSec)}:end=${r6(as + outSecAbs)},asetpts=PTS-STARTPTS`,
							}),
						),
					],
					concat: null,
					notes: [`${r6(inSec)}–${r6(outSecAbs)} s`],
				};
			}
			const v = src.video!;
			const vs = startOf(src, v.index);
			const { fps, num, den } = videoFps(v);
			let t0: number;
			let t1: number;
			let a0: number;
			let a1: number;
			let range: { startFrame: number; endFrame: number } | undefined;
			let vf: string;
			if (src.variableFrameRate) {
				// No frame grid: the frames whose timestamps lie in [In, Out).
				t0 = a0 = vs + inSec;
				t1 = a1 = vs + outSecAbs;
				vf = `trim=start=${r6(t0)}:end=${r6(t1)},setpts=PTS-STARTPTS,fps=fps=${num}/${den}`;
			} else {
				// Frame n starts at vs + n/fps: trim at half-frame offsets so float rounding never moves a boundary frame.
				range = rangeFrames(recipe, { num, den });
				t0 = vs + (range.startFrame - 0.5) / fps;
				t1 = vs + (range.endFrame - 0.5) / fps;
				a0 = vs + range.startFrame / fps;
				a1 = vs + range.endFrame / fps;
				vf = `${range.startFrame > 0 ? `trim=start=${r6(t0)}:end=${r6(t1)}` : `trim=end=${r6(t1)}`},setpts=PTS-STARTPTS,fps=fps=${num}/${den}`;
			}
			return {
				output,
				passes: [
					withTail(
						simplePass(src, out, a1 - a0, {
							inputArgs: input(src, { copyts: true, seekSec: seekFor(src, Math.max(vs, t0)) }),
							vf,
							af: `atrim=start=${r6(Math.max(0, a0))}:end=${r6(a1)},asetpts=PTS-STARTPTS`,
							videoArgs: ['-fps_mode', 'passthrough'],
						}),
					),
				],
				concat: null,
				...(range ? { range } : {}),
				notes: [
					range
						? `frames ${range.startFrame}–${range.endFrame - 1} (${range.endFrame - range.startFrame} frames)`
						: `${r6(inSec)}–${r6(outSecAbs)} s (variable frame rate: frames by timestamp, made constant at ${r6(fps)} fps)`,
				],
			};
		}
		case 'reverse':
			return planReverse(src, output, scratch, opts);
	}
}

function planReverse(
	src: DeriveSource,
	output: DeriveOutput,
	scratch: string,
	opts: { reverseSegmentFrames?: number; reverseAudioSegmentSec?: number },
): DerivePlan {
	const D = src.durationSec;
	const passes: FfmpegPass[] = [];
	const segFile = (k: number) => `${scratch}/seg-${String(k).padStart(6, '0')}${output.ext}`;
	const segTail = output.ext === '.mov' ? [...PCM, ...MOV] : [...PCM, ...WAV];
	if (src.kind === 'audio') {
		const a = src.audio[0]!;
		const as = startOf(src, a.index);
		const seg = Math.min(reverseAudioSegmentSec(a), opts.reverseAudioSegmentSec ?? Number.POSITIVE_INFINITY);
		const count = Math.max(1, Math.ceil(D / seg - 1e-9));
		for (let k = count - 1; k >= 0; k--) {
			const s = as + k * seg;
			const bounds = [k > 0 ? `start=${r6(s)}` : '', k < count - 1 ? `end=${r6(s + seg)}` : '']
				.filter(Boolean)
				.join(':');
			const trim = bounds ? `atrim=${bounds},` : '';
			passes.push({
				args: [
					...input(src, { copyts: true, seekSec: k > 0 ? seekFor(src, s) : 0 }),
					'-map',
					`0:${a.index}`,
					'-vn',
					'-sn',
					'-dn',
					'-af',
					checked(`${trim}areverse,asetpts=PTS-STARTPTS`),
					...segTail,
				],
				outSec: k < count - 1 ? seg : Math.max(0.001, D - k * seg),
				out: segFile(k),
			});
		}
		return {
			output,
			passes,
			concat: passes.map((p) => p.out),
			notes: [`reversed in ${count} segment${count === 1 ? '' : 's'} of ≤ ${seg} s`],
		};
	}
	const v = src.video!;
	const vs = startOf(src, v.index);
	const { num, den, fps } = videoFps(v);
	const F = Math.max(
		1,
		Math.min(reverseSegmentFrames(v, fps), opts.reverseSegmentFrames ?? Number.POSITIVE_INFINITY),
	);
	const totalFrames = Math.max(1, Math.round(D * fps));
	const count = Math.max(1, Math.ceil(totalFrames / F));
	const enc = videoEncode(src);
	for (let k = count - 1; k >= 0; k--) {
		const first = k * F;
		const last = k < count - 1 ? (k + 1) * F : null;
		// A grid `fps` (start at the stream start) makes variable-rate sources constant-rate and is a no-op for
		// constant-rate ones; segment boundaries sit half a frame before a frame start (no rounding at the edge).
		const vb = [
			first > 0 ? `start=${r6(vs + (first - 0.5) / fps)}` : '',
			last !== null ? `end=${r6(vs + (last - 0.5) / fps)}` : '',
		]
			.filter(Boolean)
			.join(':');
		const ab = [
			first > 0 ? `start=${r6(vs + first / fps)}` : '',
			last !== null ? `end=${r6(vs + last / fps)}` : '',
		]
			.filter(Boolean)
			.join(':');
		const graph = [
			`[0:${v.index}]fps=fps=${num}/${den}:start_time=${r6(vs)},${vb ? `trim=${vb},` : ''}reverse,setpts=PTS-STARTPTS,fps=fps=${num}/${den},${enc.tail}[v]`,
			...src.audio.map(
				(a, i) => `[0:${a.index}]${ab ? `atrim=${ab},` : ''}areverse,asetpts=PTS-STARTPTS[a${i}]`,
			),
		].join(';');
		passes.push({
			args: [
				...input(src, { copyts: true, seekSec: first > 0 ? seekFor(src, vs + first / fps) : 0 }),
				'-filter_complex',
				checked(graph),
				'-map',
				'[v]',
				...enc.args,
				'-fps_mode',
				'passthrough',
				...src.audio.flatMap((_, i) => ['-map', `[a${i}]`]),
				'-sn',
				'-dn',
				...segTail,
			],
			outSec: ((last ?? totalFrames) - first) / fps,
			out: segFile(k),
		});
	}
	return {
		output,
		passes,
		concat: passes.map((p) => p.out),
		notes: [
			`reversed in ${count} segment${count === 1 ? '' : 's'} of ≤ ${F} frames (≤ ${Math.round(REVERSE_VIDEO_BUDGET_BYTES / 1024 / 1024)} MB of frames each)`,
			...(src.variableFrameRate ? [`variable frame rate made constant at ${r6(fps)} fps`] : []),
		],
	};
}

/** The concat-demuxer list of `files` (single quotes escaped). */
export function concatList(files: readonly string[]): string {
	return `${files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')}\n`;
}

/** Arguments joining reversed segments (`concat` demuxer, stream copy) into `out`. */
export function concatArgs(listFile: string, output: DeriveOutput): string[] {
	return [
		...LOCAL_PROTOCOLS,
		'-f',
		'concat',
		'-safe',
		'0',
		'-i',
		listFile,
		'-map',
		'0',
		'-c',
		'copy',
		...(output.ext === '.mov' ? MOV : WAV),
	];
}

/** Human label of a recipe in file names, e.g. `Reversed`, `Time-stretched 2×`, `Conformed 25 fps`. */
export function deriveLabel(recipe: DeriveRecipe): string {
	switch (recipe.op) {
		case 'conform-cfr':
			return `Conformed ${r6(recipe.frameRate.num / recipe.frameRate.den)} fps`;
		case 'reverse':
			return 'Reversed';
		case 'denoise-audio':
			return `Audio Denoised ${Math.round(recipe.strength * 100)}%`;
		case 'extract-audio':
			return `Audio stream ${recipe.streamIndex}`;
		case 'time-stretch':
			return `Time-stretched ${r6(recipe.rate)}×${recipe.preservePitch ? '' : ' (pitch)'}`;
		case 'range':
			return `Range ${(recipe.inFlicks / FLICKS_PER_SECOND).toFixed(3)}–${(recipe.outFlicks / FLICKS_PER_SECOND).toFixed(3)} s`;
	}
}
