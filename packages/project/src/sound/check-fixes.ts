// Sound Check fixes judged together (spec 12 §2.6 "Fix all safe"; wp-note "WP6.5b → Sound Check"). Each fix the engine
// marks safe was judged on its own; two of them on the same sound can still overload it together (a hero's solved gain
// and its demotion to support: the gain was solved under the hero's bed cap), and with loudness normalisation off a
// gain that lifts a masked sound can push the mix's true peak over the ceiling. `planSoundCheckFixes` applies the
// candidate fixes IN SEQUENCE on a dry-run copy of the document — commands first, then sound swaps, then engine jobs, each
// group in report order (an align before a swap of the same clip keeps the aligned frame) — and re-validates after each
// one: a fix is skipped (with a translatable reason and the findings it conflicts with) when its commands no longer
// apply, when it makes any measured sound worse than before it (further under its minimum lift, further over its bed
// cap, its own true peak further over the ceiling, or — normalisation off — the bound on the mix's true peak where it
// plays further over the ceiling), when it no longer resolves its own finding, when it changes the level of a sound
// another accepted fix moves or replaces (or the other way round: the level was measured for the old sound or place),
// or — for an engine job — when accepted fixes changed sound-effect levels the job's bed would move under. Earlier fixes
// win; the result is deterministic. Used by the engine (the report's `safe` flags are jointly safe for the checked
// document, so an agent applying every safe fix in `soundCheckFixOrder` gets the same result) and by the editor's Fix all
// safe (re-validated on the current document with the real swap commands).
//
// Level model (from the check's measurements, `report.levelGuard`): the masking solver's quantities are linear in the
// clip gain g — lift(g) = liftAt0Db + g, peak over the bed(g) = peakOverBedAt0Lu + g, the sound's true peak(g) =
// truePeakAt0Db + g — and the weight follows the clip's role (`sfxSolverWeight`). The mix's true peak after raising
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
};

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
export function soundCheckFixOrder<T extends { kind: SoundCheckFixCandidate['kind'] }>(items: readonly T[]): T[] {
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
	if (!clip || clip.kind !== 'audio') return null;
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
	const l = (doc.sequences?.[sequenceId]?.master as { loudness?: { enabled?: unknown } } | undefined)?.loudness;
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
			value.masked = m.liftAt0Db + g;
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
	const replaced = new Set<string>();
	/** Issue ids of accepted fixes that changed a clip's level / its sound or place. */
	const levelBy = new Map<string, string[]>();
	const soundBy = new Map<string, string[]>();
	const accepted: SoundCheckFixCandidate[] = [];
	const skipped: SoundCheckFixSkip[] = [];
	const titleOf = (clipId: string) => {
		const m = guard?.levels.find((l) => l.clipId === clipId);
		return m?.title ? `“${m.title}”` : clipId;
	};
	const skip = (c: SoundCheckFixCandidate, reason: SoundCheckMessage, conflictsWith: string[] = []) =>
		skipped.push({ candidate: c, reason, conflictsWith: [...new Set(conflictsWith)] });

	for (const c of soundCheckFixOrder(candidates)) {
		// jobs: an engine job's bed moves under accepted level changes (ducking under speech; a rebalance everywhere)
		if (c.kind === 'job') {
			const moved = [...levelBy.entries()].filter(([clipId]) => {
				if (c.job?.route === 'rebalance') return true;
				return guard?.levels.some((l) => l.clipId === clipId && l.speech) ?? false;
			});
			if (moved.length) {
				skip(
					c,
					soundCheckMessage('whyFixBedChanged'),
					moved.flatMap(([, by]) => by),
				);
				continue;
			}
			accepted.push(c);
			continue;
		}
		let next = dry;
		if (c.commands?.length) {
			if (preludeError && c.kind === 'swap') {
				skip(c, soundCheckMessage('whyFixRefused', preludeError));
				continue;
			}
			const r = run(dry, substitute(c.commands));
			if (!r.ok) {
				skip(c, soundCheckMessage('whyFixRefused', r.message), accepted.flatMap((a) => a.issueIds));
				continue;
			}
			next = r.doc;
		}
		if (!guard) {
			dry = next;
			accepted.push(c);
			continue;
		}
		const nextReplaced = new Set(replaced);
		const before = statesOf(dry, sequenceId, guard, replaced);
		if (c.swap) {
			const s = before.get(c.swap.clipId);
			if (s && s.sound !== c.swap.soundId && !s.sound.endsWith('#replaced')) nextReplaced.add(c.swap.clipId);
		}
		const after = statesOf(next, sequenceId, guard, nextReplaced);
		// a level change and a move / sound change of the same clip do not go together: the level was measured there
		let conflict: { clipId: string; with: string[] } | null = null;
		for (const m of guard.levels) {
			const b = before.get(m.clipId);
			const a = after.get(m.clipId);
			if (!b || !a) continue;
			const levelChanged = Math.abs(a.gainDb - b.gainDb) > EPS || a.weight !== b.weight || a.layer !== b.layer;
			const soundChanged = a.place !== b.place || a.sound !== b.sound;
			const base = baseStates.get(m.clipId);
			const invalid = !base || b.place !== base.place || b.sound !== base.sound;
			if (levelChanged && (invalid || soundChanged)) {
				conflict = { clipId: m.clipId, with: soundBy.get(m.clipId) ?? [] };
				break;
			}
			if (soundChanged && (levelBy.get(m.clipId)?.length ?? 0) > 0) {
				conflict = { clipId: m.clipId, with: levelBy.get(m.clipId) ?? [] };
				break;
			}
		}
		if (conflict) {
			skip(c, soundCheckMessage('whyFixSoundChanged', titleOf(conflict.clipId)), conflict.with);
			continue;
		}
		const e0 = evaluate(dry, sequenceId, guard, before, baseStates);
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
			const st = after.get(worse.clipId);
			const value = e1.by.get(worse.clipId)!.value[worse.v];
			const title = titleOf(worse.clipId);
			const weight = st?.weight ?? 'support';
			const reason =
				worse.v === 'overcap'
					? soundCheckMessage(
							'whyFixOverCap',
							title,
							fmt(value - guard.bedCapLu[weight]),
							r1(guard.bedCapLu[weight]),
						)
					: worse.v === 'masked'
						? soundCheckMessage(
								'whyFixMasked',
								title,
								fmt(value),
								weight === 'ambient' ? 0 : MASKED_MIN_LIFT_DB[weight],
							)
						: worse.v === 'eventTp'
							? soundCheckMessage('whyFixEventPeak', title, fmt(value), r1(guard.eventCeilingDb))
							: soundCheckMessage(
									'whyFixMixPeak',
									title,
									Number.isFinite(value) ? fmt(value) : '+∞',
									r1(guard.ceilingDb),
								);
			const m = guard.levels.find((l) => l.clipId === worse.clipId)!;
			const related =
				worse.v === 'mixTp'
					? [...levelBy.entries()]
							.filter(([id]) => {
								const o = guard.levels.find((l) => l.clipId === id);
								return !!o && o.start < m.end && m.start < o.end;
							})
							.flatMap(([, by]) => by)
					: (levelBy.get(worse.clipId) ?? []);
			skip(c, reason, related);
			continue;
		}
		const unresolved = (c.targets ?? []).find((t) => {
			const x = e1.by.get(t.clipId);
			return !x || x.mag[t.kind] > EPS;
		});
		if (unresolved) {
			skip(
				c,
				soundCheckMessage('whyFixUnresolved'),
				levelBy.get(unresolved.clipId) ?? soundBy.get(unresolved.clipId) ?? [],
			);
			continue;
		}
		// accepted: what it changed
		for (const m of guard.levels) {
			const b = before.get(m.clipId);
			const a = after.get(m.clipId);
			if (!b || !a) continue;
			if (Math.abs(a.gainDb - b.gainDb) > EPS || a.weight !== b.weight || a.layer !== b.layer)
				levelBy.set(m.clipId, [...(levelBy.get(m.clipId) ?? []), ...c.issueIds]);
			if (a.place !== b.place || a.sound !== b.sound)
				soundBy.set(m.clipId, [...(soundBy.get(m.clipId) ?? []), ...c.issueIds]);
		}
		for (const id of nextReplaced) replaced.add(id);
		dry = next;
		accepted.push(c);
	}
	const anySwap = accepted.some((c) => c.kind === 'swap' && c.commands?.length);
	const commands = [
		...(anySwap ? prelude : []),
		...accepted.flatMap((c) => (c.kind === 'job' ? [] : [...(c.commands ?? [])])),
	];
	return { accepted, skipped, commands, document: dry };
}
