// Ease read-outs for agents (docs/wp-notes/mcp-cli.md § Easing and Trim Paths): the compact per-key ease of the
// `clip.properties` keyframe listings and the detailed `keyframeEasesView` behind MCP get_keyframe_eases (the
// Keyframe Velocity editor's numbers from `describeKeyframeEases`, in sequence frames, with the segments as CSS
// cubic-bezier strings and the built-in preset they match).
import { copyEase, describeKeyframeEases, type EaseSideInfo } from '../commands/handlers/ease-read.ts';
import type { Registries } from '../commands/types.ts';
import { type CubicEase, type EaseCurve, easesToCubic } from '../ease/curve.ts';
import { matchEasePreset } from '../ease/presets.ts';
import { spanEases, spanLeaving } from '../ease/segments.ts';
import { rovingRuns } from '../keyframes.ts';
import { sequenceFrameOfContentTime } from '../registry/properties.ts';
import type { Keyframe } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { formatTimecode } from '../timecode.ts';
import { transitionStartFrame } from '../transitions.ts';

const r4 = (n: number) => {
	const v = Math.round(n * 1e4) / 1e4;
	return Object.is(v, -0) ? 0 : v;
};
const roundValue = (v: unknown): unknown => {
	if (typeof v === 'number') return Number.isFinite(v) ? r4(v) : v;
	if (Array.isArray(v)) return v.map(roundValue);
	return v;
};

/** `cubic-bezier(x1, y1, x2, y2)` with at most four decimals (the form apply_ease takes back). */
export function formatCubicBezier(c: Pick<CubicEase, 'x1' | 'y1' | 'x2' | 'y2'>): string {
	return `cubic-bezier(${r4(c.x1)}, ${r4(c.y1)}, ${r4(c.x2)}, ${r4(c.y2)})`;
}

/** True when both handles lie on the diagonal: progress = time, a linear segment. */
export function isLinearCubic(c: Pick<CubicEase, 'x1' | 'y1' | 'x2' | 'y2'>): boolean {
	return Math.abs(c.x1 - c.y1) < 1e-9 && Math.abs(c.x2 - c.y2) < 1e-9;
}

/** Tolerance for naming a multi-key span after a preset (keys sit on whole flicks; points on arc-length tables). */
const SPAN_MATCH_TOLERANCE = 2e-3;

/** `matchEasePreset` memoised per curve (a read-out matches many identical segments). */
function presetMatcher(tolerance?: number): (curve: EaseCurve) => string | undefined {
	const cache = new Map<string, string | undefined>();
	return (curve) => {
		const key = JSON.stringify(curve);
		if (cache.has(key)) return cache.get(key);
		const id = matchEasePreset(curve, undefined, tolerance)?.id;
		cache.set(key, id);
		return id;
	};
}

/** The compact ease of the segment leaving a key, as `clip.properties` lists it next to `interpolation`. */
export type KeyEaseSummary = {
	/** "hold", "linear" or "cubic-bezier(x1, y1, x2, y2)"; absent on the last key and on roving keys. */
	ease?: string;
	/** The built-in ease preset the segment matches (list_ease_presets); never set for hold / linear. */
	easePreset?: string;
	/** The key roves: it has no time of its own, its run is one segment (eased on the run's first key). */
	roving?: true;
};

/**
 * Per key (in the given order) the segment leaving it as the evaluator draws it: auto-bezier eases derived, a
 * roving run reported once on its first key. Preset matching only runs for shaped segments.
 */
export function keyEaseSummaries(
	keys: readonly Keyframe<unknown>[],
	match: (curve: EaseCurve) => string | undefined = presetMatcher(),
): KeyEaseSummary[] {
	const sorted = [...keys].sort((a, b) => a.time - b.time);
	const runs = rovingRuns(sorted);
	const byId = new Map<string, KeyEaseSummary>();
	sorted.forEach((k, i) => {
		if (runs.some((r) => i > r.a && i < r.b)) {
			byId.set(k.id, { roving: true });
			return;
		}
		const sp = spanLeaving(sorted, i, runs);
		if (!sp) {
			byId.set(k.id, {});
			return;
		}
		const e = spanEases(sorted, sp.a, sp.b);
		if (e.hold) {
			byId.set(k.id, { ease: 'hold' });
			return;
		}
		const c = easesToCubic(e.out, e.in);
		if (isLinearCubic(c)) {
			byId.set(k.id, { ease: 'linear' });
			return;
		}
		const preset = match(c);
		byId.set(k.id, { ease: formatCubicBezier(c), ...(preset ? { easePreset: preset } : {}) });
	});
	return keys.map((k) => byId.get(k.id) ?? {});
}

