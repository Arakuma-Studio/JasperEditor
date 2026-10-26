// SFX of the editing-automation passes through the sound-design cue / placement system (spec 15 EA-020/EA-021, spec 12
// §2.2–§2.3; no parallel SFX placer): the library sounds of the pass's asset role (a taxonomy type, `whoosh` by default)
// are ranked with `rankSounds` for the decoration's window, rotated with `pickVariant` (no varispeed, ±1 dB), and each
// decoration gets a cue (`soundCue.add`, anchored to the edit when the cut is between two clips of one track) filled by
// `soundDesign.place` — the sound's peak on the cut. A kit's whoosh is then trimmed to the kit (`clip.trim`), so it is
// exactly as long as the kit and centred on the cut (the user's whooshes: same length, 100 % paired). The span is
// computed with the placement's own function (`planSoundInsert`), so the trims are exact. Pure.
import { mediaDurationFlicks } from '../interpret/model.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { planSoundInsert, resolveSoundAlign, soundTimingOf } from '../sound/insert.ts';
import { type LibraryProvenance, readLibraryProvenance } from '../sound/provenance.ts';
import { type RankableSound, rankSounds } from '../sound/rank.ts';
import type { VisualKind } from '../sound/taxonomy.ts';
import { pickVariant } from '../sound/variant.ts';
import type { Rational } from '../time.ts';
import { AUTOMATION_DEFAULTS, type AutomationSfx } from './params.ts';

export type ResolvedSfx = {
	enabled: boolean;
	type: string;
	sources?: string[];
	packId?: string;
	rootId?: string;
	gainDb?: number;
	variety: number;
};

export function resolveSfx(raw: AutomationSfx | undefined, defaultOn: boolean): ResolvedSfx {
	return {
		enabled: raw?.enabled ?? defaultOn,
		type: raw?.type ?? AUTOMATION_DEFAULTS.sfxType,
		variety: raw?.variety ?? AUTOMATION_DEFAULTS.sfxVariety,
		...(raw?.sources ? { sources: raw.sources } : {}),
		...(raw?.packId ? { packId: raw.packId } : {}),
		...(raw?.rootId ? { rootId: raw.rootId } : {}),
		...(raw?.gainDb !== undefined ? { gainDb: raw.gainDb } : {}),
	};
}

/** A library entry as the pass needs it (the engine's `SoundEntry` conforms). */
export type SfxEntry = RankableSound & {
	source: { type: string; packId?: string; rootId?: string };
};

/** The pool of a pass: entries of the role's type from the allowed source / pack / folder. */
export function sfxPool<T extends SfxEntry>(entries: readonly T[], sfx: ResolvedSfx): T[] {
	return entries.filter(
		(e) =>
			(!sfx.sources || sfx.sources.includes(e.source.type)) &&
			(!sfx.packId || e.source.packId === sfx.packId) &&
			(!sfx.rootId || e.source.rootId === sfx.rootId),
	);
}

/** Ranked sound ids for decorations with a window of `windowSec` (best first; `variety` long). */
export function rankSfx<T extends SfxEntry>(
	pool: readonly T[],
	sfx: ResolvedSfx,
	opts: { windowSec: number; visualKind: VisualKind },
): { ids: string[]; synth: string[] } {
	const ranked = rankSounds(pool, {
		types: [sfx.type],
		visualKind: opts.visualKind,
		...(opts.windowSec > 0 ? { windowSec: opts.windowSec } : {}),
		align: 'peak',
	});
	const ids = ranked.slice(0, Math.max(sfx.variety, 1) * 2).map((r) => r.entry.id);
	const synth = ranked.filter((r) => r.entry.source.type === 'synth').map((r) => r.entry.id);
	return { ids, synth };
}

/**
 * The sound of each decoration (in time order): a rotation over the top `variety` sounds where neighbours differ,
 * with the seeded ±1 dB of sound design's `takes` variation (no varispeed: the kit length stays exact).
 */
export function assignSfx(
	items: readonly { id: string; seed: number }[],
	ranked: { ids: string[]; synth: string[] },
	opts: { sequenceId: string; variety: number },
): Map<string, { soundId: string; gainOffsetDb: number }> {
	const out = new Map<string, { soundId: string; gainOffsetDb: number }>();
	const recent: string[] = [];
	for (const it of items) {
		const pick = pickVariant(ranked.ids, {
			seed: it.seed,
			cueId: it.id,
			sequenceId: opts.sequenceId,
			recentSoundIds: recent,
			topN: Math.min(16, Math.max(1, opts.variety)),
			fallbackIds: ranked.synth,
			variation: 'takes',
		});
		if (!pick) continue;
		out.set(it.id, { soundId: pick.soundId, gainOffsetDb: pick.gainDb });
		recent.unshift(pick.soundId);
		if (recent.length > 32) recent.pop();
	}
	return out;
}

/** What placement reads of a media: its library provenance and its length. */
export type SfxMediaInfo = { library: LibraryProvenance | null; durationFlicks: number | null };

