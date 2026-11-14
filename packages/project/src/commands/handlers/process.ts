import type { SourceFit } from '../schemas/clip.ts';
// Processed media (M2, S07:PRC-001…007) and source ranges (M3, S07:PRC-015…019): media.derive (register a
// processed version of a media asset and optionally swap clips to it), clip.replaceSource (swap a clip between
// versions of the same original), media.setSourceRange, and the "keep source timing" remap used by
// media.relink (Replace Footage).
//
// - A processed version is a MediaAsset whose `derivation` points at its source and whose `sourceRange` records
//   the source frames it holds (the whole source, or a processed range with handles). It gets a project item
//   in the auto-created bin "Processed" next to the original's bin (PRC-004). Re-deriving the same file (same
//   fingerprint, or same source + recipe hash) reuses the asset (idempotent) and still performs the swaps.
// - A swap changes the video clip's `mediaId` (and `videoStreamIndex`) and keeps start, duration and speed.
//   Content time moves by the shift between the two files' source ranges (`versionShift`), so the clip shows
//   exactly the same source frames: `sourceIn`, keyframes, clip markers and tracker samples move together
//   (`shiftClipContentTime`). When the pixel size differs, Motion and tracker geometry are compensated
//   (`rescaleClipForSource`, PRC-006). Linked audio keeps pointing at the original (PRC-007). A version that
//   does not hold every frame the clip shows is refused (E_OUT_OF_MEDIA), or with `fit` the clip is trimmed to
//   the covered frames (`trim`) or left alone with a warning (`skip`). `keepDuration` is accepted and has no
//   effect: the duration is always kept.

import { current, type Draft, isDraft } from 'immer';
import {
	type ClipContentTiming,
	clipFileFrames,
	coverageTolerance,
	coveredClipFrames,
	type DeriveRecipe,
	derivedKind,
	deriveMakesAudio,
	deriveProblems,
	deriveSourceKinds,
	isDeriveOp,
	isVersionDerivation,
	mediaFrameCount,
	mediaIntrinsicSize,
	PROCESSED_BIN_NAME,
	processedItemName,
	rangeFrames,
	rescaleClipForSource,
	rootFrameSpan,
	rootPlacement,
	shiftClipContentTime,
	shiftedTiming,
	sourceLinkOf,
	versionShift,
} from '../../process/index.ts';
import { defaultLabelForMedia, isBoundedContent } from '../../registry/kinds.ts';
import { retargetRotos, rotoRateOf } from '../../roto/index.ts';
import type { ProjectItem } from '../../schema/document.ts';
import type { MediaAsset, SourceRange } from '../../schema/media.ts';
import type { AudioClip, Clip, VideoClip } from '../../schema/sequence.ts';
import { type Rational, rationalEquals } from '../../time.ts';
import { mediaFrameRate } from '../../tracking/request.ts';
import { clipHandles, fitTransitionDuration } from '../../transitions.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, cleanupSequence, findTrackIn, setClipRange } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { assertBin, insertItem } from './project-items.ts';
import type { HandlerMap } from './util.ts';

export type { SourceFit } from '../schemas/clip.ts';

type SwapResult = {
	clipId: string;
	fromMediaId: string;
	toMediaId: string;
	changed: boolean;
	/** Content-time shift applied, in frames of the original (0 for versions of the same range). */
	shiftFrames?: number;
	/** Frames trimmed off the clip's head/tail (`fit: 'trim'`). */
	trimmed?: { head: number; tail: number };
	/** Why the clip was left unchanged (`fit: 'skip'`). */
	skipped?: string;
};

function mediaOf(doc: DDoc, id: string, h: HandlerContext): MediaAsset {
	const m = doc.media[id] as MediaAsset | undefined;
	if (!m) h.fail('E_NOT_FOUND', `Media not found: ${id}`);
	return m;
}

function plain<T>(v: T): T {
	return isDraft(v) ? (current(v as never) as T) : v;
}

/** Rendered duration of every transition of a sequence (what fits in the handles, TRN-003). */
function transitionFits(doc: DDoc, seq: DSeq): Map<string, number> {
	const out = new Map<string, number>();
	for (const t of Object.values(seq.transitions)) {
		const a = t.outgoingClipId ? (seq.clips[t.outgoingClipId] as Clip | undefined) : undefined;
		const b = t.incomingClipId ? (seq.clips[t.incomingClipId] as Clip | undefined) : undefined;
		if ((t.outgoingClipId && !a) || (t.incomingClipId && !b)) continue;
		out.set(
			t.id,
			fitTransitionDuration({
				effectId: t.effectId,
				wanted: t.duration,
				alignment: t.alignment,
				cutPosition: t.cutPosition,
				outgoing: a ? { duration: a.duration, tail: clipHandles(doc, seq, a).tail } : null,
				incoming: b ? { duration: b.duration, head: clipHandles(doc, seq, b).head } : null,
			}),
		);
	}
	return out;
}

