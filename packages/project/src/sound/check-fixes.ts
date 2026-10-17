// Sound Check fixes judged together (spec 12 §2.6 "Fix all safe"; wp-note "WP6.5b → Sound Check"). Each fix the engine
// marks safe was judged on its own; two of them on the same sound can still undo or overload each other (a hero's
// solved gain and its demotion: `soundDesign.setRole` resets a solver gain to the new role's default level, and a
// hero-solved gain applied to a support can sit over the support's bed cap), and with loudness normalisation off a gain
// that lifts a masked sound can push the mix's true peak over the ceiling. `planSoundCheckFixes` applies the candidate
// fixes IN SEQUENCE on a dry-run copy of the document — commands first, then sound swaps, then engine jobs, each group in
// report order (an align before a swap of the same clip keeps the aligned frame). Each fix is judged on its own first (on
// the document as given), then after the fixes accepted before it; it is skipped, with a translatable reason and the
// findings it conflicts with (none when it is not safe on its own), when its commands no longer apply; when it leaves
// any measured sound worse than before it (further under its minimum lift, further over its bed cap, its own true peak
// further over the ceiling, or — normalisation off — the bound on the mix's true peak where it plays further over the
// ceiling); when it no longer resolves its own finding; when it changes the level of a sound another accepted fix moves
// or replaces, or the other way round (the level was measured for the old sound and place); or — an engine job — when
// accepted fixes changed sound-effect levels the job's bed would move under. Earlier fixes win; the result is
// deterministic. Used by the engine (a report's `safe` flags are safe alone and in `soundCheckFixOrder` after the safe
// fixes before them, for the checked document) and by the editor (Fix all safe, and a single Fix, re-judged on the
// current document with the real swap commands).
//
// Level model (from the check's measurements, `report.levelGuard`): the masking solver's quantities are linear in the
// clip gain g — lift(g) = liftAt0Db + g, peak over the bed(g) = peakOverBedAt0Lu + g, the sound's true peak(g) =
// truePeakAt0Db + g — and the weight follows the clip's role (`sfxSolverWeight`). The lift's bed includes the sound
// effects of a lower weight playing under it (the solver's inter-SFX masking): the model keeps each overlapping one's
// power in the sound's dominant bands (`masking`), so a fix that raises, lowers, demotes or promotes ANOTHER sound moves
// this one's lift by exactly the solver's amount (lift = liftAt0Db + g + masked bed at the check − masked bed now). The mix's true peak after raising
// sounds by Δᵢ dB is bounded by the triangle inequality on the oversampled signal: TP′ ≤ TP(mix over the span) +
// Σ (10^(Δᵢ/20) − 1) · TP(soundᵢ at its checked gain), summed over the raised sounds playing in the span (linear
// amplitudes; exact for a linear mix, an estimate behind dynamics processors). Lowering a sound is not counted as
// raising the peak (decision). Pure; never throws.
import { applyTransaction } from '../commands/apply.ts';
import type { Registries } from '../commands/types.ts';
import { createRandomIdSource, type IdSource } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { readClipSfx } from '../schema/sound.ts';
import { MASKED_MIN_LIFT_DB, type SoundCheckMessage, soundCheckMessage } from './check.ts';
import { readLibraryProvenance } from './provenance.ts';
import { type SfxSolverWeight, sfxSolverWeight } from './sfx-clip.ts';

/** A sound may peak this much over its bed cap before OVERLOAD (LU; the check's rule). */
export const SOUND_CHECK_CAP_TOLERANCE_LU = 0.5;
/** Rounding slack when comparing levels before and after a fix (dB). */
const EPS = 0.005;

