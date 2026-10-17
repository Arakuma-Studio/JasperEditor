// Swapping the sound of placed clips (spec 12 §2.7: Swap Sound… / Replace mode, Essential Sound ▸ Swap…, Next /
// Previous Variation). A swap is `soundDesign.swap {clipId, mediaId}`: the new sound's aligned point lands where the
// old one played, keeping the clip's track, role, pan, gain (the user's offset), effects, group, link and cue link.
//
// Variation cycling walks a per-clip list anchored on the clip's ring (`sfx.alternatives`, the original sound first,
// stored by Fill / agents, or by the first variation step of a clip without one): the ring, then sounds of the
// original's family, then its nearest descriptors (engine `similarTo`). The list is the same in every run, and a run
// starts from the sound the clip plays, so presses after another edit continue the cycle and come back to the original. Repeated presses on
// the same clips coalesce into ONE history entry "Swap Sound ×4" (the session's coalescing with no time window and a
// changing label); the run closes on any other edit or undo (the document revision moves), a selection of other clips
// or another sequence (deselecting and selecting the same clips again — Esc, a click on the clip — continues it). A step that fails leaves the run where it was. Presses that arrive while a step is running are
// added up and applied as one step. With "Audition on swap" (default on) the 2 s around the swapped sound play in
// context afterwards.
import type { EngineClient } from '@jasper/engine-client';
import { type Clip, type Command, type Sequence, SOUND_DESIGN_LIMITS, SOUND_REF_RE } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import {
	alignedFrameOf,
	alternativesOf,
	clipProvenance,
	clipSoundId,
	clipSoundTitle,
	familyRequest,
	sfxOf,
	variationList,
} from './design-model.ts';
import { playTimelineWindow } from './in-context.ts';
import { type LibraryEntryLike, registerLibrarySounds, soundMediaCommands } from './library-media.ts';
import { soundLibraryPrefs } from './prefs.ts';

export class SwapError extends Error {}

/**
 * Clips a variation step can act on: audio clips that play a library sound or carry alternatives to cycle through.
 * Project audio with a detected peak carries `sfx` too, but has no variation (no library sound, no alternatives).
 */
export function swappableClips(session: EditorSession, seq: Sequence, ids: readonly string[]): Clip[] {
	const doc = session.getCommitted();
	return ids
		.map((id) => seq.clips[id])
		.filter(
			(c): c is Clip =>
				!!c &&
				c.kind === 'audio' &&
				(!!clipSoundId(doc, c) || !!clipProvenance(doc, c) || alternativesOf(seq, c).length > 0),
		);
}

/**
 * Swaps clips to library sounds in ONE transaction (registering them first). `coalesce` merges the step into the
 * entry before it (variation cycling).
 */
export async function swapSounds(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	sequenceId: string,
	swaps: readonly { clipId: string; entry: LibraryEntryLike; ring?: readonly string[] }[],
	opts: { label: string; coalesceKey?: string },
): Promise<{ clipIds: string[] }> {
	const s0 = session.getState();
	if (s0.readOnly) throw new SwapError(t('The project is read-only'));
	let sounds: Awaited<ReturnType<typeof registerLibrarySounds>>;
	try {
		sounds = await registerLibrarySounds(
			engine,
			s0.document.projectId,
			swaps.map((s) => s.entry),
		);
	} catch (e) {
		throw new SwapError(e instanceof Error ? e.message : String(e));
	}
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new SwapError(t('The sequence was closed'));
	const prepared = soundMediaCommands(session, doc, sounds);
	const commands: Command[] = [
		...prepared.commands,
		...swaps
			.filter((s) => seq.clips[s.clipId])
			.map(
				(s) =>
					({
						type: 'soundDesign.swap',
						clipId: s.clipId,
						mediaId: prepared.media.get(s.entry.id)!.ref,
						// the clip's variation ring (original first), stored in the same step
						...(s.ring?.length ? { alternatives: [...s.ring] } : {}),
					}) as Command,
			),
	];
	if (commands.length === prepared.commands.length) throw new SwapError(t('The clip is gone'));
	const r = session.apply({
		label: opts.label,
		origin: 'user',
		sequenceId,
		commands,
		...(opts.coalesceKey
			? { coalesceKey: opts.coalesceKey, coalesceWindowMs: Number.POSITIVE_INFINITY, coalesceRelabel: true }
			: {}),
	});
	if (!r.ok)
		throw new SwapError(r.errors.map((e) => e.message).join('; ') || t('The sound could not be swapped'));
	return { clipIds: swaps.map((s) => s.clipId) };
}

