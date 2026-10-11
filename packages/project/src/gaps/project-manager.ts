// File ▸ Project Manager… (docs/wp-notes/gaps.md §PRJ-6), the pure part: which sequences, items and
// media a trimmed copy of the project keeps, which part of each media its clips use, and the document of the copy
// once the engine has copied or transcoded the files. Premiere's two modes:
// - Collect Files and Copy to New Location: every used file is copied whole;
// - Consolidate and Transcode: only the used part of each video / audio media (plus handles) is written, and the
//   clips are re-based so every edit, keyframe and marker stays where it was (Replace Footage with Keep Source
//   Timing over a declared source range — the mechanism of processed versions).
// "Exclude Unused Clips" drops the sequences that were not chosen and the media items no kept clip uses (LUTs, fonts,
// motion-graphics bundles and colour configs are always kept: effects and clips reference them by id).
import { contentTimeAt } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';

export type ProjectManagerMode = 'collect' | 'consolidate';

export type MediaUse = { lo: number; hi: number; whole: boolean };

/** Media kinds Project Manager never drops (referenced by effects, text and clips by id, not by placement). */
const ALWAYS_KEPT = new Set(['lut', 'font', 'mg-bundle', 'color-config', 'model']);
/** Media consolidation can trim (timed). */
const TRIMMABLE = new Set(['video', 'audio']);

/** The sequences reachable from `roots` through nested sequences (multicam sources and merged clips included). */
export function sequenceClosure(doc: ProjectDocument, roots: readonly string[]): string[] {
	const seen = new Set<string>();
	const stack = roots.filter((id) => !!doc.sequences[id]);
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id) || seen.size > 10_000) continue;
		seen.add(id);
		const seq = doc.sequences[id];
		if (!seq) continue;
		for (const c of Object.values(seq.clips)) {
			const nested = (c as { sequenceId?: unknown }).sequenceId;
			if (typeof nested === 'string' && doc.sequences[nested] && !seen.has(nested)) stack.push(nested);
		}
	}
	return [...seen];
}

/**
 * The media time (flicks) the clips of `sequenceIds` use per media: [lo, hi). `whole` = something needs the whole
 * media (time remapping, a loop, a still). Frame holds count their held time.
 */
export function usedMedia(doc: ProjectDocument, sequenceIds: readonly string[]): Map<string, MediaUse> {
	const out = new Map<string, MediaUse>();
	const add = (mediaId: string, lo: number, hi: number, whole = false) => {
		const cur = out.get(mediaId);
		if (!cur) out.set(mediaId, { lo, hi, whole });
		else {
			cur.lo = Math.min(cur.lo, lo);
			cur.hi = Math.max(cur.hi, hi);
			cur.whole ||= whole;
		}
	};
	for (const id of sequenceIds) {
		const seq = doc.sequences[id] as Sequence | undefined;
		if (!seq) continue;
		const rate = seq.settings.frameRate;
		for (const c of Object.values(seq.clips) as Clip[]) {
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string' || !doc.media[mediaId]) continue;
			const asset = doc.media[mediaId]!;
			const r = c as Clip & { timeRemap?: unknown; frameHold?: { flicks: number }; loop?: boolean };
			if (!TRIMMABLE.has(asset.kind) || r.timeRemap || r.loop || asset.interpretation?.loop) {
				add(mediaId, 0, asset.probe.durationFlicks ?? 0, true);
				continue;
			}
			const a = contentTimeAt(c, c.start, rate);
			const b = contentTimeAt(c, c.start + c.duration - 1, rate);
			const F = flicksPerFrame(rate) * (c.speed?.rate ?? 1);
			let lo = Math.min(a, b);
			let hi = Math.max(a, b) + F;
			if (r.frameHold) {
				lo = Math.min(lo, r.frameHold.flicks);
				hi = Math.max(hi, r.frameHold.flicks + F);
			}
			add(mediaId, Math.max(0, Math.floor(lo)), Math.ceil(hi));
		}
	}
	return out;
}