/** What the check measured about one sound effect, linear in its clip gain (see the module docs). */
export type SoundCheckLevelModel = {
	clipId: string;
	title: string;
	/** Clip gain when it was measured (dB). */
	gainDb: number;
	/** Dominant-band lift over the bed at 0 dB clip gain (dB); null for a silent sound. */
	liftAt0Db: number | null;
	/** Peak loudness over the solver's bed reference at 0 dB clip gain (LU); null unmeasured. */
	peakOverBedAt0Lu: number | null;
	/** The sound's own true peak in the mix at 0 dB clip gain (dBTP); null unmeasured. */
	truePeakAt0Db: number | null;
	/** True peak of the mix as checked over `[start, end)` (dBTP); null when the Mix normalised (the limiter holds it). */
	mixTruePeakDb: number | null;
	/** Sequence frames where the sound plays (its clip and a tail allowance). */
	start: number;
	end: number;
	/** It plays over speech (an engine ducking job moves its bed). */
	speech: boolean;
	/**
	 * The sound effects overlapping it (the solver's inter-SFX masking; see the module docs): `liftAt0Db` is over the bed
	 * plus the terms of a lower weight than `weight` (its weight at the check) at their checked `gainDb`. Absent: none.
	 */
	masking?: SoundCheckMaskingModel;
};

/** One sound effect's share of another's bed in that one's dominant bands (dB at 0 dB clip gain). */
export type SoundCheckMaskingTerm = {
	clipId: string;
	weight: SfxSolverWeight;
	gainDb: number;
	at0Db: number;
};
export type SoundCheckMaskingModel = {
	weight: SfxSolverWeight;
	bedDomDb: number;
	terms: SoundCheckMaskingTerm[];
};

/** Most overlapping sounds kept per sound effect (the loudest at their checked gains). */
export const SOUND_CHECK_MASKING_TERMS_MAX = 64;
/** The masked-bed floor (dB; `BAND_FLOOR_DB` of the solver's band levels). */
const MASKING_FLOOR_DB = -200;

const WEIGHT_RANK: Readonly<Record<SfxSolverWeight, number>> = { ambient: 0, support: 1, hero: 2 };

/**
 * The masked bed (dB) of a sound of weight `weight` from its masking model, with each overlapping sound at the gain and
 * weight `of` gives (null: it no longer plays) — the solver's power sum over the lower-weight ones.
 */
export function maskedBedDb(
	model: SoundCheckMaskingModel,
	weight: SfxSolverWeight,
	of: (t: SoundCheckMaskingTerm) => { gainDb: number; weight: SfxSolverWeight } | null,
): number {
	let e = fin(model.bedDomDb) ? 10 ** (model.bedDomDb / 10) : 0;
	for (const t of model.terms) {
		const now = of(t);
		if (!now || !fin(t.at0Db) || !fin(now.gainDb)) continue;
		if (WEIGHT_RANK[now.weight] < WEIGHT_RANK[weight]) e += 10 ** ((t.at0Db + now.gainDb) / 10);
	}
	return e > 0 && Number.isFinite(e) ? Math.max(MASKING_FLOOR_DB, 10 * Math.log10(e)) : MASKING_FLOOR_DB;
}

/** The numbers fixes are judged by, and the measured sounds (`report.levelGuard`). */
export type SoundCheckLevelGuard = {
	/** The delivery's true-peak ceiling (dBTP): the mix's. */
	ceilingDb: number;
	/** The solver's per-sound ceiling (dBTP). */
	eventCeilingDb: number;
	bedCapLu: Readonly<Record<SfxSolverWeight, number>>;
	capToleranceLu: number;
	levels: readonly SoundCheckLevelModel[];
};

/** A fix to judge: one or more findings sharing it (LOUDNESS and TRUE_PEAK normalise the Mix once). */
export type SoundCheckFixCandidate = {
	issueIds: string[];
	kind: 'commands' | 'swap' | 'job';
	/** The document commands (a swap's once its sound is registered); null: not a document edit here. */
	commands: readonly Record<string, unknown>[] | null;
	/** What the fix must resolve on its clip (MASKED → masked, OVERLOAD over the bed → overcap). */
	targets?: readonly { clipId: string; kind: 'masked' | 'overcap' }[];
	/** A swap judged without its commands (the sound is registered when it is applied). */
	swap?: { clipId: string; soundId: string };
	/** An engine job (`rebalance`, `delivery`). */
	job?: { route: string };
};

export type SoundCheckFixSkip = {
	candidate: SoundCheckFixCandidate;
	reason: SoundCheckMessage;
	/** Findings of accepted fixes it conflicts with (empty: it is not safe on its own). */
	conflictsWith: string[];
};

