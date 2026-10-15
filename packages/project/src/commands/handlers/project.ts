import type { Draft } from 'immer';
import { mediaDurationFlicks } from '../../interpret/model.ts';
import { frameShiftFlicks, sourceTimingShift } from '../../process/source-range.ts';
import { defaultLabelForMedia } from '../../registry/kinds.ts';
import type { MediaItem, ProjectDocument, ProjectItem, SourceMarks } from '../../schema/document.ts';
import type { MediaAsset, Transcript } from '../../schema/media.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import type { LibraryProvenance } from '../../sound/provenance.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import { cleanupSequence, removeClip } from '../placement.ts';
import { orphanedSynthetics } from '../tx-delta.ts';
import { replaceMediaFile, type SourceFit } from './process.ts';
import { assertBin, detachItem, insertItem } from './project-items.ts';
import { libraryDescriptorIssue } from './sound.ts';
import { type HandlerMap, idList, memoPlain, peek, peekKeys } from './util.ts';

function isDescendant(doc: DDoc, ancestorBinId: string, itemId: string): boolean {
	const bin = doc.items[ancestorBinId];
	if (bin?.kind !== 'bin') return false;
	for (const child of bin.children) {
		if (child === itemId || isDescendant(doc, child, itemId)) return true;
	}
	return false;
}

function item(doc: DDoc, id: string, h: HandlerContext): ProjectItem {
	const it = doc.items[id];
	if (!it) h.fail('E_NOT_FOUND', `Project item not found: ${id}`);
	return it as ProjectItem;
}

/** Removes assets/synthetics/transcripts no longer referenced by any item or clip (INV-014). */
type ClipRefs = { media: string[]; synthetics: string[]; transcripts: string[] };
const clipRefsCache = new WeakMap<object, ClipRefs>();
/** Media / synthetic / transcript ids referenced by a clips record (memoized per untouched record). */
function clipRefs(clips: Record<string, Clip>): ClipRefs {
	return memoPlain(clipRefsCache, clips, () => {
		const out: ClipRefs = { media: [], synthetics: [], transcripts: [] };
		for (const cid of peekKeys(clips)) {
			const r = peek<Record<string, unknown>>(clips, cid)!;
			if (typeof r.mediaId === 'string') out.media.push(r.mediaId);
			if (typeof r.syntheticId === 'string') out.synthetics.push(r.syntheticId);
			if (typeof r.transcriptId === 'string') out.transcripts.push(r.transcriptId);
		}
		return out;
	});
}

export function collectOrphans(doc: DDoc): void {
	// after a normalized base only what the transaction gave up can be orphaned (tx-delta.ts).
	const scoped = orphanedSynthetics(doc as ProjectDocument);
	if (scoped) {
		for (const id of scoped) delete doc.synthetics[id];
		return;
	}
	// Runs after every transaction: reads through `peek` (no drafts for the thousands of untouched clips); only the
	// records that lose entries are written through the draft.
	const usedMedia = new Set<string>();
	const usedSyn = new Set<string>();
	const usedTrs = new Set<string>();
	const items = peek<Record<string, ProjectItem>>(doc, 'items')!;
	for (const key of peekKeys(items)) {
		const it = peek<ProjectItem>(items, key)!;
		if (it.kind === 'media' || it.kind === 'subclip') usedMedia.add(it.mediaId);
		if (it.kind === 'synthetic') usedSyn.add(it.syntheticId);
	}
	const sequences = peek<Record<string, Sequence>>(doc, 'sequences')!;
	for (const sid of peekKeys(sequences)) {
		const refs = clipRefs(peek<Record<string, Clip>>(peek<Sequence>(sequences, sid)!, 'clips')!);
		for (const id of refs.media) usedMedia.add(id);
		for (const id of refs.synthetics) usedSyn.add(id);
		for (const id of refs.transcripts) usedTrs.add(id);
	}
	const media = peek<Record<string, MediaAsset>>(doc, 'media')!;
	for (const id of peekKeys(media)) {
		const m = peek<MediaAsset>(media, id)!;
		if (m.derivation) usedMedia.add(m.derivation.fromMediaId);
	}
	const transcripts = peek<Record<string, Transcript>>(doc, 'transcripts')!;
	for (const id of peekKeys(transcripts)) {
		const t = peek<Transcript>(transcripts, id)!;
		if (!usedTrs.has(t.id) && (t.mediaId === null || !usedMedia.has(t.mediaId))) delete doc.transcripts[id];
		else if (t.mediaId && !usedMedia.has(t.mediaId)) doc.transcripts[id]!.mediaId = null;
	}
	for (const id of peekKeys(media)) if (!usedMedia.has(id)) delete doc.media[id];
	const synthetics = peek<Record<string, unknown>>(doc, 'synthetics')!;
	for (const id of peekKeys(synthetics)) if (!usedSyn.has(id)) delete doc.synthetics[id];
}