/** A media's frame rate for counting source frames (its video rate; ms for sound). */
export function sourceRateOf(asset: Pick<MediaAsset, 'probe'>): Rational {
	const v = asset.probe.streams.find((s) => s.type === 'video');
	return v && v.type === 'video' && v.frameRate.num > 0 && v.frameRate.den > 0
		? v.frameRate
		: { num: 1000, den: 1 };
}

export type ProjectManagerPlan = {
	sequences: string[];
	/** Sequences dropped (not chosen, not nested in a chosen one). */
	droppedSequences: string[];
	/** Media items dropped (no kept clip uses their media). */
	droppedItems: string[];
	/** Every media the copy references, with what to do with it. */
	files: {
		mediaId: string;
		name: string;
		/** `copy` the whole file, or `trim` it to [firstFrame, firstFrame + frames) of `rate`. */
		action: 'copy' | 'trim';
		firstFrame: number;
		frames: number;
		rate: Rational;
		/** Bytes of the original file; the estimated bytes of the result. */
		sizeBytes: number;
		estimatedBytes: number;
	}[];
};

/**
 * Plans a Project Manager run over `sequenceIds` (all sequences when empty). Consolidation trims video / audio
 * media used by clips to their used range plus `handlesFrames`, rounded out to whole source frames.
 */
export function planProjectManager(
	doc: ProjectDocument,
	opts: {
		sequenceIds?: readonly string[];
		mode: ProjectManagerMode;
		excludeUnused: boolean;
		handlesFrames: number;
	},
): ProjectManagerPlan {
	const roots = opts.sequenceIds?.length ? opts.sequenceIds : Object.keys(doc.sequences);
	const sequences = sequenceClosure(doc, roots);
	const keepSeq = new Set(sequences);
	const droppedSequences = opts.excludeUnused
		? Object.keys(doc.sequences).filter((id) => !keepSeq.has(id))
		: [];
	const uses = usedMedia(doc, sequences);
	const keptMedia = new Set<string>();
	const droppedItems: string[] = [];
	for (const it of Object.values(doc.items)) {
		if (it.kind !== 'media' && it.kind !== 'subclip') continue;
		const asset = doc.media[it.mediaId];
		const keep = !opts.excludeUnused || !asset || ALWAYS_KEPT.has(asset.kind) || uses.has(it.mediaId);
		if (keep) keptMedia.add(it.mediaId);
		else droppedItems.push(it.id);
	}
	for (const id of uses.keys()) keptMedia.add(id);
	const handles = Math.max(0, Math.floor(opts.handlesFrames));
	const files: ProjectManagerPlan['files'] = [];
	for (const id of keptMedia) {
		const a = doc.media[id];
		if (!a) continue;
		const rate = sourceRateOf(a);
		const dur = a.probe.durationFlicks ?? 0;
		const perFrame = (FLICKS_PER_SECOND * rate.den) / rate.num;
		const total = Math.max(1, Math.round(dur / perFrame));
		const use = uses.get(id);
		const trim = opts.mode === 'consolidate' && TRIMMABLE.has(a.kind) && !!use && !use.whole && dur > 0;
		let first = 0;
		let frames = total;
		if (trim && use) {
			first = Math.max(0, Math.floor(use.lo / perFrame) - handles);
			const last = Math.min(total, Math.ceil(use.hi / perFrame) + handles);
			frames = Math.max(1, last - first);
		}
		files.push({
			mediaId: id,
			name: a.originalName,
			action: trim && frames < total ? 'trim' : 'copy',
			firstFrame: trim ? first : 0,
			frames,
			rate,
			sizeBytes: a.sizeBytes,
			estimatedBytes: trim && frames < total ? Math.round((a.sizeBytes * frames) / total) : a.sizeBytes,
		});
	}
	return { sequences, droppedSequences, droppedItems, files };
}

