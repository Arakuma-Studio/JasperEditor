// The voice analysis contract (spec 14 TC-001; docs/wp-notes/transcript-cleanup.md "Voice analysis"): 10 ms frames of
// one audio stream of a media file — level, voicing, flatness (bytes) and the class of each frame (speech /
// breath-like / silence) — with the file's noise floor, speech level and thresholds, the same per 60 s window, and
// the compact binary file the engine caches it in. The engine's `voice-analysis` job computes it (features and classes
// are @jasper/audio-dsp `voice.ts`); the cleanup detector, the speech worker and agents read it through this module.
// Pure: no DOM or Node APIs.
//
// Time: frame k covers decoded samples [k·160, (k+1)·160) at 16 kHz — media time k × 10 ms from the first decoded
// sample of the stream (the transcripts' timeline: the speech worker decodes the same way). The last frame may be
// partial. Levels are measured over 25 ms centred on the frame.
//
// File format (`.bin`, little-endian, version `VOICE_ANALYSIS_FORMAT`):
//   0      4  magic "JVA1"
//   4      4  u32 header length H (2 … 262 144)
//   8      H  header: ASCII JSON, `VoiceAnalysisHeaderSchema`
//   8+H    N  level plane    (N = frameCount bytes; dB = −120 + q × 0.5)
//   …      N  voicing plane  (q / 255)
//   …      N  flatness plane (q / 255)
//   …      N  class plane    (0 silence, 1 breath-like, 2 speech)
//   end−4  4  u32 CRC-32 (IEEE) of every byte before it
// ≈ 1.44 MB per hour of audio. `decodeVoiceAnalysis` validates everything (magic, sizes, header schema, CRC, class
// bytes, windows, counts) and never throws.
import {
	classifyVoiceFrames,
	VOICE_CLASS_BREATH,
	VOICE_CLASS_SILENCE,
	VOICE_CLASS_SPEECH,
	VOICE_HOP,
	VOICE_LEVEL_MIN_DB,
	VOICE_LEVEL_STEP_DB,
	VOICE_SAMPLE_RATE,
	VOICE_WINDOW,
	type VoiceFeaturePlanes,
	voiceFrameCount,
	voiceLevelDb,
	voiceLevels,
} from '@jasper/audio-dsp';
import { z } from 'zod';

/** Bump when the features or the classes change: cached analyses of other versions are recomputed. */
export const VOICE_ANALYSIS_VERSION = 1;
/** Version of the binary layout. */
export const VOICE_ANALYSIS_FORMAT = 1;
/** Frames per level window ("per 60 s window for drifting rooms"). */
export const VOICE_WINDOW_FRAMES = 6000;
/** Longest analysable stream: 24 h of frames (≈ 35 MB). */
export const VOICE_ANALYSIS_MAX_FRAMES = 24 * 3600 * 100;
/** Header bytes: 24 h of 60 s windows take ≈ 150 KB. */
const MAX_HEADER_BYTES = 262_144;
const MAGIC = [0x4a, 0x56, 0x41, 0x31] as const; // "JVA1"

export const VOICE_CLASSES = {
	silence: VOICE_CLASS_SILENCE,
	breath: VOICE_CLASS_BREATH,
	speech: VOICE_CLASS_SPEECH,
} as const;
export type VoiceClassName = keyof typeof VOICE_CLASSES;
export const VOICE_CLASS_NAMES: readonly VoiceClassName[] = ['silence', 'breath', 'speech'];

const Db = z.number().finite().min(-200).max(50);

/** Levels of a stretch of frames: null when it is all digital silence (≤ −100 dBFS). */
export const VoiceLevelsSchema = z.object({
	floorDb: Db.nullable(),
	speechDb: Db.nullable(),
	speechThresholdDb: Db.nullable(),
});

export const VoiceWindowSchema = VoiceLevelsSchema.extend({
	startFrame: z.number().int().min(0),
	frameCount: z.number().int().min(1).max(VOICE_WINDOW_FRAMES),
});
export type VoiceWindow = z.infer<typeof VoiceWindowSchema>;

const Count = z.number().int().min(0).max(VOICE_ANALYSIS_MAX_FRAMES);

