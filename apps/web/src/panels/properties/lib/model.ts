// Inspector model shared by the Properties and Effect Controls panels (S03 §11–§14, S05:PRP/ECP).
// Pure functions: which clips are inspected, the per-clip "bindings" of a property row, mixed values,
// and the document commands for every edit (set, relative scrub, stopwatch, ◆, navigation, reset).
// Everything goes through the property registry and the document command API (S03:PRP-020).
import {
	type Clip,
	type Command,
	CROP_EFFECT,
	type EffectInstance,
	type EffectSpec,
	effectParamPropertySpec,
	isKnownClipKind,
	kindCapabilities,
	type MgTemplateRegistry,
	type ParamPath,
	type ParamSpec,
	type ProjectDocument,
	type PropertySpec,
	propertyDefault,
	propertyKeyToParamPath,
	propertyWriteCommand,
	type ResolvedProperty,
	resolvePropertyAt,
	resolvePropertySpec,
	type Sequence,
	sequenceFrameOfContentTime,
} from '@jasper/project';

export type InspectorSelection = {
	seq: Sequence;
	/** Selected clips of the active sequence, in selection order. */
	clips: Clip[];
	primary: Clip | null;
};

/** The clips the inspector edits: the timeline selection restricted to the active sequence. */
export function selectInspector(
	doc: ProjectDocument,
	activeSequenceId: string | null,
	clipIds: readonly string[],
	primaryId: string | null,
): InspectorSelection | null {
	const seq = activeSequenceId ? doc.sequences[activeSequenceId] : undefined;
	if (!seq) return null;
	const clips = clipIds.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
	const primary = (primaryId ? seq.clips[primaryId] : undefined) ?? clips[clips.length - 1] ?? null;
	return { seq, clips, primary };
}

export const isVisualClip = (c: Clip) => isKnownClipKind(c.kind) && !!kindCapabilities(c.kind)?.hasTransform;
export const isAudioClip = (c: Clip) => c.kind === 'audio' || c.kind === 'nest-audio';

// ---------------------------------------------------------------- bindings

/** One clip's side of a property row. */
export type Binding = {
	clip: Clip;
	spec: PropertySpec;
	/** ParamPath of the stored parameter; null while its owner (the crop effect) does not exist yet. */
	path: ParamPath | null;
	resolved: ResolvedProperty;
	/** Commands creating the owner with initial params and declaring `ref` (crop on first edit). */
	create?: (ref: string, params?: Record<string, unknown>) => Command[];
	/** Param name inside the owner (effect params). */
	param?: string;
};

export type Row = {
	/** Stable row id (property key with `effects.<fxId>` collapsed for crop rows). */
	id: string;
	label: string;
	/** Representative spec (first binding). */
	spec: PropertySpec;
	bindings: Binding[];
};

export function templateOf(clip: Clip, mg: MgTemplateRegistry) {
	return clip.kind === 'motion-graphic' ? mg.get(clip.template.id, clip.template.version) : undefined;
}

/** Binding of a registry property (`opacity`, `transform.scale`, `params.title`…) on a clip. */
export function bindProperty(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	key: string,
	frame: number,
	mg?: MgTemplateRegistry,
): Binding | null {
	// M2 (wp-m2-text-anim, S11:TXA-007): the clip resolves its dynamic `textAnimation.<side>.params.*` keys.
	const spec = resolvePropertySpec(key, mg ? templateOf(clip, mg) : undefined, undefined, clip);
	if (!spec?.appliesTo(clip)) return null;
	const resolved = resolvePropertyAt({ doc, seq, clip }, spec, frame);
	return { clip, spec, path: propertyKeyToParamPath({ clipId: clip.id }, key), resolved };
}

/** Binding of one param of an applied effect instance. */
export function bindEffectParam(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	fx: EffectInstance,
	effect: EffectSpec,
	param: ParamSpec,
	frame: number,
): Binding {
	const spec = effectParamPropertySpec(fx.id, effect, param);
	return {
		clip,
		spec,
		path: ['effect', fx.id, param.name],
		resolved: resolvePropertyAt({ doc, seq, clip }, spec, frame),
		param: param.name,
	};
}

