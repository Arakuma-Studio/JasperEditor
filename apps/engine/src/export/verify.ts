// Export verification (spec 18 §2.5 AF-VER-001…003; docs/wp-notes/agent-footage-verify.md): the thresholds, the
// picture and click detectors at cuts, and the judge that turns measurements of a finished export into rows
// `{id, kind, status, measured, expected, tolerance, at?, message}`. `format` rows check what the file is (an agent may
// fix them unasked by exporting again); `judgement` rows check what the cut does (ask the user). `verified` = no `fail`
// row and no `unverified` format row. Row shape and the format / judgement split are adapted from kajisho5/ffmpeg-skill
// (MIT; licenses/ported/ffmpeg-skill.md; no code copied). Pure: the measurements come from verify-measure.ts.
import type { ExportOutputInfo, ExportOutputStream, VerifyAt, VerifyRow } from '@jasper/api';
import { type DeliveryTarget, formatTimecode } from '@jasper/project';
import type { ExportVerifyContext, VerifyCut } from './verify-context.ts';

/** Every threshold of the checks (the wp-note's "Thresholds" table is pinned to these by a test). */
export const VERIFY_THRESHOLDS = {
	/** `duration`: |file − range| ≤ max(1 frame, this). */
	durationToleranceSec: 0.05,
	/** `av-skew`: video and audio stream ends differ at most this much. */
	avSkewMaxSec: 0.25,
	/** `streams`: frame rate difference still taken as the same rate (fps). */
	frameRateToleranceFps: 0.01,
	/** `cut-black` / `cut-flash`: frames on each side of a cut whose picture is judged. */
	cutWindowFrames: 2,
	/** `cut-black`: normalised mean luma (0 = black level, 1 = white level) under which a frame is black. */
	blackLuma: 16 / 255,
	/** `cut-black`: shortest black run that counts. */
	blackMinSec: 0.1,
	/** `cut-flash`: normalised mean luma step against both neighbours of a single frame. */
	flashJump: 0.25,
	/** `cut-click`: how far from a cut a click is looked for. */
	clickWindowSec: 0.01,
	/** `cut-click`: a sample step this far over the local RMS is a click. */
	clickOverRmsDb: 12,
	/** `cut-click`: the local RMS (of the sample-to-sample steps) is taken over this centred neighbourhood… */
	clickRmsWindowSec: 0.02,
	/** …without this much on each side of the step (the click itself), and the step must be the only one this big. */
	clickIsolationSec: 0.002,
	/** `cut-click`: steps under this level (dBFS) are dither, not clicks. */
	clickMinStepDbfs: -60,
	/** `loudness`: integrated loudness within this of the target. */
	loudnessToleranceLu: 1.0,
	/** `true-peak`: true peak at most the ceiling plus this. */
	truePeakToleranceDb: 0.1,
	/** `true-peak`: the ceiling of an export that was not normalised (full scale: over it the file clips). */
	defaultTruePeakCeilingDbtp: 0,
	/** `silence`: every channel at or under this level (dBFS) is digital silence… */
	silenceDbfs: -90,
	/** …listed when it lasts longer than this. */
	silenceMinSec: 2,
	/** `target-aspect`: frame shapes this close (relative) are the same shape. */
	aspectTolerance: 0.01,
} as const;

/** Most rows a check lists one by one (the rest are counted in one row). */
export const MAX_ROWS_PER_CHECK = 50;

const T = VERIFY_THRESHOLDS;

// ---------------------------------------------------------------------------------------------------------------
// Pixel formats

type PixTraits = { chroma: '420' | '422' | '444' | 'gray' | 'rgb'; depth: number; alpha: boolean };

/** Chroma subsampling, bit depth and alpha of an ffmpeg pixel format name (null = not known). */
export function pixFmtTraits(name: string): PixTraits | null {
	const n = name.toLowerCase();
	if (n === 'nv12' || n === 'nv21') return { chroma: '420', depth: 8, alpha: false };
	const p = /^p0(10|12|16)(le|be)?$/.exec(n);
	if (p) return { chroma: '420', depth: Number(p[1]), alpha: false };
	const y = /^yuv(a?)j?(420|422|444)p(\d+)?(le|be)?$/.exec(n);
	if (y) return { chroma: y[2] as PixTraits['chroma'], depth: y[3] ? Number(y[3]) : 8, alpha: y[1] === 'a' };
	const g = /^gbr(a?)p(\d+)?(le|be)?$/.exec(n);
	if (g) return { chroma: 'rgb', depth: g[2] ? Number(g[2]) : 8, alpha: g[1] === 'a' };
	return null;
}

/** The file's pixel format carries what was encoded: same subsampling, at least the bit depth, alpha when asked. */
export function pixFmtMatches(expected: string, actual: string, alpha: boolean): boolean {
	const e = pixFmtTraits(expected);
	const a = pixFmtTraits(actual);
	if (!e || !a) return expected === actual;
	return e.chroma === a.chroma && a.depth >= e.depth && (!alpha || a.alpha);
}

