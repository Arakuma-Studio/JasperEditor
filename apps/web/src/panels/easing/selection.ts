// Easing panel ▸ what the keyframe selection is: per property (Effect Controls row) the selected keys, the
// segments between them as normalised cubic-bezier curves (x = time fraction, y = fraction of the value change;
// the keyframe model's {influence, slope} map onto them exactly, `easesToCubic`), and — for three or more keys of a
// numeric property — the whole span as one multi-point curve. Also why nothing can be eased (no selection, track
// keys, read-only project, locked track), so every control can say why it is disabled.
import {
	type Clip,
	type CubicEase,
	type Ease,
	type EaseCurve,
	type EaseCurvePoint,
	type EffectRegistry,
	easesToCubic,
	incomingEase,
	type Keyframe,
	type MgTemplateRegistry,
	type MultiEase,
	outgoingEase,
	type ParamPath,
	type ProjectDocument,
	type Sequence,
} from '@jasper/project';
import { t } from '../../i18n/runtime.ts';
import { buildGroups, type FxSection } from '../effectControls/items.ts';
import type { Row } from '../properties/lib/model.ts';
import { clampY, LINEAR_EASE_CURVE, sanitizeMulti } from './curve-edit.ts';

export type EaseSegmentInfo = {
	fromId: string;
	toId: string;
	/** Null for a hold segment (no curve: the value jumps at the next key). */
	curve: CubicEase | null;
	/** Both keys of the segment are selected. */
	inner: boolean;
};

export type EasePropertyInfo = {
	/** Row id (property key) — stable across renders. */
	id: string;
	label: string;
	path: ParamPath | null;
	kind: string;
	/** Point property with a motion path (Position, Anchor Point…). */
	spatial: boolean;
	/** Keys the property has in all. */
	total: number;
	/** The selected keys of this property, in time order, with their index among all its keys. */
	keys: {
		id: string;
		index: number;
		time: number;
		value: unknown;
		interpolation: Keyframe<unknown>['interpolation'];
		easeIn: Ease;
		easeOut: Ease;
	}[];
	/** Segment into the first selected key, between selected keys, and after the last one (when they exist). */
	segments: EaseSegmentInfo[];
	/** The span from the first to the last selected key as one curve (cubic for one segment), or null. */
	curve: EaseCurve | null;
};

export type EaseSelection = {
	clipId: string | null;
	keyframeIds: string[];
	properties: EasePropertyInfo[];
	/** Why nothing can be eased right now; null when the selection is editable. */
	blocked: string | null;
};

/** Nothing selected (the reason is translated when it is read). */
export const noEaseSelection = (): EaseSelection => ({
	clipId: null,
	keyframeIds: [],
	properties: [],
	blocked: t('Select keyframes in Effect Controls'),
});

/** Every property row of a section, including masks, text animators, selectors and puppet pins. */
function sectionRows(s: FxSection): Row[] {
	const rows = [...s.rows];
	for (const b of s.masks?.blocks ?? []) rows.push(...b.rows);
	const t = s.textAnimators;
	if (t) {
		if (t.sourceText) rows.push(t.sourceText);
		rows.push(...t.path.rows, ...t.more);
		for (const a of t.animators) {
			rows.push(...a.rows);
			for (const sel of a.selectors) rows.push(...sel.rows, ...sel.advanced);
		}
	}
	for (const p of s.puppet?.pins ?? []) rows.push(...p.rows);
	return rows;
}

/** The cubic of segment i → i+1 as the evaluator plays it (linear keys straight, holds null). */
export function segmentCurve(kfs: readonly Keyframe<unknown>[], i: number): CubicEase | null {
	const a = kfs[i];
	if (!a || !kfs[i + 1]) return null;
	if (a.interpolation === 'hold') return null;
	if (a.interpolation === 'linear') return { ...LINEAR_EASE_CURVE };
	return easesToCubic(outgoingEase(kfs, i), incomingEase(kfs, i + 1));
}

/** Fractions of the total change along keys (numbers signed; numeric vectors by cumulative distance). */
function progressOf(values: readonly unknown[]): number[] | null {
	if (values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
		const a = values[0] as number;
		const span = (values[values.length - 1] as number) - a;
		if (!(Math.abs(span) > 1e-12)) return null;
		return values.map((v) => ((v as number) - a) / span);
	}
	const isVec = (v: unknown): v is number[] =>
		Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
	if (!values.every(isVec)) return null;
	const cum = [0];
	for (let i = 1; i < values.length; i++) {
		const a = values[i - 1] as number[];
		const b = values[i] as number[];
		if (a.length !== b.length) return null;
		cum.push(cum[i - 1]! + Math.hypot(...a.map((x, k) => b[k]! - x)));
	}
	const total = cum[cum.length - 1]!;
	return total > 1e-12 ? cum.map((c) => c / total) : null;
}