export function cropEffectOf(clip: Clip): EffectInstance | null {
	return (
		((clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.effectId === CROP_EFFECT.id) ??
		null
	);
}

/**
 * The pinned Crop section (ARCHITECTURE §2.3): shows the clip's first `jasper.crop` effect, or registry
 * defaults when there is none; the first edit creates the effect at stack index 0.
 */
export function bindCrop(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	param: string,
	frame: number,
): Binding {
	const p = CROP_EFFECT.params.find((x) => x.name === param)!;
	const fx = cropEffectOf(clip);
	if (fx) return bindEffectParam(doc, seq, clip, fx, CROP_EFFECT, p, frame);
	const spec = effectParamPropertySpec('new', CROP_EFFECT, p);
	return {
		clip,
		spec,
		path: null,
		param,
		resolved: { value: p.default, animated: false, anim: null, time: 0, outside: false },
		create: (ref, params) => [
			{
				type: 'effect.add',
				target: { clipId: clip.id },
				effectId: CROP_EFFECT.id,
				index: 0,
				...(params ? { params } : {}),
				ref,
			} as Command,
		],
	};
}

export function makeRow(id: string, bindings: (Binding | null)[]): Row | null {
	const list = bindings.filter((b): b is Binding => !!b);
	if (list.length === 0) return null;
	return { id, label: list[0]!.spec.label, spec: list[0]!.spec, bindings: list };
}

// ---------------------------------------------------------------- display state

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Shared value of a row: equal values display normally, differing ones as mixed (S03:INS-004). */
export function rowValue(row: Row): { mixed: boolean; value: unknown } {
	const first = row.bindings[0]!.resolved.value;
	const mixed = row.bindings.some((b) => !same(b.resolved.value, first));
	return { mixed, value: mixed ? null : first };
}

/** Per-component mixed state of a vec2 row. */
export function vecComponent(row: Row, i: 0 | 1): number | null {
	const vals = row.bindings.map((b) =>
		Array.isArray(b.resolved.value) ? (b.resolved.value[i] as number) : NaN,
	);
	return vals.every((v) => v === vals[0]) ? vals[0]! : null;
}

type AnimState = 'none' | 'some' | 'all';
export function animState(row: Row): AnimState {
	const n = row.bindings.filter((b) => b.resolved.animated).length;
	return n === 0 ? 'none' : n === row.bindings.length ? 'all' : 'some';
}

/** Exact (fractional) sequence frame of a content time. */
export function exactFrameOf(clip: Clip, time: number, seq: Sequence): number {
	const F = 705_600_000 / (seq.settings.frameRate.num / seq.settings.frameRate.den);
	const i = (time - clip.sourceIn) / (F * clip.speed.rate);
	return clip.speed.reverse ? clip.start + clip.duration - 1 - i : clip.start + i;
}

/** Key sitting exactly on the playhead (the navigator diamond is filled, S03:EC-005). */
export function keyAtFrame(b: Binding, seq: Sequence, frame: number): string | null {
	const anim = b.resolved.anim;
	if (!anim) return null;
	const k = anim.keyframes.find(
		(x) => sequenceFrameOfContentTime(b.clip, x.time, seq.settings.frameRate) === frame,
	);
	return k?.id ?? null;
}

const insideClip = (clip: Clip, frame: number) => frame >= clip.start && frame < clip.start + clip.duration;
const clampIntoClip = (clip: Clip, frame: number) =>
	Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));

// ---------------------------------------------------------------- commands

type EditPlan = {
	commands: Command[];
	/** Animated clips skipped because the playhead is outside them (S03:PRP-020 `playhead-outside-clip`). */
	skipped: string[];
};

function paramSet(path: ParamPath, value: unknown, frame?: number): Command {
	return (
		frame === undefined
			? { type: 'param.set', target: path, value }
			: { type: 'param.set', target: path, value, at: { sequenceFrame: frame } }
	) as Command;
}

/** Write one value to one binding (auto mode: keyframe when animated, else static). */
function writeBinding(b: Binding, value: unknown, frame: number, refIndex: number): Command[] | null {
	if (b.spec.write?.via === 'clip.update') return [propertyWriteCommand(b.clip, b.spec, value) as Command];
	if (!b.path) {
		const ref = `$own${refIndex}`;
		return b.create!(ref, b.param ? { [b.param]: value } : undefined);
	}
	if (b.resolved.animated) {
		if (!insideClip(b.clip, frame)) return null;
		return [paramSet(b.path, value, frame)];
	}
	return [paramSet(b.path, value)];
}

/** Sets every binding of a row to `compute(base, binding)` (absolute, relative or per component). */
export function planSet(row: Row, frame: number, compute: (base: unknown, b: Binding) => unknown): EditPlan {
	const commands: Command[] = [];
	const skipped: string[] = [];
	row.bindings.forEach((b, i) => {
		const value = clampValue(b.spec, compute(b.resolved.value, b));
		const cmds = writeBinding(b, value, frame, i);
		if (cmds) commands.push(...cmds);
		else skipped.push(b.clip.id);
	});
	return { commands, skipped };
}

function clampValue(spec: PropertySpec, v: unknown): unknown {
	const lo = spec.range?.min ?? Number.NEGATIVE_INFINITY;
	const hi = spec.range?.max ?? Number.POSITIVE_INFINITY;
	if (spec.kind === 'number' && typeof v === 'number') return Math.min(hi, Math.max(lo, v));
	if (spec.kind === 'color' && Array.isArray(v)) return v.map((x) => Math.min(1, Math.max(0, Number(x))));
	return v;
}

