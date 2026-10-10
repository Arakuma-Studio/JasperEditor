// edit-ux: keyframe lanes and rubber bands on timeline clips (Premiere: Show Video/Audio Keyframes, the clip's
// keyframe menu "Opacity ▸ Opacity", "Volume ▸ Level", any effect parameter; helpx "Adjust volume levels" and
// "Working with keyframes in the Timeline"). Pure model: which property a clip shows, value ↔ lane y mapping, the
// band sampled across the clip, keyframe positions, fade lengths, and the document commands of each gesture.
//
// Values are keyed by property keys of the property registry (`opacity`, `volumeDb`, `pan`, `transform.scale`,
// `effects.<fxId>.<param>`, `masks.<maskId>.<prop>`, `params.<name>`). Keyframes live in content time (flicks), so
// lanes follow speed changes, trims and slips. Roving keys (keyframes-blend) are drawn as dots and keep their
// derived times (only their value is edited); expressions (wave expressions) are flagged on the lane.
import {
	type Animatable,
	type Clip,
	clipContentTimeAtFrame,
	type EffectInstance,
	type EffectRegistry,
	effectParamPropertySpec,
	evaluate,
	isRovingKey,
	kindCapabilities,
	MASK_PROPS,
	type Mask,
	type MgTemplateRegistry,
	maskPropertySpec,
	type ParamPath,
	type ProjectDocument,
	type PropertySpec,
	propertiesForClip,
	propertyEvaluateOptions,
	propertyKeyToParamPath,
	type Rational,
	resolvePropertyAt,
	resolvePropertySpec,
	type Sequence,
	sequenceFrameOfContentTime,
} from '@jasper/project';

/** Lanes show on tracks at least this tall (Premiere draws keyframes on expanded tracks). */
export const LANE_MIN_TRACK_PX = 48;
/** Rubber band top of the volume lane: +6 dB (Premiere's clip volume band maximum). */
export const VOLUME_BAND_MAX_DB = 6;
/** Rubber band bottom of the volume lane (−∞ in Premiere's readout). */
export const VOLUME_BAND_MIN_DB = -96;

export type LaneOption = { key: string; label: string; group: string };

const isVisual = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasOpacity;
const isAudio = (c: Pick<Clip, 'kind'>) => {
	const caps = kindCapabilities(c.kind);
	return !!caps && caps.audio && !caps.visual;
};

/** Default lane: Opacity on video clips, Level (volume) on audio clips (Premiere). */
export function defaultLaneKey(c: Pick<Clip, 'kind'>): string | null {
	if (isAudio(c)) return 'volumeDb';
	if (isVisual(c)) return 'opacity';
	return null;
}

/**
 * The property a clip's lane shows: its own choice, else its track's ("Show Clip Keyframes" per track), else the
 * default. `'none'` hides the lane.
 */
export function laneKeyFor(
	display: Record<string, string> | undefined,
	c: Pick<Clip, 'id' | 'trackId' | 'kind'>,
): string | null {
	const v = display?.[c.id] ?? display?.[c.trackId];
	if (v === 'none') return null;
	return v ?? defaultLaneKey(c);
}

type Registries = { effects: EffectRegistry; mgTemplates?: MgTemplateRegistry };

/** Every animatable property a clip can show in its lane, grouped like Effect Controls. */
export function laneOptions(clip: Clip, registries: Registries): LaneOption[] {
	const out: LaneOption[] = [];
	const template =
		clip.kind === 'motion-graphic' && registries.mgTemplates
			? registries.mgTemplates.get(
					(clip as { template: { id: string; version: number } }).template.id,
					(clip as { template: { id: string; version: number } }).template.version,
				)
			: undefined;
	for (const s of propertiesForClip(clip, template)) {
		if (s.animatable === 'no') continue;
		const group =
			s.group === 'motion'
				? 'Motion'
				: s.group === 'opacity'
					? 'Opacity'
					: s.group === 'audio'
						? 'Volume'
						: s.group;
		out.push({ key: s.key, label: s.label, group });
	}
	const c = clip as { effects?: EffectInstance[]; masks?: Mask[] };
	for (const fx of c.effects ?? []) {
		const effect = registries.effects.get(fx.effectId);
		if (!effect) continue;
		for (const p of effect.params) {
			const s = effectParamPropertySpec(fx.id, effect, p);
			if (s.animatable === 'no') continue;
			out.push({ key: s.key, label: s.label, group: effect.label });
		}
	}
	for (const m of c.masks ?? [])
		for (const prop of MASK_PROPS) {
			const s = maskPropertySpec(m.id, prop);
			out.push({ key: s.key, label: s.label, group: m.name ?? 'Mask' });
		}
	return out;
}