/** Warns about transitions whose handles shrank with a source change (they render shorter, TRN-003). */
function warnTransitions(doc: DDoc, seq: DSeq, before: Map<string, number>, h: HandlerContext): void {
	const after = transitionFits(doc, seq);
	for (const [id, was] of before) {
		const now = after.get(id);
		const t = seq.transitions[id];
		if (now === undefined || !t || now >= was) continue;
		h.warn(
			'W_TRANSITION_SHORTENED',
			now === 0
				? `Transition ${id} no longer has media handles in the new source and will not render`
				: `Transition ${id} now has handles for ${now} of its ${t.duration} frames and renders shorter`,
		);
	}
}

/**
 * Trims a clip to its timeline frames `[from, to)` (relative to its start) after a source change, together
 * with linked clips on unlocked tracks that share a trimmed edge (S07:PRC-017 `fit: 'trim'`).
 */
function trimToCovered(seq: DSeq, clip: DClip, cov: { from: number; to: number }, h: HandlerContext) {
	const oldStart = clip.start;
	const oldEnd = clip.start + clip.duration;
	const newStart = oldStart + cov.from;
	const newEnd = oldStart + cov.to;
	const partners =
		clip.linkId && seq.links[clip.linkId]
			? seq.links[clip.linkId]!.members.map((id) => seq.clips[id]).filter(
					(p): p is DClip => !!p && p.id !== clip.id && !findTrackIn(seq, p.trackId)?.track.locked,
				)
			: [];
	setClipRange(seq, clip, newStart, newEnd);
	for (const p of partners) {
		const ps = p.start === oldStart ? newStart : p.start;
		const pe = p.start + p.duration === oldEnd ? newEnd : p.start + p.duration;
		if ((ps !== p.start || pe !== p.start + p.duration) && pe > ps) setClipRange(seq, p, ps, pe);
	}
	cleanupSequence(seq, h);
	return { head: cov.from, tail: oldEnd - newEnd };
}

/** "frames 1090–1149" of the original a media is a version of. */
function coverageMessage(
	doc: DDoc,
	clip: { id: string; sourceIn: number; duration: number; speed: { rate: number; reverse: boolean } },
	seqRate: Rational,
	target: MediaAsset,
): string {
	const span = rootFrameSpan(doc, target.id);
	const rate = mediaFrameRate(target);
	const root = span ? (doc.media[span.rootId] as MediaAsset | undefined) : undefined;
	if (!span || !rate) return `Media ${target.id} does not hold every frame clip ${clip.id} shows`;
	const used = clipFileFrames(clip, seqRate, rate);
	const a = span.start + used.first;
	const b = span.start + used.end;
	const before = Math.max(0, span.start - a);
	const after = Math.max(0, b - span.end);
	const missing = [before ? `${before} before its first frame` : '', after ? `${after} after its last` : '']
		.filter(Boolean)
		.join(' and ');
	return `${target.originalName} holds frames ${span.start}–${span.end - 1} of ${root?.originalName ?? span.rootId}; clip ${clip.id} shows frames ${a}–${b - 1} (${missing || 'not covered'})`;
}

type RetimeOutcome =
	| { kind: 'ok'; trimmed?: { head: number; tail: number } }
	| { kind: 'skipped'; message: string };

/**
 * Moves one clip's content time by `shift` for a new file of `target` (already the clip's media or about to
 * be) and checks that the file holds every frame the clip shows; `fit` decides what happens when it does not.
 * The clip is modified only when the outcome is `ok`.
 */
