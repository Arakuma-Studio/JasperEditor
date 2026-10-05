// Transition bins of the Effects panel (S10:TUI-020) and "apply to the selected clips" (double-click,
// context menu): generated from TRANSITION_SPECS, one transaction per invocation.
import { TRANSITION_SPECS, type TransitionSpec, transitionSpec } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { transitionDefaults } from './transition-prefs.ts';

/** Effects-panel folder of a transition: its spec's `bin` (Premiere bins, "Sapphire Transitions", "Crossfade"). */
const binOf = (s: TransitionSpec) => s.bin || 'Other';
/** Third-party packs (Sapphire) are listed after Premiere's own bins, as Premiere lists plug-in folders. */
const binRank = (bin: string) => (bin.startsWith('Sapphire') ? 1 : 0);
/** Sub-folders sorted by name, "Other" last. */
const groupOrder = (a: string, b: string) =>
	Number(a === 'Other') - Number(b === 'Other') || a.localeCompare(b);

type TransitionBin = {
	medium: 'Video Transitions' | 'Audio Transitions';
	appliesTo: 'video' | 'audio';
	/**
	 * Folders (`spec.bin`); `transitions` are the folder's direct items, `groups` its sub-folders (`spec.subBin`,
	 * e.g. Sapphire Transitions > Dissolves).
	 */
	categories: {
		category: string;
		transitions: TransitionSpec[];
		groups: { group: string; transitions: TransitionSpec[] }[];
	}[];
};

const byLabel = (x: TransitionSpec, y: TransitionSpec) => x.label.localeCompare(y.label);

/** "Video Transitions ▸ Iris ▸ Iris Round", "… ▸ Sapphire Transitions ▸ Dissolves ▸ S_DissolveLuma", filtered. */
export function transitionTree(
	query: string,
	specs: readonly TransitionSpec[] = TRANSITION_SPECS,
): TransitionBin[] {
	const q = query.trim().toLowerCase();
	const out: TransitionBin[] = [];
	for (const appliesTo of ['video', 'audio'] as const) {
		const cats = new Map<string, TransitionSpec[]>();
		for (const s of specs) {
			if (s.appliesTo !== appliesTo) continue;
			const category = binOf(s);
			const hay = [
				s.label,
				s.id,
				category,
				s.subBin ?? '',
				'transition',
				s.description,
				...(s.keywords ?? []),
			]
				.join(' ')
				.toLowerCase();
			if (q && !hay.includes(q)) continue;
			cats.set(category, [...(cats.get(category) ?? []), s]);
		}
		if (!cats.size) continue;
		out.push({
			medium: appliesTo === 'video' ? 'Video Transitions' : 'Audio Transitions',
			appliesTo,
			categories: [...cats.entries()]
				.sort(([a], [b]) => binRank(a) - binRank(b) || a.localeCompare(b))
				.map(([category, list]) => {
					const groups = new Map<string, TransitionSpec[]>();
					for (const s of list) if (s.subBin) groups.set(s.subBin, [...(groups.get(s.subBin) ?? []), s]);
					return {
						category,
						transitions: list.filter((s) => !s.subBin).sort(byLabel),
						groups: [...groups.entries()]
							.sort(([a], [b]) => groupOrder(a, b))
							.map(([group, g]) => ({ group, transitions: g.sort(byLabel) })),
					};
				}),
		});
	}
	return out;
}

/**
 * Applies a transition at both edges of the selected clips of its medium (two-sided where clips meet, with
 * the user's default alignment; the project's default length of that medium), as one history entry. Null when no selected clip is of that medium.
 */
export function applyTransitionToClips(
	session: EditorSession,
	effectId: string,
	clipIds: readonly string[],
): { ok: true; count: number } | { ok: false; message: string } | null {
	const spec = transitionSpec(effectId);
	if (!spec) return null;
	const seqId = session.getState().activeSequenceId;
	const seq = seqId ? session.getCommitted().sequences[seqId] : undefined;
	if (!seq) return null;
	const tracks = new Set((spec.appliesTo === 'video' ? seq.videoTracks : seq.audioTracks).map((t) => t.id));
	const ids = clipIds.filter((id) => seq.clips[id] && tracks.has(seq.clips[id]!.trackId));
	if (!ids.length) return null;
	const r = session.apply({
		label: `Apply ${spec.label}`,
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'transition.applyDefault',
				clipIds: ids,
				edges: 'both',
				media: [spec.appliesTo],
				...(spec.appliesTo === 'video' ? { videoEffectId: spec.id } : { audioEffectId: spec.id }),
				// M3 (TUI-033): the user's default alignment, as Ctrl+D.
				alignment: transitionDefaults().getState().alignment,
			},
		] as never[],
	});
	if (!r.ok) return { ok: false, message: r.errors[0]?.message ?? `Could not apply ${spec.label}.` };
	return { ok: true, count: (r.results[0] as { transitionIds: string[] }).transitionIds.length };
}
