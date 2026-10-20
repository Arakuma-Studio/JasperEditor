// Easing panel ▸ what the keyframe selection is, read with the model's `describeKeyframeEases` (per property: the
// selected keys with their effective eases — influence, slope, speed — and the in / middle / out segments as
// cubic-bezier curves). The editor shows one curve per property: the segment between two selected keys, the whole
// span of three or more keys as a multi-point curve (`copyEase`), or around a single key its leaving (else arriving)
// segment. Also why nothing can be eased (no selection, read-only project, locked track), so every control can say
// why it is disabled.
import {
	copyEase,
	describeKeyframeEases,
	type EaseCurve,
	type EaseKeyInfo,
	type EaseSegmentInfo,
	type EffectInstance,
	getPropertySpec,
	type ParamPath,
	type ProjectDocument,
	type Registries,
	type Sequence,
} from '@jasper/project';
import { t } from '../../i18n/runtime.ts';

export type { EaseKeyInfo, EaseSegmentInfo };

export type EasePropertyInfo = {
	/** Stable id (the parameter path). */
	id: string;
	label: string;
	path: ParamPath;
	/** Value kind of the property (`number`, `vec2`, `vec3`, `color`, other). */
	kind: string;
	/** Point property with a motion path (Position, Anchor Point…). */
	spatial: boolean;
	/** The selected keys in time order. */
	keys: EaseKeyInfo[];
	/** The segments into, between and after the selected keys. */
	segments: EaseSegmentInfo[];
	/** The curve the editor shows for this property, or null (holds only). */
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

function kindOf(v: unknown): string {
	if (typeof v === 'number') return 'number';
	if (Array.isArray(v) && v.every((x) => typeof x === 'number'))
		return v.length === 2 ? 'vec2' : v.length === 3 ? 'vec3' : v.length === 4 ? 'color' : 'json';
	return typeof v;
}

/**
 * A readable name for a parameter path: the property's label (`transform.position` → Position), or
 * "<effect>: <parameter>" for an effect parameter; else the model's label.
 */
function displayLabel(seq: Sequence, path: ParamPath, fallback: string, registries: Registries) {
	if (path[0] === 'clip') return getPropertySpec(path.slice(2).join('.'))?.label ?? fallback;
	if (path[0] === 'effect') {
		for (const c of Object.values(seq.clips)) {
			const fx = ((c as { effects?: EffectInstance[] }).effects ?? []).find((f) => f.id === path[1]);
			if (!fx) continue;
			const spec = registries.effects.get(fx.effectId);
			const param = spec?.params.find((x) => x.name === path[2]);
			return spec && param ? `${spec.label}: ${param.label}` : fallback;
		}
	}
	return fallback;
}

/** The curve shown for one property. */
function propertyCurve(
	doc: ProjectDocument,
	keys: readonly EaseKeyInfo[],
	segments: readonly EaseSegmentInfo[],
	registries: Registries,
): EaseCurve | null {
	const live = (s: EaseSegmentInfo | undefined) => (s && !s.hold ? s.curve : null);
	const middle = segments.filter((s) => s.section === 'middle');
	if (middle.length >= 2) {
		const c = copyEase(
			doc,
			keys.map((k) => k.id),
			registries,
		);
		if (c.ok && c.clip.kind === 'segments' && c.clip.curve) return c.clip.curve;
		return middle.map(live).find((x) => x) ?? null;
	}
	if (middle.length === 1) return live(middle[0]);
	return live(segments.find((s) => s.section === 'out')) ?? live(segments.find((s) => s.section === 'in'));
}

/** Reads the keyframe selection of the active sequence. */
export function readEaseSelection(
	doc: ProjectDocument,
	seq: Sequence | null,
	keySel: { clipOrTrackId: string; keyframeIds: readonly string[] } | null,
	opts: { registries: Registries; readOnly: boolean },
): EaseSelection {
	if (!seq || !keySel || keySel.keyframeIds.length === 0) return noEaseSelection();
	const clip = seq.clips[keySel.clipOrTrackId];
	const base = { clipId: clip?.id ?? null, keyframeIds: [...keySel.keyframeIds] };
	const r = describeKeyframeEases(doc, keySel.keyframeIds, opts.registries);
	if (!r.ok) return { ...base, properties: [], blocked: r.message };
	const properties = r.properties.map(
		(p): EasePropertyInfo => ({
			id: p.path.join('/'),
			label: displayLabel(seq, p.path, p.label, opts.registries),
			path: p.path,
			kind: kindOf(p.keys[0]?.value),
			spatial: p.spatial,
			keys: p.keys,
			segments: p.segments,
			curve: propertyCurve(doc, p.keys, p.segments, opts.registries),
		}),
	);
	const trackId = clip?.trackId ?? keySel.clipOrTrackId;
	const track = [...seq.videoTracks, ...seq.audioTracks].find((tr) => tr.id === trackId);
	const blocked = opts.readOnly
		? t('The project is open read-only')
		: track?.locked
			? clip
				? t('The clip’s track is locked')
				: t('The track is locked')
			: properties.length === 0
				? t('The selected keyframes are not on an easable property')
				: null;
	return { ...base, properties, blocked };
}

/** Keys of point properties (spatial) among the selection. */
export function spatialKeyIds(sel: EaseSelection): string[] {
	return sel.properties.filter((p) => p.spatial).flatMap((p) => p.keys.map((k) => k.id));
}