export const projectHandlers = {
	'project.rename': (doc, cmd) => {
		doc.name = cmd.name;
	},
	'project.updateSettings': (doc, cmd) => {
		Object.assign(doc.settings, cmd.settings);
	},
	'bin.create': (doc, cmd, h: HandlerContext) => {
		assertBin(doc, cmd.parentBinId, h);
		const id = h.newId(doc, 'bin', cmd.id);
		doc.items[id] = { id, kind: 'bin', name: cmd.name, children: [], label: cmd.label ?? 'mango' };
		insertItem(doc, id, cmd.parentBinId, cmd.index);
		h.defineRef(cmd.ref, id);
		return { itemId: id };
	},
	'item.rename': (doc, cmd, h: HandlerContext) => {
		for (const id of idList(cmd.itemIds)) item(doc, id, h).name = cmd.name;
	},
	'item.setLabel': (doc, cmd, h: HandlerContext) => {
		for (const id of idList(cmd.itemIds)) item(doc, id, h).label = cmd.label;
	},
	'item.move': (doc, cmd, h: HandlerContext) => {
		assertBin(doc, cmd.toBinId, h);
		let index = cmd.index;
		for (const id of idList(cmd.itemIds)) {
			item(doc, id, h);
			if (cmd.toBinId && (cmd.toBinId === id || isDescendant(doc, id, cmd.toBinId))) {
				h.fail('E_CYCLE', `Cannot move ${id} into itself or one of its bins`);
			}
			detachItem(doc, id);
			insertItem(doc, id, cmd.toBinId, index);
			if (index !== undefined) index++;
		}
	},
	'item.delete': (doc, cmd, h: HandlerContext) => {
		const toDelete = new Set<string>();
		const addRec = (id: string) => {
			const it = item(doc, id, h);
			toDelete.add(id);
			if (it.kind === 'bin') for (const c of it.children) addRec(c);
		};
		for (const id of idList(cmd.itemIds)) addRec(id);
		const remainingRefs = (field: 'mediaId' | 'syntheticId', value: string) =>
			Object.values(doc.items).some(
				(it) => !toDelete.has(it.id) && (it as Record<string, unknown>)[field] === value,
			);
		const clipRemovals: { seqId: string; clipId: string }[] = [];
		const deletedSequences = new Set<string>();
		for (const id of toDelete) {
			const it = doc.items[id]!;
			if (it.kind === 'sequence') deletedSequences.add(it.sequenceId);
		}
		for (const id of toDelete) {
			const it = doc.items[id]!;
			const field = it.kind === 'media' ? 'mediaId' : it.kind === 'synthetic' ? 'syntheticId' : null;
			if (!field) continue;
			const value = (it as Record<string, unknown>)[field] as string;
			if (remainingRefs(field, value)) continue;
			for (const seq of Object.values(doc.sequences)) {
				if (deletedSequences.has(seq.id)) continue;
				for (const c of Object.values(seq.clips)) {
					if ((c as Record<string, unknown>)[field] === value)
						clipRemovals.push({ seqId: seq.id, clipId: c.id });
				}
			}
		}
		for (const seq of Object.values(doc.sequences)) {
			if (deletedSequences.has(seq.id)) continue;
			for (const c of Object.values(seq.clips)) {
				const nested = (c as Record<string, unknown>).sequenceId;
				if (typeof nested === 'string' && deletedSequences.has(nested))
					clipRemovals.push({ seqId: seq.id, clipId: c.id });
			}
		}
		if (clipRemovals.length > 0 && !cmd.force) {
			const seqs = new Set(clipRemovals.map((r) => r.seqId));
			h.fail('E_IN_USE', `${clipRemovals.length} clips in ${seqs.size} sequences use this media`, {
				blocking: clipRemovals.map((r) => r.clipId),
			});
		}
		for (const r of clipRemovals) {
			const seq = doc.sequences[r.seqId]!;
			const track = [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].find(
				(t) => t.id === seq.clips[r.clipId]?.trackId,
			);
			if (track?.locked)
				h.fail('E_TRACK_LOCKED', `Clip ${r.clipId} is on a locked track`, { blocking: [track.id] });
			removeClip(seq, r.clipId, h);
		}
		for (const seqId of deletedSequences) delete doc.sequences[seqId];
		for (const id of toDelete) {
			detachItem(doc, id);
			delete doc.items[id];
		}
		// clips forget a deleted subclip (their media stays); subclips forget a deleted parent item.
		for (const seq of Object.values(doc.sequences))
			for (const c of Object.values(seq.clips))
				if (c.subclipId && toDelete.has(c.subclipId)) delete c.subclipId;
		for (const it of Object.values(doc.items))
			if (it.kind === 'subclip' && it.parentItemId && toDelete.has(it.parentItemId)) it.parentItemId = null;
		for (const seq of Object.values(doc.sequences)) cleanupSequence(seq, h);
		collectOrphans(doc);
		return { deletedItems: [...toDelete], removedClips: clipRemovals.map((r) => r.clipId) };
	},
	// Set / Clear Poster Frame (the thumbnail frame of a media item).
	'item.setPoster': (doc, cmd, h: HandlerContext) => {
		const it = item(doc, cmd.itemId, h);
		if (it.kind !== 'media') h.fail('E_INVALID_PARAM', 'Only media items have a poster frame');
		const media = it as Draft<MediaItem>;
		if (cmd.time === null) {
			delete media.poster;
			return;
		}
		const asset = doc.media[media.mediaId] as MediaAsset | undefined;
		const flicks = h.flicks(cmd.time, asset, { num: 30, den: 1 });
		const duration = asset ? mediaDurationFlicks(asset) : undefined;
		if (duration != null && duration > 0 && flicks >= duration)
			h.fail('E_OUT_OF_MEDIA', 'The poster frame is past the end of the media');
		media.poster = { flicks };
	},
	'item.setMarks': (doc, cmd, h: HandlerContext) => {
		const it = item(doc, cmd.itemId, h);
		if (it.kind !== 'media' && it.kind !== 'synthetic' && it.kind !== 'subclip')
			h.fail('E_INVALID_PARAM', 'Only media, subclip and synthetic items have marks');
		const asset: MediaAsset | undefined =
			it.kind === 'media' || it.kind === 'subclip' ? (doc.media[it.mediaId] as MediaAsset) : undefined;
		const fallback: Rational = { num: 30, den: 1 };
		const conv = (v: Parameters<typeof h.flicks>[0] | null | undefined) =>
			v ? h.flicks(v, asset, fallback) : null;
		// Subclips: marks live in the media's content time, inside the subclip's range (edit-ux).
		const lo = it.kind === 'subclip' ? it.range.in : 0;
		const hiDur = it.kind === 'subclip' ? it.range.out : asset ? mediaDurationFlicks(asset) : undefined;
		const check = (a: number | null, b: number | null, what: string) => {
			if (a !== null && b !== null && b <= a)
				h.fail('E_INVALID_PARAM', `${what} Out mark must be after its In mark`);
			if ((a !== null && a < lo) || (b !== null && b <= lo))
				h.fail(
					'E_OUT_OF_MEDIA',
					`${what} marks are outside the ${it.kind === 'subclip' ? 'subclip' : 'media'}`,
				);
			if (hiDur != null && ((a ?? 0) > hiDur || (b ?? 0) > hiDur + flicksPerFrame(fallback)))
				h.fail(
					'E_OUT_OF_MEDIA',
					`${what} marks are outside the ${it.kind === 'subclip' ? 'subclip' : 'media'}`,
				);
		};
		const inF = conv(cmd.in);
		const outF = conv(cmd.out);
		check(inF, outF, '');
		const marks: Draft<SourceMarks> = {
			in: inF === null ? null : { flicks: inF },
			out: outF === null ? null : { flicks: outF },
		};
		// edit-ux (Mark Split): keep, replace or clear the video/audio marks.
		const prev = (it.marks as SourceMarks).split;
		if (cmd.split !== null) {
			const sp = { ...(prev ?? {}) } as NonNullable<SourceMarks['split']>;
			for (const k of ['videoIn', 'videoOut', 'audioIn', 'audioOut'] as const) {
				const v = cmd.split?.[k];
				if (v === undefined) continue;
				sp[k] = v === null ? null : { flicks: conv(v)! };
			}
			const f = (k: keyof typeof sp) => sp[k]?.flicks ?? null;
			check(f('videoIn') ?? inF, f('videoOut') ?? outF, 'Video');
			check(f('audioIn') ?? inF, f('audioOut') ?? outF, 'Audio');
			if (Object.values(sp).some((v) => v)) marks.split = sp;
		}
		it.marks = marks as SourceMarks;
	},
	'media.register': (doc, cmd, h: HandlerContext) => {
		assertBin(doc, cmd.binId, h);
		// sound-design: the same checks as `media.setLibraryInfo` (audio/video media, descriptors inside the sound).
		if (cmd.asset.library) {
			if (cmd.asset.kind !== 'audio' && cmd.asset.kind !== 'video')
				h.fail('E_INVALID_PARAM', `Library provenance applies to audio media, not ${cmd.asset.kind}`, {
					path: ['asset', 'library'],
				});
			const bad = libraryDescriptorIssue(cmd.asset.library as LibraryProvenance);
			if (bad) h.fail('E_INVALID_PARAM', bad, { path: ['asset', 'library', 'descriptors'] });
		}
		// the pages of one PDF share the file's fingerprint and are different media.
		const page = (a: { vector?: { page?: number } | null }) => a.vector?.page ?? 1;
		const existing = Object.values(doc.media).find(
			(m) =>
				m.fingerprint === cmd.asset.fingerprint &&
				!m.fingerprint.startsWith('pending:') &&
				page(m) === page(cmd.asset),
		);
		let mediaId: string;
		let deduped = false;
		if (existing) {
			mediaId = existing.id;
			deduped = true;
			h.warn('W_DEDUPED', `Already in project; added another reference to ${existing.id}`);
			// sound-design: the same bytes registered from the Sound Library gain its provenance (never overwritten).
			if (cmd.asset.library && existing.library === undefined)
				existing.library = JSON.parse(JSON.stringify(cmd.asset.library)) as typeof existing.library;
		} else {
			mediaId = h.newId(doc, 'med', cmd.asset.id);
			doc.media[mediaId] = {
				...cmd.asset,
				id: mediaId,
				derivation: cmd.asset.derivation ?? null,
				importedAt: cmd.asset.importedAt ?? h.ctx.now(),
			} as MediaAsset;
		}
		const asset = doc.media[mediaId]!;
		const itemId = h.ids.next('itm');
		doc.items[itemId] = {
			id: itemId,
			kind: 'media',
			name: cmd.name ?? cmd.asset.originalName,
			mediaId,
			label: cmd.label ?? defaultLabelForMedia(asset as MediaAsset),
			marks: { in: null, out: null },
		};
		insertItem(doc, itemId, cmd.binId);
		h.defineRef(cmd.ref, mediaId);
		h.defineRef(cmd.itemRef, itemId);
		return { mediaId, itemId, deduped };
	},
	'media.relink': (doc, cmd, h: HandlerContext) => {
		const asset = doc.media[cmd.mediaId];
		if (!asset) h.fail('E_NOT_FOUND', `Media not found: ${cmd.mediaId}`);
		if (cmd.mgBundle && asset.kind !== 'mg-bundle')
			h.fail(
				'E_INVALID_PARAM',
				`mgBundle only applies to mg-bundle assets (${cmd.mediaId} is ${asset.kind})`,
			);
		if (cmd.lut && asset.kind !== 'lut')
			h.fail('E_INVALID_PARAM', `lut only applies to lut assets (${cmd.mediaId} is ${asset.kind})`);
		const fingerprintChanges = !!cmd.fingerprint && cmd.fingerprint !== asset.fingerprint;
		// A rebuilt Remotion bundle is new content by definition (S08:MGC-013), and Replace Footage (S07:PRC-018)
		// says so explicitly: no force needed.
		// An offline placeholder of an imported timeline has no content to compare: linking it to its
		// file is the first time the fingerprint is known (the Link Media dialog compares name, size and duration).
		const placeholder = asset.fingerprint.startsWith('pending:interchange:');
		if (
			fingerprintChanges &&
			!cmd.force &&
			!cmd.replace &&
			!placeholder &&
			!(asset.kind === 'mg-bundle' && cmd.mgBundle)
		)
			h.fail('E_INVALID_PARAM', 'Fingerprint does not match the media (pass force to relink anyway)');
		const sr = cmd.sourceRange;
		if (sr?.mediaId && sr.mediaId !== asset.id && !doc.media[sr.mediaId])
			h.fail('E_NOT_FOUND', `Source media not found: ${sr.mediaId}`);
		const keep = !!cmd.keepSourceTiming;
		if (keep && asset.kind !== 'video' && asset.kind !== 'audio')
			h.fail(
				'E_INVALID_PARAM',
				`Source timing applies to video and audio media (${asset.id} is ${asset.kind})`,
			);
		// Keep source timing (S07:PRC-018): how far the new file's content time is from the current one's.
		let shift = 0;
		let timing: Extract<ReturnType<typeof sourceTimingShift>, { ok: true }> | null = null;
		if (keep) {
			const t = sourceTimingShift(asset as MediaAsset, {
				originalName: cmd.originalName ?? asset.originalName,
				probe: (cmd.probe ?? asset.probe) as MediaAsset['probe'],
				sourceRange: (sr === undefined ? asset.sourceRange : sr) as MediaAsset['sourceRange'],
			});
			if (!t.ok) h.fail('E_INVALID_PARAM', `Cannot keep the source timing: ${t.reason}`);
			if (t.warning) h.warn('W_SOURCE_NAME_MISMATCH', t.warning);
			timing = t;
			shift = frameShiftFlicks(t.shiftFrames, t.frameRate);
		}
		const update = () => {
			if (fingerprintChanges) asset.fingerprint = cmd.fingerprint!;
			asset.locators = cmd.locators
				? (cmd.locators as typeof asset.locators)
				: [cmd.locator, ...asset.locators.filter((l) => l.type !== cmd.locator.type)];
			if (cmd.locators && !cmd.locators.some((l) => l.type === cmd.locator.type))
				asset.locators.unshift(cmd.locator);
			if (cmd.probe) asset.probe = cmd.probe;
			if (cmd.mgBundle) asset.mgBundle = cmd.mgBundle;
			if (cmd.lut) asset.lut = cmd.lut;
			if (cmd.sizeBytes !== undefined) asset.sizeBytes = cmd.sizeBytes;
			if (cmd.originalName !== undefined) asset.originalName = cmd.originalName;
			if (cmd.container !== undefined) asset.container = cmd.container;
			if (sr === null) delete asset.sourceRange;
			else if (sr !== undefined) asset.sourceRange = sr;
		};
		if (!keep && !cmd.replace) {
			update();
			return { mediaId: asset.id };
		}
		const r = replaceMediaFile(
			doc,
			asset.id,
			shift,
			(cmd.fit ?? 'refuse') as SourceFit,
			h,
			update,
			timing ? { shiftFrames: timing.shiftFrames, rate: timing.frameRate } : undefined,
		);
		return {
			mediaId: asset.id,
			shiftFrames: timing?.shiftFrames ?? 0,
			...(timing ? { basis: timing.basis } : {}),
			clipIds: r.clipIds,
			trimmedClipIds: r.trimmed,
		};
	},
} satisfies HandlerMap;
