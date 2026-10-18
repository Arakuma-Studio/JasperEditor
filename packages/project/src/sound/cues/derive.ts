// `deriveCues` (spec 12 §2.2 "Derivation", P2-R3): cue points read from the edit itself. Pure and deterministic: the
// same document and options give the same cues in the same order. Never throws: a source that fails on a damaged
// document is skipped with a `W_SOURCE_FAILED` warning, the others still run (AGENTS.md §0).
// The cue grammar (spec 12 P6-E10, `../grammar.ts`) applies here, with the sequence's style as the default: typing
// patterns (text source), the personality's type exclusions and boosts, "music carries the cuts" (a cut inside unmuted
// music, outside dialogue, at half confidence: dropped under balanced, kept under rich, and reported in `carried`), and
// runs of staggered appear / emphasis cues grouped so the budget keeps or drops a run as one unit.
import { sequenceDuration } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import { SOUND_TYPING_MODES } from '../../schema/sound.ts';
import {
	isSoundPersonality,
	MUSIC_CARRIES_CUT_REASON,
	MUSIC_CUT_CONFIDENCE_FACTOR,
	musicPlaysAt,
	RUN_KINDS,
	RUN_MAX_GAP_SEC,
	RUN_MIN_LENGTH,
	RUN_TYPES,
	resolveSoundStyle,
	sequenceSoundStyle,
	styleCueTypes,
} from '../grammar.ts';
import { isSoundTypeId, VISUAL_KINDS } from '../taxonomy.ts';
import { applyBudgets, DENSITY_BUDGETS, mergeCandidates } from './budget.ts';
import { deriveEdgeCues } from './edges.ts';
import { deriveEditCues, dialogueRanges, inRanges } from './edits.ts';
import { beatFramesOf, snapCuesToBeats } from './engine-sources.ts';
import { deriveMarkerCues } from './markers.ts';
import { deriveMgCues } from './mg.ts';
import { deriveCameraCues, deriveMotionCues } from './motion.ts';
import { deriveTextCues } from './text.ts';
import { deriveTransitionCues } from './transitions.ts';
import {
	type CarriedCut,
	CUE_DENSITIES,
	CUE_DERIVE_SOURCES,
	type CueCandidate,
	type CueDeriveSource,
	type CueSpeedCurve,
	type DeriveCuesOptions,
	type DeriveCuesResult,
	type DeriveCuesStats,
	type DeriveCuesWarning,
	type ExtraCue,
	isCueDeriveSource,
} from './types.ts';
import { clamp01, makeContext } from './util.ts';

/** Hard cap of returned cues (whatever `maxCues` asks): bounds the result on hostile documents. */
export const MAX_DERIVED_CUES = 10_000;

function emptyStats(): DeriveCuesStats {
	const bySource = {} as DeriveCuesStats['bySource'];
	for (const s of CUE_DERIVE_SOURCES)
		bySource[s] = { found: 0, kept: 0, merged: 0, droppedByBudget: 0, suppressedByDialogue: 0 };
	return {
		bySource,
		dropped: { rate: 0, gap: 0, maxCues: 0, confidence: 0, range: 0 },
		heroesDemoted: 0,
		heroesUnderDialogue: 0,
		snappedToBeat: 0,
		musicCarriesCuts: 0,
		runs: 0,
		found: 0,
		kept: 0,
	};
}

function sourceSet(s: DeriveCuesOptions['sources']): Set<CueDeriveSource> {
	if (!s) return new Set(CUE_DERIVE_SOURCES);
	const list = s instanceof Set ? [...s] : Array.isArray(s) ? s : [];
	return new Set(list.filter(isCueDeriveSource));
}

const KINDS: ReadonlySet<string> = new Set([...VISUAL_KINDS, 'manual']);