function retimeClipForFile(
	doc: DDoc,
	seq: DSeq,
	clip: DClip,
	shift: number,
	target: MediaAsset,
	fit: SourceFit,
	h: HandlerContext,
	apply: () => void,
): RetimeOutcome {
	const seqRate = seq.settings.frameRate as Rational;
	const timing = shiftedTiming(clip as unknown as ClipContentTiming, shift);
	const tol = coverageTolerance(seqRate, clip.speed.rate, mediaFrameRate(target));
	const bounded = isBoundedContent(clip as Clip);
	const cov = bounded
		? coveredClipFrames(timing, seqRate, target.probe.durationFlicks, tol)
		: { from: 0, to: clip.duration };
	const whole = !!cov && cov.from === 0 && cov.to === clip.duration;
	if (!whole) {
		const msg = coverageMessage(doc, { ...timing, id: clip.id }, seqRate, target);
		if (fit === 'skip') {
			h.warn('W_CLIP_SKIPPED', `${msg}; the clip was left on its current media`);
			return { kind: 'skipped', message: msg };
		}
		if (fit !== 'trim' || !cov)
			h.fail(
				'E_OUT_OF_MEDIA',
				cov
					? `${msg}. Trim the clip first, or pass fit: "trim" to trim it to the covered frames`
					: `${msg}: no frame of the clip is in the new media`,
			);
		const found = findTrackIn(seq, clip.trackId);
		if (found) assertUnlocked(found.track, h);
	}
	apply();
	const rep = shiftClipContentTime(clip as never, shift);
	if (rep.droppedMarkers)
		h.warn(
			'W_MARKERS_REMOVED',
			`${rep.droppedMarkers} clip marker(s) of ${clip.id} lay before the new media's first frame and were removed`,
		);
	if (rep.droppedTrackerSamples)
		h.warn(
			'W_TRACKER_TRIMMED',
			`${rep.droppedTrackerSamples} tracker sample(s) of ${clip.id} lay before the new media's first frame and were removed`,
		);
	if (whole) return { kind: 'ok' };
	return { kind: 'ok', trimmed: trimToCovered(seq, clip, cov!, h) };
}

/**
 * Whether every frame of `clip` stays inside `target` when its content time moves by `shift` (what `replaceMediaFile`
 * with fit `refuse` requires; read-only).
 */
export function clipCoveredAfterShift(seq: DSeq, clip: DClip, shift: number, target: MediaAsset): boolean {
	const seqRate = seq.settings.frameRate as Rational;
	if (!isBoundedContent(clip as Clip)) return true;
	const timing = shiftedTiming(clip as unknown as ClipContentTiming, shift);
	const tol = coverageTolerance(seqRate, clip.speed.rate, mediaFrameRate(target));
	const cov = coveredClipFrames(timing, seqRate, target.probe.durationFlicks, tol);
	return !!cov && cov.from === 0 && cov.to === clip.duration;
}

/** Swaps a video clip's source to another version of the same original (S07:PRC-006/007, PRC-016/017). */
function swapClipSource(
	doc: DDoc,
	clipId: string,
	targetId: string,
	h: HandlerContext,
	fit: SourceFit = 'refuse',
): SwapResult {
	const { seq, clip } = h.clip(doc, clipId);
	if (clip.kind !== 'video')
		h.fail('E_INVALID_PARAM', `Clip ${clipId} is a ${clip.kind} clip; only video clips can change version`);
	const vclip = clip as unknown as VideoClip;
	const found = findTrackIn(seq, clip.trackId);
	if (!found) h.fail('E_NOT_FOUND', `Track not found: ${clip.trackId}`);
	assertUnlocked(found.track, h);
	const from = mediaOf(doc, vclip.mediaId, h);
	const target = mediaOf(doc, targetId, h);
	if (target.id === from.id) return { clipId, fromMediaId: from.id, toMediaId: target.id, changed: false };
	const vs = versionShift(doc, from.id, target.id);
	if (!vs.ok)
		h.fail(
			'E_INVALID_PARAM',
			vs.unrelated
				? `${vs.reason}; clip ${clipId} can only switch between versions of its original`
				: vs.reason,
		);
	const oldSize = mediaIntrinsicSize(from);
	const newSize = mediaIntrinsicSize(target);
	const stream =
		target.probe.streams.find((s) => s.type === 'video' && s.index === vclip.videoStreamIndex) ??
		target.probe.streams.find((s) => s.type === 'video');
	if (!newSize || !stream) h.fail('E_INVALID_PARAM', `Media ${target.id} has no video stream`);

	const before = transitionFits(doc, seq);
	const outcome = retimeClipForFile(doc, seq, clip, vs.shift, target, fit, h, () => {
		const next = oldSize
			? rescaleClipForSource(plain(vclip), oldSize, newSize, { newKeyframeId: () => h.ids.next('kf') })
			: null;
		const d = clip as unknown as VideoClip;
		// parity (roto): roto objects follow the new media (frames at its rate, strokes scaled); mattes dropped.
		retargetRotos(d.rotos as never, {
			to: {
				mediaId: target.id,
				rate: rotoRateOf(target, seq.settings.frameRate as Rational),
				scaleX: oldSize ? newSize.width / oldSize.width : 1,
				scaleY: oldSize ? newSize.height / oldSize.height : 1,
			},
		});
		d.mediaId = target.id;
		d.videoStreamIndex = stream.index;
		if (next) {
			d.transform = next.transform;
			if (next.trackers) d.trackers = next.trackers;
		}
	});
	if (outcome.kind === 'skipped')
		return { clipId, fromMediaId: from.id, toMediaId: target.id, changed: false, skipped: outcome.message };
	warnTransitions(doc, seq, before, h);
	return {
		clipId,
		fromMediaId: from.id,
		toMediaId: target.id,
		changed: true,
		shiftFrames: (vs.from.shiftFrames ?? 0) - (vs.to.shiftFrames ?? 0),
		...(outcome.trimmed ? { trimmed: outcome.trimmed } : {}),
	};
}