/** Plays the 2 s around the first swapped clip in context, when "Audition on swap" is on. */
export function auditionAfterSwap(session: EditorSession, sequenceId: string, clipId: string): void {
	if (!soundLibraryPrefs.get().auditionOnSwap) return;
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const clip = seq?.clips[clipId];
	if (!seq || !clip) return;
	const at = alignedFrameOf(doc, seq, clip) ?? clip.start;
	playTimelineWindow(session, seq, {
		center: at,
		returnTo: session.transport.getState().frame,
		title: clipSoundTitle(doc, clip),
	});
}

/** One swap from the Sound Library (Replace mode, Essential Swap…): label "Swap Sound <title>". */
export async function swapClipSound(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	sequenceId: string,
	clipId: string,
	entry: LibraryEntryLike,
): Promise<string> {
	await swapSounds(session, engine, sequenceId, [{ clipId, entry }], {
		label: t('Swap Sound {0}', entry.title ?? entry.id),
	});
	session.select('timeline', [clipId], 'replace', { primary: clipId, linked: false });
	auditionAfterSwap(session, sequenceId, clipId);
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	const clip = seq?.clips[clipId];
	return clip ? t('Swapped to {0}', clipSoundTitle(doc, clip)) : t('Swapped');
}

// ---------------------------------------------------------------------------------------------------------------
// Variation cycling

type Run = {
	key: string;
	sequenceId: string;
	clipIds: string[];
	/** Per clip: its list, where the cycle is, and the ring its first step stores (clips without one). */
	lists: Map<string, { ids: string[]; index: number; ring?: string[] }>;
	steps: number;
	/** Session revision after our last step: anything else moves it and closes the run. */
	revision: number;
	nonce: number;
	/** Stops watching the selection (selecting other clips after a step closes the run). */
	unwatch: () => void;
};

let run: Run | null = null;
let nonce = 0;
let busy: Promise<void> | null = null;
let pendingSteps = 0;

function closeRun(): void {
	run?.unwatch();
	run = null;
}

/** Forgets the run (tests; the next press starts a new history entry). */
export function resetVariationRun(): void {
	closeRun();
	pendingSteps = 0;
}

/** A library sound id or a take id (P6-E9). */
const SOUND_ID = SOUND_REF_RE;

/**
 * The variation ring a clip carries (`sfx.alternatives`, the original sound first), or, for a clip without one, the
 * ring its first variation step stores: [the sound it plays now, then its cue's other layers' alternatives]. The cycle
 * is anchored on the ring's first sound, so it is the same list in every run and comes back to the original (it would
 * otherwise be rebuilt around each new sound and drift).
 */
export function variationRing(
	doc: Parameters<typeof clipSoundId>[0],
	seq: Sequence,
	clip: Clip,
): { ring: string[]; store: boolean } {
	const own = (sfxOf(clip)?.alternatives ?? []).filter((id) => SOUND_ID.test(id));
	if (own.length) return { ring: [...new Set(own)], store: false };
	const current = clipSoundId(doc, clip);
	if (!current || !SOUND_ID.test(current)) return { ring: [], store: false };
	const ring = [...new Set([current, ...alternativesOf(seq, clip).filter((id) => SOUND_ID.test(id))])];
	return { ring: ring.slice(0, SOUND_DESIGN_LIMITS.alternatives), store: true };
}

/**
 * The variation list of a clip, anchored on its ring's first sound (the original): the ring, then the same family
 * and the nearest descriptors of the original (engine searches).
 */
export async function variationCandidates(
	session: EditorSession,
	engine: Pick<EngineClient, 'searchSounds' | 'getSound'>,
	seq: Sequence,
	clip: Clip,
): Promise<string[]> {
	const doc = session.getCommitted();
	const current = clipSoundId(doc, clip);
	const { ring } = variationRing(doc, seq, clip);
	const anchor = ring[0] ?? current;
	// the family of the original (its library entry; the clip's provenance when it is the original or is gone)
	let types = clipProvenance(doc, clip)?.types ?? [];
	if (anchor && anchor !== current)
		types = await engine
			.getSound(anchor)
			.then((e) => e.types)
			.catch(() => types);
	const fam = familyRequest(types, 12);
	const [family, similar] = await Promise.all([
		fam
			? engine
					.searchSounds(fam)
					.then((r) => r.results.map((x) => x.sound.id))
					.catch(() => [])
			: [],
		anchor
			? engine
					.searchSounds({ similarTo: anchor, limit: 12 })
					.then((r) => r.results.map((x) => x.sound.id))
					.catch(() => [])
			: [],
	]);
	return variationList(anchor, ring, family, similar);
}

export type VariationStep = { ok: true; message: string; steps: number } | { ok: false; message: string };