/** Validates an engine-provided cue (untrusted); null when unusable. */
function extraCandidate(x: ExtraCue, i: number): CueCandidate | null {
	if (!x || typeof x !== 'object' || !isCueDeriveSource(x.from)) return null;
	if (!Number.isInteger(x.frame) || !KINDS.has(x.kind as string)) return null;
	if (!x.anchor || typeof x.anchor !== 'object' || typeof (x.anchor as { type?: unknown }).type !== 'string')
		return null;
	const weight = x.weight === 'hero' || x.weight === 'ambient' ? x.weight : 'support';
	const align = x.align === 'start' || x.align === 'end' ? x.align : 'peak';
	const types = Array.isArray(x.types) ? x.types.filter(isSoundTypeId).slice(0, 8) : [];
	const window =
		x.window &&
		Number.isInteger(x.window.start) &&
		Number.isInteger(x.window.end) &&
		x.window.end > x.window.start
			? { start: x.window.start, end: x.window.end }
			: undefined;
	const pan =
		typeof x.pan === 'number' && Number.isFinite(x.pan) ? Math.max(-100, Math.min(100, x.pan)) : undefined;
	const sweep = x.panSweep as { from?: unknown; to?: unknown } | undefined;
	const panSweep =
		sweep &&
		typeof sweep === 'object' &&
		typeof sweep.from === 'number' &&
		Number.isFinite(sweep.from) &&
		typeof sweep.to === 'number' &&
		Number.isFinite(sweep.to)
			? {
					from: Math.max(-100, Math.min(100, sweep.from)),
					to: Math.max(-100, Math.min(100, sweep.to)),
				}
			: undefined;
	return {
		key: typeof x.key === 'string' && x.key ? x.key.slice(0, 200) : `${x.from}:extra:${i}`,
		frame: x.frame,
		kind: x.kind,
		weight,
		types,
		align,
		...(pan !== undefined ? { pan } : {}),
		...(panSweep ? { panSweep } : {}),
		anchor: x.anchor,
		confidence: clamp01(Number(x.confidence)),
		reason: typeof x.reason === 'string' ? x.reason.slice(0, 300) : `${x.from} cue`,
		...(window ? { window } : {}),
		source: x.source === 'marker' ? 'marker' : 'derived',
		from: x.from,
		...(typeof x.group === 'string' && x.group ? { group: x.group.slice(0, 200) } : {}),
		size: typeof x.size === 'number' ? clamp01(x.size) : 1,
	};
}

/** Project sources whose events a measured picture motion may repeat. */
const PIXEL_YIELDS_TO: ReadonlySet<string> = new Set([
	'edits',
	'transitions',
	'keyframes',
	'text',
	'mg',
	'clipEdges',
	'camera3d',
]);
/** How close (frames) a project event must be to a pixel one to describe it (merging covers 2; a measured peak may differ by 1). */
const PIXEL_NEAR_FRAMES = 3;

function describedByProject(c: CueCandidate, project: readonly CueCandidate[]): boolean {
	for (const p of project) {
		if (!PIXEL_YIELDS_TO.has(p.from)) continue;
		if (c.kind === 'cut') {
			if (p.kind === 'cut' || p.kind === 'transition') {
				if (Math.abs(p.frame - c.frame) <= PIXEL_NEAR_FRAMES) return true;
				if (p.window && c.frame >= p.window.start - 2 && c.frame <= p.window.end + 2) return true;
			}
			continue;
		}
		if (Math.abs(p.frame - c.frame) <= PIXEL_NEAR_FRAMES) return true;
		if (p.window && c.frame >= p.window.start - 2 && c.frame < p.window.end + 2) return true;
	}
	return false;
}

/**
 * Groups runs (P6-E10): ≥ 3 consecutive ungrouped appear / emphasis candidates ≤ 0.6 s apart whose best type is pop,
 * ui, chime or tick (staggered cards, successive notifications) share the group `run:<first key>`, so the density
 * budget keeps or drops the run as one unit (a stagger of 4 cards 0.3 s apart is not thinned to 2). Explicit `sfx:`
 * markers are left alone. Returns the number of runs.
 */
