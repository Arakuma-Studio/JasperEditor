// Swapping the sound of placed clips (spec 12 §2.7: Swap Sound… / Replace mode, Essential Sound ▸ Swap…, Next /
// Previous Variation). A swap is `soundDesign.swap {clipId, mediaId}`: the new sound's aligned point lands where the
// old one played, keeping the clip's track, role, pan, gain (the user's offset), effects, group, link and cue link.
//
// Variation cycling walks a per-clip list — the clip's alternatives (stored by Fill / agents), then sounds of the same
// family, then the nearest descriptors (engine `similarTo`) — with the original sound at index 0. Repeated presses on
// the same clips coalesce into ONE history entry "Swap Sound ×4" (the session's coalescing with no time window and a
// changing label); the run closes on any other edit (the document revision moves), another selection or another
// sequence. Presses that arrive while a step is running are added up and applied as one step. With "Audition on swap"
// (default on) the 2 s around the swapped sound play in context afterwards.
import type { EngineClient } from '@jasper/engine-client';
import type { Clip, Command, Sequence } from '@jasper/project';
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

/** Clips a swap or variation step can act on: audio clips that carry `sfx` or play a library sound. */
export function swappableClips(session: EditorSession, seq: Sequence, ids: readonly string[]): Clip[] {
	const doc = session.getCommitted();
	return ids
		.map((id) => seq.clips[id])
		.filter((c): c is Clip => !!c && c.kind === 'audio' && (!!sfxOf(c) || !!clipProvenance(doc, c)));
}

/**
 * Swaps clips to library sounds in ONE transaction (registering them first). `coalesce` merges the step into the
 * entry before it (variation cycling).
 */
export async function swapSounds(
	session: EditorSession,
	engine: Pick<EngineClient, 'registerSound'>,
	sequenceId: string,
	swaps: readonly { clipId: string; entry: LibraryEntryLike }[],
	opts: { label: string; coalesceKey?: string } ,
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
	if (!r.ok) throw new SwapError(r.errors.map((e) => e.message).join('; ') || t('The sound could not be swapped'));
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
	lists: Map<string, { ids: string[]; index: number }>;
	steps: number;
	/** Session revision after our last step: anything else moves it and closes the run. */
	revision: number;
	nonce: number;
};

let run: Run | null = null;
let nonce = 0;
let busy: Promise<void> | null = null;
let pendingSteps = 0;

/** Forgets the run (tests; the next press starts a new history entry). */
export function resetVariationRun(): void {
	run = null;
	pendingSteps = 0;
}

/** The variation list of a clip (engine searches for the family and similar sounds). */
export async function variationCandidates(
	session: EditorSession,
	engine: Pick<EngineClient, 'searchSounds' | 'getSound'>,
	seq: Sequence,
	clip: Clip,
): Promise<string[]> {
	const doc = session.getCommitted();
	const current = clipSoundId(doc, clip);
	const alternatives = alternativesOf(seq, clip);
	const types = clipProvenance(doc, clip)?.types ?? [];
	const fam = familyRequest(types, 12);
	const [family, similar] = await Promise.all([
		fam ? engine.searchSounds(fam).then((r) => r.results.map((x) => x.sound.id)).catch(() => []) : [],
		current
			? engine
					.searchSounds({ similarTo: current, limit: 12 })
					.then((r) => r.results.map((x) => x.sound.id))
					.catch(() => [])
			: [],
	]);
	return variationList(current, alternatives, family, similar);
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
		const lists = new Map<string, { ids: string[]; index: number }>();
		for (const c of clips) {
			const list = await variationCandidates(session, engine, seq, c);
			lists.set(c.id, { ids: list, index: 0 });
		}
		run = { key, sequenceId: seq.id, clipIds: ids, lists, steps: 0, revision: -1, nonce: ++nonce };
	}
	const current = run;
	const swaps: { clipId: string; entry: LibraryEntryLike }[] = [];
	for (const id of current.clipIds) {
		const l = current.lists.get(id);
		if (!l || l.ids.length < 2) continue;
		const n = l.ids.length;
		const next = (((l.index + steps) % n) + n) % n;
		l.index = next;
		swaps.push({ clipId: id, entry: { id: l.ids[next]! } });
	}
	if (!swaps.length) return { ok: false, message: t('No other variation of this sound in the library') };
	current.steps += Math.abs(steps);
	const label = current.steps > 1 ? t('Swap Sound ×{0}', current.steps) : t('Swap Sound');
	await swapSounds(session, engine, current.sequenceId, swaps, {
		label,
		coalesceKey: `variation:${current.nonce}`,
	});
	current.revision = session.revision;
	auditionAfterSwap(session, current.sequenceId, swaps[0]!.clipId);
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
