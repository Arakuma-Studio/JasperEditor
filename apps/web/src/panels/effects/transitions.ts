// Transition bins of the Effects panel (S10:TUI-020) and "apply to the selected clips" (double-click,
// context menu): generated from TRANSITION_SPECS, one transaction per invocation.
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	DIP_TO_BLACK,
	TRANSITION_SPECS,
	type TransitionSpec,
	transitionSpec,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';

/** Sub-folder of each built-in transition (unknown future ids land in "Other"). */
const CATEGORY: Record<string, string> = {
	[CROSS_DISSOLVE]: 'Dissolve',
	[DIP_TO_BLACK]: 'Dissolve',
	[CONSTANT_GAIN]: 'Crossfade',
	[CONSTANT_POWER]: 'Crossfade',
};

export type TransitionBin = {
	medium: 'Video Transitions' | 'Audio Transitions';
	appliesTo: 'video' | 'audio';
	categories: { category: string; transitions: TransitionSpec[] }[];
};

/** "Video Transitions ▸ Dissolve", "Audio Transitions ▸ Crossfade", filtered by the search query. */
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
			const category = CATEGORY[s.id] ?? 'Other';
			const hay = [s.label, s.id, category, 'transition', s.description].join(' ').toLowerCase();
			if (q && !hay.includes(q)) continue;
			cats.set(category, [...(cats.get(category) ?? []), s]);
		}
		if (!cats.size) continue;
		out.push({
			medium: appliesTo === 'video' ? 'Video Transitions' : 'Audio Transitions',
			appliesTo,
			categories: [...cats.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([category, transitions]) => ({
					category,
					transitions: [...transitions].sort((x, y) => x.label.localeCompare(y.label)),
				})),
		});
	}
	return out;
}

/**
 * Applies a transition at both edges of the selected clips of its medium (two-sided where clips meet),
 * as one history entry. Null when no selected clip is of that medium.
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
			},
		] as never[],
	});
	if (!r.ok) return { ok: false, message: r.errors[0]?.message ?? `Could not apply ${spec.label}.` };
	return { ok: true, count: (r.results[0] as { transitionIds: string[] }).transitionIds.length };
}