function groupRuns(candidates: CueCandidate[], fps: number): number {
	const eligible = candidates
		.filter(
			(c) =>
				!c.group &&
				!c.explicit &&
				c.source !== 'marker' &&
				RUN_KINDS.includes(c.kind) &&
				(RUN_TYPES as readonly string[]).includes(c.types[0] ?? ''),
		)
		.sort((a, b) => a.frame - b.frame || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const maxGap = RUN_MAX_GAP_SEC * fps + 1e-9;
	let runs = 0;
	let i = 0;
	while (i < eligible.length) {
		let j = i + 1;
		while (j < eligible.length && eligible[j]!.frame - eligible[j - 1]!.frame <= maxGap) j++;
		if (j - i >= RUN_MIN_LENGTH) {
			runs++;
			const group = `run:${eligible[i]!.key}`.slice(0, 200);
			for (let k = i; k < j; k++) eligible[k]!.group = group;
		}
		i = j;
	}
	return runs;
}

/**
 * Cue points of a sequence from its edits, transitions, keyframed motion, text animation, motion-graphic templates,
 * graphic clip edges, 3D camera moves and `sfx:` markers; merged within 2 frames and thinned to the density budget.
 * `curves` are the per-frame motion speeds the keyframe and camera sources measured (the Cue Seam draws them).
 */
export function deriveCues(
	doc: ProjectDocument,
	sequenceId: string,
	opts: DeriveCuesOptions = {},
): DeriveCuesResult {
	const stats = emptyStats();
	const warnings: DeriveCuesWarning[] = [];
	const curves: CueSpeedCurve[] = [];
	const empty = (): DeriveCuesResult => ({ cues: [], curves: [], stats, warnings });
	try {
		const seq = doc?.sequences?.[sequenceId];
		if (!seq || typeof seq !== 'object' || !seq.clips || typeof seq.clips !== 'object') {
			warnings.push({ code: 'W_SEQUENCE_NOT_FOUND', message: `Sequence ${String(sequenceId)} not found` });
			return empty();
		}
		let duration = 0;
		try {
			duration = sequenceDuration(seq);
		} catch {
			duration = 0;
		}
		if (!Number.isFinite(duration) || duration < 0) duration = 0;
		const rs = Number.isFinite(opts.range?.start) ? Math.max(0, Math.floor(opts.range!.start)) : 0;
		const re = Number.isFinite(opts.range?.end) ? Math.min(duration, Math.ceil(opts.range!.end)) : duration;
		const range = { start: Math.min(rs, duration), end: Math.max(Math.min(rs, duration), re) };
		const ctx = makeContext(doc, seq, duration, range, (w) => {
			if (warnings.length < 200) warnings.push(w);
		});
		if (opts.voiceActivity && typeof opts.voiceActivity === 'object') ctx.voice = opts.voiceActivity;
		// The grammar's style: the options, else the sequence's `soundDesign.settings.style`, else the defaults.
		const style = resolveSoundStyle(
			{
				...((SOUND_TYPING_MODES as readonly unknown[]).includes(opts.typing) ? { typing: opts.typing } : {}),
				...(typeof opts.musicCarriesCuts === 'boolean' ? { musicCarriesCuts: opts.musicCarriesCuts } : {}),
				...(opts.personality === null || isSoundPersonality(opts.personality)
					? { personality: opts.personality }
					: {}),
			},
			sequenceSoundStyle(seq),
		);
		ctx.typing = style.typing;
		// Where dialogue is heard (computed once: `dialogueSpans`, transcript words / voice activity / dialogue clips).
		let dialogueCache: Array<[number, number]> | null = null;
		const dialogueOf = () => {
			dialogueCache ??= opts.respectDialogue !== false ? dialogueRanges(ctx) : [];
			return dialogueCache;
		};
		const sources = sourceSet(opts.sources);
		const density = (CUE_DENSITIES as readonly string[]).includes(opts.density as string)
			? opts.density!
			: 'balanced';
		const candidates: CueCandidate[] = [];
		const run = (source: CueDeriveSource, f: () => CueCandidate[]) => {
			if (!sources.has(source)) return;
			try {
				const found = f();
				for (const c of found) {
					if (!Number.isInteger(c.frame) || c.frame < range.start || c.frame >= range.end) {
						stats.dropped.range++;
						continue;
					}
					stats.bySource[c.from].found++;
					stats.found++;
					candidates.push(c);
				}
			} catch (e) {
				warnings.push({
					code: 'W_SOURCE_FAILED',
					message:
						`The ${source} source failed on this sequence: ${e instanceof Error ? e.message : String(e)}`.slice(
							0,
							300,
						),
					source,
				});
			}
		};
		if (range.end > range.start) {
			run('edits', () => {
				const r = deriveEditCues(ctx, {
					respectDialogue: opts.respectDialogue !== false,
					dialogue: opts.respectDialogue !== false ? dialogueOf() : [],
				});
				stats.bySource.edits.suppressedByDialogue += r.suppressed;
				return r.cues;
			});
			run('transitions', () => deriveTransitionCues(ctx));
			run('keyframes', () => deriveMotionCues(ctx, { curves }));
			run('text', () => deriveTextCues(ctx));
			run('mg', () => deriveMgCues(ctx, opts.mgTemplates));
			run('clipEdges', () => deriveEdgeCues(ctx, { keyframesSource: sources.has('keyframes') }));
			run('camera3d', () => deriveCameraCues(ctx, { curves }));
			run('markers', () => deriveMarkerCues(ctx));
			const extras = Array.isArray(opts.extraCues) ? opts.extraCues.slice(0, MAX_DERIVED_CUES) : [];
			let bad = 0;
			const valid: CueCandidate[] = [];
			extras.forEach((x, i) => {
				const c = extraCandidate(x, i);
				if (c) valid.push(c);
				else bad++;
			});
			if (bad)
				warnings.push({
					code: 'W_EXTRA_CUE_INVALID',
					message: `${bad} engine cue(s) were malformed and ignored`,
				});
			// Shot changes and pixel cuts are cuts: silent where dialogue is heard, like edit points.
			const dialogue =
				opts.respectDialogue !== false && valid.some((c) => c.kind === 'cut') ? dialogueOf() : [];
			const project = candidates.slice();
			const engine: CueCandidate[] = [];
			for (const c of valid) {
				if (c.kind === 'cut' && inRanges(dialogue, c.frame)) {
					if (sources.has(c.from) && c.frame >= range.start && c.frame < range.end)
						stats.bySource[c.from].suppressedByDialogue++;
					continue;
				}
				engine.push(c);
			}
			for (const s of new Set(engine.map((c) => c.from))) run(s, () => engine.filter((c) => c.from === s));
			// Pixel cues measure the rendered picture: an event a project source already describes keeps that source's cue.
			for (let i = candidates.length - 1; i >= 0; i--) {
				const c = candidates[i]!;
				if (c.from !== 'pixel' || !describedByProject(c, project)) continue;
				candidates.splice(i, 1);
				stats.bySource.pixel.merged++;
			}
		}
		// P6-E10 personality: excluded types out of derived cues (an explicit `sfx:` marker keeps what it asks for).
		if (style.personality)
			for (const c of candidates)
				if (c.source !== 'marker' && !c.explicit) c.types = styleCueTypes(c.types, style.personality);
		// P6-E10 "music carries the cuts": a cut inside unmuted music, outside dialogue, at half its confidence.
		const halved = new Set<CueCandidate>();
		if (style.musicCarriesCuts) {
			const dialogue = candidates.some((c) => c.kind === 'cut') ? dialogueOf() : [];
			for (const c of candidates) {
				if (c.kind !== 'cut' || c.explicit || c.source === 'marker') continue;
				if (inRanges(dialogue, c.frame) || !musicPlaysAt(seq, c.frame)) continue;
				c.confidence = Math.round(c.confidence * MUSIC_CUT_CONFIDENCE_FACTOR * 1e4) / 1e4;
				c.reason = `${c.reason}; ${MUSIC_CARRIES_CUT_REASON}`.slice(0, 2000);
				halved.add(c);
			}
			stats.musicCarriesCuts = halved.size;
		}
		stats.runs = groupRuns(candidates, ctx.fps);
		// No hero under dialogue (spec 12 §1 "Less is more"; P6-R3): a derived hero where speech is heard becomes support.
		// Explicit requests (`sfx:` markers) are the user's and stay as asked.
		if (
			opts.respectDialogue !== false &&
			candidates.some((c) => c.weight === 'hero' && c.source !== 'marker')
		) {
			const dialogue = dialogueOf();
			for (const c of candidates)
				if (c.weight === 'hero' && c.source !== 'marker' && inRanges(dialogue, c.frame)) {
					c.weight = 'support';
					c.reason = `${c.reason}; support: under dialogue`;
					stats.heroesUnderDialogue++;
				}
		}
		const merged = mergeCandidates(candidates, (from) => stats.bySource[from].merged++);
		const maxCues = Number.isFinite(opts.maxCues) ? Math.max(0, Math.floor(opts.maxCues!)) : MAX_DERIVED_CUES;
		const minGap = Number.isFinite(opts.minGapFrames) ? Math.max(0, Math.floor(opts.minGapFrames!)) : 0;
		const cues = applyBudgets(
			merged,
			{ fps: ctx.fps, density, minGapFrames: minGap, maxCues: Math.min(maxCues, MAX_DERIVED_CUES) },
			stats,
		);
		for (const c of cues) stats.bySource[c.from].kept++;
		stats.kept = cues.length;
		// The carried cuts the budget left out for their (halved) confidence, with their reasons.
		const carried: CarriedCut[] = [];
		if (halved.size) {
			const min = DENSITY_BUDGETS[density].minConfidence;
			const keptKeys = new Set(cues.map((c) => c.key));
			for (const m of merged)
				if (halved.has(m) && !keptKeys.has(m.key) && m.confidence < min)
					carried.push({
						key: m.key,
						frame: m.frame,
						confidence: m.confidence,
						minConfidence: min,
						reason: m.reason,
					});
			carried.sort((a, b) => a.frame - b.frame || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		}
		const extra = carried.length ? { carried } : {};
		if (opts.snapToBeats) {
			const beats = Array.isArray(opts.beatFrames)
				? opts.beatFrames.slice(0, MAX_DERIVED_CUES * 10)
				: beatFramesOf(
						Array.isArray(opts.extraCues) ? opts.extraCues.filter((x) => x && typeof x === 'object') : [],
					);
			const snapped = snapCuesToBeats(cues, beats);
			stats.snappedToBeat = snapped.snapped;
			const out = snapped.cues.sort(
				(a, b) => a.frame - b.frame || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
			);
			return { cues: out, curves, stats, warnings, ...extra };
		}
		return { cues, curves, stats, warnings, ...extra };
	} catch (e) {
		warnings.push({
			code: 'W_SOURCE_FAILED',
			message: `Cue derivation failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
		});
		return { cues: [], curves: [], stats: emptyStats(), warnings };
	}
}
