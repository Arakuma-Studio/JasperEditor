// `jasper apply` (docs/wp-notes/scene-file.md § Apply): the diff of a resolved scene against the project, as ordinary
// serializable commands for ONE transaction (one undo step). Only what differs becomes a command: applying the same
// file twice plans nothing the second time. Layers are matched by binding (clips an earlier apply created), then by
// `clip:` pin, then by clip name; unmatched layers are created; a bound layer that left the file is removed — clips
// the scene did not create are never removed. Pure.

import type { CommandInput } from '../commands/schemas/index.ts';
import type { Registries } from '../commands/types.ts';
import { cubicToEases } from '../ease/curve.ts';
import { LINEAR_EASE } from '../ease/segments.ts';
import type { IdPrefix } from '../ids.ts';
import type { RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { sceneBindingsOf } from './bindings.ts';
import type { SceneIssue, SceneProp } from './format.ts';
import {
	animatorEqual,
	animEqual,
	colorEqual,
	effectEqual,
	maskEqual,
	nearlyEqual,
	type ResolvedScene,
	type ResolvedSceneLayer,
	type SceneAnimatorR,
	type SceneAnimR,
	type SceneEffectR,
	type SceneKeyR,
	type SceneMaskR,
	type SceneTextR,
	strokeEqual,
} from './model.ts';
import { isSceneEffect, readSceneLayer, sceneKindOf } from './read.ts';
import { SCENE_DEFAULT_RATE, SCENE_DEFAULT_SIZE, scenePropPath } from './resolve.ts';
import { findSceneSequence } from './sequence.ts';

export type PlanContext = {
	registries: Registries;
	/** A new entity id (explicit ids keep the plan's references stable across the transaction). */
	newId(prefix: IdPrefix): string;
};

export type LayerOutcome =
	| { id: string; status: 'created'; clipId: string }
	| { id: string; status: 'recreated'; clipId: string; why: string }
	| { id: string; status: 'updated'; clipId: string; aspects: string[] }
	| { id: string; status: 'unchanged'; clipId: string };

export type ScenePlan = {
	sequenceId: string;
	/** True when the sequence does not exist yet. */
	createsSequence: boolean;
	commands: CommandInput[];
	layers: LayerOutcome[];
	/** Layers of an earlier apply that left the file: their clips are removed. */
	removed: { id: string; clipId: string }[];
	warnings: string[];
};

type Cmd = Record<string, unknown> & { type: string };

const POINT_PROPS = new Set<SceneProp>(['position']);

/** keyframe.add commands writing `keys` on `target` (ease of a key = the segment leaving it). */
function keyCommands(target: string[], keys: readonly SceneKeyR[], point: boolean): Cmd[] {
	return keys.map((k, i) => {
		const prev = keys[i - 1];
		const last = i === keys.length - 1;
		const out =
			!last && k.ease.kind === 'cubic' ? cubicToEases({ ...k.ease, kind: 'cubic' }).easeOut : LINEAR_EASE;
		const inn =
			prev?.ease.kind === 'cubic' ? cubicToEases({ ...prev.ease, kind: 'cubic' }).easeIn : LINEAR_EASE;
		const interpolation = last ? 'linear' : k.ease.kind === 'cubic' ? 'bezier' : k.ease.kind;
		return {
			type: 'keyframe.add',
			target,
			at: { frames: k.frame },
			value: k.value,
			interpolation,
			// keyframe-sides: an explicit Bezier incoming side, so the key's in ease shapes the segment whatever its
			// outgoing type (read the legacy way, a Linear key would arrive linearly)
			...(prev?.ease.kind === 'cubic' ? { inInterpolation: 'bezier' } : {}),
			easeIn: { ...inn },
			easeOut: { ...out },
			...(point ? { spatial: { mode: k.path === 'auto' ? 'auto-bezier' : 'linear' } } : {}),
		};
	});
}

/** Commands turning `cur` into `want` on `target` (cur null = a fresh property, nothing to clear). */
function animCommands(target: string[], want: SceneAnimR, cur: SceneAnimR | null, point: boolean): Cmd[] {
	if (cur && animEqual(cur, want)) return [];
	const out: Cmd[] = [];
	if (cur?.kind === 'keys') out.push({ type: 'param.setAnimated', target, animated: false });
	if (want.kind === 'static') out.push({ type: 'param.set', target, value: want.value });
	else out.push(...keyCommands(target, want.keys, point));
	return out;
}

const animatorInput = (a: SceneAnimatorR | null) =>
	a === null
		? null
		: { preset: a.preset, version: a.version, durationFrames: a.durationFrames, params: a.params };

/** Text style fields a scene manages → `TextStyle` keys. */
function styleOf(t: SceneTextR, fontIdOf: (family: string) => string): Record<string, unknown> {
	const s: Record<string, unknown> = {};
	if (t.font !== undefined) s.fontId = fontIdOf(t.font);
	if (t.sizePx !== undefined) s.sizePx = t.sizePx;
	if (t.weight !== undefined) s.weight = t.weight;
	if (t.italic !== undefined) s.italic = t.italic;
	if (t.fill !== undefined) s.fill = t.fill;
	if (t.align !== undefined) s.align = t.align;
	if (t.lineHeight !== undefined) s.lineHeight = t.lineHeight;
	if (t.trackingEm !== undefined) s.trackingEm = t.trackingEm;
	if (t.allCaps !== undefined) s.allCaps = t.allCaps;
	if (t.stroke !== undefined)
		s.strokes = t.stroke
			? [{ color: t.stroke.color, widthPx: t.stroke.width, position: t.stroke.position }]
			: [];
	if (t.shadow !== undefined) s.shadow = t.shadow;
	if (t.background !== undefined) s.background = t.background;
	return s;
}

/** The style fields of `want` that differ from `cur` (cur = the clip's canonical text). */
function styleDiff(want: SceneTextR, cur: SceneTextR): (keyof SceneTextR)[] {
	const d: (keyof SceneTextR)[] = [];
	const num = (k: 'sizePx' | 'weight' | 'lineHeight' | 'trackingEm') =>
		want[k] !== undefined && !nearlyEqual(want[k], cur[k]) && d.push(k);
	if (want.font !== undefined && want.font !== cur.font) d.push('font');
	num('sizePx');
	num('weight');
	num('lineHeight');
	num('trackingEm');
	if (want.italic !== undefined && want.italic !== cur.italic) d.push('italic');
	if (want.allCaps !== undefined && want.allCaps !== cur.allCaps) d.push('allCaps');
	if (want.align !== undefined && want.align !== cur.align) d.push('align');
	if (want.fill !== undefined && !colorEqual(want.fill, cur.fill)) d.push('fill');
	if (want.stroke !== undefined && (cur.stroke === undefined || !strokeEqual(want.stroke, cur.stroke)))
		d.push('stroke');
	if (
		want.shadow !== undefined &&
		!(want.shadow === null
			? cur.shadow === null
			: cur.shadow != null &&
				colorEqual(want.shadow.color, cur.shadow.color) &&
				nearlyEqual({ ...want.shadow, color: 0 }, { ...cur.shadow, color: 0 }))
	)
		d.push('shadow');
	if (
		want.background !== undefined &&
		!(want.background === null
			? cur.background === null
			: cur.background != null &&
				colorEqual(want.background.color, cur.background.color) &&
				nearlyEqual({ ...want.background, color: 0 }, { ...cur.background, color: 0 }))
	)
		d.push('background');
	return d;
}

function boxPatch(b: NonNullable<SceneTextR['box']>): Record<string, unknown> {
	if (b.mode === 'point') return { autoSize: 'width' };
	if (b.mode === 'paragraph') return { autoSize: 'height', width: b.width };
	return { autoSize: 'none', width: b.width, height: b.height };
}

function boxEqual(a: NonNullable<SceneTextR['box']>, b: SceneTextR['box']): boolean {
	if (!b || a.mode !== b.mode) return false;
	if (a.mode === 'paragraph' && b.mode === 'paragraph') return nearlyEqual(a.width, b.width);
	if (a.mode === 'box' && b.mode === 'box') return nearlyEqual([a.width, a.height], [b.width, b.height]);
	return true;
}

type Occupant = { key: string; track: number; start: number; end: number; label: string };

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
	a.start < b.end && b.start < a.end;

/** Plans the commands that make the project match `scene`. Never throws; problems come back as issues. */
export function planScene(
	doc: ProjectDocument,
	scene: ResolvedScene,
	ctx: PlanContext,
): { ok: true; plan: ScenePlan } | { ok: false; issues: SceneIssue[] } {
	const issues: SceneIssue[] = [];
	const warnings: string[] = [];
	const commands: Cmd[] = [];
	const found = findSceneSequence(doc, scene.sequence.name);
	if (found.error) return { ok: false, issues: [{ path: ['sequence', 'name'], message: found.error }] };
	const seq: Sequence | undefined = found.seq;
	const sequenceId = seq?.id ?? ctx.newId('seq');
	const rate = (scene.sequence.frameRate ?? seq?.settings.frameRate ?? SCENE_DEFAULT_RATE) as Rational;
	const maxTrack = Math.max(1, ...scene.layers.map((l) => l.track));

	// --- the sequence -----------------------------------------------------------------------------------------
	if (!seq) {
		const [w, h] = SCENE_DEFAULT_SIZE;
		commands.push({
			type: 'sequence.create',
			id: sequenceId,
			name: scene.sequence.name,
			settings: {
				width: scene.sequence.width ?? w,
				height: scene.sequence.height ?? h,
				frameRate: rate,
				...(scene.sequence.background ? { backgroundColor: scene.sequence.background } : {}),
			},
			tracks: { video: maxTrack, audio: 1 },
		});
	} else {
		const s = seq.settings;
		const patch: Record<string, unknown> = {};
		if (scene.sequence.width !== undefined && scene.sequence.width !== s.width)
			patch.width = scene.sequence.width;
		if (scene.sequence.height !== undefined && scene.sequence.height !== s.height)
			patch.height = scene.sequence.height;
		if (
			scene.sequence.frameRate &&
			scene.sequence.frameRate.num * s.frameRate.den !== s.frameRate.num * scene.sequence.frameRate.den
		)
			patch.frameRate = scene.sequence.frameRate;
		if (scene.sequence.background && !colorEqual(scene.sequence.background, s.backgroundColor as RGBA))
			patch.backgroundColor = scene.sequence.background;
		if (Object.keys(patch).length)
			commands.push({
				type: 'sequence.updateSettings',
				sequenceId,
				settings: patch,
				reposition: 'keep-pixels',
			});
	}
	const width = scene.sequence.width ?? seq?.settings.width ?? SCENE_DEFAULT_SIZE[0];
	const height = scene.sequence.height ?? seq?.settings.height ?? SCENE_DEFAULT_SIZE[1];

	// --- matching ------------------------------------------------------------------------------------------------
	const clips: Record<string, Clip> = seq?.clips ?? {};
	const bindings = sceneBindingsOf(doc, sequenceId);
	const boundClips = new Set(Object.values(bindings));
	const taken = new Map<string, number>();
	type Match = { layer: ResolvedSceneLayer; clip: Clip | null; owned: boolean };
	const matches: Match[] = [];
	const inScene = new Set(scene.layers.map((l) => l.id));
	for (const layer of scene.layers) {
		const at = ['layers', layer.index] as const;
		let clip: Clip | null = null;
		let owned = false;
		const bound = bindings[layer.id];
		if (bound && clips[bound]) {
			clip = clips[bound]!;
			owned = true;
		} else if (layer.clipPin) {
			clip = clips[layer.clipPin] ?? null;
			if (!clip)
				issues.push({
					path: [...at, 'clip'],
					message: `no clip ${layer.clipPin} in "${scene.sequence.name}"`,
				});
		} else {
			const named = Object.values(clips).filter(
				(c) => c.name === layer.name && sceneKindOf(c) !== null && !boundClips.has(c.id),
			);
			if (named.length > 1)
				issues.push({
					path: [...at, 'id'],
					message: `${named.length} clips are named "${layer.name}" (${named.map((c) => c.id).join(', ')}): pin one with clip:, or rename them`,
				});
			else clip = named[0] ?? null;
		}
		if (clip) {
			const other = taken.get(clip.id);
			if (other !== undefined)
				issues.push({ path: [...at, 'id'], message: `layers[${other}] already is clip ${clip.id}` });
			taken.set(clip.id, layer.index);
			if (!owned && sceneKindOf(clip) !== layer.kind)
				issues.push({
					path: [...at, 'type'],
					message: `clip ${clip.id} ("${clip.name}") is a ${sceneKindOf(clip) ?? clip.kind} clip, not a ${layer.kind} layer: rename it or the layer`,
				});
		}
		matches.push({ layer, clip, owned });
	}
	if (issues.length) return { ok: false, issues };

	// --- what goes, what is made again -----------------------------------------------------------------------------
	const bindPatch: Record<string, string | null> = {};
	const removed: ScenePlan['removed'] = [];
	const lifts: string[] = [];
	for (const [layerId, clipId] of Object.entries(bindings)) {
		if (inScene.has(layerId)) continue;
		bindPatch[layerId] = null;
		if (clips[clipId]) {
			removed.push({ id: layerId, clipId });
			lifts.push(clipId);
		}
	}
	for (const [layerId, clipId] of Object.entries(bindings))
		if (inScene.has(layerId) && !clips[clipId]) bindPatch[layerId] = null; // its clip is gone: made again below
	const outcomes: LayerOutcome[] = [];
	const recreate = new Map<string, string>(); // layer id → why
	for (const m of matches) {
		if (!m.clip) continue;
		const why =
			sceneKindOf(m.clip) !== m.layer.kind
				? `it was a ${sceneKindOf(m.clip) ?? m.clip.kind}`
				: m.layer.kind === 'composition' &&
						m.layer.composition &&
						((m.clip as Extract<Clip, { kind: 'composition' }>).composition.mediaId !==
							m.layer.composition.mediaId ||
							(m.clip as Extract<Clip, { kind: 'composition' }>).composition.id !== m.layer.composition.id)
					? 'another composition'
					: m.layer.kind === 'shape' &&
							(m.clip as Extract<Clip, { kind: 'shape' }>).shape.type !== m.layer.shape?.type
						? 'another shape type'
						: null;
		if (why) recreate.set(m.layer.id, why);
		else if (!seq || !readSceneLayer(doc, seq, m.clip, ctx.registries))
			recreate.set(m.layer.id, 'the clip cannot be read as a layer');
	}

	// --- occupancy: the final timeline must hold one clip per track and frame -----------------------------------
	const trackNo = (c: Clip) => (seq ? seq.videoTracks.findIndex((t) => t.id === c.trackId) + 1 : 0);
	const leaving = new Set(lifts);
	for (const m of matches) if (m.clip && recreate.has(m.layer.id)) leaving.add(m.clip.id);
	const others: Occupant[] = [];
	const managed = new Set(matches.flatMap((m) => (m.clip ? [m.clip.id] : [])));
	for (const c of Object.values(clips)) {
		const t = trackNo(c);
		if (t < 1 || leaving.has(c.id) || managed.has(c.id)) continue;
		others.push({
			key: c.id,
			track: t,
			start: c.start,
			end: c.start + c.duration,
			label: `clip "${c.name}" (${c.id})`,
		});
	}
	for (const m of matches) {
		const want = { start: m.layer.start, end: m.layer.start + m.layer.duration };
		const hit = others.find((o) => o.track === m.layer.track && overlaps(o, want));
		if (hit)
			issues.push({
				path: ['layers', m.layer.index, 'track'],
				message: `V${m.layer.track} already holds ${hit.label} at frames ${hit.start}…${hit.end - 1}: give the layer another track or start`,
			});
	}
	if (issues.length) return { ok: false, issues };

	// Locked tracks are refused by the commands themselves; warn early for clarity.
	for (const m of matches) {
		const t = seq?.videoTracks[m.layer.track - 1];
		if (t?.locked)
			warnings.push(`layers[${m.layer.index}] ("${m.layer.id}"): track V${m.layer.track} is locked`);
	}

	// --- moves (scheduled so a move never lands on a clip that has not left yet) -------------------------------
	type Move = { m: Match; clip: Clip; from: Occupant };
	const current: Occupant[] = [...others];
	const pending: Move[] = [];
	for (const m of matches) {
		if (!m.clip || recreate.has(m.layer.id)) continue;
		const from: Occupant = {
			key: m.clip.id,
			track: trackNo(m.clip),
			start: m.clip.start,
			end: m.clip.start + m.clip.duration,
			label: `layers[${m.layer.index}]`,
		};
		if (
			from.track === m.layer.track &&
			from.start === m.layer.start &&
			from.end === m.layer.start + m.layer.duration
		)
			current.push(from);
		else pending.push({ m, clip: m.clip, from });
	}
	for (const p of pending) current.push(p.from);
	const moveCmds: Cmd[] = [];
	const moved = new Set<string>();
	while (pending.length) {
		const i = pending.findIndex((p) => {
			const to = { start: p.m.layer.start, end: p.m.layer.start + p.m.layer.duration };
			return !current.some((o) => o.key !== p.clip.id && o.track === p.m.layer.track && overlaps(o, to));
		});
		if (i < 0) {
			// a cycle (two layers trading places): make one again
			const p = pending.shift()!;
			recreate.set(p.m.layer.id, 'it trades places with another layer');
			current.splice(current.indexOf(p.from), 1);
			continue;
		}
		const p = pending.splice(i, 1)[0]!;
		const l = p.m.layer;
		const oldDur = p.from.end - p.from.start;
		const move: Cmd | null =
			p.from.start !== l.start || p.from.track !== l.track
				? {
						type: 'clip.move',
						clipIds: [p.clip.id],
						deltaFrames: l.start - p.from.start,
						...(p.from.track !== l.track ? { deltaTracks: { video: l.track - p.from.track } } : {}),
						mode: 'overwrite',
						createTracks: true,
						groups: false,
					}
				: null;
		const trim: Cmd | null =
			l.duration !== oldDur
				? {
						type: 'clip.trim',
						clipId: p.clip.id,
						edge: 'out',
						deltaFrames: l.duration - oldDur,
						mode: 'regular',
						linked: false,
						group: false,
					}
				: null;
		// shrinking: trim in place first; growing: move first — every step stays inside the free target range
		const steps = l.duration < oldDur ? [trim, move] : [move, trim];
		for (const s of steps) if (s) moveCmds.push(s);
		current.splice(current.indexOf(p.from), 1, {
			...p.from,
			track: l.track,
			start: l.start,
			end: l.start + l.duration,
		});
		moved.add(p.clip.id);
	}
	for (const m of matches) if (m.clip && recreate.has(m.layer.id)) lifts.push(m.clip.id);

	// --- fonts ------------------------------------------------------------------------------------------------------
	const fontRefs = new Map<string, string>();
	const fontCmds: Cmd[] = [];
	const fontIdOf = (family: string): string => {
		const known = Object.values(doc.fonts).find((f) => f.family === family);
		if (known) return known.id;
		let ref = fontRefs.get(family);
		if (!ref) {
			ref = `$scene_font_${fontRefs.size}`;
			fontRefs.set(family, ref);
			fontCmds.push({ type: 'font.add', family, ref });
		}
		return ref;
	};

	// --- creations and updates ------------------------------------------------------------------------------------
	const createCmds: Cmd[] = [];
	const updateCmds: Cmd[] = [];
	let fxRef = 0;
	const F = flicksPerFrame(rate);
	const centre = [width / 2, height / 2];

	/** Effect commands on `clipRef` turning `cur` (managed effects + their instance ids) into `want`. */
	const effectCommands = (
		clipRef: string,
		want: readonly SceneEffectR[],
		cur: readonly { fx: SceneEffectR; instanceId: string }[],
	): Cmd[] => {
		const out: Cmd[] = [];
		const sameShape = want.length === cur.length && want.every((w, i) => w.effectId === cur[i]!.fx.effectId);
		if (sameShape) {
			want.forEach((w, i) => {
				const c = cur[i]!;
				if (effectEqual(c.fx, w)) return;
				if (w.enabled !== c.fx.enabled)
					out.push({ type: 'effect.setEnabled', effectInstanceId: c.instanceId, enabled: w.enabled });
				for (const [name, a] of Object.entries(w.params))
					out.push(...animCommands(['effect', c.instanceId, name], a, c.fx.params[name] ?? null, false));
			});
			return out;
		}
		for (const c of cur) out.push({ type: 'effect.remove', effectInstanceId: c.instanceId });
		for (const w of want) {
			const ref = `$scene_fx_${fxRef++}`;
			const statics: Record<string, unknown> = {};
			for (const [name, a] of Object.entries(w.params)) if (a.kind === 'static') statics[name] = a.value;
			out.push({
				type: 'effect.add',
				target: { clipId: clipRef },
				effectId: w.effectId,
				params: statics,
				ref,
			});
			if (!w.enabled) out.push({ type: 'effect.setEnabled', effectInstanceId: ref, enabled: false });
			for (const [name, a] of Object.entries(w.params))
				if (a.kind === 'keys') out.push(...keyCommands(['effect', ref, name], a.keys, false));
		}
		return out;
	};

	/** `cur` null = masks the format cannot say: replaced. */
	const maskCommands = (
		clipRef: string,
		want: readonly SceneMaskR[],
		curIds: readonly string[],
		cur: readonly SceneMaskR[] | null,
	): Cmd[] => {
		if (cur && want.length === cur.length && want.every((w, i) => maskEqual(w, cur[i]!))) return [];
		if (!cur && !want.length && !curIds.length) return [];
		const out: Cmd[] = [];
		if (curIds.length) out.push({ type: 'mask.remove', maskIds: [...curIds] });
		for (const w of want)
			out.push({
				type: 'mask.add',
				clipId: clipRef,
				shape: w.shape,
				path: { closed: w.closed, vertices: w.vertices },
				mode: w.mode,
				inverted: w.inverted,
				feather: w.feather,
				opacity: w.opacity,
				expansion: w.expansion,
				featherFalloff: w.falloff,
			});
		return out;
	};

	let imageRef = 0;
	for (const m of matches) {
		const l = m.layer;
		const fresh = !m.clip || recreate.has(l.id);
		if (fresh) {
			// --- create ---
			const explicit = l.kind !== 'image';
			const clipId = explicit ? ctx.newId('clp') : `$scene_img_${imageRef++}`;
			const target = (path: string[]) => ['clip', clipId, ...path];
			const statics: Partial<Record<SceneProp, unknown>> = {};
			for (const [p, a] of Object.entries(l.props) as [SceneProp, SceneAnimR][])
				if (a.kind === 'static') statics[p] = a.value;
			const placement = {
				sequenceId,
				at: l.start,
				duration: l.duration,
				track: `V${l.track}`,
				name: l.name,
				id: clipId,
			};
			const transform: Record<string, unknown> = {};
			for (const p of ['position', 'anchor', 'scale', 'rotation'] as const)
				if (statics[p] !== undefined) transform[p] = statics[p];
			const after: Cmd[] = [];
			const setAtCreate = new Set<SceneProp>();
			if (l.kind === 'text') {
				const t = l.text!;
				createCmds.push({
					type: 'clip.addText',
					...placement,
					content: { text: t.text, style: styleOf(t, fontIdOf) },
					...(t.box && t.box.mode !== 'point' ? { box: boxPatch(t.box) } : {}),
					...(Object.keys(transform).length ? { transform } : {}),
					...(t.animIn !== undefined || t.animOut !== undefined
						? {
								textAnimation: {
									...(t.animIn ? { in: animatorInput(t.animIn) } : {}),
									...(t.animOut ? { out: animatorInput(t.animOut) } : {}),
								},
							}
						: {}),
				});
				for (const p of Object.keys(transform)) setAtCreate.add(p as SceneProp);
			} else if (l.kind === 'shape') {
				const sh = l.shape!;
				const size = l.props.size;
				const fill = l.props.fill;
				createCmds.push({
					type: 'clip.addShape',
					...placement,
					shape: {
						type: sh.type,
						...(size ? { size: size.kind === 'static' ? size.value : size.keys[0]!.value } : {}),
						...(fill ? { fill: fill.kind === 'static' ? fill.value : fill.keys[0]!.value } : {}),
						...(sh.stroke !== undefined ? { stroke: sh.stroke } : {}),
						...(l.props.radius?.kind === 'static' ? { cornerRadius: l.props.radius.value } : {}),
					},
					...(Object.keys(transform).length ? { transform } : {}),
				});
				for (const p of Object.keys(transform)) setAtCreate.add(p as SceneProp);
				for (const p of ['size', 'fill', 'radius'] as const)
					if (l.props[p]?.kind === 'static') setAtCreate.add(p);
			} else if (l.kind === 'image') {
				createCmds.push({
					type: 'clip.place',
					sequenceId,
					source: { mediaId: l.mediaId },
					sourceRange: { in: { flicks: 0 }, out: { flicks: Math.round(l.duration * F) } },
					at: l.start,
					tracks: { video: `V${l.track}` },
					video: true,
					audio: false,
					createTracks: true,
					scaling: 'none',
					matchSequence: 'keep',
					ref: clipId,
				});
				after.push({ type: 'clip.update', clipId, patch: { name: l.name } });
			} else {
				const comp = l.composition!;
				createCmds.push({
					type: 'clip.addComposition',
					...placement,
					composition: { mediaId: comp.mediaId, id: comp.id },
					...(comp.props ? { props: comp.props } : {}),
				});
			}
			createCmds.push(...after);
			const blend = l.blend && l.blend !== 'normal' ? l.blend : undefined;
			if (blend) createCmds.push({ type: 'clip.update', clipId, patch: { blendMode: blend } });
			for (const [p, a] of propsInOrder(l.props)) {
				if (setAtCreate.has(p)) continue;
				if (
					a.kind === 'keys' ||
					!(p in DEFAULTS) ||
					!nearlyEqual(a.value, DEFAULTS[p as keyof typeof DEFAULTS](centre))
				)
					createCmds.push(...animCommands(target(scenePropPath(p)), a, null, POINT_PROPS.has(p)));
			}
			if (l.effects?.length) createCmds.push(...effectCommands(clipId, l.effects, []));
			if (l.masks?.length) createCmds.push(...maskCommands(clipId, l.masks, [], []));
			bindPatch[l.id] = clipId;
			outcomes.push(
				m.clip
					? { id: l.id, status: 'recreated', clipId, why: recreate.get(l.id)! }
					: { id: l.id, status: 'created', clipId },
			);
			continue;
		}
		// --- update ---
		const clip = m.clip!;
		const read = readSceneLayer(doc, seq!, clip, ctx.registries)!;
		const cur = read.layer;
		const aspects: string[] = [];
		const target = (path: string[]) => ['clip', clip.id, ...path];
		if (moved.has(clip.id)) aspects.push('timing');
		const patch: Record<string, unknown> = {};
		if (cur.name !== l.name) {
			patch.name = l.name;
			aspects.push('name');
		}
		if (l.blend !== undefined && l.blend !== cur.blend) {
			patch.blendMode = l.blend;
			aspects.push('blend');
		}
		if (l.text && cur.text) {
			const t = l.text;
			const content: Record<string, unknown> = {};
			if (t.text !== cur.text.text) {
				content.text = t.text;
				aspects.push('text');
			}
			const diff = styleDiff(t, cur.text);
			if (diff.length) {
				const full = styleOf(t, fontIdOf);
				const want: Record<string, unknown> = {};
				const map: Partial<Record<keyof SceneTextR, string>> = { font: 'fontId', stroke: 'strokes' };
				for (const k of diff) want[map[k] ?? k] = full[map[k] ?? k];
				content.style = want;
				aspects.push(...diff.map((k) => `style.${k}`));
			}
			if (Object.keys(content).length) patch.content = content;
			if (t.box && !boxEqual(t.box, cur.text.box)) {
				patch.box = boxPatch(t.box);
				aspects.push('box');
			}
			const ta: Record<string, unknown> = {};
			if (t.animIn !== undefined && !animatorEqual(t.animIn, cur.text.animIn ?? null))
				ta.in = animatorInput(t.animIn);
			if (t.animOut !== undefined && !animatorEqual(t.animOut, cur.text.animOut ?? null))
				ta.out = animatorInput(t.animOut);
			if (Object.keys(ta).length) {
				patch.textAnimation = ta;
				aspects.push('animation');
			}
		}
		if (
			l.shape &&
			cur.shape &&
			l.shape.stroke !== undefined &&
			(cur.shape.stroke === undefined || !strokeEqual(l.shape.stroke, cur.shape.stroke))
		) {
			patch.shape = { stroke: l.shape.stroke };
			aspects.push('stroke');
		}
		if (
			l.composition?.props !== undefined &&
			!nearlyEqual(l.composition.props, cur.composition?.props ?? {})
		) {
			patch.props = l.composition.props;
			aspects.push('props');
		}
		if (Object.keys(patch).length) updateCmds.push({ type: 'clip.update', clipId: clip.id, patch });
		if (l.mediaId && l.mediaId !== cur.mediaId) {
			updateCmds.push({
				type: 'clip.replaceSource',
				clipId: clip.id,
				mediaId: l.mediaId,
				keepDuration: true,
			});
			aspects.push('src');
		}
		// the box first: a new size or stroke moves a shape's anchor (keepShapesCentred), a given anchor is set after
		for (const [p, a] of propsInOrder(l.props)) {
			const c = cur.props[p] ?? null;
			if (c && animEqual(c, a)) continue;
			if (read.omitted.includes(p))
				warnings.push(
					`layers[${l.index}] ("${l.id}"): ${p} had what the scene format cannot say (an expression or curved path); it is replaced`,
				);
			if (p === 'fill' && (a.kind === 'static' || (c?.kind === 'static' && c.value === null))) {
				// fill: null removes it; a fill must exist before it is keyed
				const first = a.kind === 'static' ? a.value : a.keys[0]!.value;
				if (c?.kind === 'keys')
					updateCmds.push({ type: 'param.setAnimated', target: target(scenePropPath(p)), animated: false });
				updateCmds.push({ type: 'clip.update', clipId: clip.id, patch: { shape: { fill: first } } });
				if (a.kind === 'keys') updateCmds.push(...keyCommands(target(scenePropPath(p)), a.keys, false));
			} else updateCmds.push(...animCommands(target(scenePropPath(p)), a, c, POINT_PROPS.has(p)));
			aspects.push(p);
		}
		if (l.effects) {
			const managedFx = (clip as Extract<Clip, { kind: 'text' }>).effects.filter((fx) =>
				isSceneEffect(fx, ctx.registries),
			);
			if (!cur.effects)
				warnings.push(
					`layers[${l.index}] ("${l.id}"): its effects had keys the scene format cannot say; they are replaced`,
				);
			const pairs = managedFx.map((fx, i) => ({
				instanceId: fx.id,
				fx: cur.effects?.[i] ?? { effectId: `${fx.effectId}#unreadable`, enabled: fx.enabled, params: {} },
			}));
			const cmds = effectCommands(clip.id, l.effects, pairs);
			if (cmds.length) {
				updateCmds.push(...cmds);
				aspects.push('effects');
			}
		}
		if (l.masks) {
			const ids = ((clip as Extract<Clip, { kind: 'text' }>).masks ?? []).map((mk) => mk.id);
			const cmds = maskCommands(clip.id, l.masks, ids, cur.masks ?? null);
			if (cmds.length) {
				updateCmds.push(...cmds);
				aspects.push('masks');
			}
		}
		outcomes.push(
			aspects.length
				? { id: l.id, status: 'updated', clipId: clip.id, aspects }
				: { id: l.id, status: 'unchanged', clipId: clip.id },
		);
	}

	const all: Cmd[] = [
		...commands,
		...fontCmds,
		...(lifts.length ? [{ type: 'clip.lift', clipIds: lifts, groups: false }] : []),
		...moveCmds,
		...createCmds,
		...updateCmds,
		...(Object.keys(bindPatch).length ? [{ type: 'scene.bind', sequenceId, clipIds: bindPatch }] : []),
	];
	return {
		ok: true,
		plan: {
			sequenceId,
			createsSequence: !seq,
			commands: all as CommandInput[],
			layers: outcomes,
			removed,
			warnings,
		},
	};
}

const PROP_ORDER: readonly SceneProp[] = [
	'size',
	'radius',
	'fill',
	'position',
	'anchor',
	'scale',
	'rotation',
	'opacity',
];
const propsInOrder = (props: ResolvedSceneLayer['props']) =>
	PROP_ORDER.flatMap((p) => (props[p] ? [[p, props[p]] as [SceneProp, SceneAnimR]] : []));

/** What a new clip holds before the plan sets anything (what need not be set on a fresh clip). */
const DEFAULTS = {
	position: (c: number[]) => c,
	scale: () => 100,
	rotation: () => 0,
	opacity: () => 100,
} as const;
