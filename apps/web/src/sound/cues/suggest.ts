// Suggest Cues… (spec 12 §2.7, §2.2 "Derivation"): what the dialog would add, computed with `deriveCues` on the
// committed document (its expressions bound, as the engine route does). Pure; the dialog shows the counts and commits `plan.commands` as ONE transaction
// "Suggest Cues (n)" (one undo step).
import { mgRegistry } from '@jasper/mg-templates';
import {
	bindExpressions,
	type Command,
	type CueDensity,
	type CueDeriveSource,
	cueInputFromDerived,
	type DeriveCuesWarning,
	type DerivedCue,
	deriveCues,
	PROJECT_CUE_SOURCES,
	type ProjectDocument,
	type Sequence,
	SOUND_DESIGN_LIMITS,
	type SoundCue,
	sequenceDuration,
} from '@jasper/project';
import { type CueInput, cuesOf, duplicatesStored, isFilled } from './model.ts';

export type ProjectCueSource = (typeof PROJECT_CUE_SOURCES)[number];
export type SuggestRange = 'sequence' | 'inout' | 'selection';

export type SuggestOptions = {
	sources: ReadonlySet<ProjectCueSource>;
	range: SuggestRange;
	density: CueDensity;
	respectDialogue: boolean;
	/** Remove the earlier unfilled suggestions (source `derived`) in the range first (default on). */
	replace: boolean;
	/** Selected clip ids (range `selection`). */
	selectedClips?: readonly string[];
	/** Derive from the document with its expressions bound, as the engine route does (default true). */
	expressions?: boolean;
};

export type SuggestPlan = {
	/** Frames `[start, end)` searched, or null when the chosen range is empty / unavailable. */
	range: { start: number; end: number } | null;
	found: Record<ProjectCueSource, number>;
	kept: Record<ProjectCueSource, number>;
	/** Cues the transaction adds (after the duplicates of cues that stay were dropped). */
	adds: CueInput[];
	/** Earlier unfilled suggestions it removes (`replace`). */
	removes: string[];
	/** Derived cues left out because a cue of the same kind is already within 2 frames. */
	duplicates: number;
	byWeight: { hero: number; support: number; ambient: number };
	warnings: DeriveCuesWarning[];
	commands: Command[];
};

/** The frames a range choice covers, or null (no In/Out, no selected clips). */
export function suggestRange(
	seq: Sequence,
	range: SuggestRange,
	selectedClips: readonly string[] = [],
): { start: number; end: number } | null {
	const end = Math.max(1, sequenceDuration(seq));
	if (range === 'sequence') return { start: 0, end };
	if (range === 'inout') {
		if (seq.inPoint === null && seq.outPoint === null) return null;
		const s = Math.max(0, seq.inPoint ?? 0);
		const e = Math.min(end, seq.outPoint ?? end);
		return e > s ? { start: s, end: e } : null;
	}
	const clips = selectedClips.map((id) => seq.clips[id]).filter((c) => !!c);
	if (!clips.length) return null;
	const s = Math.min(...clips.map((c) => c.start));
	const e = Math.max(...clips.map((c) => c.start + c.duration));
	return e > s ? { start: s, end: e } : null;
}

const zero = (): Record<ProjectCueSource, number> =>
	Object.fromEntries(PROJECT_CUE_SOURCES.map((s) => [s, 0])) as Record<ProjectCueSource, number>;

/** The plan of a Suggest Cues run (never throws: `deriveCues` reports problems as warnings). */
export function planSuggestion(doc: ProjectDocument, sequenceId: string, o: SuggestOptions): SuggestPlan {
	const seq = doc.sequences[sequenceId];
	const empty: SuggestPlan = {
		range: null,
		found: zero(),
		kept: zero(),
		adds: [],
		removes: [],
		duplicates: 0,
		byWeight: { hero: 0, support: 0, ambient: 0 },
		warnings: [],
		commands: [],
	};
	if (!seq) return empty;
	const range = suggestRange(seq, o.range, o.selectedClips);
	if (!range) return empty;
	const base = {
		range,
		density: o.density,
		respectDialogue: o.respectDialogue,
		mgTemplates: mgRegistry,
	};
	// Like the engine route: expression-driven motion moves as the renderer shows it (a no-op until the expression
	// engine is loaded; the dialog loads it and plans again).
	const derivedFrom = o.expressions === false ? doc : bindExpressions(doc);
	// Found counts do not depend on the selection; kept counts do (merging), so both runs are needed unless all are on.
	const all = deriveCues(derivedFrom, sequenceId, { ...base, sources: [...PROJECT_CUE_SOURCES] });
	const allOn = PROJECT_CUE_SOURCES.every((s) => o.sources.has(s));
	const chosen = allOn
		? all
		: deriveCues(derivedFrom, sequenceId, { ...base, sources: [...o.sources] as CueDeriveSource[] });
	const found = zero();
	const kept = zero();
	for (const s of PROJECT_CUE_SOURCES) {
		found[s] = all.stats.bySource[s]?.found ?? 0;
		kept[s] = o.sources.has(s) ? (chosen.stats.bySource[s]?.kept ?? 0) : 0;
	}
	const stored = cuesOf(seq);
	const inRange = (c: SoundCue) => c.frame >= range.start && c.frame < range.end;
	const removes = o.replace
		? stored.filter((c) => c.source === 'derived' && inRange(c) && !isFilled(c, seq.clips)).map((c) => c.id)
		: [];
	const removed = new Set(removes);
	const staying = stored.filter((c) => !removed.has(c.id));
	const derived: DerivedCue[] = chosen.cues.filter((d) => !duplicatesStored(d, staying));
	const adds = derived.map((d) => cueInputFromDerived(d) as CueInput);
	const byWeight = { hero: 0, support: 0, ambient: 0 };
	for (const a of adds) byWeight[a.weight]++;
	const commands: Command[] = [];
	if (removes.length) commands.push({ type: 'soundCue.remove', cueIds: removes } as Command);
	// `soundCue.add` takes ≤ 2000 cues; a long sequence's suggestion is several commands of the same transaction.
	for (let i = 0; i < adds.length; i += SOUND_DESIGN_LIMITS.addCues)
		commands.push({
			type: 'soundCue.add',
			sequenceId,
			cues: adds.slice(i, i + SOUND_DESIGN_LIMITS.addCues),
		} as Command);
	return {
		range,
		found,
		kept,
		adds,
		removes,
		duplicates: chosen.cues.length - derived.length,
		byWeight,
		warnings: [
			...new Map([...all.warnings, ...chosen.warnings].map((w) => [w.code + w.message, w])).values(),
		],
		commands,
	};
}