export const VoiceAnalysisHeaderSchema = z
	.object({
		format: z.literal(VOICE_ANALYSIS_FORMAT),
		analysisVersion: z.number().int().min(1),
		/** The media file's content fingerprint (`q1:…`). */
		fingerprint: z.string().min(1).max(200),
		/** Container stream index of the audio stream (what audio clips store in `channels.streamIndex`). */
		stream: z.number().int().min(0).max(65_535),
		sampleRate: z.literal(VOICE_SAMPLE_RATE),
		frameStep: z.literal(VOICE_HOP),
		window: z.literal(VOICE_WINDOW),
		levelMinDb: z.literal(VOICE_LEVEL_MIN_DB),
		levelStepDb: z.literal(VOICE_LEVEL_STEP_DB),
		/** Decoded samples at 16 kHz (mono). */
		samples: z
			.number()
			.int()
			.min(0)
			.max(VOICE_ANALYSIS_MAX_FRAMES * VOICE_HOP),
		frameCount: Count,
		/** Noise floor / speech level / threshold of the whole stream (the classes use these). */
		levels: VoiceLevelsSchema.extend({ breathFloorDb: Db.nullable() }),
		counts: z.object({ silence: Count, breath: Count, speech: Count }),
		windowFrames: z.literal(VOICE_WINDOW_FRAMES),
		windows: z.array(VoiceWindowSchema).max(Math.ceil(VOICE_ANALYSIS_MAX_FRAMES / VOICE_WINDOW_FRAMES)),
	})
	.strict();
export type VoiceAnalysisHeader = z.infer<typeof VoiceAnalysisHeaderSchema>;

/** A decoded voice analysis: the header plus the four byte planes (`frameCount` bytes each). */
export type VoiceAnalysis = VoiceAnalysisHeader & {
	/** Level, quantised: dB = −120 + q × 0.5 (`voiceLevelDb`). */
	level: Uint8Array;
	/** Voicing, q / 255. */
	voicing: Uint8Array;
	/** Spectral flatness, q / 255. */
	flatness: Uint8Array;
	/** Frame classes (`VOICE_CLASSES`). */
	classes: Uint8Array;
};

/**
 * The analysis of a stream from its feature planes (`VoiceFeatureExtractor`): frame classes against the whole
 * stream's levels, the levels of each 60 s window, class counts.
 */
export function buildVoiceAnalysis(o: {
	fingerprint: string;
	stream: number;
	samples: number;
	planes: VoiceFeaturePlanes;
}): VoiceAnalysis {
	const n = voiceFrameCount(o.samples);
	if (o.planes.level.length !== n) throw new RangeError('buildVoiceAnalysis: planes do not match samples');
	if (n > VOICE_ANALYSIS_MAX_FRAMES) throw new RangeError('buildVoiceAnalysis: stream too long');
	const { classes, levels } = classifyVoiceFrames(o.planes);
	const counts = { silence: 0, breath: 0, speech: 0 };
	for (let i = 0; i < n; i++) counts[VOICE_CLASS_NAMES[classes[i]!]!]++;
	const windows: VoiceWindow[] = [];
	for (let start = 0; start < n; start += VOICE_WINDOW_FRAMES) {
		const end = Math.min(n, start + VOICE_WINDOW_FRAMES);
		const w = voiceLevels(o.planes.level, start, end);
		windows.push({
			startFrame: start,
			frameCount: end - start,
			floorDb: w?.floorDb ?? null,
			speechDb: w?.speechDb ?? null,
			speechThresholdDb: w?.speechThresholdDb ?? null,
		});
	}
	return {
		format: VOICE_ANALYSIS_FORMAT,
		analysisVersion: VOICE_ANALYSIS_VERSION,
		fingerprint: o.fingerprint,
		stream: o.stream,
		sampleRate: VOICE_SAMPLE_RATE,
		frameStep: VOICE_HOP,
		window: VOICE_WINDOW,
		levelMinDb: VOICE_LEVEL_MIN_DB,
		levelStepDb: VOICE_LEVEL_STEP_DB,
		samples: o.samples,
		frameCount: n,
		levels: {
			floorDb: levels?.floorDb ?? null,
			speechDb: levels?.speechDb ?? null,
			speechThresholdDb: levels?.speechThresholdDb ?? null,
			breathFloorDb: levels?.breathFloorDb ?? null,
		},
		counts,
		windowFrames: VOICE_WINDOW_FRAMES,
		windows,
		level: o.planes.level,
		voicing: o.planes.voicing,
		flatness: o.planes.flatness,
		classes,
	};
}