export type SoundCheckFixPlan = {
	/** In the order to apply them. */
	accepted: SoundCheckFixCandidate[];
	skipped: SoundCheckFixSkip[];
	/** ONE transaction of every accepted document fix: the prelude (when a swap needs it), then the fixes in order. */
	commands: Record<string, unknown>[];
	/** The document after them (dry run). */
	document: ProjectDocument;
};

export type SoundCheckFixOptions = {
	registries: Registries;
	/** The check's level guard; without it only the commands are dry-run (reports before WP6.5b). */
	guard?: SoundCheckLevelGuard | null | undefined;
	/** Commands every swap needs first (media registrations); their refs are visible to the swaps. */
	prelude?: readonly Record<string, unknown>[];
	ids?: IdSource;
};

const KIND_RANK = { commands: 0, swap: 1, job: 2 } as const;

/** The order fixes are applied in: document commands, then sound swaps, then engine jobs, each in the given order. */
export function soundCheckFixOrder<T extends { kind: SoundCheckFixCandidate['kind'] }>(
	items: readonly T[],
): T[] {
	return items
		.map((c, i) => ({ c, i }))
		.sort((a, b) => KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind] || a.i - b.i)
		.map((x) => x.c);
}

type IssueLike = {
	id: string;
	code: string;
	clipIds?: readonly string[] | undefined;
	fix?:
		| {
				kind: SoundCheckFixCandidate['kind'];
				safe: boolean;
				commands?: readonly Record<string, unknown>[] | undefined;
				swap?: { clipId: string; soundId: string } | undefined;
				job?: { route: string; body?: unknown } | undefined;
		  }
		| undefined;
};