// ---------------------------------------------------------------------------------------------------------------
// Picture at a cut

export type CutPictureFinding =
	| { kind: 'black'; startFrame: number; frames: number }
	| { kind: 'flash'; frame: number; jump: number };

/**
 * Black and flash frames around one cut. `luma(i)` = normalised mean luma of file frame `i` (undefined = not decoded).
 * A black run counts when it touches the ±`cutWindowFrames` frames of the cut, lasts ≥ `blackMinSec` and lies where the
 * timeline intends no black (frames before the cut unless `blackBefore`, from it unless `blackAfter`); its length is
 * followed into the analysed frames around the window. A flash is one frame of the window whose luma differs by more
 * than `flashJump` from both neighbours in the same direction.
 */
export function cutPictureFindings(
	luma: (frame: number) => number | undefined,
	cut: Pick<VerifyCut, 'blackBefore' | 'blackAfter'> & { fileFrame: number },
	fps: number,
	frames: number,
): CutPictureFinding[] {
	const out: CutPictureFinding[] = [];
	const minRun = Math.max(1, Math.ceil(T.blackMinSec * fps - 1e-9));
	const c = cut.fileFrame;
	const lo = Math.max(0, c - T.cutWindowFrames);
	const hi = Math.min(frames - 1, c + T.cutWindowFrames);
	const unintendedBlack = (i: number) => {
		const v = luma(i);
		if (v === undefined || !(v < T.blackLuma)) return false;
		return i < c ? !cut.blackBefore : !cut.blackAfter;
	};
	for (let i = lo; i <= hi; i++) {
		if (!unintendedBlack(i)) continue;
		let s = i;
		while (s - 1 >= 0 && s - 1 >= c - T.cutWindowFrames - minRun && unintendedBlack(s - 1)) s--;
		let e = i;
		while (e + 1 < frames && e + 1 <= c + T.cutWindowFrames + minRun && unintendedBlack(e + 1)) e++;
		if (e - s + 1 >= minRun) {
			out.push({ kind: 'black', startFrame: s, frames: e - s + 1 });
			break;
		}
		i = e;
	}
	for (let i = Math.max(1, lo); i <= Math.min(frames - 2, hi); i++) {
		const v = luma(i);
		const a = luma(i - 1);
		const b = luma(i + 1);
		if (v === undefined || a === undefined || b === undefined) continue;
		const da = v - a;
		const db = v - b;
		if (Math.abs(da) > T.flashJump && Math.abs(db) > T.flashJump && Math.sign(da) === Math.sign(db)) {
			// a black frame is reported by the black run check when it is long enough; a single dark frame is a flash
			out.push({ kind: 'flash', frame: i, jump: Math.min(Math.abs(da), Math.abs(db)) });
			break;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Click at a cut

export type CutClick = { sample: number; channel: number; overDb: number; stepDbfs: number };

/**
 * The strongest click within ±`clickWindowSec` of `center` (a sample index of `planar`): a sample-to-sample step more
 * than `clickOverRmsDb` over the local RMS — the RMS of the sample-to-sample steps in the centred `clickRmsWindowSec`
 * neighbourhood without ±`clickIsolationSec` around the step (a discontinuity measure: against the RMS of the signal
 * itself a phase jump of a tone, +0.2 → −0.2 at 0.14 RMS, is only 9 dB) — at least `clickMinStepDbfs`, and isolated: no
 * other step outside ±`clickIsolationSec` of it within the searched window is half as big (broadband sound — noise,
 * cymbals — is not a click). Null when there is none.
 */
export function detectCutClick(
	planar: readonly Float32Array[],
	sampleRate: number,
	center: number,
): CutClick | null {
	if (!(sampleRate > 0) || !planar.length) return null;
	const n = planar[0]!.length;
	const win = Math.max(1, Math.round(T.clickWindowSec * sampleRate));
	const half = Math.max(1, Math.round((T.clickRmsWindowSec / 2) * sampleRate));
	const iso = Math.max(1, Math.round(T.clickIsolationSec * sampleRate));
	const minStep = 10 ** (T.clickMinStepDbfs / 20);
	const ratio = 10 ** (T.clickOverRmsDb / 20);
	let best: CutClick | null = null;
	for (let ch = 0; ch < planar.length; ch++) {
		const x = planar[ch]!;
		const a = Math.max(1, center - win);
		const b = Math.min(n - 1, center + win);
		if (b < a) continue;
		let peak = 0;
		let at = -1;
		for (let i = a; i <= b; i++) {
			const d = Math.abs(x[i]! - x[i - 1]!);
			if (Number.isFinite(d) && d > peak) {
				peak = d;
				at = i;
			}
		}
		if (at < 0 || peak < minStep) continue;
		let isolated = true;
		for (let i = a; i <= b && isolated; i++) {
			if (Math.abs(i - at) <= iso) continue;
			if (Math.abs(x[i]! - x[i - 1]!) >= peak / 2) isolated = false;
		}
		if (!isolated) continue;
		let sum = 0;
		let count = 0;
		for (let i = Math.max(1, at - half); i <= Math.min(n - 1, at + half); i++) {
			if (Math.abs(i - at) <= iso) continue;
			const d = x[i]! - x[i - 1]!;
			sum += d * d;
			count++;
		}
		const rms = count ? Math.sqrt(sum / count) : 0;
		const over = rms > 0 ? peak / rms : Number.POSITIVE_INFINITY;
		if (over <= ratio) continue;
		const overDb = Number.isFinite(over) ? 20 * Math.log10(over) : 120;
		if (!best || overDb > best.overDb)
			best = { sample: at, channel: ch, overDb: Math.min(120, overDb), stepDbfs: 20 * Math.log10(peak) };
	}
	return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Judge

export type VerifyChecks = 'fast' | 'full';

/** Measurements of a full verification (decoded). */
export type FullMeasurements = {
	/** Decoder error lines (empty = the streams decoded cleanly). */
	decodeErrors: string[];
	/** Normalised mean luma per file frame (only frames around cuts). */
	luma: ReadonlyMap<number, number>;
	/** Decoded video frames (0 without a video stream). */
	videoFrames: number;
	/** Per context cut (same order): the click found, or null. Null when the file has no audio. */
	clicks: ((CutClick & { sec: number }) | null)[] | null;
	loudness: { integratedLufs: number | null; truePeakDbtp: number | null } | null;
	silences: { startSec: number; endSec: number }[];
};

export type JudgeInput = {
	checks: VerifyChecks;
	context: ExportVerifyContext | null;
	/** What the export job's result says when there is no context (exports of older builds). */
	fallback: { container?: string | undefined; durationSec?: number | undefined };
	output: ExportOutputInfo;
	target: DeliveryTarget | null;
	full?: FullMeasurements;
};

const r2 = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const fpsOf = (q: { num: number; den: number }) => q.num / q.den;

function atOf(ctx: ExportVerifyContext | null, videoFps: number | null, sec: number): VerifyAt {
	if (ctx) {
		const fps = fpsOf(ctx.fps);
		const frame = ctx.range.start + Math.max(0, Math.floor(sec * fps + 1e-6));
		return {
			sec: r2(sec, 3),
			frame,
			timecode: formatTimecode(frame, ctx.fps, {
				dropFrame: ctx.dropFrame,
				startFrames: ctx.startTimecodeFrames,
			}),
		};
	}
	const fps = videoFps && videoFps > 0 ? videoFps : 30;
	const frame = Math.max(0, Math.floor(sec * fps + 1e-6));
	return { sec: r2(sec, 3), frame, timecode: formatTimecode(frame, { num: Math.round(fps), den: 1 }) };
}

function describeVideo(s: ExportOutputStream | undefined): string {
	if (!s) return 'no video';
	return `${s.codec} ${s.width ?? '?'}×${s.height ?? '?'} ${s.frameRate !== undefined ? `${r2(s.frameRate, 3)} fps` : '? fps'} ${s.pixFmt ?? ''}`.trim();
}
function describeAudio(s: ExportOutputStream | undefined): string {
	if (!s) return 'no audio';
	return `${s.codec} ${s.sampleRate ?? '?'} Hz ${s.channels ?? '?'} ch`;
}

function streamsRow(input: JudgeInput): VerifyRow {
	const { context: ctx, output } = input;
	const v = output.streams.find((s) => s.type === 'video');
	const a = output.streams.find((s) => s.type === 'audio');
	const measured = `${describeVideo(v)}; ${describeAudio(a)}`;
	if (!ctx)
		return {
			id: 'streams',
			kind: 'format',
			status: 'unverified',
			measured,
			expected: null,
			tolerance: null,
			message:
				'This export did not record its settings (an older build): the streams cannot be compared with what was asked. Export again to verify.',
		};
	const e = ctx.expected;
	const bad: string[] = [];
	if (e.video) {
		if (!v) bad.push('the file has no video stream');
		else {
			if (v.codec !== e.video.codec) bad.push(`video codec ${v.codec}, expected ${e.video.codec}`);
			if (v.width !== e.video.width || v.height !== e.video.height)
				bad.push(`frame size ${v.width}×${v.height}, expected ${e.video.width}×${e.video.height}`);
			const want = fpsOf(e.video.frameRate);
			if (v.frameRate === undefined || Math.abs(v.frameRate - want) > T.frameRateToleranceFps)
				bad.push(
					`frame rate ${v.frameRate === undefined ? 'unknown' : r2(v.frameRate, 3)}, expected ${r2(want, 3)}`,
				);
			if (e.video.pixFmt && (!v.pixFmt || !pixFmtMatches(e.video.pixFmt, v.pixFmt, e.video.alpha)))
				bad.push(
					`pixel format ${v.pixFmt ?? 'unknown'}, expected ${e.video.pixFmt}${e.video.alpha ? ' with alpha' : ''}`,
				);
		}
	} else if (v) bad.push('the file has a video stream; none was asked for');
	if (e.audio) {
		if (!a) bad.push('the file has no audio stream');
		else {
			if (a.codec !== e.audio.codec) bad.push(`audio codec ${a.codec}, expected ${e.audio.codec}`);
			if (a.sampleRate !== e.audio.sampleRate)
				bad.push(`sample rate ${a.sampleRate ?? 'unknown'} Hz, expected ${e.audio.sampleRate} Hz`);
			if (a.channels !== e.audio.channels)
				bad.push(`${a.channels ?? 'unknown'} channels, expected ${e.audio.channels}`);
		}
	} else if (a) bad.push('the file has an audio stream; the export was picture only');
	const expected = `${
		e.video
			? `${e.video.codec} ${e.video.width}×${e.video.height} ${r2(fpsOf(e.video.frameRate), 3)} fps${e.video.pixFmt ? ` ${e.video.pixFmt}` : ''}`
			: 'no video'
	}; ${e.audio ? `${e.audio.codec} ${e.audio.sampleRate} Hz ${e.audio.channels} ch` : 'no audio'}`;
	return {
		id: 'streams',
		kind: 'format',
		status: bad.length ? 'fail' : 'pass',
		measured,
		expected,
		tolerance: `frame rate ±${T.frameRateToleranceFps} fps; pixel format: same subsampling, at least the bit depth`,
		message: bad.length
			? `The file is not what the export settings asked for: ${bad.join('; ')}.`
			: 'Codec, frame size, frame rate, pixel format, sample rate and channels match the export settings.',
	};
}

function durationRow(input: JudgeInput): VerifyRow {
	const { context: ctx, output } = input;
	const file = output.durationSec;
	const want = ctx
		? ((ctx.range.end - ctx.range.start) * ctx.fps.den) / ctx.fps.num
		: input.fallback.durationSec;
	const tol = ctx ? Math.max(ctx.fps.den / ctx.fps.num, T.durationToleranceSec) : T.durationToleranceSec;
	if (file === null || want === undefined)
		return {
			id: 'duration',
			kind: 'format',
			status: 'unverified',
			measured: file === null ? null : r2(file, 3),
			expected: want === undefined ? null : r2(want, 3),
			tolerance: r2(tol, 3),
			message:
				file === null
					? 'The file reports no duration.'
					: 'The exported range is not known (an older build): the duration cannot be compared.',
		};
	const ok = Math.abs(file - want) <= tol + 1e-9;
	return {
		id: 'duration',
		kind: 'format',
		status: ok ? 'pass' : 'fail',
		measured: r2(file, 3),
		expected: r2(want, 3),
		tolerance: r2(tol, 3),
		message: ok
			? `The file lasts ${r2(file, 3)} s, the exported range ${r2(want, 3)} s.`
			: `The file lasts ${r2(file, 3)} s but the exported range is ${r2(want, 3)} s (${r2(file - want, 3)} s off, more than max(1 frame, ${T.durationToleranceSec * 1000} ms)).`,
	};
}

function skewRow(input: JudgeInput): VerifyRow {
	const v = input.output.streams.find((s) => s.type === 'video');
	const a = input.output.streams.find((s) => s.type === 'audio');
	if (!v || !a)
		return {
			id: 'av-skew',
			kind: 'format',
			status: 'pass',
			measured: null,
			expected: null,
			tolerance: T.avSkewMaxSec,
			message: `Nothing to compare: the file has ${v ? 'no audio' : 'no video'} stream.`,
		};
	if (v.endSec === undefined || a.endSec === undefined)
		return {
			id: 'av-skew',
			kind: 'format',
			status: 'unverified',
			measured: null,
			expected: 0,
			tolerance: T.avSkewMaxSec,
			message: 'The stream ends could not be read from the file.',
		};
	const skew = a.endSec - v.endSec;
	const ok = Math.abs(skew) <= T.avSkewMaxSec + 1e-9;
	return {
		id: 'av-skew',
		kind: 'format',
		status: ok ? 'pass' : 'fail',
		measured: r2(skew, 3),
		expected: 0,
		tolerance: T.avSkewMaxSec,
		at: atOf(input.context, v.frameRate ?? null, Math.min(v.endSec, a.endSec)),
		message: ok
			? `Video ends at ${r2(v.endSec, 3)} s, audio at ${r2(a.endSec, 3)} s.`
			: `The audio ends ${r2(Math.abs(skew), 3)} s ${skew < 0 ? 'before' : 'after'} the video (video ${r2(v.endSec, 3)} s, audio ${r2(a.endSec, 3)} s): more than ${T.avSkewMaxSec * 1000} ms.`,
	};
}

function decodeRow(full: FullMeasurements): VerifyRow {
	const ok = full.decodeErrors.length === 0;
	return {
		id: 'decode',
		kind: 'format',
		status: ok ? 'pass' : 'fail',
		measured: ok ? 0 : full.decodeErrors.length,
		expected: 0,
		tolerance: 0,
		message: ok
			? 'The video and audio streams decode without errors.'
			: `The file does not decode cleanly (${full.decodeErrors.length} error line${full.decodeErrors.length === 1 ? '' : 's'}): ${full.decodeErrors.slice(0, 3).join(' | ').slice(0, 600)}`,
	};
}

function capped(rows: VerifyRow[], id: VerifyRow['id'], kind: VerifyRow['kind'], what: string): VerifyRow[] {
	if (rows.length <= MAX_ROWS_PER_CHECK) return rows;
	const more = rows.length - MAX_ROWS_PER_CHECK;
	const worst = rows.some((r) => r.status === 'fail') ? 'fail' : 'warn';
	return [
		...rows.slice(0, MAX_ROWS_PER_CHECK),
		{
			id,
			kind,
			status: worst,
			measured: more,
			expected: 0,
			tolerance: null,
			message: `${more} more ${what} not listed.`,
		},
	];
}

function cutRows(input: JudgeInput, full: FullMeasurements): VerifyRow[] {
	const ctx = input.context;
	const rows: VerifyRow[] = [];
	const note = ctx?.cutsNote ? ` ${ctx.cutsNote}.` : '';
	if (!ctx) {
		for (const id of ['cut-black', 'cut-flash', 'cut-click'] as const)
			rows.push({
				id,
				kind: 'judgement',
				status: 'unverified',
				measured: null,
				expected: null,
				tolerance: null,
				message: 'The cut list of this export is not known (an older build): export again to check the cuts.',
			});
		return rows;
	}
	const fps = fpsOf(ctx.fps);
	const black: VerifyRow[] = [];
	const flash: VerifyRow[] = [];
	const click: VerifyRow[] = [];
	const hasVideo = full.videoFrames > 0;
	for (const [i, cut] of ctx.cuts.entries()) {
		const fileFrame = cut.frame - ctx.range.start;
		if (hasVideo) {
			const found = cutPictureFindings((f) => full.luma.get(f), { ...cut, fileFrame }, fps, full.videoFrames);
			for (const f of found) {
				if (f.kind === 'black') {
					black.push({
						id: 'cut-black',
						kind: 'judgement',
						status: 'fail',
						measured: r2((f.frames / fps) * 1000, 0),
						expected: 0,
						tolerance: `luma < ${r2(T.blackLuma, 4)} for ≥ ${T.blackMinSec * 1000} ms`,
						at: atOf(ctx, fps, f.startFrame / fps),
						message: `${f.frames} black frame${f.frames === 1 ? '' : 's'} (${r2((f.frames / fps) * 1000, 0)} ms) at the cut where the timeline shows a picture: a gap or a missing frame in the render. Look at it and ask the user before re-cutting.`,
					});
				} else {
					flash.push({
						id: 'cut-flash',
						kind: 'judgement',
						status: cut.effect ? 'warn' : 'fail',
						measured: r2(f.jump, 3),
						expected: 0,
						tolerance: T.flashJump,
						at: atOf(ctx, fps, f.frame / fps),
						message: cut.effect
							? `A single frame differs in brightness by ${r2(f.jump, 2)} from both neighbours at a cut with a transition or effect over it: probably designed — ask the user.`
							: `A single frame differs in brightness by ${r2(f.jump, 2)} from both neighbours at the cut: a stray frame (flash). Ask the user before re-cutting.`,
					});
				}
			}
		}
		const c = full.clicks?.[i];
		if (c)
			click.push({
				id: 'cut-click',
				kind: 'judgement',
				status: 'fail',
				measured: r2(c.overDb, 1),
				expected: null,
				tolerance: `≤ ${T.clickOverRmsDb} dB over the local RMS within ±${T.clickWindowSec * 1000} ms of the cut`,
				at: atOf(ctx, fps, c.sec),
				message: `A click at the cut: a sample step ${r2(c.overDb, 1)} dB over the local level (${r2(c.stepDbfs, 1)} dBFS). A short audio fade or crossfade at the edit usually removes it; ask the user.`,
			});
	}
	const n = ctx.cuts.length;
	const passRow = (id: 'cut-black' | 'cut-flash' | 'cut-click', what: string): VerifyRow => ({
		id,
		kind: 'judgement',
		status: 'pass',
		measured: 0,
		expected: 0,
		tolerance: null,
		message: `${n} cut${n === 1 ? '' : 's'} checked: no ${what}.${note}`,
	});
	const unverified = (id: 'cut-black' | 'cut-flash' | 'cut-click', why: string): VerifyRow => ({
		id,
		kind: 'judgement',
		status: 'unverified',
		measured: null,
		expected: null,
		tolerance: null,
		message: why,
	});
	if (!hasVideo) {
		rows.push(unverified('cut-black', 'The file has no picture to check.'));
		rows.push(unverified('cut-flash', 'The file has no picture to check.'));
	} else {
		rows.push(
			...(black.length
				? capped(black, 'cut-black', 'judgement', 'black runs')
				: [passRow('cut-black', 'unintended black')]),
		);
		rows.push(
			...(flash.length
				? capped(flash, 'cut-flash', 'judgement', 'flashes')
				: [passRow('cut-flash', 'single-frame flash')]),
		);
	}
	if (full.clicks === null) rows.push(unverified('cut-click', 'The file has no audio to check.'));
	else
		rows.push(
			...(click.length ? capped(click, 'cut-click', 'judgement', 'clicks') : [passRow('cut-click', 'click')]),
		);
	return rows;
}

function loudnessRows(input: JudgeInput, full: FullMeasurements): VerifyRow[] {
	const ctx = input.context;
	const l = full.loudness;
	if (!l) {
		const msg = 'The file has no audio.';
		return [
			{
				id: 'loudness',
				kind: 'judgement',
				status: 'pass',
				measured: null,
				expected: null,
				tolerance: null,
				message: msg,
			},
			{
				id: 'true-peak',
				kind: 'format',
				status: 'pass',
				measured: null,
				expected: null,
				tolerance: null,
				message: msg,
			},
		];
	}
	const rows: VerifyRow[] = [];
	const norm = ctx?.normalize ?? null;
	const targetLufs = norm?.targetLufs ?? input.target?.limits.loudnessLufs ?? null;
	const basis = norm
		? "the export's loudness normalisation"
		: input.target
			? `${input.target.name}'s level`
			: null;
	if (targetLufs === null || l.integratedLufs === null) {
		rows.push({
			id: 'loudness',
			kind: 'judgement',
			status: 'unverified',
			measured: l.integratedLufs === null ? null : r2(l.integratedLufs, 1),
			expected: targetLufs,
			tolerance: T.loudnessToleranceLu,
			message:
				l.integratedLufs === null
					? 'The audio is too short or too quiet for an integrated loudness (BS.1770 gating).'
					: `Integrated loudness ${r2(l.integratedLufs, 1)} LUFS; nothing to compare with (the export was not normalised and no delivery target with a loudness level was given).`,
		});
	} else {
		const d = l.integratedLufs - targetLufs;
		const ok = Math.abs(d) <= T.loudnessToleranceLu + 1e-9;
		rows.push({
			id: 'loudness',
			kind: 'judgement',
			status: ok ? 'pass' : 'fail',
			measured: r2(l.integratedLufs, 1),
			expected: targetLufs,
			tolerance: T.loudnessToleranceLu,
			message: ok
				? `Integrated loudness ${r2(l.integratedLufs, 1)} LUFS, within ${T.loudnessToleranceLu} LU of ${basis} (${targetLufs} LUFS).`
				: `Integrated loudness ${r2(l.integratedLufs, 1)} LUFS is ${r2(Math.abs(d), 1)} LU ${d > 0 ? 'over' : 'under'} ${basis} (${targetLufs} LUFS). Ask the user before changing the mix or the normalisation.`,
		});
	}
	const ceiling = norm?.truePeakDb ?? input.target?.limits.truePeakDbtp ?? T.defaultTruePeakCeilingDbtp;
	if (l.truePeakDbtp === null)
		rows.push({
			id: 'true-peak',
			kind: 'format',
			status: 'pass',
			measured: null,
			expected: ceiling,
			tolerance: T.truePeakToleranceDb,
			message: 'The audio is digital silence: no peak.',
		});
	else {
		const ok = l.truePeakDbtp <= ceiling + T.truePeakToleranceDb + 1e-9;
		rows.push({
			id: 'true-peak',
			kind: 'format',
			status: ok ? 'pass' : 'fail',
			measured: r2(l.truePeakDbtp, 2),
			expected: ceiling,
			tolerance: T.truePeakToleranceDb,
			message: ok
				? `True peak ${r2(l.truePeakDbtp, 2)} dBTP, at most the ${ceiling} dBTP ceiling.`
				: `True peak ${r2(l.truePeakDbtp, 2)} dBTP is over the ${ceiling} dBTP ceiling (+${T.truePeakToleranceDb} dB). Export again with loudness normalisation (its true-peak limiter) at this ceiling.`,
		});
	}
	return rows;
}

function silenceRows(input: JudgeInput, full: FullMeasurements): VerifyRow[] {
	if (!full.loudness)
		return [
			{
				id: 'silence',
				kind: 'judgement',
				status: 'pass',
				measured: null,
				expected: null,
				tolerance: T.silenceMinSec,
				message: 'The file has no audio.',
			},
		];
	const v = input.output.streams.find((s) => s.type === 'video');
	const rows = full.silences.map(
		(s): VerifyRow => ({
			id: 'silence',
			kind: 'judgement',
			status: 'warn',
			measured: r2(s.endSec - s.startSec, 2),
			expected: null,
			tolerance: T.silenceMinSec,
			at: atOf(input.context, v?.frameRate ?? null, s.startSec),
			message: `${r2(s.endSec - s.startSec, 2)} s of digital silence (${r2(s.startSec, 2)}–${r2(s.endSec, 2)} s). Intended? Ask the user.`,
		}),
	);
	if (rows.length) return capped(rows, 'silence', 'judgement', 'silent spans');
	return [
		{
			id: 'silence',
			kind: 'judgement',
			status: 'pass',
			measured: 0,
			expected: null,
			tolerance: T.silenceMinSec,
			message: `No digital silence longer than ${T.silenceMinSec} s.`,
		},
	];
}

const fmtBytes = (b: number) => (b >= 1e9 ? `${r2(b / 1e9, 2)} GB` : `${r2(b / 1e6, 1)} MB`);

function targetRows(input: JudgeInput, t: DeliveryTarget): VerifyRow[] {
	const l = t.limits;
	const out = input.output;
	const v = out.streams.find((s) => s.type === 'video');
	const rows: VerifyRow[] = [];
	const container = (input.context?.expected.container ?? input.fallback.container ?? out.container) as
		| 'mp4'
		| 'mov'
		| 'webm';
	const okContainer = (l.containers as readonly string[]).includes(container);
	rows.push({
		id: 'target-container',
		kind: 'format',
		status: okContainer ? 'pass' : 'fail',
		measured: container,
		expected: l.containers.join(', '),
		tolerance: null,
		message: okContainer
			? `${t.name} takes ${container.toUpperCase()}.`
			: `${t.name} does not take ${container.toUpperCase()} (${l.containers.join(', ').toUpperCase()}): export again with the ${t.name} preset.`,
	});
	if (v?.width && v.height) {
		const shape = v.width / v.height;
		const [aw, ah] = t.aspect.split(':').map(Number) as [number, number];
		const want = aw / ah;
		const same = Math.abs(shape / want - 1) <= T.aspectTolerance;
		const accepted =
			!l.aspectRange || (shape >= l.aspectRange.min - 1e-6 && shape <= l.aspectRange.max + 1e-6);
		rows.push({
			id: 'target-aspect',
			kind: accepted ? 'judgement' : 'format',
			status: same ? 'pass' : accepted ? 'warn' : 'fail',
			measured: `${v.width}:${v.height}`,
			expected: t.aspect,
			tolerance: T.aspectTolerance,
			message: same
				? `${t.aspect}, the shape ${t.name} shows full-screen.`
				: accepted
					? `${r2(shape, 3)}:1 is accepted by ${t.name} but not full-screen (${t.aspect}): it shows with bars. Ask the user; auto_reframe_sequence makes a ${t.aspect} copy.`
					: `${t.name} refuses (or does not show as ${t.name}) a ${r2(shape, 3)}:1 picture: make a ${t.aspect} copy with auto_reframe_sequence and export it.`,
		});
		const box = l.recommendedSize;
		const fits = Math.min(box.width / v.width, box.height / v.height);
		const full =
			Math.abs(fits - 1) < 0.01 ||
			(v.width === box.width && v.height <= box.height) ||
			(v.height === box.height && v.width <= box.width);
		rows.push({
			id: 'target-resolution',
			kind: 'judgement',
			status: full ? 'pass' : 'warn',
			measured: `${v.width}x${v.height}`,
			expected: `${box.width}x${box.height}`,
			tolerance: null,
			message: full
				? `${v.width} × ${v.height} fills ${t.name}'s recommended ${box.width} × ${box.height}.`
				: fits > 1
					? `${v.width} × ${v.height} is under ${t.name}'s recommended ${box.width} × ${box.height}: it will look soft. The ${t.name} preset exports at the recommended size.`
					: `${v.width} × ${v.height} is over ${t.name}'s recommended ${box.width} × ${box.height}: the platform scales it down.`,
		});
	} else
		rows.push({
			id: 'target-aspect',
			kind: 'format',
			status: 'fail',
			measured: null,
			expected: t.aspect,
			tolerance: null,
			message: `The file has no picture: ${t.name} takes video.`,
		});
	const dur = out.durationSec;
	if (dur === null)
		rows.push({
			id: 'target-duration',
			kind: 'format',
			status: 'unverified',
			measured: null,
			expected: l.maxDurationSec,
			tolerance: null,
			message: 'The file reports no duration.',
		});
	else {
		const tooLong = dur > l.maxDurationSec + 1e-6;
		const tooShort = l.minDurationSec !== null && dur < l.minDurationSec - 1e-6;
		rows.push({
			id: 'target-duration',
			kind: 'format',
			status: tooLong || tooShort ? 'fail' : 'pass',
			measured: r2(dur, 2),
			expected: `${l.minDurationSec ?? 0}–${l.maxDurationSec}`,
			tolerance: null,
			message: tooLong
				? `${r2(dur, 1)} s is longer than ${t.name}'s ${l.maxDurationSec} s limit: the upload is refused. Ask the user what to cut.`
				: tooShort
					? `${r2(dur, 2)} s is shorter than ${t.name}'s ${l.minDurationSec} s minimum.`
					: `${r2(dur, 1)} s is within ${t.name}'s ${l.maxDurationSec} s limit.`,
		});
	}
	const fr = v?.frameRate;
	if (fr !== undefined) {
		const over = fr > l.maxFrameRate + T.frameRateToleranceFps;
		const under = l.minFrameRate !== null && fr < l.minFrameRate - T.frameRateToleranceFps;
		const recommended = l.frameRates.some(
			(x) => Math.abs(x - fr) <= 0.05 || Math.abs(x * (1000 / 1001) - fr) <= 0.05,
		);
		rows.push({
			id: 'target-frame-rate',
			kind: over || under ? 'format' : 'judgement',
			status: over || under ? 'fail' : recommended ? 'pass' : 'warn',
			measured: r2(fr, 3),
			expected: l.frameRates.join(', '),
			tolerance: `${l.minFrameRate ?? 0}–${l.maxFrameRate} fps`,
			message:
				over || under
					? `${r2(fr, 3)} fps is outside the ${l.minFrameRate ?? 0}–${l.maxFrameRate} fps ${t.name} takes: export again with the ${t.name} preset.`
					: recommended
						? `${r2(fr, 3)} fps is a rate ${t.name} recommends.`
						: `${r2(fr, 3)} fps is accepted but not one of ${t.name}'s recommended rates (${l.frameRates.join(', ')}).`,
		});
	}
	const tooBig = out.sizeBytes > l.maxFileSizeBytes;
	rows.push({
		id: 'target-size',
		kind: 'format',
		status: tooBig ? 'fail' : 'pass',
		measured: out.sizeBytes,
		expected: l.maxFileSizeBytes,
		tolerance: null,
		message: tooBig
			? `${fmtBytes(out.sizeBytes)} is over ${t.name}'s ${fmtBytes(l.maxFileSizeBytes)} upload limit: export again at a lower bit rate (start_export videoBitrateKbps).`
			: `${fmtBytes(out.sizeBytes)} is under ${t.name}'s ${fmtBytes(l.maxFileSizeBytes)} upload limit.`,
	});
	const lu = input.full?.loudness?.integratedLufs ?? null;
	if (l.loudnessLufs === null)
		rows.push({
			id: 'target-loudness',
			kind: 'judgement',
			status: 'unverified',
			measured: lu === null ? null : r2(lu, 1),
			expected: null,
			tolerance: T.loudnessToleranceLu,
			message: `${t.name} publishes no loudness it normalises to.`,
		});
	else if (!input.full)
		rows.push({
			id: 'target-loudness',
			kind: 'judgement',
			status: 'unverified',
			measured: null,
			expected: l.loudnessLufs,
			tolerance: T.loudnessToleranceLu,
			message: 'Loudness is measured by the full check (verify_export).',
		});
	else if (lu === null)
		rows.push({
			id: 'target-loudness',
			kind: 'judgement',
			status: 'unverified',
			measured: null,
			expected: l.loudnessLufs,
			tolerance: T.loudnessToleranceLu,
			message: input.full.loudness
				? 'The audio is too short or too quiet to measure.'
				: 'The file has no audio.',
		});
	else {
		const d = lu - l.loudnessLufs;
		const ok = Math.abs(d) <= T.loudnessToleranceLu + 1e-9;
		rows.push({
			id: 'target-loudness',
			kind: 'judgement',
			status: ok ? 'pass' : 'warn',
			measured: r2(lu, 1),
			expected: l.loudnessLufs,
			tolerance: T.loudnessToleranceLu,
			message: ok
				? `${r2(lu, 1)} LUFS, about the ${l.loudnessLufs} LUFS ${t.name} plays at.`
				: d > 0
					? `${r2(lu, 1)} LUFS: ${t.name} turns it down by about ${r2(d, 1)} dB (it plays at ${l.loudnessLufs} LUFS), squashing nothing but wasting headroom. The ${t.name} preset normalises to it.`
					: `${r2(lu, 1)} LUFS: ${r2(-d, 1)} LU quieter than the ${l.loudnessLufs} LUFS ${t.name} plays at (it is not turned up). The ${t.name} preset normalises to it.`,
		});
	}
	return rows;
}

/** The rows of a verification (see the file comment), in check order. */
export function judgeExport(input: JudgeInput): VerifyRow[] {
	const rows: VerifyRow[] = [];
	if (input.full) rows.push(decodeRow(input.full));
	rows.push(streamsRow(input), durationRow(input), skewRow(input));
	if (input.full) {
		rows.push(...cutRows(input, input.full));
		rows.push(...loudnessRows(input, input.full));
		rows.push(...silenceRows(input, input.full));
	}
	if (input.target) rows.push(...targetRows(input, input.target));
	return rows;
}

/** `verified` (no `fail`, no `unverified` format row) and the status counts. */
export function summarizeRows(rows: readonly VerifyRow[]): {
	verified: boolean;
	counts: { pass: number; warn: number; fail: number; unverified: number };
} {
	const counts = { pass: 0, warn: 0, fail: 0, unverified: 0 };
	for (const r of rows) counts[r.status]++;
	const verified = !rows.some(
		(r) => r.status === 'fail' || (r.status === 'unverified' && r.kind === 'format'),
	);
	return { verified, counts };
}