/** Stopwatch (S01:KF-005, S03:KF-041): on = one key at the playhead (clamped into the clip); off = bake. */
export function planStopwatch(row: Row, frame: number, on: boolean): EditPlan {
	const commands: Command[] = [];
	row.bindings.forEach((b, i) => {
		if (b.spec.animatable === 'no' || b.resolved.animated === on) return;
		const at = { sequenceFrame: clampIntoClip(b.clip, frame) };
		if (!b.path) {
			if (!on) return;
			const ref = `$own${i}`;
			commands.push(...b.create!(ref), {
				type: 'param.setAnimated',
				target: ['effect', ref, b.param!],
				animated: true,
				at,
			} as Command);
			return;
		}
		commands.push({ type: 'param.setAnimated', target: b.path, animated: on, at } as Command);
	});
	return { commands, skipped: [] };
}

/**
 * ◆ (S03:INS-005, EC-005): when every binding has a key on the playhead, remove them; otherwise add a key
 * with the current value on each binding that lacks one (turning the stopwatch on where needed).
 */
export function planToggleKey(row: Row, seq: Sequence, frame: number): EditPlan {
	const keys = row.bindings.map((b) => keyAtFrame(b, seq, frame));
	const skipped = row.bindings.filter((b) => !insideClip(b.clip, frame)).map((b) => b.clip.id);
	if (keys.every((k) => k !== null)) {
		return { commands: [{ type: 'keyframe.remove', keyframeIds: keys as string[] } as Command], skipped: [] };
	}
	const commands: Command[] = [];
	row.bindings.forEach((b, i) => {
		if (!insideClip(b.clip, frame) || keys[i] !== null || b.spec.animatable === 'no') return;
		const at = { sequenceFrame: frame };
		if (!b.path) {
			const ref = `$own${i}`;
			commands.push(...b.create!(ref), {
				type: 'param.setAnimated',
				target: ['effect', ref, b.param!],
				animated: true,
				at,
			} as Command);
		} else if (!b.resolved.animated)
			commands.push({ type: 'param.setAnimated', target: b.path, animated: true, at } as Command);
		else commands.push({ type: 'keyframe.add', target: b.path, at } as Command);
	});
	return { commands, skipped };
}

/** Previous/next key frame of the row relative to the playhead (◀ ▶), or null at the ends. */
export function navigateKey(row: Row, seq: Sequence, frame: number, dir: -1 | 1): number | null {
	const frames = row.bindings.flatMap((b) =>
		(b.resolved.anim?.keyframes ?? []).map((k) =>
			sequenceFrameOfContentTime(b.clip, k.time, seq.settings.frameRate),
		),
	);
	const cands = frames.filter((f) => (dir > 0 ? f > frame : f < frame));
	if (cands.length === 0) return null;
	return dir > 0 ? Math.min(...cands) : Math.max(...cands);
}

/** Reset ⟲ (S03:EC-005): the default value, written as a key at the playhead when animated. */
export function planReset(row: Row, doc: ProjectDocument, seq: Sequence, frame: number): EditPlan {
	const existing = row.bindings.filter((b) => b.path !== null && b.spec.defaultValue !== undefined);
	if (existing.length === 0) return { commands: [], skipped: [] };
	return planSet({ ...row, bindings: existing }, frame, (_base, b) =>
		propertyDefault({ doc, seq, clip: b.clip }, b.spec),
	);
}

/** Label for History entries (S03:NFR-010). */
export function editLabel(row: Row, clips: number): string {
	return clips > 1 ? `${row.label} (${clips} clips)` : row.label;
}

/**
 * Rebuilds a row from its id (used by UI commands acting on the focused property): `crop.<param>`,
 * `effects.<fxId>.<param>` or a registry key.
 */
export function rowForKey(
	doc: ProjectDocument,
	seq: Sequence,
	clips: readonly Clip[],
	key: string,
	frame: number,
	registries: { effects: { get(id: string, v?: number): EffectSpec | undefined }; mg?: MgTemplateRegistry },
): Row | null {
	if (key.startsWith('crop.')) {
		const param = key.slice(5);
		return makeRow(
			key,
			clips.filter(isVisualClip).map((c) => bindCrop(doc, seq, c, param, frame)),
		);
	}
	if (key.startsWith('effects.')) {
		const [, fxId, param] = key.split('.');
		for (const clip of clips) {
			const fx = ((clip as { effects?: EffectInstance[] }).effects ?? []).find((e) => e.id === fxId);
			const effect = fx && registries.effects.get(fx.effectId, fx.effectVersion);
			const p = effect?.params.find((x) => x.name === param);
			if (fx && effect && p) return makeRow(key, [bindEffectParam(doc, seq, clip, fx, effect, p, frame)]);
		}
		return null;
	}
	return makeRow(
		key,
		clips.map((c) => bindProperty(doc, seq, c, key, frame, registries.mg)),
	);
}