function stable(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
	const keys = Object.keys(v as object).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** What a finding's fix must resolve on its clip (MASKED, OVERLOAD over the bed), for re-validation. */
export function soundCheckFixTargets(issue: IssueLike): { clipId: string; kind: 'masked' | 'overcap' }[] {
	const clipId = issue.clipIds?.[0];
	if (!clipId) return [];
	if (issue.code === 'MASKED') return [{ clipId, kind: 'masked' }];
	if (issue.code === 'OVERLOAD') return [{ clipId, kind: 'overcap' }];
	return [];
}

/**
 * The candidates of these findings' fixes (`safeOnly`: only fixes marked safe), in report order: a fix several findings
 * share (the same commands, the same clip swapped, the same job) is one candidate; swaps are judged without commands.
 */
export function soundCheckFixCandidates(
	issues: readonly IssueLike[],
	opts: { safeOnly: boolean },
): SoundCheckFixCandidate[] {
	const out: SoundCheckFixCandidate[] = [];
	const seen = new Map<string, SoundCheckFixCandidate>();
	for (const i of issues) {
		const f = i.fix;
		if (!f || (opts.safeOnly && !f.safe)) continue;
		let key: string;
		let c: SoundCheckFixCandidate;
		if (f.kind === 'commands' && f.commands?.length) {
			key = `c:${stable(f.commands)}`;
			c = { issueIds: [], kind: 'commands', commands: f.commands };
		} else if (f.kind === 'swap' && f.swap?.clipId && f.swap.soundId) {
			key = `s:${f.swap.clipId}`;
			c = { issueIds: [], kind: 'swap', commands: null, swap: { ...f.swap } };
		} else if (f.kind === 'job' && f.job) {
			key = `j:${f.job.route}:${stable(f.job.body)}`;
			c = { issueIds: [], kind: 'job', commands: null, job: { route: f.job.route } };
		} else continue;
		const had = seen.get(key);
		const target = had ?? c;
		target.issueIds.push(i.id);
		const t = soundCheckFixTargets(i);
		if (t.length) target.targets = [...(target.targets ?? []), ...t];
		if (!had) {
			seen.set(key, c);
			out.push(c);
		}
	}
	return out;
}

// ── evaluation ──────────────────────────────────────────────────────────────────────────────────────────────────────

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fmt = (x: number) => {
	const v = Math.round(x * 10) / 10;
	return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

type ClipState = {
	gainDb: number;
	weight: SfxSolverWeight;
	layer: boolean;
	/** Where and how it plays: start, speed, direction, which sound. */
	place: string;
	sound: string;
};

function clipState(doc: ProjectDocument, sequenceId: string, clipId: string): ClipState | null {
	const seq = doc.sequences?.[sequenceId];
	const clip = seq && Object.hasOwn(seq.clips, clipId) ? seq.clips[clipId] : undefined;
	if (clip?.kind !== 'audio') return null;
	const c = clip as typeof clip & {
		gainDb?: unknown;
		sfx?: unknown;
		mediaId: string;
		speed?: { rate?: unknown; reverse?: unknown };
	};
	const sfx = c.sfx !== undefined ? readClipSfx(c.sfx) : null;
	const media = doc.media?.[c.mediaId] as { library?: unknown } | undefined;
	const prov = readLibraryProvenance(media?.library);
	const sound = sfx?.soundId ?? prov?.soundId ?? `media:${c.mediaId}`;
	return {
		gainDb: fin(c.gainDb) ? c.gainDb : 0,
		weight: sfxSolverWeight(sfx?.role ?? null, prov?.types ?? []),
		layer: sfx?.role === 'layer',
		place: `${c.start}|${fin(c.speed?.rate) ? c.speed.rate : 1}|${c.speed?.reverse === true}`,
		sound,
	};
}

const normalises = (doc: ProjectDocument, sequenceId: string): boolean => {
	const l = (doc.sequences?.[sequenceId]?.master as { loudness?: { enabled?: unknown } } | undefined)
		?.loudness;
	return l?.enabled === true;
};

type Violation = 'overcap' | 'masked' | 'eventTp' | 'mixTp';
const VIOLATIONS: readonly Violation[] = ['overcap', 'masked', 'eventTp', 'mixTp'];

type Eval = {
	/** By clip: how far over each limit (0 = fine), and the level reached. */
	by: Map<string, { mag: Record<Violation, number>; value: Record<Violation, number> }>;
};

function evaluate(
	doc: ProjectDocument,
	sequenceId: string,
	guard: SoundCheckLevelGuard,
	states: Map<string, ClipState | null>,
	base: Map<string, ClipState | null>,
): Eval {
	const by: Eval['by'] = new Map();
	const off = !normalises(doc, sequenceId);
	// an overlapping sound effect's state now (undefined: its model is invalid here — moved or replaced — so it counts as
	// checked; null: it no longer plays as an audio clip)
	const others = new Map<string, ClipState | null | undefined>();
	const otherState = (clipId: string): ClipState | null | undefined => {
		if (others.has(clipId)) return others.get(clipId);
		const s = states.get(clipId) ?? clipState(doc, sequenceId, clipId);
		const b = base.get(clipId) ?? s;
		const v = s && b && (s.place !== b.place || s.sound !== b.sound) ? undefined : s;
		others.set(clipId, v);
		return v;
	};
	// raised sounds (amplitude added to the mix's peak), valid models only
	const raised: { m: SoundCheckLevelModel; add: number }[] = [];
	for (const m of guard.levels) {
		const s = states.get(m.clipId);
		const b = base.get(m.clipId);
		if (!s || !b || s.place !== b.place || s.sound !== b.sound) continue;
		const d = s.gainDb - m.gainDb;
		if (d <= EPS) continue;
		const add = fin(m.truePeakAt0Db)
			? (10 ** (d / 20) - 1) * 10 ** ((m.truePeakAt0Db + m.gainDb) / 20)
			: Number.POSITIVE_INFINITY;
		raised.push({ m, add });
	}
	for (const m of guard.levels) {
		const s = states.get(m.clipId);
		const b = base.get(m.clipId);
		if (!s || !b || s.place !== b.place || s.sound !== b.sound) continue;
		const g = s.gainDb;
		const mag: Record<Violation, number> = { overcap: 0, masked: 0, eventTp: 0, mixTp: 0 };
		const value: Record<Violation, number> = { overcap: 0, masked: 0, eventTp: 0, mixTp: 0 };
		if (fin(m.peakOverBedAt0Lu)) {
			value.overcap = m.peakOverBedAt0Lu + g;
			mag.overcap = Math.max(0, value.overcap - (guard.bedCapLu[s.weight] + guard.capToleranceLu));
		}
		if (fin(m.liftAt0Db) && s.weight !== 'ambient' && !s.layer) {
			// the overlapping sound effects under it at their gains and weights now vs at the check
			let maskShift = 0;
			if (m.masking?.terms.length) {
				const checked = maskedBedDb(m.masking, m.masking.weight, (t) => t);
				const now = maskedBedDb(m.masking, s.weight, (t) => {
					const o = otherState(t.clipId);
					if (o === undefined) return t; // not judged here: as checked
					if (o === null) return null; // gone
					return { gainDb: o.gainDb, weight: o.weight };
				});
				maskShift = checked - now;
			}
			value.masked = m.liftAt0Db + g + maskShift;
			mag.masked = Math.max(0, MASKED_MIN_LIFT_DB[s.weight] - value.masked);
		}
		if (fin(m.truePeakAt0Db)) {
			value.eventTp = m.truePeakAt0Db + g;
			mag.eventTp = Math.max(0, value.eventTp - guard.eventCeilingDb);
		}
		if (off && fin(m.mixTruePeakDb)) {
			let lin = 10 ** (m.mixTruePeakDb / 20);
			for (const r of raised) if (r.m.start < m.end && m.start < r.m.end) lin += r.add;
			value.mixTp = Number.isFinite(lin) ? 20 * Math.log10(lin) : Number.POSITIVE_INFINITY;
			mag.mixTp = Math.max(0, value.mixTp - guard.ceilingDb);
		}
		by.set(m.clipId, { mag, value });
	}
	return { by };
}

function statesOf(
	doc: ProjectDocument,
	sequenceId: string,
	guard: SoundCheckLevelGuard | null,
	replaced: ReadonlySet<string>,
): Map<string, ClipState | null> {
	const out = new Map<string, ClipState | null>();
	for (const m of guard?.levels ?? []) {
		const s = clipState(doc, sequenceId, m.clipId);
		out.set(m.clipId, s && replaced.has(m.clipId) ? { ...s, sound: `${s.sound}#replaced` } : s);
	}
	return out;
}

/**
 * Applies `candidates` in `soundCheckFixOrder` on a dry-run copy of `doc`, re-validating after each one (see the module
 * docs), and returns the ones to apply, the skipped ones with why, and ONE transaction of the accepted document fixes.
 * Deterministic for the same input. Never throws.
 */
export function planSoundCheckFixes(
	doc: ProjectDocument,
	sequenceId: string,
	candidates: readonly SoundCheckFixCandidate[],
	opts: SoundCheckFixOptions,
): SoundCheckFixPlan {
	const ids = opts.ids ?? createRandomIdSource();
	const guard = opts.guard && Array.isArray(opts.guard.levels) ? opts.guard : null;
	const ctx = {
		ids,
		now: () => new Date().toISOString(),
		revision: 0,
		registries: opts.registries,
		invariants: 'incremental' as const,
	};
	const run = (
		d: ProjectDocument,
		commands: readonly Record<string, unknown>[],
	): { ok: true; doc: ProjectDocument; refs: Record<string, string> } | { ok: false; message: string } => {
		try {
			const { document, result } = applyTransaction(
				d,
				{ label: 'sound check fixes', origin: 'user', sequenceId, commands: commands as never },
				ctx,
			);
			if (!result.ok) return { ok: false, message: result.errors[0]?.message ?? 'refused' };
			return { ok: true, doc: document, refs: result.refs };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	};
	// the prelude's refs ($chk0…) are substituted into the swaps' dry runs; the final transaction keeps the refs
	let dry = doc;
	let refs = new Map<string, string>();
	const prelude = opts.prelude?.length ? [...opts.prelude] : [];
	let preludeError: string | null = null;
	if (prelude.length) {
		const p = run(doc, prelude);
		if (p.ok) {
			dry = p.doc;
			refs = new Map(Object.entries(p.refs));
		} else preludeError = p.message;
	}
	const substitute = (cmds: readonly Record<string, unknown>[]) =>
		cmds.map((c) => {
			let s = JSON.stringify(c);
			for (const [k, v] of refs) s = s.split(JSON.stringify(k)).join(JSON.stringify(v));
			return JSON.parse(s) as Record<string, unknown>;
		});
	const baseStates = statesOf(dry, sequenceId, guard, new Set());
	const titleOf = (clipId: string) => {
		const m = guard?.levels.find((l) => l.clipId === clipId);
		return m?.title ? `“${m.title}”` : clipId;
	};
	type State = {
		dry: ProjectDocument;
		replaced: Set<string>;
		/** Issue ids of accepted fixes that changed a clip's level / its sound or place. */
		levelBy: Map<string, string[]>;
		soundBy: Map<string, string[]>;
		accepted: SoundCheckFixCandidate[];
	};
	type Verdict =
		| { ok: true; state: State }
		| { ok: false; reason: SoundCheckMessage; conflictsWith: string[] };
	const no = (reason: SoundCheckMessage, conflictsWith: string[] = []): Verdict => ({
		ok: false,
		reason,
		conflictsWith,
	});
	/** Judges `c` applied after the fixes of `st` (see the module docs). */
	const judge = (c: SoundCheckFixCandidate, st: State): Verdict => {
		const { levelBy, soundBy, replaced } = st;
		// jobs: an engine job's bed moves under accepted level changes (ducking under speech; a rebalance everywhere)
		if (c.kind === 'job') {
			const moved = [...levelBy.entries()].filter(([clipId]) => {
				if (c.job?.route === 'rebalance') return true;
				return guard?.levels.some((l) => l.clipId === clipId && l.speech) ?? false;
			});
			if (moved.length)
				return no(
					soundCheckMessage('whyFixBedChanged'),
					moved.flatMap(([, by]) => by),
				);
			return { ok: true, state: { ...st, accepted: [...st.accepted, c] } };
		}
		let next = st.dry;
		if (c.commands?.length) {
			if (preludeError && c.kind === 'swap') return no(soundCheckMessage('whyFixRefused', preludeError));
			const r = run(st.dry, substitute(c.commands));
			if (!r.ok)
				return no(
					soundCheckMessage('whyFixRefused', r.message),
					st.accepted.flatMap((a) => a.issueIds),
				);
			next = r.doc;
		}
		if (!guard) return { ok: true, state: { ...st, dry: next, accepted: [...st.accepted, c] } };
		const nextReplaced = new Set(replaced);
		const before = statesOf(st.dry, sequenceId, guard, replaced);
		if (c.swap) {
			const s = before.get(c.swap.clipId);
			if (s && s.sound !== c.swap.soundId && !s.sound.endsWith('#replaced')) nextReplaced.add(c.swap.clipId);
		}
		const after = statesOf(next, sequenceId, guard, nextReplaced);
		// a level change and a move / sound change of the same clip do not go together: the level was measured there
		for (const m of guard.levels) {
			const b = before.get(m.clipId);
			const a = after.get(m.clipId);
			if (!b || !a) continue;
			const levelChanged =
				Math.abs(a.gainDb - b.gainDb) > EPS || a.weight !== b.weight || a.layer !== b.layer;
			const soundChanged = a.place !== b.place || a.sound !== b.sound;
			const base = baseStates.get(m.clipId);
			const invalid = !base || b.place !== base.place || b.sound !== base.sound;
			// (a fix that itself changes the sound — a swap re-levels the clip for its new sound — is not a level fix: its
			// clip's model no longer applies after it, under the "equivalent alternative" assumption of the swap)
			if (levelChanged && invalid && !soundChanged)
				return no(soundCheckMessage('whyFixSoundChanged', titleOf(m.clipId)), soundBy.get(m.clipId) ?? []);
			if (soundChanged && (levelBy.get(m.clipId)?.length ?? 0) > 0)
				return no(soundCheckMessage('whyFixSoundChanged', titleOf(m.clipId)), levelBy.get(m.clipId) ?? []);
		}
		const e0 = evaluate(st.dry, sequenceId, guard, before, baseStates);
		const e1 = evaluate(next, sequenceId, guard, after, baseStates);
		let worse: { clipId: string; v: Violation } | null = null;
		for (const v of VIOLATIONS) {
			for (const m of guard.levels) {
				const x0 = e0.by.get(m.clipId)?.mag[v] ?? 0;
				const x1 = e1.by.get(m.clipId)?.mag[v];
				if (x1 !== undefined && x1 > x0 + EPS) {
					worse = { clipId: m.clipId, v };
					break;
				}
			}
			if (worse) break;
		}
		if (worse) {
			const w = worse;
			const value = e1.by.get(w.clipId)!.value[w.v];
			const title = titleOf(w.clipId);
			const weight = after.get(w.clipId)?.weight ?? 'support';
			const reason =
				w.v === 'overcap'
					? soundCheckMessage(
							'whyFixOverCap',
							title,
							fmt(value - guard.bedCapLu[weight]),
							r1(guard.bedCapLu[weight]),
						)
					: w.v === 'masked'
						? soundCheckMessage(
								'whyFixMasked',
								title,
								fmt(value),
								weight === 'ambient' ? 0 : MASKED_MIN_LIFT_DB[weight],
							)
						: w.v === 'eventTp'
							? soundCheckMessage('whyFixEventPeak', title, fmt(value), r1(guard.eventCeilingDb))
							: soundCheckMessage(
									'whyFixMixPeak',
									title,
									Number.isFinite(value) ? fmt(value) : '+∞',
									r1(guard.ceilingDb),
								);
			const m = guard.levels.find((l) => l.clipId === w.clipId)!;
			const related =
				w.v === 'mixTp'
					? [...levelBy.entries()]
							.filter(([id]) => {
								const o = guard.levels.find((l) => l.clipId === id);
								return !!o && o.start < m.end && m.start < o.end;
							})
							.flatMap(([, by]) => by)
					: (levelBy.get(w.clipId) ?? []);
			return no(reason, related);
		}
		const unresolved = (c.targets ?? []).find((t) => {
			const x = e1.by.get(t.clipId);
			return !x || x.mag[t.kind] > EPS;
		});
		if (unresolved)
			return no(
				soundCheckMessage('whyFixUnresolved'),
				levelBy.get(unresolved.clipId) ?? soundBy.get(unresolved.clipId) ?? [],
			);
		// accepted: what it changed
		const lb = new Map(levelBy);
		const sb = new Map(soundBy);
		for (const m of guard.levels) {
			const b = before.get(m.clipId);
			const a = after.get(m.clipId);
			if (!b || !a) continue;
			if (Math.abs(a.gainDb - b.gainDb) > EPS || a.weight !== b.weight || a.layer !== b.layer)
				lb.set(m.clipId, [...(lb.get(m.clipId) ?? []), ...c.issueIds]);
			if (a.place !== b.place || a.sound !== b.sound)
				sb.set(m.clipId, [...(sb.get(m.clipId) ?? []), ...c.issueIds]);
		}
		return {
			ok: true,
			state: { dry: next, replaced: nextReplaced, levelBy: lb, soundBy: sb, accepted: [...st.accepted, c] },
		};
	};

	const initial: State = { dry, replaced: new Set(), levelBy: new Map(), soundBy: new Map(), accepted: [] };
	let state = initial;
	const skipped: SoundCheckFixSkip[] = [];
	for (const c of soundCheckFixOrder(candidates)) {
		// safe on its own first (on the document as given), then after the accepted ones
		const alone = judge(c, initial);
		if (!alone.ok) {
			skipped.push({ candidate: c, reason: alone.reason, conflictsWith: [] });
			continue;
		}
		const v = state.accepted.length ? judge(c, state) : alone;
		if (!v.ok) {
			const conflicts = v.conflictsWith.length ? v.conflictsWith : state.accepted.flatMap((a) => a.issueIds);
			skipped.push({ candidate: c, reason: v.reason, conflictsWith: [...new Set(conflicts)] });
			continue;
		}
		state = v.state;
	}
	const accepted = state.accepted;
	dry = state.dry;
	const anySwap = accepted.some((c) => c.kind === 'swap' && c.commands?.length);
	const commands = [
		...(anySwap ? prelude : []),
		...accepted.flatMap((c) => (c.kind === 'job' ? [] : [...(c.commands ?? [])])),
	];
	return { accepted, skipped, commands, document: dry };
}