/** The info of a project media, or of the asset a `media.register` command will create. */
export function sfxMediaInfo(asset: unknown): SfxMediaInfo {
	const a = asset as { library?: unknown; probe?: unknown } | null;
	if (!a || typeof a !== 'object') return { library: null, durationFlicks: null };
	let dur: number | null = null;
	try {
		dur = mediaDurationFlicks(a as never);
	} catch {
		dur = null;
	}
	return { library: readLibraryProvenance(a.library), durationFlicks: dur };
}

/** Where `soundDesign.place` will put the sound with its `align` point on `cueFrame` (start, frames), or null. */
export function placedSpan(
	info: SfxMediaInfo,
	cueFrame: number,
	fps: Rational,
	align: 'peak' | 'start',
): { start: number; frames: number } | null {
	const dur = info.durationFlicks;
	if (!dur || !(dur > 0)) return null;
	const timing = soundTimingOf(info.library, {
		peakSec: Number.NaN,
		onsetSec: 0,
		headQuietSec: 0,
		durationSec: dur / 705_600_000,
	});
	if (!Number.isFinite(timing.peakSec) && align === 'peak') return null;
	const a = resolveSoundAlign(info.library?.types ?? [], align);
	const plan = planSoundInsert({
		cueFrame,
		fps,
		align: a,
		timing: Number.isFinite(timing.peakSec) ? timing : { ...timing, peakSec: 0 },
		mediaDurationFlicks: dur,
		rate: 1,
		clampStart: true,
	});
	return plan.ok ? { start: plan.placement.start, frames: plan.placement.frames } : null;
}

/** The anchor of a cue on an edit between two abutting clips of one track (else none: the cue keeps its frame). */
export function editAnchor(
	seq: Sequence,
	cut: { trackId: string; outgoingClipId?: string; incomingClipId?: string; frame: number },
): Record<string, unknown> | null {
	const a = cut.outgoingClipId ? seq.clips[cut.outgoingClipId] : undefined;
	const b = cut.incomingClipId ? seq.clips[cut.incomingClipId] : undefined;
	if (!a || !b || a.trackId !== b.trackId || a.start + a.duration !== cut.frame || b.start !== cut.frame)
		return null;
	return { type: 'edit', trackId: a.trackId, outgoingClipId: a.id, incomingClipId: b.id };
}

/**
 * The commands of one decoration's sound: the cue, its placement and (with `trim`) the trims to [trim.start, trim.end)
 * of the clip placement makes (`expected` = its span). `mediaId` may be a `$ref` of the sound's setup item.
 */
export function sfxCommands(o: {
	sequenceId: string;
	cueFrame: number;
	cueRef: string;
	clipRef: string;
	mediaId: string;
	kind: 'cut' | 'move' | 'emphasis';
	type: string;
	align: 'peak' | 'start';
	window: { start: number; end: number };
	reason: string;
	label: string;
	anchor: Record<string, unknown> | null;
	gainDb?: number;
	gainOffsetDb?: number;
	expected: { start: number; frames: number } | null;
	trim?: { start: number; end: number };
}): Record<string, unknown>[] {
	const cmds: Record<string, unknown>[] = [
		{
			type: 'soundCue.add',
			sequenceId: o.sequenceId,
			cues: [
				{
					frame: o.cueFrame,
					label: o.label.slice(0, 120),
					kind: o.kind,
					weight: 'support',
					types: [o.type],
					align: o.align,
					window: o.window,
					source: 'agent',
					reason: o.reason.slice(0, 200),
					...(o.anchor ? { anchor: o.anchor } : {}),
					ref: o.cueRef,
				},
			],
		},
		{
			type: 'soundDesign.place',
			sequenceId: o.sequenceId,
			cueId: o.cueRef,
			layers: [
				{
					mediaId: o.mediaId,
					align: o.align,
					...(o.gainDb !== undefined
						? { gainDb: o.gainDb }
						: o.gainOffsetDb
							? { gainOffsetDb: o.gainOffsetDb }
							: {}),
					ref: o.clipRef,
				},
			],
			clampStart: true,
		},
	];
	if (o.trim && o.expected) {
		const head = o.trim.start - o.expected.start;
		const tail = o.expected.start + o.expected.frames - o.trim.end;
		if (head > 0 && head < o.expected.frames)
			cmds.push({ type: 'clip.trim', clipId: o.clipRef, edge: 'in', deltaFrames: head, linked: false });
		if (tail > 0 && tail < o.expected.frames - Math.max(0, head))
			cmds.push({ type: 'clip.trim', clipId: o.clipRef, edge: 'out', deltaFrames: -tail, linked: false });
	}
	return cmds;
}

/** The project media of a sound when the document has it already (same library id), else null. */
export function projectMediaOfSound(doc: ProjectDocument, soundId: string): string | null {
	for (const m of Object.values(doc.media ?? {})) {
		const p = readLibraryProvenance((m as { library?: unknown }).library);
		if (p?.soundId === soundId && !m.derivation) return m.id;
	}
	return null;
}