/** Seconds of the start of frame `k`. */
export function voiceFrameSeconds(k: number): number {
	return (k * VOICE_HOP) / VOICE_SAMPLE_RATE;
}

/** The frame containing media second `t` (clamped to [0, frameCount − 1]; 0 for an empty analysis). */
export function voiceFrameAt(a: Pick<VoiceAnalysis, 'frameCount'>, t: number): number {
	if (a.frameCount <= 0 || !(t > 0)) return 0;
	return Math.min(a.frameCount - 1, Math.floor((t * VOICE_SAMPLE_RATE) / VOICE_HOP));
}

/** Seconds of decoded audio. */
export function voiceDurationSeconds(a: Pick<VoiceAnalysis, 'samples'>): number {
	return a.samples / VOICE_SAMPLE_RATE;
}

/** Bytes of the file of an analysis with `frameCount` frames and a header of `headerBytes`. */
export function voiceAnalysisFileBytes(frameCount: number, headerBytes: number): number {
	return 8 + headerBytes + 4 * frameCount + 4;
}

/** Largest valid file (the engine refuses to read bigger ones). */
export const VOICE_ANALYSIS_MAX_FILE_BYTES = voiceAnalysisFileBytes(
	VOICE_ANALYSIS_MAX_FRAMES,
	MAX_HEADER_BYTES,
);

let CRC_TABLE: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, as zlib / PNG). */
export function crc32Ieee(bytes: Uint8Array, crc = 0): number {
	if (!CRC_TABLE) {
		CRC_TABLE = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			CRC_TABLE[n] = c >>> 0;
		}
	}
	const t = CRC_TABLE;
	let c = (crc ^ 0xffffffff) >>> 0;
	for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function asciiBytes(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c > 0x7e) throw new RangeError('voice analysis header must be ASCII');
		out[i] = c;
	}
	return out;
}

/** Problems of a decoded analysis that the header schema cannot see (sizes, windows, counts, class bytes). */
function consistencyError(a: VoiceAnalysis): string | null {
	const n = a.frameCount;
	if (n !== voiceFrameCount(a.samples)) return 'frameCount does not match samples';
	for (const p of [a.level, a.voicing, a.flatness, a.classes]) if (p.length !== n) return 'plane size';
	const counts = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		const c = a.classes[i]!;
		if (c > VOICE_CLASS_SPEECH) return `invalid class ${c} at frame ${i}`;
		counts[c]!++;
	}
	if (counts[0] !== a.counts.silence || counts[1] !== a.counts.breath || counts[2] !== a.counts.speech)
		return 'class counts do not match the class plane';
	const expected = Math.ceil(n / VOICE_WINDOW_FRAMES);
	if (a.windows.length !== expected) return `expected ${expected} windows`;
	for (let w = 0; w < a.windows.length; w++) {
		const win = a.windows[w]!;
		if (win.startFrame !== w * VOICE_WINDOW_FRAMES) return `window ${w} start`;
		if (win.frameCount !== Math.min(VOICE_WINDOW_FRAMES, n - win.startFrame)) return `window ${w} length`;
	}
	return null;
}

/** The binary file of an analysis (throws RangeError on an inconsistent analysis: a programming error). */
export function encodeVoiceAnalysis(a: VoiceAnalysis): Uint8Array {
	const header: VoiceAnalysisHeader = VoiceAnalysisHeaderSchema.parse({
		format: a.format,
		analysisVersion: a.analysisVersion,
		fingerprint: a.fingerprint,
		stream: a.stream,
		sampleRate: a.sampleRate,
		frameStep: a.frameStep,
		window: a.window,
		levelMinDb: a.levelMinDb,
		levelStepDb: a.levelStepDb,
		samples: a.samples,
		frameCount: a.frameCount,
		levels: a.levels,
		counts: a.counts,
		windowFrames: a.windowFrames,
		windows: a.windows,
	});
	const bad = consistencyError(a);
	if (bad) throw new RangeError(`encodeVoiceAnalysis: ${bad}`);
	const h = asciiBytes(JSON.stringify(header));
	if (h.length > MAX_HEADER_BYTES) throw new RangeError('encodeVoiceAnalysis: header too large');
	const n = a.frameCount;
	const out = new Uint8Array(voiceAnalysisFileBytes(n, h.length));
	const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
	out.set(MAGIC, 0);
	dv.setUint32(4, h.length, true);
	out.set(h, 8);
	let o = 8 + h.length;
	for (const p of [a.level, a.voicing, a.flatness, a.classes]) {
		out.set(p, o);
		o += n;
	}
	dv.setUint32(o, crc32Ieee(out.subarray(0, o)), true);
	return out;
}