/**
 * Replace Footage (S07:PRC-018): `update()` puts the new file into media `mediaId`; then every clip, project-item
 * mark and transcript of the media moves by `shift` flicks of content time (0 = keep content time) and every
 * clip is checked against the new file: clips it does not cover follow `fit` (`skip` is not possible here — a
 * clip cannot stay on the old file — and acts like `refuse`). Returns the clips that changed / were trimmed.
 */
export function replaceMediaFile(
	doc: DDoc,
	mediaId: string,
	shift: number,
	fit: SourceFit,
	h: HandlerContext,
	update: () => void,
	/** The same shift in frames of `rate` (versions of the media are re-anchored by it). */
	frames?: { shiftFrames: number; rate: Rational },
): { clipIds: string[]; trimmed: string[] } {
	const out = { clipIds: [] as string[], trimmed: [] as string[] };
	const oldName = mediaOf(doc, mediaId, h).originalName;
	const transcripts = new Set(
		Object.values(doc.transcripts ?? {})
			.filter((t) => t.mediaId === mediaId)
			.map((t) => t.id),
	);
	const before = new Map(Object.values(doc.sequences).map((seq) => [seq.id, transitionFits(doc, seq)]));
	const oldSize = mediaIntrinsicSize(mediaOf(doc, mediaId, h));
	update();
	const asset = mediaOf(doc, mediaId, h);
	const newSize = mediaIntrinsicSize(asset);
	// A file of another pixel size keeps every clip's framing, as a version switch does (S07:PRC-006).
	const resized =
		!!oldSize && !!newSize && (oldSize.width !== newSize.width || oldSize.height !== newSize.height);
	const mode: SourceFit = fit === 'trim' ? 'trim' : 'refuse';
	for (const seq of Object.values(doc.sequences)) {
		for (const clip of Object.values(seq.clips)) {
			const ref = clip as { mediaId?: string; transcriptId?: string };
			const uses = ref.mediaId === mediaId || (!!ref.transcriptId && transcripts.has(ref.transcriptId));
			if (!uses) continue;
			const reframe = resized && ref.mediaId === mediaId && 'transform' in clip;
			const r = retimeClipForFile(doc, seq, clip, shift, asset, mode, h, () => {
				if (!reframe) return;
				const d = clip as unknown as VideoClip;
				const next = rescaleClipForSource(plain(d), oldSize!, newSize!, {
					newKeyframeId: () => h.ids.next('kf'),
				});
				d.transform = next.transform;
				if (next.trackers) d.trackers = next.trackers;
				retargetRotos(d.rotos as never, {
					to: {
						mediaId,
						rate: rotoRateOf(asset, seq.settings.frameRate as Rational),
						scaleX: newSize!.width / oldSize!.width,
						scaleY: newSize!.height / oldSize!.height,
					},
				});
			});
			if (r.kind === 'ok') {
				if (shift !== 0 || r.trimmed) out.clipIds.push(clip.id);
				if (r.trimmed) out.trimmed.push(clip.id);
			}
		}
		warnTransitions(doc, seq, before.get(seq.id) ?? new Map(), h);
	}
	if (shift === 0) return out;
	// Versions of this media (processed versions, renders declaring it as their source) hold frames of the old
	// file: re-anchor them on the new file's frame numbers (old frame k = new frame k + shiftFrames).
	if (frames)
		for (const m of Object.values(doc.media) as MediaAsset[]) {
			if (m.id === mediaId) continue;
			const link = sourceLinkOf(doc, m);
			if (link?.parentId !== mediaId) continue;
			const first = link.firstFrame + frames.shiftFrames;
			const rate = link.frameRate ?? frames.rate;
			const count = m.sourceRange?.frames ?? mediaFrameCount(m) ?? 1;
			if (first >= 0)
				(m as { sourceRange?: SourceRange }).sourceRange = {
					...(m.sourceRange ?? { origin: 'process' as const, sourceName: oldName }),
					mediaId,
					firstFrame: first,
					frames: count,
					frameRate: rate,
				};
			else {
				(m as { sourceRange?: SourceRange }).sourceRange = {
					...(m.sourceRange ?? { origin: 'process' as const }),
					mediaId: null,
					sourceName: oldName,
					firstFrame: link.firstFrame,
					frames: count,
					frameRate: rate,
				};
				h.warn(
					'W_VERSION_DETACHED',
					`${m.originalName} holds frames before the new file's first frame; it is no longer a version of ${mediaId}`,
				);
			}
		}
	// Source marks of project items (content time of the media).
	const dur = asset.probe.durationFlicks;
	for (const it of Object.values(doc.items)) {
		if (it.kind !== 'media' || it.mediaId !== mediaId) continue;
		const mv = (m: { flicks: number } | null) => {
			if (!m) return null;
			const f = m.flicks + shift;
			return f < 0 || (dur !== null && f > dur) ? null : { flicks: f };
		};
		it.marks = {
			in: mv(it.marks.in as { flicks: number } | null),
			out: mv(it.marks.out as { flicks: number } | null),
		};
	}
	// Transcripts of the media: word times are its content time.
	for (const id of transcripts) {
		const t = doc.transcripts[id]!;
		const kept = t.words.filter((w) => w.start + shift >= 0);
		if (kept.length !== t.words.length)
			h.warn(
				'W_TRANSCRIPT_TRIMMED',
				`${t.words.length - kept.length} transcript word(s) lay before the new file's first frame and were removed`,
			);
		for (const w of kept) {
			w.start += shift;
			w.end += shift;
		}
		t.words = kept;
	}
	return out;
}