/**
 * Keys `from…to` (inclusive, at least three) as one multi-point curve: each key a point at (time fraction,
 * progress), each segment's handles scaled from its own cubic into the span. Null when a segment holds or the
 * values do not change.
 */
export function spanCurve(kfs: readonly Keyframe<unknown>[], from: number, to: number): MultiEase | null {
	if (to - from < 2) return null;
	const keys = kfs.slice(from, to + 1);
	const t0 = keys[0]!.time;
	const span = keys[keys.length - 1]!.time - t0;
	const prog = progressOf(keys.map((k) => k.value));
	if (!(span > 0) || !prog) return null;
	const points: EaseCurvePoint[] = keys.map((k, j) => ({ x: (k.time - t0) / span, y: clampY(prog[j]!) }));
	for (let j = 0; j + 1 < points.length; j++) {
		const c = segmentCurve(kfs, from + j);
		if (!c) return null;
		const a = points[j]!;
		const b = points[j + 1]!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		a.out = [a.x + c.x1 * dx, a.y + c.y1 * dy];
		b.in = [a.x + c.x2 * dx, a.y + c.y2 * dy];
	}
	return sanitizeMulti(points);
}

/** The property's keys among `want`, its segments and its span curve. */
function propertyInfo(
	row: Row,
	kfs: readonly Keyframe<unknown>[],
	want: ReadonlySet<string>,
): EasePropertyInfo {
	const b = row.bindings[0]!;
	const keys = kfs
		.map((k, index) => ({
			id: k.id,
			index,
			time: k.time,
			value: k.value,
			interpolation: k.interpolation,
			easeIn: { influence: k.easeIn.influence, slope: k.easeIn.slope },
			easeOut: { influence: k.easeOut.influence, slope: k.easeOut.slope },
		}))
		.filter((k) => want.has(k.id));
	const first = keys[0]!.index;
	const last = keys[keys.length - 1]!.index;
	const selected = new Set(keys.map((k) => k.index));
	const segments: EaseSegmentInfo[] = [];
	for (let i = Math.max(0, first - 1); i < Math.min(kfs.length - 1, last + 1); i++)
		segments.push({
			fromId: kfs[i]!.id,
			toId: kfs[i + 1]!.id,
			curve: segmentCurve(kfs, i),
			inner: selected.has(i) && selected.has(i + 1),
		});
	let curve: EaseCurve | null = null;
	if (last - first === 1) curve = segmentCurve(kfs, first);
	else if (last - first >= 2) curve = spanCurve(kfs, first, last);
	else {
		// One key: the segment leaving it, else the one arriving.
		curve = segmentCurve(kfs, first) ?? (first > 0 ? segmentCurve(kfs, first - 1) : null);
	}
	return {
		id: row.id,
		label: row.label,
		path: b.path,
		kind: row.spec.kind,
		spatial: !!row.spec.spatial,
		total: kfs.length,
		keys,
		segments,
		curve,
	};
}

/** Reads the keyframe selection of the active sequence. */
export function readEaseSelection(
	doc: ProjectDocument,
	seq: Sequence | null,
	keySel: { clipOrTrackId: string; keyframeIds: readonly string[] } | null,
	opts: {
		frame: number;
		registries: { effects: EffectRegistry; mgTemplates: MgTemplateRegistry };
		readOnly: boolean;
	},
): EaseSelection {
	if (!seq || !keySel || keySel.keyframeIds.length === 0) return noEaseSelection();
	const clip: Clip | undefined = seq.clips[keySel.clipOrTrackId];
	const base = { clipId: clip?.id ?? null, keyframeIds: [...keySel.keyframeIds], properties: [] };
	if (!clip) return { ...base, blocked: t('Track keyframes cannot be eased here; select clip keyframes') };
	const want = new Set(keySel.keyframeIds);
	const properties: EasePropertyInfo[] = [];
	const seen = new Set<string>();
	for (const g of buildGroups(doc, seq, [clip], opts.frame, opts.registries))
		for (const s of g.sections)
			for (const r of sectionRows(s)) {
				const kfs = r.bindings[0]?.resolved.anim?.keyframes as Keyframe<unknown>[] | undefined;
				if (!kfs?.some((k) => want.has(k.id))) continue;
				const id = kfs.find((k) => want.has(k.id))!.id;
				if (seen.has(id)) continue;
				seen.add(id);
				properties.push(propertyInfo(r, kfs, want));
			}
	const track = [...seq.videoTracks, ...seq.audioTracks].find((t) => t.id === clip.trackId);
	const blocked = opts.readOnly
		? t('The project is open read-only')
		: track?.locked
			? t('The clip’s track is locked')
			: properties.length === 0
				? t('The selected keyframes are not on an easable property')
				: null;
	return { ...base, properties, blocked };
}

/** Keys of point properties (spatial) among the selection. */
export function spatialKeyIds(sel: EaseSelection): string[] {
	return sel.properties.filter((p) => p.spatial).flatMap((p) => p.keys.map((k) => k.id));
}