export type VoiceAnalysisDecode = { ok: true; analysis: VoiceAnalysis } | { ok: false; error: string };

/**
 * Reads a voice analysis file: every field validated, never throws. The planes are views into `bytes` (no copy).
 * `expect` (optional) must match the header (a file found under the wrong key is refused).
 */
export function decodeVoiceAnalysis(
	bytes: Uint8Array,
	expect: { fingerprint?: string; stream?: number; analysisVersion?: number } = {},
): VoiceAnalysisDecode {
	const fail = (error: string): VoiceAnalysisDecode => ({ ok: false, error });
	if (!(bytes instanceof Uint8Array)) return fail('not bytes');
	if (bytes.length < 12) return fail('file too short');
	if (bytes.length > VOICE_ANALYSIS_MAX_FILE_BYTES) return fail('file too large');
	for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return fail('not a voice analysis file');
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const hl = dv.getUint32(4, true);
	if (hl < 2 || hl > MAX_HEADER_BYTES || 8 + hl + 4 > bytes.length) return fail('bad header length');
	let text = '';
	for (let i = 0; i < hl; i++) {
		const c = bytes[8 + i]!;
		if (c < 0x20 || c > 0x7e) return fail('header is not ASCII JSON');
		text += String.fromCharCode(c);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return fail('header is not JSON');
	}
	const parsed = VoiceAnalysisHeaderSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return fail(`invalid header: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim());
	}
	const header = parsed.data;
	if (expect.fingerprint !== undefined && header.fingerprint !== expect.fingerprint)
		return fail('fingerprint mismatch');
	if (expect.stream !== undefined && header.stream !== expect.stream) return fail('stream mismatch');
	if (expect.analysisVersion !== undefined && header.analysisVersion !== expect.analysisVersion)
		return fail('analysis version mismatch');
	const n = header.frameCount;
	if (bytes.length !== voiceAnalysisFileBytes(n, hl)) return fail('file size does not match frameCount');
	const end = bytes.length - 4;
	if (crc32Ieee(bytes.subarray(0, end)) !== dv.getUint32(end, true)) return fail('checksum mismatch');
	const base = 8 + hl;
	const analysis: VoiceAnalysis = {
		...header,
		level: bytes.subarray(base, base + n),
		voicing: bytes.subarray(base + n, base + 2 * n),
		flatness: bytes.subarray(base + 2 * n, base + 3 * n),
		classes: bytes.subarray(base + 3 * n, base + 4 * n),
	};
	const bad = consistencyError(analysis);
	return bad ? fail(bad) : { ok: true, analysis };
}

/** A run of frames of one class: `[startFrame, endFrame)`. */
export type VoiceRun = { cls: VoiceClassName; startFrame: number; endFrame: number };

/** Runs of equal classes overlapping `[from, to)` frames (clipped to it). */
export function voiceRuns(
	a: Pick<VoiceAnalysis, 'classes' | 'frameCount'>,
	from = 0,
	to = a.frameCount,
): VoiceRun[] {
	const lo = Math.max(0, Math.floor(from));
	const hi = Math.min(a.frameCount, Math.ceil(to));
	const out: VoiceRun[] = [];
	let i = lo;
	while (i < hi) {
		const c = a.classes[i]!;
		let j = i + 1;
		while (j < hi && a.classes[j] === c) j++;
		out.push({ cls: VOICE_CLASS_NAMES[c] ?? 'silence', startFrame: i, endFrame: j });
		i = j;
	}
	return out;
}

export type VoiceAnalysisSummary = {
	durationSeconds: number;
	frameCount: number;
	stream: number;
	analysisVersion: number;
	floorDb: number | null;
	speechDb: number | null;
	speechThresholdDb: number | null;
	breathFloorDb: number | null;
	/** Seconds of each class. */
	seconds: Record<VoiceClassName, number>;
	/** Runs of each class. */
	runs: Record<VoiceClassName, number>;
	/** Longest run of each class, seconds. */
	longestSeconds: Record<VoiceClassName, number>;
	windows: Array<{
		startSeconds: number;
		seconds: number;
		floorDb: number | null;
		speechDb: number | null;
		speechThresholdDb: number | null;
	}>;
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Totals of an analysis for people and agents. */
export function summarizeVoiceAnalysis(a: VoiceAnalysis): VoiceAnalysisSummary {
	const runs = { silence: 0, breath: 0, speech: 0 };
	const longest = { silence: 0, breath: 0, speech: 0 };
	for (const r of voiceRuns(a)) {
		runs[r.cls]++;
		longest[r.cls] = Math.max(longest[r.cls], r.endFrame - r.startFrame);
	}
	const sec = (frames: number) => r3(voiceFrameSeconds(frames));
	return {
		durationSeconds: r3(voiceDurationSeconds(a)),
		frameCount: a.frameCount,
		stream: a.stream,
		analysisVersion: a.analysisVersion,
		floorDb: a.levels.floorDb,
		speechDb: a.levels.speechDb,
		speechThresholdDb: a.levels.speechThresholdDb,
		breathFloorDb: a.levels.breathFloorDb,
		seconds: { silence: sec(a.counts.silence), breath: sec(a.counts.breath), speech: sec(a.counts.speech) },
		runs,
		longestSeconds: {
			silence: sec(longest.silence),
			breath: sec(longest.breath),
			speech: sec(longest.speech),
		},
		windows: a.windows.map((w) => ({
			startSeconds: sec(w.startFrame),
			seconds: sec(w.frameCount),
			floorDb: w.floorDb,
			speechDb: w.speechDb,
			speechThresholdDb: w.speechThresholdDb,
		})),
	};
}

export type VoiceAnalysisPage = {
	fromFrame: number;
	toFrame: number;
	/** Frames per point. */
	step: number;
	/** Start second of each point. */
	times: number[];
	/** Loudest level of each point (dBFS, 0.5 dB steps). */
	levelDb: number[];
	/** Mean voicing / flatness of each point (0…1, 3 decimals). */
	voicing: number[];
	flatness: number[];
	/** Majority class of each point (ties: speech over breath over silence). */
	classes: VoiceClassName[];
	/** Class runs inside the page, seconds. */
	runs: Array<{ cls: VoiceClassName; start: number; end: number }>;
};

/** Points of `[fromFrame, fromFrame + frames)` reduced by `step` frames per point (for graphs and agents). */
export function voiceAnalysisPage(
	a: VoiceAnalysis,
	opts: { fromFrame: number; frames: number; step: number },
): VoiceAnalysisPage {
	const step = Math.max(1, Math.floor(opts.step) || 1);
	const from = Math.min(a.frameCount, Math.max(0, Math.floor(opts.fromFrame) || 0));
	const to = Math.min(a.frameCount, from + Math.max(0, Math.floor(opts.frames) || 0));
	const page: VoiceAnalysisPage = {
		fromFrame: from,
		toFrame: to,
		step,
		times: [],
		levelDb: [],
		voicing: [],
		flatness: [],
		classes: [],
		runs: voiceRuns(a, from, to).map((r) => ({
			cls: r.cls,
			start: r3(voiceFrameSeconds(r.startFrame)),
			end: r3(voiceFrameSeconds(r.endFrame)),
		})),
	};
	for (let s = from; s < to; s += step) {
		const e = Math.min(to, s + step);
		let lv = 0;
		let v = 0;
		let f = 0;
		const n = [0, 0, 0];
		for (let i = s; i < e; i++) {
			if (a.level[i]! > lv) lv = a.level[i]!;
			v += a.voicing[i]!;
			f += a.flatness[i]!;
			n[a.classes[i]!]!++;
		}
		const k = e - s;
		page.times.push(r3(voiceFrameSeconds(s)));
		page.levelDb.push(voiceLevelDb(lv));
		page.voicing.push(r3(v / k / 255));
		page.flatness.push(r3(f / k / 255));
		page.classes.push(n[2]! >= n[1]! && n[2]! >= n[0]! ? 'speech' : n[1]! >= n[0]! ? 'breath' : 'silence');
	}
	return page;
}