/** The bin holding `itemId` (null = project root), or undefined when the item is not in the bin tree. */
function parentOf(doc: DDoc, itemId: string): string | null | undefined {
	if (doc.rootItems.includes(itemId)) return null;
	for (const it of Object.values(doc.items))
		if (it.kind === 'bin' && it.children.includes(itemId)) return it.id;
	return undefined;
}

function childrenOf(doc: DDoc, binId: string | null): string[] {
	if (binId === null) return doc.rootItems;
	const bin = doc.items[binId];
	return bin?.kind === 'bin' ? bin.children : doc.rootItems;
}

/**
 * The "Processed" bin next to the original's bin (S07:PRC-004): a sibling of the bin holding the original's
 * item (at the root when the item is at the root); an existing "Processed" bin there is reused.
 */
function processedBin(doc: DDoc, originalItemId: string | undefined, h: HandlerContext): string {
	const itemBin = originalItemId ? (parentOf(doc, originalItemId) ?? null) : null;
	const parent = itemBin === null ? null : (parentOf(doc, itemBin) ?? null);
	const siblings = childrenOf(doc, parent);
	const existing = siblings.find((id) => {
		const it = doc.items[id];
		return it?.kind === 'bin' && it.name === PROCESSED_BIN_NAME;
	});
	if (existing) return existing;
	const id = h.ids.next('bin');
	doc.items[id] = { id, kind: 'bin', name: PROCESSED_BIN_NAME, children: [], label: 'mango' };
	const at = itemBin === null ? undefined : siblings.indexOf(itemBin) + 1;
	insertItem(doc, id, parent, at);
	return id;
}

function mediaItemOf(doc: DDoc, mediaId: string): ProjectItem | undefined {
	return Object.values(doc.items).find((it) => it.kind === 'media' && it.mediaId === mediaId) as
		| ProjectItem
		| undefined;
}