type SideOut = { influence: number; speed: number; slope: number };

const side = (s: EaseSideInfo | null): SideOut | null =>
	s ? { influence: r4(s.influencePercent), speed: r4(s.speed), slope: r4(s.slope) } : null;

/** Converts a property's key times (flicks) to sequence frames. */
function frameConverter(
	seq: Sequence,
	clip: Clip | null,
	path: readonly string[],
): (flicks: number) => number {
	const rate = seq.settings.frameRate as Rational;
	if (clip) return (t) => sequenceFrameOfContentTime(clip, t, rate);
	const F = flicksPerFrame(rate);
	if (path[0] === 'transition') {
		const tr = seq.transitions[path[1] ?? ''];
		const start = (tr && transitionStartFrame(seq, tr)) ?? 0;
		return (t) => start + Math.round(t / F);
	}
	return (t) => Math.round(t / F);
}

/**
 * Per property (document order): the selected keys (sequence frame, timecode, value, interpolation, in / out
 * influence %, speed in property units per second — sequence px/s along the path for points —, slope relative to
 * the segment's average speed) and the segments in, between and out of them as CSS cubic-bezier strings with the
 * built-in preset each matches and its average speed. With three or more keys of one property, `span` names the
 * preset the whole first … last run matches (multi-point curves: bounce, elastic…). Reads locked tracks too.
 */
export function keyframeEasesView(
	doc: ProjectDocument,
	keyframeIds: readonly string[],
	registries?: Registries,
) {
	const described = describeKeyframeEases(doc, keyframeIds, registries);
	if (!described.ok) return described;
	const match = presetMatcher();
	const matchSpan = presetMatcher(SPAN_MATCH_TOLERANCE);
	const properties = described.properties.map((p) => {
		const seq = doc.sequences[p.sequenceId]!;
		const clip = p.clipId ? (seq.clips[p.clipId] ?? null) : null;
		const frameOf = frameConverter(seq, clip, p.path);
		const tc = (frame: number) =>
			formatTimecode(frame, seq.settings.frameRate as Rational, {
				dropFrame: seq.settings.dropFrame,
				startFrames: seq.settings.startTimecodeFrames,
			});
		const anim = p.keys.map((k) => {
			const frame = frameOf(k.time);
			return {
				id: k.id,
				frame,
				timecode: tc(frame),
				value: roundValue(k.value),
				interpolation: k.interpolation,
				...(k.roving ? { roving: true } : {}),
				in: side(k.easeIn),
				out: side(k.easeOut),
			};
		});
		const segments = p.segments.map((s) => {
			const linear = !s.hold && isLinearCubic(s.curve);
			const preset = s.hold ? undefined : match(s.curve);
			return {
				fromId: s.fromId,
				toId: s.toId,
				section: s.section,
				ease: s.hold ? 'hold' : linear ? 'linear' : formatCubicBezier(s.curve),
				...(preset ? { preset } : {}),
				...(s.roving ? { roving: true } : {}),
				averageSpeed: r4(s.averageSpeed),
			};
		});
		let span: { fromId: string; toId: string; preset: string } | undefined;
		if (p.keys.length >= 3) {
			const copied = copyEase(
				doc,
				p.keys.map((k) => k.id),
				registries,
			);
			if (copied.ok && copied.clip.kind === 'segments' && copied.clip.curve) {
				const preset = matchSpan(copied.clip.curve);
				if (preset) span = { fromId: p.keys[0]!.id, toId: p.keys[p.keys.length - 1]!.id, preset };
			}
		}
		return {
			path: p.path,
			label: p.label,
			...(p.clipId ? { clipId: p.clipId } : {}),
			sequenceId: p.sequenceId,
			spatial: p.spatial,
			keys: anim,
			segments,
			...(span ? { span } : {}),
		};
	});
	return { ok: true as const, properties };
}
