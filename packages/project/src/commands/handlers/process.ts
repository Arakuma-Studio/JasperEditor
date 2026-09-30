// Processed media (M2, S07:PRC-001…007): media.derive (register a processed version of a media asset and
// optionally swap clips to it) and clip.replaceSource (swap a clip between versions of the same original).
// Owner: wp-m2-process.
//
// - A processed version is a MediaAsset whose `derivation` points at its source; it gets a project item in the
//   auto-created bin "Processed" next to the original's bin (PRC-004). Re-deriving the same file (same
//   fingerprint, or same source + recipe hash) reuses the asset (idempotent) and still performs the swaps.
// - A swap changes only the video clip's `mediaId` (and `videoStreamIndex`): start, duration, sourceIn, speed,
//   effects, keyframes, links and markers stay; versions have the same frame count and rate by construction.
//   When the pixel size differs, Motion and tracker geometry are compensated (`rescaleClipForSource`, PRC-006).
//   Linked audio keeps pointing at the original (PRC-007).
// - Range-processed versions (PRC-015, P1) have no representation in the schema yet: a version shorter than the
//   clip's content span is refused with E_OUT_OF_MEDIA instead of remapping sourceIn. `keepDuration` is
//   accepted and has no effect: the duration is always kept.
import { current, isDraft } from 'immer';
import {
	isVersionDerivation,
	mediaIntrinsicSize,
	originalMediaId,
	PROCESSED_BIN_NAME,
	processedItemName,
	rescaleClipForSource,
} from '../../process/index.ts';
import { defaultLabelForMedia } from '../../registry/kinds.ts';
import type { ProjectItem } from '../../schema/document.ts';
import type { MediaAsset } from '../../schema/media.ts';
import type { VideoClip } from '../../schema/sequence.ts';
import { contentSpanFlicks, flicksPerFrame, type Rational } from '../../time.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { assertBin, insertItem } from './project.ts';
import type { HandlerMap } from './util.ts';

type SwapResult = { clipId: string; fromMediaId: string; toMediaId: string; changed: boolean };

function mediaOf(doc: DDoc, id: string, h: HandlerContext): MediaAsset {
	const m = doc.media[id] as MediaAsset | undefined;
	if (!m) h.fail('E_NOT_FOUND', `Media not found: ${id}`);
	return m;
}

function plain<T>(v: T): T {
	return isDraft(v) ? (current(v as never) as T) : v;
}

/** Swaps a video clip's source to another version of the same original (S07:PRC-006/007). */
function swapClipSource(doc: DDoc, clipId: string, targetId: string, h: HandlerContext): SwapResult {
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
	const original = originalMediaId(doc, from.id);
	if (original === null || originalMediaId(doc, target.id) !== original)
		h.fail(
			'E_INVALID_PARAM',
			`Media ${target.id} is not a version of ${original ?? from.id} (the original of clip ${clipId})`,
		);
	const oldSize = mediaIntrinsicSize(from);
	const newSize = mediaIntrinsicSize(target);
	const stream =
		target.probe.streams.find((s) => s.type === 'video' && s.index === vclip.videoStreamIndex) ??
		target.probe.streams.find((s) => s.type === 'video');
	if (!newSize || !stream) h.fail('E_INVALID_PARAM', `Media ${target.id} has no video stream`);
	assertCovers(seq, vclip, target, h);

	const next = oldSize
		? rescaleClipForSource(plain(vclip), oldSize, newSize, { newKeyframeId: () => h.ids.next('kf') })
		: null;
	const d = clip as unknown as VideoClip;
	d.mediaId = target.id;
	d.videoStreamIndex = stream.index;
	if (next) {
		d.transform = next.transform;
		if (next.trackers) d.trackers = next.trackers;
	}
	return { clipId, fromMediaId: from.id, toMediaId: target.id, changed: true };
}

/** Versions share the frame count; refuse a (future, range-processed) version that cannot cover the clip. */
function assertCovers(seq: DSeq, clip: VideoClip, target: MediaAsset, h: HandlerContext): void {
	const total = target.probe.durationFlicks;
	if (total === null) return;
	const rate = seq.settings.frameRate as Rational;
	const span = contentSpanFlicks(clip.duration, rate, clip.speed.rate);
	const tol = flicksPerFrame(rate) * clip.speed.rate + 1;
	if (clip.sourceIn + span > total + tol)
		h.fail('E_OUT_OF_MEDIA', `Media ${target.id} is shorter than the part of it clip ${clip.id} uses`);
}

// ---------------------------------------------------------------- media.derive

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

function mediaDerive(doc: DDoc, cmd: CommandOf<'media.derive'>, h: HandlerContext): unknown {
	const source = mediaOf(doc, cmd.fromMediaId, h);
	const asset = cmd.asset;
	if (!asset)
		h.fail(
			'E_INVALID_PARAM',
			'media.derive needs `asset`: the engine produces the processed file (POST /api/media/:key/process) and its result is committed here',
		);
	if (source.kind !== 'video')
		h.fail('E_INVALID_PARAM', `Media ${source.id} is ${source.kind}; only video can be processed`);
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
		doc.media[mediaId] = {
			id: mediaId,
			kind: source.kind,
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
		} as MediaAsset;
	}
	const media = doc.media[mediaId] as MediaAsset;
	if (!isVersionDerivation(media.derivation) && cmd.replaceInClips?.length)
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
			name: processedItemName(originalItem?.name ?? source.originalName, cmd.recipe),
			mediaId,
			label: defaultLabelForMedia(media),
			marks: { in: null, out: null },
		};
		doc.items[itemId] = item;
		insertItem(doc, itemId, binId);
	}
	h.defineRef(cmd.ref, mediaId);

	const swaps = [...new Set(cmd.replaceInClips ?? [])].map((id) => swapClipSource(doc, id, mediaId, h));
	return {
		mediaId,
		itemId: item.id,
		binId,
		deduped: !!existing,
		clipIds: swaps.filter((s) => s.changed).map((s) => s.clipId),
	};
}

export const processHandlers: HandlerMap = {
	'media.derive': mediaDerive,
	'clip.replaceSource': (doc, cmd, h) => swapClipSource(doc, cmd.clipId, cmd.mediaId, h),
};