/**
 * Next (+1) or Previous (−1) Variation on the selected SFX clips. Coalesces with the previous press of the same run.
 */
export function cycleVariation(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound' | 'searchSounds' | 'getSound'>,
	dir: 1 | -1,
	report: (r: VariationStep) => void,
): Promise<void> {
	pendingSteps += dir;
	if (busy) return busy;
	busy = (async () => {
		try {
			while (pendingSteps !== 0) {
				const steps = pendingSteps;
				pendingSteps = 0;
				report(await step(session, engine, steps));
			}
		} catch (e) {
			report({ ok: false, message: e instanceof Error ? e.message : String(e) });
		} finally {
			busy = null;
			pendingSteps = 0;
		}
	})();
	return busy;
}

async function step(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound' | 'searchSounds' | 'getSound'>,
	steps: number,
): Promise<VariationStep> {
	const s = session.getState();
	if (s.readOnly) return { ok: false, message: t('The project is read-only') };
	const seqId = s.activeSequenceId;
	const seq = seqId ? s.document.sequences[seqId] : undefined;
	if (!seq) return { ok: false, message: t('Open a sequence first') };
	const clips = swappableClips(session, seq, s.selection.timeline.clips);
	if (!clips.length) return { ok: false, message: t('Select sound effect clips') };
	const ids = clips.map((c) => c.id).sort();
	const key = `${seq.id}|${ids.join(',')}`;
	if (!run || run.key !== key || run.revision !== session.revision) {
		closeRun();
		const lists = new Map<string, { ids: string[]; index: number; ring?: string[] }>();
		const doc0 = session.getCommitted();
		for (const c of clips) {
			const list = await variationCandidates(session, engine, seq, c);
			// the cycle goes on from the sound the clip plays (a run after another edit continues, not restarts)
			const at = list.indexOf(clipSoundId(doc0, c) ?? '');
			const ring = variationRing(doc0, seq, c);
			lists.set(c.id, { ids: list, index: Math.max(0, at), ...(ring.store ? { ring: ring.ring } : {}) });
		}
		run = {
			key,
			sequenceId: seq.id,
			clipIds: ids,
			lists,
			steps: 0,
			revision: -1,
			nonce: ++nonce,
			unwatch: () => undefined,
		};
	}
	const current = run;
	// this step's own transaction may report a selection change (the selection re-filtered): not the user's
	current.unwatch();
	current.unwatch = () => undefined;
	const swaps: { clipId: string; entry: LibraryEntryLike; ring?: string[] }[] = [];
	const nextIndex = new Map<string, number>();
	for (const id of current.clipIds) {
		const l = current.lists.get(id);
		if (!l || l.ids.length < 2) continue;
		const n = l.ids.length;
		const next = (((l.index + steps) % n) + n) % n;
		nextIndex.set(id, next);
		swaps.push({ clipId: id, entry: { id: l.ids[next]! }, ...(l.ring ? { ring: l.ring } : {}) });
	}
	if (!swaps.length) return { ok: false, message: t('No other variation of this sound in the library') };
	const total = current.steps + Math.abs(steps);
	const label = total > 1 ? t('Swap Sound ×{0}', total) : t('Swap Sound');
	// a step that fails (engine offline, a refused swap) throws here: the run keeps its position and count
	await swapSounds(session, engine, current.sequenceId, swaps, {
		label,
		coalesceKey: `variation:${current.nonce}`,
	});
	for (const [id, index] of nextIndex) {
		const l = current.lists.get(id)!;
		l.index = index;
		delete l.ring; // stored with this step
	}
	current.steps = total;
	current.revision = session.revision;
	auditionAfterSwap(session, current.sequenceId, swaps[0]!.clipId);
	// a selection of other clips closes the run (the next press is a new history entry), even if the user comes back
	// to these clips before pressing again; an empty selection (Esc) or the same clips again do not
	if (run === current) {
		const runIds = new Set(current.clipIds);
		const off = session.on('selection.changed', () => {
			if (run !== current) return;
			const sel = session.getState().selection.timeline.clips;
			if (sel.length && (sel.length !== runIds.size || sel.some((id) => !runIds.has(id)))) closeRun();
		});
		current.unwatch = () => off();
	}
	const doc = session.getCommitted();
	const first = doc.sequences[current.sequenceId]?.clips[swaps[0]!.clipId];
	const l0 = current.lists.get(swaps[0]!.clipId)!;
	return {
		ok: true,
		steps: current.steps,
		message: first
			? t('{0} ({1} of {2})', clipSoundTitle(doc, first), l0.index + 1, l0.ids.length)
			: t('Swapped'),
	};
}