/** The `sourceRange` of a processed version of `source` (PRC-015): the processed range or the whole source. */
function processedSourceRange(
	source: MediaAsset,
	asset: Pick<MediaAsset, 'probe'>,
	range: { startFrame: number; endFrame: number } | undefined,
	h: HandlerContext,
): SourceRange | undefined {
	const rate = mediaFrameRate(source);
	const own = mediaFrameRate(asset);
	if (!rate) return undefined;
	if (own && !rationalEquals(own, rate))
		h.fail(
			'E_INVALID_PARAM',
			`The processed file runs at ${own.num}/${own.den} fps, its source at ${rate.num}/${rate.den}: processing keeps the frame rate`,
		);
	const srcFrames = mediaFrameCount(source);
	const fileFrames = mediaFrameCount(asset);
	let first = 0;
	let frames = fileFrames ?? srcFrames;
	if (range) {
		if (range.endFrame <= range.startFrame)
			h.fail('E_INVALID_PARAM', `Empty range ${range.startFrame}..${range.endFrame}`);
		if (srcFrames !== null && range.endFrame > srcFrames + 1)
			h.fail(
				'E_OUT_OF_MEDIA',
				`Range ${range.startFrame}..${range.endFrame} is outside ${source.originalName} (${srcFrames} frames)`,
			);
		first = range.startFrame;
		frames = range.endFrame - range.startFrame;
	}
	if (fileFrames !== null && frames !== null && Math.abs(fileFrames - frames) > 1)
		h.fail(
			'E_INVALID_PARAM',
			`The processed file has ${fileFrames} frames but the processed range has ${frames} (every step keeps the frame count)`,
		);
	if (!frames) return undefined;
	return {
		mediaId: source.id,
		sourceName: source.originalName,
		firstFrame: first,
		frames,
		frameRate: rate,
		origin: 'process',
	};
}

/**
 * The `sourceRange` of a `range` derivation (spec 18 AF-OPS-001): the source frames whose start lies in
 * `[inFlicks, outFlicks)` (`rangeFrames`), so the trimmed file is a version of its source and clips can switch to
 * it keeping their source frames. None for audio and variable-frame-rate sources (no frame index to map).
 */
function rangeSourceRange(
	source: MediaAsset,
	recipe: { inFlicks: number; outFlicks: number },
	probe: MediaAsset['probe'],
	range: { startFrame: number; endFrame: number } | undefined,
	h: HandlerContext,
): SourceRange | undefined {
	const rate = mediaFrameRate(source);
	if (source.kind !== 'video' || source.probe.variableFrameRate || !rate) return undefined;
	const frames = rangeFrames(recipe, rate);
	if (range && (range.startFrame !== frames.startFrame || range.endFrame !== frames.endFrame))
		h.fail(
			'E_INVALID_PARAM',
			`The range ${range.startFrame}..${range.endFrame} is not the recipe's frames ${frames.startFrame}..${frames.endFrame}`,
		);
	return processedSourceRange(source, { probe }, frames, h);
}

