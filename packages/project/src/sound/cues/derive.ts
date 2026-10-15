// `deriveCues` (spec 12 §2.2 "Derivation", P2-R3): cue points read from the edit itself. Pure and deterministic: the
// same document and options give the same cues in the same order. Never throws: a source that fails on a damaged
// document is skipped with a `W_SOURCE_FAILED` warning, the others still run (AGENTS.md §0).
import { sequenceDuration } from '../../derive/index.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import { isSoundTypeId, VISUAL_KINDS } from '../taxonomy.ts';
import { applyBudgets, mergeCandidates } from './budget.ts';
import { deriveEdgeCues } from './edges.ts';
import { deriveEditCues } from './edits.ts';
import { deriveMarkerCues } from './markers.ts';
import { deriveMgCues } from './mg.ts';
import { deriveCameraCues, deriveMotionCues } from './motion.ts';
import { deriveTextCues } from './text.ts';
import { deriveTransitionCues } from './transitions.ts';
import {
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
	return {
		key: typeof x.key === 'string' && x.key ? x.key.slice(0, 200) : `${x.from}:extra:${i}`,
		frame: x.frame,
		kind: x.kind,
		weight,
		types,
		align,
		...(pan !== undefined ? { pan } : {}),
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
				const r = deriveEditCues(ctx, { respectDialogue: opts.respectDialogue !== false });
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
			for (const s of new Set(valid.map((c) => c.from))) run(s, () => valid.filter((c) => c.from === s));
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
		return { cues, curves, stats, warnings };
	} catch (e) {
		warnings.push({
			code: 'W_SOURCE_FAILED',
			message: `Cue derivation failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
		});
		return { cues: [], curves: [], stats: emptyStats(), warnings };
	}
}