/** What the engine wrote for one planned file. */
export type ProjectManagerOutput = {
	mediaId: string;
	path: string;
	registered: {
		mediaKey: string;
		fingerprint: string;
		originalName: string;
		sizeBytes: number;
		container: string;
		probe: MediaAsset['probe'];
		locators: MediaAsset['locators'];
	};
	/** Old audio stream index → the new one (transcodes renumber streams). */
	streamMap?: Record<number, number>;
	proxy?: { path: string; registered: ProjectManagerOutput['registered'] } | null;
};

/**
 * The commands that turn the project into its trimmed copy: drop unused sequences and items, point every media at
 * its copy (a trimmed file: Replace Footage keeping the source timing over its declared source range), carry or drop
 * proxies, and renumber audio streams of transcoded media in the clips.
 */
export function projectManagerCommands(
	doc: ProjectDocument,
	plan: ProjectManagerPlan,
	outputs: readonly ProjectManagerOutput[],
): unknown[] {
	const cmds: unknown[] = [];
	for (const id of plan.droppedSequences) cmds.push({ type: 'sequence.delete', sequenceId: id, force: true });
	if (plan.droppedItems.length) cmds.push({ type: 'item.delete', itemIds: plan.droppedItems, force: true });
	const byMedia = new Map(plan.files.map((f) => [f.mediaId, f]));
	for (const o of outputs) {
		const f = byMedia.get(o.mediaId);
		const asset = doc.media[o.mediaId];
		if (!f || !asset) continue;
		const r = o.registered;
		const locators = [
			{ type: 'engine-store', engineId: 'local', key: r.mediaKey },
			{ type: 'path', path: o.path, relativeToProject: null },
		];
		if (f.action === 'copy')
			cmds.push({
				type: 'media.relink',
				mediaId: o.mediaId,
				locator: locators[1],
				locators,
				...(r.fingerprint !== asset.fingerprint ? { fingerprint: r.fingerprint, replace: true } : {}),
			});
		else
			cmds.push({
				type: 'media.relink',
				mediaId: o.mediaId,
				replace: true,
				keepSourceTiming: true,
				fit: 'trim',
				locator: locators[1],
				locators,
				fingerprint: r.fingerprint,
				probe: r.probe,
				sizeBytes: r.sizeBytes,
				originalName: r.originalName,
				container: r.container,
				sourceRange: {
					mediaId: null,
					sourceName: asset.originalName,
					firstFrame: f.firstFrame,
					frames: f.frames,
					frameRate: f.rate,
					origin: 'manual',
				},
			});
		if (o.proxy)
			cmds.push({
				type: 'media.attachProxy',
				mediaId: o.mediaId,
				force: true,
				proxy: {
					fingerprint: o.proxy.registered.fingerprint,
					originalName: o.proxy.registered.originalName,
					sizeBytes: o.proxy.registered.sizeBytes,
					container: o.proxy.registered.container,
					probe: o.proxy.registered.probe,
					locators: [
						{ type: 'engine-store', engineId: 'local', key: o.proxy.registered.mediaKey },
						{ type: 'path', path: o.proxy.path, relativeToProject: null },
					],
					origin: asset.proxy?.origin ?? 'attached',
					...(asset.proxy?.preset ? { preset: asset.proxy.preset } : {}),
				},
			});
		else if (asset.proxy) cmds.push({ type: 'media.detachProxy', mediaIds: [o.mediaId] });
		// Transcodes renumber audio streams: the clips follow.
		if (o.streamMap && Object.entries(o.streamMap).some(([a, b]) => Number(a) !== b))
			for (const seqId of plan.sequences) {
				const seq = doc.sequences[seqId];
				if (!seq) continue;
				for (const c of Object.values(seq.clips)) {
					if (c.kind !== 'audio' || (c as { mediaId: string }).mediaId !== o.mediaId) continue;
					const ch = (c as { channels: { streamIndex: number; map: number[]; mute?: number[] } }).channels;
					const to = o.streamMap[ch.streamIndex];
					if (to !== undefined && to !== ch.streamIndex)
						cmds.push({
							type: 'clip.update',
							sequenceId: seqId,
							clipId: c.id,
							patch: { channels: { ...ch, streamIndex: to } },
						});
				}
			}
	}
	return cmds;
}