function mediaDerive(doc: DDoc, cmd: CommandOf<'media.derive'>, h: HandlerContext) {
	const source = mediaOf(doc, cmd.fromMediaId, h);
	const asset = cmd.asset;
	if (!asset)
		h.fail(
			'E_INVALID_PARAM',
			'media.derive needs `asset`: the engine produces the processed file (POST /api/media/:key/process) and its result is committed here',
		);
	// Audio ops (loudness-normalize, denoise-audio, extract-audio) make an audio file from the audio of a video or
	// audio media; the timing ops (reverse, time-stretch, range) keep the source's kind; the picture ops need video.
	const op = cmd.recipe.op;
	const kinds = deriveSourceKinds(op);
	if (!kinds.includes(source.kind))
		h.fail(
			'E_INVALID_PARAM',
			op === 'process' || op === 'transcode' || op === 'stabilize'
				? `Media ${source.id} is ${source.kind}; only video can be processed`
				: `Media ${source.id} is ${source.kind}; ${op} needs ${kinds.join(' or ')} media`,
		);
	const audioOp = deriveMakesAudio(op);
	if (isDeriveOp(op)) {
		const problem = deriveProblems(source, cmd.recipe as DeriveRecipe)[0];
		if (problem)
			h.fail(problem.code === 'OUT_OF_RANGE' ? 'E_OUT_OF_MEDIA' : 'E_INVALID_PARAM', problem.message);
	}
	if (cmd.binId) assertBin(doc, cmd.binId, h);
	if (asset.fingerprint === source.fingerprint)
		h.fail('E_INVALID_PARAM', 'The processed file has the fingerprint of its source');

	// Idempotent: the same file, or the same recipe of the same source, is registered once.
	const existing = Object.values(doc.media).find(
		(m) =>
			(m.fingerprint === asset.fingerprint && !m.fingerprint.startsWith('pending:')) ||
			(m.derivation?.fromMediaId === source.id && m.derivation.recipeHash === asset.recipeHash),
	);
	let mediaId: string;
	if (existing) {
		mediaId = existing.id;
		h.warn('W_DEDUPED', `This processed version is already in the project (${existing.id})`);
	} else {
		mediaId = h.ids.next('med');
		const isVersion = op === 'process' || op === 'transcode';
		const sourceRange = isVersion
			? processedSourceRange(source, { probe: asset.probe }, cmd.range, h)
			: op === 'range'
				? rangeSourceRange(source, cmd.recipe, asset.probe, cmd.range, h)
				: undefined;
		doc.media[mediaId] = {
			id: mediaId,
			kind: derivedKind(op, source.kind),
			fingerprint: asset.fingerprint,
			originalName: asset.originalName,
			sizeBytes: asset.sizeBytes,
			container: asset.container,
			probe: asset.probe,
			locators: asset.locators,
			derivation: {
				fromMediaId: source.id,
				recipe: cmd.recipe,
				recipeVersion: asset.recipeVersion,
				recipeHash: asset.recipeHash,
			},
			importedAt: h.ctx.now(),
			...(sourceRange ? { sourceRange } : {}),
		} as MediaAsset;
	}
	const media = doc.media[mediaId] as MediaAsset;
	if (audioOp && cmd.replaceInClips?.length) {
		if (op === 'extract-audio')
			h.fail(
				'E_INVALID_PARAM',
				'An extracted audio stream is added to the project only; place it like any audio media',
			);
		const out = useNormalizedAudio(doc, media, source.id, cmd.replaceInClips, h);
		let item0 = mediaItemOf(doc, mediaId);
		if (!item0) {
			const originalItem = mediaItemOf(doc, source.id);
			const binId0 = cmd.binId ?? processedBin(doc, originalItem?.id, h);
			const itemId = h.ids.next('itm');
			item0 = {
				id: itemId,
				kind: 'media',
				name: processedItemName(originalItem?.name ?? source.originalName, cmd.recipe, null),
				mediaId,
				label: defaultLabelForMedia(media),
				marks: { in: null, out: null },
			};
			doc.items[itemId] = item0;
			insertItem(doc, itemId, binId0);
		}
		h.defineRef(cmd.ref, mediaId);
		return { mediaId, itemId: item0.id, deduped: !!existing, clipIds: out };
	}
	if (!isVersionDerivation(media.derivation) && !media.sourceRange && cmd.replaceInClips?.length)
		h.fail('E_INVALID_PARAM', `Media ${mediaId} is not a processed version; clips cannot switch to it`);

	let item = mediaItemOf(doc, mediaId);
	let binId: string | null;
	if (item) binId = parentOf(doc, item.id) ?? null;
	else {
		const originalItem = mediaItemOf(doc, source.id);
		binId = cmd.binId ?? processedBin(doc, originalItem?.id, h);
		const itemId = h.ids.next('itm');
		item = {
			id: itemId,
			kind: 'media',
			name: processedItemName(
				originalItem?.name ?? source.originalName,
				cmd.recipe,
				cmd.range ??
					(op === 'range' && media.sourceRange
						? {
								startFrame: media.sourceRange.firstFrame,
								endFrame: media.sourceRange.firstFrame + media.sourceRange.frames,
							}
						: null),
			),
			mediaId,
			label: defaultLabelForMedia(media),
			marks: { in: null, out: null },
		};
		doc.items[itemId] = item;
		insertItem(doc, itemId, binId);
	}
	h.defineRef(cmd.ref, mediaId);

	const fit = (cmd.fit ?? 'refuse') as SourceFit;
	const swaps = [...new Set(cmd.replaceInClips ?? [])].map((id) => swapClipSource(doc, id, mediaId, h, fit));
	return {
		mediaId,
		itemId: item.id,
		binId,
		deduped: !!existing,
		clipIds: swaps.filter((s) => s.changed).map((s) => s.clipId),
		...(swaps.some((s) => s.skipped)
			? { skippedClipIds: swaps.filter((s) => s.skipped).map((s) => s.clipId) }
			: {}),
		...(swaps.some((s) => s.trimmed)
			? { trimmedClipIds: swaps.filter((s) => s.trimmed).map((s) => s.clipId) }
			: {}),
	};
}