/** The spec of a lane key on a clip (effects and masks included). */
export function laneSpec(clip: Clip, key: string, registries: Registries): PropertySpec | null {
	if (key.startsWith('effects.')) {
		const [, fxId, ...rest] = key.split('.');
		const fx = ((clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === fxId);
		const effect = fx ? registries.effects.get(fx.effectId) : undefined;
		const p = effect?.params.find((x) => x.name === rest.join('.'));
		return fx && effect && p ? effectParamPropertySpec(fx.id, effect, p) : null;
	}
	if (key.startsWith('masks.')) {
		const [, maskId, prop] = key.split('.');
		const has = ((clip as { masks?: Mask[] }).masks ?? []).some((m) => m.id === maskId);
		return has && (MASK_PROPS as readonly string[]).includes(prop!)
			? maskPropertySpec(maskId!, prop as never)
			: null;
	}
	const template =
		clip.kind === 'motion-graphic' && registries.mgTemplates
			? registries.mgTemplates.get(
					(clip as { template: { id: string; version: number } }).template.id,
					(clip as { template: { id: string; version: number } }).template.version,
				)
			: undefined;
	const s = resolvePropertySpec(key, template, undefined, clip as never);
	return s?.appliesTo(clip) && s.animatable !== 'no' ? s : null;
}

export function lanePath(clip: Clip, key: string): ParamPath {
	return propertyKeyToParamPath({ clipId: clip.id }, key);
}

// ---------------------------------------------------------------- value ↔ y

/** Whether a lane draws a band (numbers) or only keyframe marks (vectors, colours, paths…). */
export const hasBand = (s: Pick<PropertySpec, 'kind'>) => s.kind === 'number';

function isVolume(s: Pick<PropertySpec, 'key'>): boolean {
	return s.key === 'volumeDb';
}

/** The value range a lane spans (soft range when given, else the hard range; volume −∞ … +6 dB). */
export function laneRange(
	s: Pick<PropertySpec, 'key' | 'range'>,
	anim?: Animatable<unknown> | null,
): [number, number] {
	if (isVolume(s)) return [VOLUME_BAND_MIN_DB, VOLUME_BAND_MAX_DB];
	const r = s.range ?? {};
	let lo = r.softMin ?? r.min;
	let hi = r.softMax ?? r.max;
	if (lo === undefined || hi === undefined) {
		const vals = [anim?.value, ...(anim?.keyframes ?? []).map((k) => k.value)].filter(
			(v): v is number => typeof v === 'number' && Number.isFinite(v),
		);
		const a = Math.min(0, ...vals);
		const b = Math.max(1, ...vals);
		lo ??= a;
		hi ??= b + (b - a) * 0.25;
	}
	return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** Volume band position from dB: p = √(amplitude / amplitude(+6 dB)), −96 dB (−∞) at the bottom. */
function volumeFraction(db: number): number {
	if (db <= VOLUME_BAND_MIN_DB) return 0;
	const a = 10 ** (db / 20);
	const amax = 10 ** (VOLUME_BAND_MAX_DB / 20);
	return Math.min(1, Math.sqrt(a / amax));
}

function volumeFromFraction(p: number): number {
	if (p <= 0) return VOLUME_BAND_MIN_DB;
	const amax = 10 ** (VOLUME_BAND_MAX_DB / 20);
	const db = 20 * Math.log10(p * p * amax);
	return Math.max(VOLUME_BAND_MIN_DB, Math.min(VOLUME_BAND_MAX_DB, Math.round(db * 100) / 100));
}

/** y (0 = top of the lane) of a value in a lane of height `h`. */
export function valueToY(
	s: Pick<PropertySpec, 'key' | 'range'>,
	v: number,
	h: number,
	range = laneRange(s),
): number {
	const f = isVolume(s) ? volumeFraction(v) : (v - range[0]) / (range[1] - range[0]);
	return (1 - Math.min(1, Math.max(0, f))) * h;
}

/** The value at lane y (clamped to the lane's range, rounded to the property's step). */
export function yToValue(
	s: Pick<PropertySpec, 'key' | 'range'>,
	y: number,
	h: number,
	range = laneRange(s),
): number {
	const f = Math.min(1, Math.max(0, 1 - y / Math.max(1, h)));
	if (isVolume(s)) return volumeFromFraction(f);
	const v = range[0] + f * (range[1] - range[0]);
	const step = s.range?.step ?? 0.01;
	const rounded = Math.round(v / step) * step;
	return Math.round(rounded * 1e6) / 1e6;
}

/** Readout of a lane value (Premiere's tooltip: "Level: −3.52 dB", "Opacity: 50.0 %"). */
export function formatLaneValue(s: Pick<PropertySpec, 'key' | 'unit' | 'label'>, v: number): string {
	if (isVolume(s) && v <= VOLUME_BAND_MIN_DB) return `${s.label}: −∞ dB`;
	const n = Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
	return `${s.label}: ${n.replace('-', '−')}${s.unit ? ` ${s.unit}` : ''}`;
}

// ---------------------------------------------------------------- band and keys

export type LaneKey = {
	id: string;
	/** Clip-local x in px from the clip start. */
	x: number;
	frame: number;
	time: number;
	value: unknown;
	y: number | null;
	roving: boolean;
	hold: boolean;
};

export type LaneModel = {
	spec: PropertySpec;
	path: ParamPath;
	anim: Animatable<unknown> | null;
	range: [number, number];
	/** Static value when not animated. */
	value: unknown;
	keys: LaneKey[];
	/** Band polyline points (clip-local px), empty for non-number lanes. */
	band: [number, number][];
	expression: { enabled: boolean } | null;
	/** The keyframed value at a sequence frame of the clip (clamped to the clip). */
	valueAt(frame: number): unknown;
};

/** The lane of `clip` for property `spec`, `w` px wide and `h` px tall at `pxPerFrame`. */
export function laneModel(
	doc: Pick<ProjectDocument, 'media' | 'synthetics'>,
	seq: Pick<Sequence, 'settings'>,
	clip: Clip,
	spec: PropertySpec,
	h: number,
	pxPerFrame: number,
	visible?: { x0: number; x1: number },
): LaneModel {
	const rate = seq.settings.frameRate as Rational;
	const r = resolvePropertyAt({ doc, seq, clip }, spec, clip.start);
	const anim = r.anim;
	const range = laneRange(spec, anim);
	const opts = propertyEvaluateOptions(spec);
	const band = hasBand(spec);
	const keys: LaneKey[] = (anim?.keyframes ?? [])
		.map((k, i, all): LaneKey | null => {
			const frame = sequenceFrameOfContentTime(clip, k.time, rate);
			if (frame < clip.start || frame > clip.start + clip.duration) return null;
			return {
				id: k.id,
				x: (frame - clip.start) * pxPerFrame,
				frame,
				time: k.time,
				value: k.value,
				y: band && typeof k.value === 'number' ? valueToY(spec, k.value, h, range) : null,
				roving: isRovingKey(all, i),
				hold: k.interpolation === 'hold',
			};
		})
		.filter((k): k is LaneKey => !!k);
	const points: [number, number][] = [];
	if (band) {
		const w = clip.duration * pxPerFrame;
		const x0 = Math.max(0, visible?.x0 ?? 0);
		const x1 = Math.min(w, visible?.x1 ?? w);
		const at = (x: number) => {
			const frame = clip.start + Math.min(clip.duration - 1e-6, x / pxPerFrame);
			const { time } = clipContentTimeAtFrame(clip, frame, rate);
			const v = anim ? evaluate(anim, time, opts) : r.value;
			return typeof v === 'number' ? valueToY(spec, v, h, range) : h;
		};
		if (!anim || anim.keyframes.length === 0) {
			const y = at(0);
			points.push([x0, y], [x1, y]);
		} else {
			// Every 3 px plus the exact keyframe positions (corners stay sharp).
			const xs = new Set<number>([x0, x1]);
			for (let x = x0; x < x1; x += 3) xs.add(x);
			for (const k of keys) if (k.x >= x0 && k.x <= x1) xs.add(k.x);
			for (const x of [...xs].sort((a, b) => a - b)) points.push([x, at(x)]);
		}
	}
	const expr = anim?.expression;
	const valueAt = (frame: number) => {
		const { time } = clipContentTimeAtFrame(clip, frame, rate);
		return anim ? evaluate(anim, time, opts) : r.value;
	};
	return {
		valueAt,
		spec,
		path: lanePath(clip, spec.key),
		anim,
		range,
		value: r.value,
		keys,
		band: points,
		expression: expr ? { enabled: expr.enabled } : null,
	};
}

/** Index of the key at clip-local `x`,`y` (within `tol` px), or -1. */
export function keyAt(m: Pick<LaneModel, 'keys'>, x: number, y: number, h: number, tol = 5): number {
	let best = -1;
	let bd = Number.POSITIVE_INFINITY;
	m.keys.forEach((k, i) => {
		const ky = k.y ?? h / 2;
		const d = Math.hypot(k.x - x, ky - y);
		if (d <= tol && d < bd) {
			bd = d;
			best = i;
		}
	});
	return best;
}

/** Whether `y` is within `tol` px of the band at clip-local `x`. */
export function onBand(m: Pick<LaneModel, 'band'>, x: number, y: number, tol = 4): boolean {
	const b = m.band;
	for (let i = 1; i < b.length; i++) {
		const [x0, y0] = b[i - 1]!;
		const [x1, y1] = b[i]!;
		if (x < x0 || x > x1) continue;
		const yy = x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
		return Math.abs(yy - y) <= tol;
	}
	return false;
}

/** The two keys bounding clip-local `x` (indices into `keys`; -1 when none on that side). */
export function segmentAt(m: Pick<LaneModel, 'keys'>, x: number): [number, number] {
	let a = -1;
	let b = -1;
	m.keys.forEach((k, i) => {
		if (k.x <= x) a = i;
		else if (b === -1) b = i;
	});
	return [a, b];
}

// ---------------------------------------------------------------- fades (fade handles)

/** The lane's "silent / transparent" value a fade starts or ends at. */
export function fadeFloor(s: Pick<PropertySpec, 'key' | 'range'>): number {
	if (isVolume(s)) return VOLUME_BAND_MIN_DB;
	return s.range?.min ?? 0;
}

/**
 * Current fade-in / fade-out length in frames: a key at the clip's first (last) frame at the floor value followed
 * (preceded) by another key. 0 = no fade.
 */
export function fadeLengths(
	m: LaneModel,
	clip: Pick<Clip, 'start' | 'duration'>,
): { in: number; out: number } {
	const floor = fadeFloor(m.spec);
	const ks = [...m.keys].sort((a, b) => a.frame - b.frame);
	const first = ks[0];
	const last = ks[ks.length - 1];
	const end = clip.start + clip.duration;
	return {
		in: first && first.frame === clip.start && first.value === floor && ks[1] ? ks[1].frame - clip.start : 0,
		out:
			last && (last.frame === end - 1 || last.frame === end) && last.value === floor && ks.length > 1
				? last.frame - ks[ks.length - 2]!.frame
				: 0,
	};
}

/**
 * Commands that set a fade of `frames` at the clip's `side` (Premiere-style fade handle, as in FCP / Resolve): keys
 * inside the fade are replaced by a floor key at the clip edge and a key at the fade end holding the value the
 * property has there without the fade. `frames` 0 removes the fade.
 */
export function fadeCommands(
	m: LaneModel,
	clip: Pick<Clip, 'start' | 'duration'>,
	side: 'in' | 'out',
	frames: number,
): unknown[] {
	const end = clip.start + clip.duration;
	const cur = fadeLengths(m, clip)[side];
	const edgeFrame = side === 'in' ? clip.start : end - 1;
	const n = Math.max(0, Math.min(clip.duration - 1, Math.round(frames)));
	// Keys of the current fade and any key inside the new fade go.
	const lo = side === 'in' ? clip.start : end - 1 - Math.max(cur, n);
	const hi = side === 'in' ? clip.start + Math.max(cur, n) : end;
	// Inclusive: the old fade's far key goes too (a new one is written at the new fade's end).
	const gone = m.keys.filter((k) => k.frame >= lo && k.frame <= hi);
	const others = m.keys.filter((k) => !gone.includes(k));
	// The level the fade reaches: the property's value at the far end of the longer fade (old or new), which is
	// the level without the fade there.
	const farOld = side === 'in' ? hi : lo;
	const full = (() => {
		const v = m.valueAt(farOld);
		return typeof v === 'number' && v !== fadeFloor(m.spec) ? v : typeof m.value === 'number' ? m.value : 0;
	})();
	const cmds: unknown[] = [];
	if (gone.length) cmds.push({ type: 'keyframe.remove', keyframeIds: gone.map((k) => k.id) });
	if (n > 0) {
		const farFrame = side === 'in' ? clip.start + n : end - 1 - n;
		cmds.push(
			{ type: 'keyframe.add', target: m.path, at: { sequenceFrame: edgeFrame }, value: fadeFloor(m.spec) },
			{ type: 'keyframe.add', target: m.path, at: { sequenceFrame: farFrame }, value: full },
		);
	} else if (gone.length && others.length === 0) {
		// Removing the only keys: the property keeps the full level as its static value.
		cmds.push({ type: 'param.set', target: m.path, value: full });
	}
	return cmds;
}
