// Spec 13 AS-010 / AS-011 / AS-013: the cut events subtitles align to, from the cut map (SH-001) below the
// subtitles' track. When the subtitles' sequence is itself nested in other sequences, the cuts of each parent under
// its nest clips are mapped into this sequence too (warned: they only fit the parents' current edit).
import type { ProjectDocument } from '../../schema/document.ts';
import type { Clip, Sequence } from '../../schema/sequence.ts';
import { analyzePictureCuts, CutMapError } from '../../structure/cuts.ts';
import { flicksPerFrame } from '../../time.ts';
import type { CutEvent } from './layout.ts';
import type { CutAwareOptions } from './rules.ts';

export type SubtitleCuts = { events: CutEvent[]; warnings: string[]; trackIds: string[] };

const nestClipsOf = (doc: ProjectDocument, seqId: string): Array<{ parent: Sequence; clip: Clip }> => {
	const out: Array<{ parent: Sequence; clip: Clip }> = [];
	for (const parent of Object.values(doc.sequences)) {
		if (parent.id === seqId) continue;
		for (const c of Object.values(parent.clips))
			if (c.kind === 'nest-video' && (c as { sequenceId?: string }).sequenceId === seqId && c.enabled)
				out.push({ parent, clip: c });
	}
	return out;
};

/**
 * Cut events of `seq` for subtitles on `outputTrackId` (null = above every video track), with the parents' cuts
 * mapped in when the sequence is nested. Throws `CutMapError` for invalid options (a track that does not exist).
 */
export function subtitleCutEvents(
	doc: ProjectDocument,
	seq: Sequence,
	outputTrackId: string | null,
	opts: CutAwareOptions,
): SubtitleCuts {
	const warnings: string[] = [];
	const r = analyzePictureCuts(doc, seq.id, {
		...(outputTrackId ? { outputTrackId } : {}),
		...(opts.trackIds ? { trackIds: opts.trackIds } : {}),
		overlayCoverage: opts.overlayCoverage,
		includeJumpCuts: opts.includeJumpCuts,
		includeOverlays: opts.includeOverlays,
	});
	for (const w of r.warnings) warnings.push(`Cut map: ${w.message}`);
	const events: CutEvent[] = r.cuts.map((c) => ({
		frame: c.frame,
		...(c.zone ? { zone: { ...c.zone } } : {}),
	}));
	// AS-013 "output in a nest": the parents' cuts over this sequence
	const nests = nestClipsOf(doc, seq.id);
	if (nests.length) {
		const Fc = flicksPerFrame(seq.settings.frameRate);
		let mapped = 0;
		for (const { parent, clip } of nests) {
			if (
				clip.speed.reverse ||
				(clip as { timeRemap?: unknown }).timeRemap ||
				(clip as { frameHold?: unknown }).frameHold
			) {
				warnings.push(
					`Nest clip ${clip.id} in "${parent.id}" is reversed, time-remapped or held: its cuts were not mapped`,
				);
				continue;
			}
			let pc: ReturnType<typeof analyzePictureCuts>;
			try {
				pc = analyzePictureCuts(doc, parent.id, {
					range: { start: clip.start, end: clip.start + clip.duration },
					overlayCoverage: opts.overlayCoverage,
					includeJumpCuts: opts.includeJumpCuts,
					includeOverlays: opts.includeOverlays,
				});
			} catch (e) {
				if (e instanceof CutMapError) continue;
				throw e;
			}
			const Fp = flicksPerFrame(parent.settings.frameRate);
			const speed = clip.speed.rate > 0 ? clip.speed.rate : 1;
			const toNested = (pf: number) => Math.round((clip.sourceIn + (pf - clip.start) * Fp * speed) / Fc);
			for (const c of pc.cuts) {
				// cuts inside the nest clip are this sequence's own cuts (already in the map)
				if (c.outgoingClipId === clip.id && c.incomingClipId === clip.id) continue;
				events.push({
					frame: toNested(c.frame),
					...(c.zone ? { zone: { start: toNested(c.zone.start), end: toNested(c.zone.end) } } : {}),
				});
				mapped++;
			}
		}
		warnings.push(
			mapped
				? `The subtitles are in a nested sequence: ${mapped} cut(s) of the sequence(s) it is placed in were mapped in; align again after editing those sequences`
				: 'The subtitles are in a nested sequence: the sequences it is placed in were not analysed for cuts',
		);
	}
	events.sort((a, b) => a.frame - b.frame);
	const unique: CutEvent[] = [];
	for (const e of events) {
		const last = unique[unique.length - 1];
		if (last && last.frame === e.frame) {
			if (!last.zone && e.zone) last.zone = e.zone;
			continue;
		}
		if (e.frame > 0) unique.push(e);
	}
	return { events: unique, warnings, trackIds: r.trackIds };
}