/**
 * audio clips of `sourceId` play the loudness-normalised `media` instead (same timing: the file starts at
 * the source's time 0; its first audio stream holds the normalised stream's channels).
 */
function useNormalizedAudio(
	doc: DDoc,
	media: MediaAsset,
	sourceId: string,
	clipIds: readonly string[],
	h: HandlerContext,
): string[] {
	const stream = media.probe.streams.find((s) => s.type === 'audio');
	if (stream?.type !== 'audio') return h.fail('E_INVALID_PARAM', 'The normalised file has no audio stream');
	// The engine processes the source's first audio stream (loudness-normalize, denoise-audio): a clip playing another
	// stream of a multi-stream file (e.g. the lav on stream 2) would silently switch to the wrong sound.
	const source = doc.media[sourceId] as MediaAsset | undefined;
	const processed = source?.probe.streams.find((s) => s.type === 'audio')?.index;
	const others = [...new Set(clipIds)].filter((id) => {
		const c = h.clip(doc, id).clip as Draft<AudioClip>;
		return c.kind === 'audio' && c.mediaId === sourceId && c.channels.streamIndex !== processed;
	});
	if (others.length)
		h.fail(
			'E_INVALID_PARAM',
			`Clip${others.length > 1 ? 's' : ''} ${others
				.map((id) => {
					const c = h.clip(doc, id).clip as Draft<AudioClip>;
					return `${id} (stream ${c.channels.streamIndex})`;
				})
				.join(
					', ',
				)} play${others.length > 1 ? '' : 's'} another audio stream than the processed one (stream ${processed}); only clips playing stream ${processed} can switch to this version`,
		);
	const changed: string[] = [];
	for (const id of new Set(clipIds)) {
		const { seq, clip } = h.clip(doc, id);
		if (clip.kind !== 'audio')
			h.fail(
				'E_INVALID_PARAM',
				`Clip ${id} is ${clip.kind}; only audio clips switch to a normalised version`,
			);
		const c = clip as Draft<AudioClip>;
		if (c.mediaId !== sourceId) h.fail('E_INVALID_PARAM', `Clip ${id} does not play media ${sourceId}`);
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		c.mediaId = media.id;
		const map = c.channels.map.every((i) => i < stream.channels)
			? [...c.channels.map]
			: Array.from({ length: Math.min(2, stream.channels) }, (_, i) => i);
		c.channels = { streamIndex: stream.index, map };
		changed.push(id);
	}
	return changed;
}

function setSourceRange(doc: DDoc, cmd: CommandOf<'media.setSourceRange'>, h: HandlerContext) {
	const asset = mediaOf(doc, cmd.mediaId, h);
	const sr = cmd.sourceRange as SourceRange | null;
	if (sr === null) {
		delete (asset as { sourceRange?: unknown }).sourceRange;
		return { mediaId: asset.id };
	}
	if (sr.mediaId !== null) {
		const parent = mediaOf(doc, sr.mediaId, h);
		if (parent.id === asset.id) h.fail('E_INVALID_PARAM', 'A media cannot be its own source');
		if (parent.kind !== 'video' && parent.kind !== 'audio')
			h.fail('E_INVALID_PARAM', `Media ${parent.id} is ${parent.kind}; a source must be video or audio`);
	}
	if (sr.mediaId !== null && originalChain(doc, sr.mediaId).includes(asset.id))
		h.fail('E_INVALID_PARAM', `Media ${sr.mediaId} is a version of ${asset.id}: the link would form a cycle`);
	(asset as { sourceRange?: SourceRange }).sourceRange = sr;
	if (sr.mediaId !== null) {
		const p = rootPlacement(doc, asset.id);
		if (p && !p.ok) h.fail('E_INVALID_PARAM', p.reason);
	}
	return { mediaId: asset.id };
}

/** Media ids from `mediaId` up its source links (itself first). */
function originalChain(doc: DDoc, mediaId: string): string[] {
	const chain = [mediaId];
	for (let link = sourceLinkOf(doc, doc.media[mediaId]); link && !chain.includes(link.parentId); ) {
		chain.push(link.parentId);
		link = sourceLinkOf(doc, doc.media[link.parentId]);
	}
	return chain;
}

export const processHandlers = {
	'media.derive': mediaDerive,
	'media.setSourceRange': setSourceRange,
	'clip.replaceSource': (doc, cmd, h) =>
		swapClipSource(doc, cmd.clipId, cmd.mediaId, h, (cmd.fit ?? 'refuse') as SourceFit),
} satisfies HandlerMap;
