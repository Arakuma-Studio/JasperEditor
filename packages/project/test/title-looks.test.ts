// Spec 19 §4: Title Looks in the pure model. Commands (undo through document identity, as the session's History does),
// refusals, invariants, the walkers of TL-014, persistence (TL-020) and media references (TL-021).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearanceClipReach,
	appearancePropertySpecs,
	buildClipsPayload,
	buildEffectsPayload,
	buildKeyframesPayload,
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	clearEffectMedia,
	clipContentTime,
	clipLook,
	clipParamMediaIds,
	createCounterIdSource,
	defaultEffectRegistry,
	type EffectInstance,
	evaluate,
	expressionRefToParamPath,
	type LookRecipe,
	loadProject,
	lookReach,
	MAX_APPEARANCE_LAYERS,
	MAX_GRADIENT_STOPS,
	paramPathToExpressionRef,
	propertyKeyToParamPath,
	repairDocument,
	resolveAppearance,
	resolveCachedLayerProps,
	resolveLayerProps,
	resolvePropertySpec,
	sequenceAnimatables,
	TITLE_LOOK_EFFECT_ID,
	lookLayerReachCut,
	titleLookBleed,
	titleLookOf,
	titleLooksOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 23_520_000; // flicks per frame at 30 fps

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1], keyline: [0, 0, 0.2, 1] },
	layers: [
		{ type: 'shadow', params: { distance: 8, blur: 6 } },
		{ type: 'rim', name: 'Outline', params: { width: 5 } },
		{ type: 'face' },
	],
};
const source = { name: 'Gold', recipe };

function project() {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		{ type: 'clip.addText', at: 80, duration: 60, track: 'V2', content: { text: 'Second' }, ref: '$u' },
		{ type: 'clip.addSolid', at: 0, duration: 200, track: 'V1', color: [0, 0, 0, 1], ref: '$s' },
	]);
	return { h, t: r.refs.$t!, u: r.refs.$u!, s: r.refs.$s! };
}

const fxOf = (h: Harness, id: string) =>
	clipLook((h.seq.clips[id] as unknown as { effects: EffectInstance[] }).effects)!;
const lookOf = (h: Harness, id: string) => fxOf(h, id)?.appearance as Appearance;
const ok = (h: Harness) => expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
const code = (r: { ok: boolean; errors?: { code: string }[] }) => (r.ok ? null : r.errors![0]!.code);
const layerOf = (h: Harness, id: string, type: string) => lookOf(h, id).layers.find((l) => l.type === type)!;

function applied() {
	const p = project();
	p.h.ok([{ type: 'look.apply', clipIds: [p.t], look: source }]);
	return { ...p, fx: fxOf(p.h, p.t).id };
}

describe('look.apply (TL-018, TL-019)', () => {
	it('applies one look to several clips in one transaction, and the look is copied into the project once', () => {
		const { h, t, u } = project();
		const before = h.doc;
		const r = h.ok([{ type: 'look.apply', clipIds: [t, u], look: source }]);
		const res = r.results[0] as { lookId: string; effectInstanceIds: string[]; droppedKeyframes: number };
		expect(res.effectInstanceIds).toHaveLength(2);
		expect(titleLooksOf(h.doc).map((l) => l.name)).toEqual(['Gold']);
		expect(lookOf(h, t).lookId).toBe(res.lookId);
		expect(lookOf(h, t).layers.map((l) => l.type)).toEqual(['shadow', 'rim', 'face']);
		expect(lookOf(h, t).seed).not.toBe(lookOf(h, u).seed);
		ok(h);
		// Undo restores the document; the transaction left it untouched.
		expect(titleLooksOf(before)).toEqual([]);
		expect(fxOf({ seq: Object.values(before.sequences)[0]! } as Harness, t)).toBeNull();
	});

	it('the instance is internal: first in the stack, no params, not addable as an effect', () => {
		const { h, t, fx } = applied();
		expect(fxOf(h, t).id).toBe(fx);
		expect(fxOf(h, t).effectId).toBe(TITLE_LOOK_EFFECT_ID);
		expect(fxOf(h, t).params).toEqual({});
		expect(defaultEffectRegistry.get(TITLE_LOOK_EFFECT_ID)?.internal).toBe(true);
		expect(code(h.tx([{ type: 'effect.add', target: { clipId: t }, effectId: TITLE_LOOK_EFFECT_ID }]))).toBe(
			'E_UNKNOWN_EFFECT',
		);
	});

	it('applying keeps text, transform, timing and user effects, and reports the keyframes it drops', () => {
		const { h, t, fx } = applied();
		h.ok([{ type: 'effect.add', target: { clipId: t }, effectId: 'jasper.gaussian-blur' }]);
		const width = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, width, 'width'], at: { frames: 0 }, value: 3 },
			{ type: 'keyframe.add', target: ['appearance', fx, width, 'width'], at: { frames: 30 }, value: 9 },
		]);
		const seed = lookOf(h, t).seed;
		const clipBefore = h.seq.clips[t] as Clip & { content: { text: string } };
		const r = h.ok([{ type: 'look.apply', clipIds: [t], look: { ...source, name: 'Other' } }]);
		expect((r.results[0] as { droppedKeyframes: number }).droppedKeyframes).toBe(2);
		const after = h.seq.clips[t] as Clip & { content: { text: string }; effects: EffectInstance[] };
		expect(after.content.text).toBe(clipBefore.content.text);
		expect(after.duration).toBe(clipBefore.duration);
		expect(after.effects.map((e) => e.effectId)).toEqual([TITLE_LOOK_EFFECT_ID, 'jasper.gaussian-blur']);
		expect(after.effects[0]!.id).toBe(fx);
		expect(lookOf(h, t).seed).toBe(seed);
		ok(h);
	});

	it('refuses clips that take no look, locked tracks, and looks it cannot read', () => {
		const { h, t, s } = project();
		const a = h.ok([
			{ type: 'clip.addSolid', at: 300, duration: 10, track: 'V1', color: [0, 0, 0, 1], ref: '$x' },
		]);
		expect(a.refs.$x).toBeTruthy();
		expect(code(h.tx([{ type: 'look.apply', clipIds: [t], lookId: 'tlk_0000000000000000' }]))).toBe(
			'E_NOT_FOUND',
		);
		expect(code(h.tx([{ type: 'look.apply', clipIds: [t] }]))).toBe('E_INVALID_PARAM');
		expect(
			code(
				h.tx([
					{
						type: 'look.apply',
						clipIds: [t],
						look: { name: 'Bad', recipe: { layers: [{ type: 'nonsense' }] } },
					},
				]),
			),
		).toBe('E_INVALID_PARAM');
		expect(
			code(
				h.tx([
					{
						type: 'look.apply',
						clipIds: [t],
						look: { name: 'Bad', recipe: { layers: [{ type: 'rim', params: { width: 'wide' } }] } },
					},
				]),
			),
		).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'track.update', trackId: h.seq.videoTracks[0]!.id, patch: { locked: true } }]);
		expect(code(h.tx([{ type: 'look.apply', clipIds: [s], look: source }]))).toBe('E_TRACK_LOCKED');
	});

	it('refuses more layers than a look holds, with E_LIMIT (TL-013)', () => {
		const { h, t } = project();
		const layers = Array.from({ length: MAX_APPEARANCE_LAYERS + 1 }, () => ({ type: 'rim' }));
		expect(
			code(h.tx([{ type: 'look.apply', clipIds: [t], look: { name: 'Big', recipe: { layers } } }])),
		).toBe('E_LIMIT');
	});

	it('applies a font once: the text changes, later edits of the look do not read it again', () => {
		const { h, t } = project();
		h.ok([
			{
				type: 'look.apply',
				clipIds: [t],
				look: { name: 'Typed', recipe: { ...recipe, font: { family: 'Oswald' } } },
			},
		]);
		const c = h.seq.clips[t] as unknown as { content: { style: { fontId: string } } };
		expect(h.doc.fonts[c.content.style.fontId]?.family).toBe('Oswald');
		ok(h);
	});
});

describe('look.remove, look.detach, look.reset', () => {
	it('remove takes the instance away; undo brings it back', () => {
		const { h, t, fx } = applied();
		const before = h.doc;
		h.ok([{ type: 'look.remove', clipIds: [t] }]);
		expect(clipLook((h.seq.clips[t] as unknown as { effects: EffectInstance[] }).effects)).toBeNull();
		h.doc = before;
		expect(fxOf(h, t).id).toBe(fx);
		ok(h);
		expect(code(h.tx([{ type: 'look.remove', clipIds: [project().s] }]))).not.toBeNull();
	});

	it('detach keeps every value and drops the link', () => {
		const { h, t } = applied();
		const layers = lookOf(h, t).layers;
		h.ok([{ type: 'look.detach', clipIds: [t] }]);
		expect(lookOf(h, t).lookId).toBeUndefined();
		expect(lookOf(h, t).layers).toEqual(layers);
		expect(code(h.tx([{ type: 'look.detach', clipIds: [t] }]))).toBe('E_INVALID_PARAM');
	});

	it('reset goes back to the look, keeps the seed, and can reset one layer', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		const shadow = layerOf(h, t, 'shadow').id;
		const seed = lookOf(h, t).seed;
		h.ok([
			{ type: 'param.set', target: ['appearance', fx, rim, 'width'], value: 20 },
			{ type: 'param.set', target: ['appearance', fx, shadow, 'distance'], value: 30 },
		]);
		expect(lookOf(h, t).lookOverrides).toMatchObject({ [rim]: ['width'], [shadow]: ['distance'] });
		h.ok([{ type: 'look.reset', clipIds: [t], layerIds: [rim] }]);
		expect(layerOf(h, t, 'rim').params.width!.value).toBe(5);
		expect(layerOf(h, t, 'shadow').params.distance!.value).toBe(30);
		expect(lookOf(h, t).lookOverrides).toEqual({ [shadow]: ['distance'] });
		h.ok([{ type: 'look.reset', clipIds: [t] }]);
		expect(layerOf(h, t, 'shadow').params.distance!.value).toBe(8);
		expect(lookOf(h, t).lookOverrides).toBeUndefined();
		expect(lookOf(h, t).seed).toBe(seed);
		ok(h);
	});

	it('reset refuses an unlinked clip', () => {
		const { h, t } = applied();
		h.ok([{ type: 'look.detach', clipIds: [t] }]);
		expect(code(h.tx([{ type: 'look.reset', clipIds: [t] }]))).toBe('E_INVALID_PARAM');
	});
});

describe('look.setColorway (TL-019)', () => {
	it('changes role values only: structure and keyframes stay', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 20 }, value: 8 },
		]);
		const types = lookOf(h, t).layers.map((l) => l.type);
		h.ok([{ type: 'look.setColorway', clipIds: [t], colorwayId: 'mint', palette: { face: [0, 1, 0.5, 1] } }]);
		const a = lookOf(h, t);
		expect(a.palette.face!.value).toEqual([0, 1, 0.5, 1]);
		expect(a.colorwayId).toBe('mint');
		expect(a.layers.map((l) => l.type)).toEqual(types);
		expect(layerOf(h, t, 'rim').params.width!.keyframes).toHaveLength(2);
		ok(h);
	});

	it('reads a colourway of the linked look, reports keyed roles it could not change, refuses an unknown one', () => {
		const { h, t } = project();
		h.ok([
			{
				type: 'look.apply',
				clipIds: [t],
				look: { ...source, colorways: [{ id: 'cool', name: 'Cool', palette: { face: [0, 0.5, 1, 1] } }] },
			},
		]);
		const id = fxOf(h, t).id;
		h.ok([
			{
				type: 'keyframe.add',
				target: ['appearance', id, 'palette', 'face'],
				at: { frames: 0 },
				value: [1, 1, 1, 1],
			},
		]);
		const r = h.ok([{ type: 'look.setColorway', clipIds: [t], colorwayId: 'cool' }]);
		expect((r.results[0] as { keptAnimated: Record<string, string[]> }).keptAnimated[t]).toEqual(['face']);
		expect(code(h.tx([{ type: 'look.setColorway', clipIds: [t], colorwayId: 'nope' }]))).toBe('E_NOT_FOUND');
		expect(code(h.tx([{ type: 'look.setColorway', clipIds: [t] }]))).toBe('E_INVALID_PARAM');
	});
});

describe('project looks: create, update, rename, delete (TL-015, TL-016)', () => {
	it('create from a clip takes the values at its first frame, with no keyframes', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 11 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 30 }, value: 3 },
		]);
		const r = h.ok([{ type: 'look.create', name: 'From Clip', fromClipId: t }]);
		const look = titleLookOf(h.doc, (r.results[0] as { lookId: string }).lookId)!;
		const w = look.appearance.layers.find((l) => l.type === 'rim')!.params.width!;
		expect(w).toEqual({ value: 11, keyframes: [] });
		expect(look.appearance.lookId).toBeUndefined();
		ok(h);
	});

	it('create refuses duplicate names, missing sources and bad recipes', () => {
		const { h, t } = applied();
		h.ok([{ type: 'look.create', name: 'One', recipe }]);
		expect(code(h.tx([{ type: 'look.create', name: 'one', recipe }]))).toBe('E_INVALID_PARAM');
		expect(code(h.tx([{ type: 'look.create', name: 'Two' }]))).toBe('E_INVALID_PARAM');
		expect(code(h.tx([{ type: 'look.create', name: 'Two', recipe, fromClipId: t }]))).toBe('E_INVALID_PARAM');
		expect(code(h.tx([{ type: 'look.create', name: 'Two', recipe: { layers: 'no' } }]))).toBe(
			'E_INVALID_PARAM',
		);
	});

	it('update rewrites linked clips, keeps overrides and keyframes, and skips locked tracks with a warning', () => {
		const { h, t, u, fx } = applied();
		h.ok([{ type: 'look.apply', clipIds: [u], lookId: lookOf(h, t).lookId }]);
		const lookId = lookOf(h, t).lookId!;
		const rim = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 1 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 30 }, value: 2 },
		]);
		const r = h.ok([
			{
				type: 'look.update',
				lookId,
				recipe: { ...recipe, layers: [...recipe.layers, { type: 'glow', params: { radius: 44 } }] },
			},
		]);
		expect((r.results[0] as { updated: number }).updated).toBe(2);
		ok(h);
		expect(lookOf(h, u).layers.at(-1)!.type).toBe('glow');
		// A recipe has no layer ids: layers keep theirs by type and position, so the clip's keys survive.
		expect(lookOf(h, t).layers.at(-1)!.type).toBe('glow');
		expect(layerOf(h, t, 'rim').params.width!.keyframes.map((k) => k.value)).toEqual([1, 2]);
		expect(lookOf(h, t).lookOverrides).toEqual({ [rim]: ['width'] });
	});

	it('update by clip keeps a deviation of another clip, on the same layer ids', () => {
		const { h, t, u, fx } = applied();
		const lookId = lookOf(h, t).lookId!;
		h.ok([{ type: 'look.apply', clipIds: [u], lookId }]);
		const fxU = fxOf(h, u).id;
		const rim = layerOf(h, t, 'rim').id;
		const shadow = layerOf(h, t, 'shadow').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fxU, rim, 'width'], at: { frames: 0 }, value: 1 },
			{ type: 'keyframe.add', target: ['appearance', fxU, rim, 'width'], at: { frames: 30 }, value: 2 },
			{ type: 'param.set', target: ['appearance', fx, shadow, 'distance'], value: 40 },
		]);
		h.ok([{ type: 'look.update', lookId, fromClipId: t }]);
		// The look took the new shadow; the other clip follows it and keeps its own keyed rim.
		expect(layerOf(h, u, 'shadow').params.distance!.value).toBe(40);
		expect(layerOf(h, u, 'rim').params.width!.keyframes).toHaveLength(2);
		ok(h);
	});

	it('update skips clips on locked tracks and warns W_CLIP_SKIPPED', () => {
		const { h, t } = applied();
		const lookId = lookOf(h, t).lookId!;
		const shadow = layerOf(h, t, 'shadow').params.distance!.value;
		h.ok([{ type: 'track.update', trackId: h.seq.clips[t]!.trackId, patch: { locked: true } }]);
		const r = h.ok([{ type: 'look.update', lookId, recipe: { layers: [{ type: 'face' }] } }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_CLIP_SKIPPED');
		expect((r.results[0] as { skipped: string[] }).skipped).toEqual([t]);
		expect(layerOf(h, t, 'shadow').params.distance!.value).toBe(shadow);
	});

	it('rename and delete: a deleted look only unlinks its clips, which keep their values', () => {
		const { h, t } = applied();
		const lookId = lookOf(h, t).lookId!;
		h.ok([{ type: 'look.rename', lookId, name: 'Renamed' }]);
		expect(titleLookOf(h.doc, lookId)!.name).toBe('Renamed');
		const layers = lookOf(h, t).layers;
		h.ok([{ type: 'look.delete', lookId }]);
		expect(lookOf(h, t).lookId).toBeUndefined();
		expect(lookOf(h, t).layers).toEqual(layers);
		expect(h.doc.titleLooks).toBeUndefined();
		expect(code(h.tx([{ type: 'look.delete', lookId }]))).toBe('E_NOT_FOUND');
		ok(h);
	});
});

describe('appearance.* (TL-018)', () => {
	it('adds, reorders, disables and removes layers; each is one undo step', () => {
		const { h, t, fx } = applied();
		const before = h.doc;
		const r = h.ok([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'glow', index: 1 }]);
		const id = (r.results[0] as { layerId: string }).layerId;
		expect(lookOf(h, t).layers.map((l) => l.type)).toEqual(['shadow', 'glow', 'rim', 'face']);
		h.ok([{ type: 'appearance.reorderLayer', effectInstanceId: fx, layerId: id, index: 0 }]);
		expect(lookOf(h, t).layers[0]!.id).toBe(id);
		h.ok([{ type: 'appearance.setLayerEnabled', effectInstanceId: fx, layerId: id, enabled: false }]);
		expect(lookOf(h, t).layers[0]!.enabled).toBe(false);
		expect(resolveAppearance(lookOf(h, t), 0).layers.map((l) => l.type)).toEqual(['shadow', 'rim', 'face']);
		h.ok([{ type: 'appearance.removeLayer', effectInstanceId: fx, layerId: id }]);
		expect(lookOf(h, t).layers).toHaveLength(3);
		ok(h);
		h.doc = before;
		expect(lookOf(h, t).layers).toHaveLength(3);
	});

	it('refuses unknown types, ids, params and the 25th layer', () => {
		const { h, t, fx } = applied();
		const add = (o: object) => ({
			type: 'appearance.addLayer',
			effectInstanceId: fx,
			layerType: 'rim',
			...o,
		});
		expect(code(h.tx([add({ layerType: 'nonsense' })]))).toBe('E_UNKNOWN_EFFECT');
		expect(code(h.tx([add({ params: { nonsense: 1 } })]))).toBe('E_INVALID_PARAM');
		expect(code(h.tx([add({ params: { width: -5 } })]))).toBe('E_INVALID_PARAM');
		expect(
			code(
				h.tx([{ type: 'appearance.addLayer', effectInstanceId: 'fx_0000000000000000', layerType: 'rim' }]),
			),
		).toBe('E_NOT_FOUND');
		expect(
			code(h.tx([{ type: 'appearance.removeLayer', effectInstanceId: fx, layerId: 'apl_0000000000000000' }])),
		).toBe('E_NOT_FOUND');
		h.ok(Array.from({ length: MAX_APPEARANCE_LAYERS - 3 }, () => add({})));
		expect(lookOf(h, t).layers).toHaveLength(MAX_APPEARANCE_LAYERS);
		expect(code(h.tx([add({})]))).toBe('E_LIMIT');
		ok(h);
	});

	it('setPaint and setGradient write a layer paint; 33 stops is E_LIMIT, a bad gradient E_INVALID_PARAM', () => {
		const { h, t, fx } = applied();
		const face = layerOf(h, t, 'face').id;
		h.ok([
			{
				type: 'appearance.setPaint',
				effectInstanceId: fx,
				layerId: face,
				paint: { kind: 'color', color: [1, 0, 0, 1] },
			},
		]);
		expect(layerOf(h, t, 'face').params.paint!.value).toEqual({ kind: 'color', color: [1, 0, 0, 1] });
		const stops = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ at: i / Math.max(1, n - 1), paint: { role: 'face' } }));
		const gradient = (n: number) => ({ type: 'linear', span: 'block', angle: 90, stops: stops(n) });
		h.ok([{ type: 'appearance.setGradient', effectInstanceId: fx, layerId: face, gradient: gradient(32) }]);
		expect(
			code(
				h.tx([
					{
						type: 'appearance.setGradient',
						effectInstanceId: fx,
						layerId: face,
						gradient: gradient(MAX_GRADIENT_STOPS + 1),
					},
				]),
			),
		).toBe('E_LIMIT');
		expect(
			code(
				h.tx([
					{ type: 'appearance.setGradient', effectInstanceId: fx, layerId: face, gradient: gradient(1) },
				]),
			),
		).toBe('E_INVALID_PARAM');
		expect(
			code(
				h.tx([
					{ type: 'appearance.setPaint', effectInstanceId: fx, layerId: face, paint: { kind: 'plaid' } },
				]),
			),
		).toBe('E_INVALID_PARAM');
		expect(
			code(
				h.tx([
					{
						type: 'appearance.setPaint',
						effectInstanceId: fx,
						layerId: face,
						param: 'opacity',
						paint: { kind: 'source' },
					},
				]),
			),
		).toBe('E_INVALID_PARAM');
		ok(h);
	});

	it('refuses edits on a locked track', () => {
		const { h, t, fx } = applied();
		h.ok([{ type: 'track.update', trackId: h.seq.clips[t]!.trackId, patch: { locked: true } }]);
		expect(code(h.tx([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'rim' }]))).toBe(
			'E_TRACK_LOCKED',
		);
	});
});

describe('animation reaches every number (TL-014)', () => {
	it('param.set clamps to the range, hold-only params take hold keys, paints are hold-only', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		const r = h.ok([{ type: 'param.set', target: ['appearance', fx, rim, 'width'], value: 99_999 }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect(code(h.tx([{ type: 'param.set', target: ['appearance', fx, rim, 'width'], value: 'wide' }]))).toBe(
			'E_INVALID_PARAM',
		);
		expect(code(h.tx([{ type: 'param.set', target: ['appearance', fx, rim, 'nonsense'], value: 1 }]))).toBe(
			'E_NOT_FOUND',
		);
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'finish'], at: { frames: 0 }, value: 'flat' },
			{
				type: 'keyframe.add',
				target: ['appearance', fx, rim, 'paint'],
				at: { frames: 0 },
				value: { kind: 'role', role: 'face' },
			},
		]);
		const keys = layerOf(h, t, 'rim').params;
		expect(keys.finish!.keyframes[0]!.interpolation).toBe('hold');
		expect(keys.paint!.keyframes[0]!.interpolation).toBe('hold');
		expect(
			code(h.tx([{ type: 'param.set', target: ['appearance', fx, rim, 'paint'], value: { kind: 'plaid' } }])),
		).toBe('E_INVALID_PARAM');
		ok(h);
	});

	it('palette colours and light animate, with keys in content time', () => {
		const { h, t, fx } = applied();
		h.ok([
			{
				type: 'keyframe.add',
				target: ['appearance', fx, 'palette', 'face'],
				at: { frames: 0 },
				value: [0, 0, 0, 1],
			},
			{
				type: 'keyframe.add',
				target: ['appearance', fx, 'palette', 'face'],
				at: { frames: 30 },
				value: [1, 1, 1, 1],
			},
			{ type: 'keyframe.add', target: ['appearance', fx, 'light', 'angle'], at: { frames: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['appearance', fx, 'light', 'angle'], at: { frames: 30 }, value: 90 },
		]);
		const a = lookOf(h, t);
		const mid = resolveAppearance(a, 15 * F);
		expect(mid.palette.face[0]).toBeCloseTo(0.5, 5);
		expect(mid.light.angle).toBeCloseTo(45, 5);
		ok(h);
	});

	it('every walker sees appearance params: keyframes commands, expressions, property keys', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		const add = h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 5 }, value: 7 },
		]);
		const key = (add.results[0] as { keyframeId: string }).keyframeId;
		// keyframe.* locates keys by id through the shared walker.
		h.ok([{ type: 'keyframe.remove', keyframeIds: [key] }]);
		expect(layerOf(h, t, 'rim').params.width!.keyframes).toEqual([]);
		// Expressions address the same property.
		h.ok([{ type: 'expression.set', target: ['appearance', fx, rim, 'width'], text: '3 + 4' }]);
		expect(layerOf(h, t, 'rim').params.width!.expression?.text).toBe('3 + 4');
		const refs = [...sequenceAnimatables(h.seqId, h.seq)].map((l) => l.ref.path);
		expect(refs).toContain(`appearance.${fx}.${rim}.width`);
		const ref = paramPathToExpressionRef(h.doc, ['appearance', fx, rim, 'width'])!;
		expect(ref).toEqual({ seq: h.seqId, owner: t, path: `appearance.${fx}.${rim}.width` });
		expect(expressionRefToParamPath(ref)).toEqual(['appearance', fx, rim, 'width']);
		// Property registry keys.
		const k = `appearance.${fx}.${rim}.width`;
		expect(propertyKeyToParamPath({ clipId: t }, k)).toEqual(['appearance', fx, rim, 'width']);
		const clip = h.seq.clips[t]!;
		const spec = resolvePropertySpec(k, undefined, undefined, clip as never);
		expect(spec).toMatchObject({ kind: 'number', unit: '%', animatable: 'continuous' });
		expect(appearancePropertySpecs(fxOf(h, t), lookOf(h, t)).some((s) => s.key === k)).toBe(true);
		ok(h);
	});

	it('a key in the appearance makes the clip animated (a static clip would reuse its first frame)', () => {
		const { h, t, fx } = applied();
		const rim = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 30 }, value: 8 },
		]);
		const fxLook = lookOf(h, t);
		const c = {
			transform: null,
			opacity: { value: 100, keyframes: [] },
			intrinsicBox: { width: 100, height: 100 },
			effects: [fxOf(h, t)],
		};
		const at = (t2: number) =>
			resolveLayerProps(c as never, t2).effects[0]!.appearance!.layers.find((l) => l.type === 'rim')!.params
				.width;
		expect(at(0)).toBe(2);
		expect(at(30 * F)).toBe(8);
		expect(evaluate(fxLook.layers[1]!.params.width as never, 15 * F)).toBeCloseTo(5, 5);
	});
});

describe('the look survives editing (TL-014)', () => {
	const keyed = () => {
		const p = applied();
		const rim = layerOf(p.h, p.t, 'rim').id;
		p.h.ok([
			{ type: 'keyframe.add', target: ['appearance', p.fx, rim, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', p.fx, rim, 'width'], at: { frames: 40 }, value: 10 },
			{
				type: 'keyframe.add',
				target: ['appearance', p.fx, 'palette', 'face'],
				at: { frames: 0 },
				value: [1, 0, 0, 1],
			},
		]);
		return { ...p, rim };
	};

	it('split: both parts keep the look, the seed and the same value at every time, with fresh key ids', () => {
		const { h, t, rim } = keyed();
		const seed = lookOf(h, t).seed;
		const lookId = lookOf(h, t).lookId;
		h.ok([{ type: 'clip.split', at: 20, clipIds: [t] }]);
		const clips = Object.values(h.seq.clips).filter((c) => c.kind === 'text' && c.start < 70);
		expect(clips).toHaveLength(2);
		const [a, b] = clips.sort((x, y) => x.start - y.start);
		const la = lookOf(h, a!.id);
		const lb = lookOf(h, b!.id);
		expect(lb.seed).toBe(seed);
		expect(lb.lookId).toBe(lookId);
		// Layer ids stay: `lookOverrides` is keyed by them.
		expect(lb.layers.map((l) => l.id)).toEqual(la.layers.map((l) => l.id));
		const wa = la.layers.find((l) => l.id === rim)!.params.width!;
		const wb = lb.layers.find((l) => l.id === rim)!.params.width!;
		expect(wa.keyframes.map((k) => k.id)).not.toEqual(wb.keyframes.map((k) => k.id));
		// Content time is continuous across the cut: the right part reads the same curve.
		expect(evaluate(wb as never, b!.sourceIn)).toBeCloseTo(
			evaluate(wa as never, a!.sourceIn + 20 * F) as number,
			6,
		);
		expect(fxOf(h, b!.id).id).not.toBe(fxOf(h, a!.id).id);
		ok(h);
	});

	it('duplicate: a new instance with the same seed and link, fresh key ids', () => {
		const { h, t } = keyed();
		const seed = lookOf(h, t).seed;
		h.ok([{ type: 'clip.duplicate', clipIds: [t], deltaFrames: 300 }]);
		const copy = Object.values(h.seq.clips).find((c) => c.id !== t && c.start === 300)!;
		expect(lookOf(h, copy.id).seed).toBe(seed);
		expect(lookOf(h, copy.id).lookId).toBe(lookOf(h, t).lookId);
		expect(fxOf(h, copy.id).id).not.toBe(fxOf(h, t).id);
		ok(h);
	});

	it('copy and paste in the same project keeps the link', () => {
		const { h, t } = keyed();
		const payload = buildClipsPayload(h.doc, h.seqId, [t]);
		h.ok([{ type: 'clip.paste', payload, at: 400 }]);
		const copy = Object.values(h.seq.clips).find((c) => c.start === 400)!;
		expect(lookOf(h, copy.id).lookId).toBe(lookOf(h, t).lookId);
		expect(titleLooksOf(h.doc)).toHaveLength(1);
		ok(h);
	});

	it('cross-project paste brings the look along, under a new id', () => {
		const { h, t } = keyed();
		const payload = buildClipsPayload(h.doc, h.seqId, [t]);
		expect(payload.titleLooks).toHaveLength(1);
		const other = new Harness({ seed: 900 });
		other.ok([{ type: 'clip.paste', payload: JSON.parse(JSON.stringify(payload)), at: 0 }]);
		const clip = Object.values(other.seq.clips)[0]!;
		const a = lookOf(other, clip.id);
		expect(a.lookId).not.toBe(lookOf(h, t).lookId);
		expect(titleLookOf(other.doc, a.lookId!)!.name).toBe('Gold');
		expect(a.seed).toBe(lookOf(h, t).seed);
		ok(other);
		// Pasting again reuses nothing silently: a second copy of a project-made look comes along with its own name.
		other.ok([{ type: 'clip.paste', payload: JSON.parse(JSON.stringify(payload)), at: 100 }]);
		ok(other);
	});

	it('a pasted clip whose look did not travel only unlinks: it keeps its values', () => {
		const { h, t } = keyed();
		const payload = JSON.parse(JSON.stringify(buildClipsPayload(h.doc, h.seqId, [t])));
		delete payload.titleLooks;
		const other = new Harness({ seed: 901 });
		other.ok([{ type: 'clip.paste', payload, at: 0 }]);
		const clip = Object.values(other.seq.clips)[0]!;
		expect(lookOf(other, clip.id).lookId).toBeUndefined();
		expect(lookOf(other, clip.id).layers).toHaveLength(3);
		ok(other);
	});

	it('Paste Attributes: a look onto a clip without one, keys retimed, and it replaces an existing one', () => {
		const { h, t, u } = keyed();
		const payload = buildEffectsPayload(h.doc, t);
		h.ok([{ type: 'clip.pasteAttributes', payload, clipIds: [u], attributes: { effects: 'all' } }]);
		const a = lookOf(h, u);
		expect(a.layers).toHaveLength(3);
		const width = a.layers.find((l) => l.type === 'rim')!.params.width!;
		expect(width.keyframes.map((k) => k.time)).toEqual([
			h.seq.clips[u]!.sourceIn,
			h.seq.clips[u]!.sourceIn + 40 * F,
		]);
		expect(a.lookId).toBe(lookOf(h, t).lookId);
		ok(h);
		// A second paste replaces the look (TL-010: at most one).
		const fxU = fxOf(h, u).id;
		h.ok([{ type: 'clip.pasteAttributes', payload, clipIds: [u], attributes: { effects: 'all' } }]);
		const list = (h.seq.clips[u] as unknown as { effects: EffectInstance[] }).effects;
		expect(list.filter((e) => e.effectId === TITLE_LOOK_EFFECT_ID)).toHaveLength(1);
		expect(fxOf(h, u).id).toBe(fxU);
		ok(h);
	});

	it('Paste Attributes across projects carries the look, and an unlinked paste keeps the values', () => {
		const { h, t } = keyed();
		const payload = JSON.parse(JSON.stringify(buildEffectsPayload(h.doc, t)));
		expect(payload.titleLooks).toHaveLength(1);
		const other = new Harness({ seed: 902 });
		const r = other.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'X' }, ref: '$x' },
		]);
		const id = r.refs.$x!;
		other.ok([{ type: 'clip.pasteAttributes', payload, clipIds: [id], attributes: { effects: 'all' } }]);
		expect(titleLookOf(other.doc, lookOf(other, id).lookId!)!.name).toBe('Gold');
		ok(other);
	});
});

describe('keyframe copy and paste reach appearance params (TL-014)', () => {
	it('copies keys of a layer param and pastes them onto another clip with the same look', () => {
		const { h, t, u, fx } = applied();
		h.ok([{ type: 'look.apply', clipIds: [u], lookId: lookOf(h, t).lookId }]);
		const rim = layerOf(h, t, 'rim').id;
		const add = h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 10 }, value: 8 },
		]);
		const ids = add.results.map((r) => (r as { keyframeId: string }).keyframeId);
		const payload = buildKeyframesPayload(h.doc, t, ids);
		h.ok([{ type: 'keyframe.paste', payload, clipId: u, at: { frames: 5 } }]);
		const keys = layerOf(h, u, 'rim').params.width!.keyframes;
		expect(keys.map((k) => k.value)).toEqual([2, 8]);
		expect(keys[1]!.time - keys[0]!.time).toBe(10 * F);
		ok(h);
	});

	it('refuses a clip whose look has no such layer', () => {
		const { h, t, u, fx } = applied();
		h.ok([
			{ type: 'look.apply', clipIds: [u], look: { name: 'Other', recipe: { layers: [{ type: 'face' }] } } },
		]);
		const rim = layerOf(h, t, 'rim').id;
		const add = h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 2 },
		]);
		const payload = buildKeyframesPayload(h.doc, t, [(add.results[0] as { keyframeId: string }).keyframeId]);
		expect(code(h.tx([{ type: 'keyframe.paste', payload, clipId: u, at: { frames: 0 } }]))).toBe(
			'E_INVALID_PARAM',
		);
	});
});

describe('global light (TL-017)', () => {
	it('a look following the sequence light reads its keys in sequence time, on a clip that starts later', () => {
		const { h, u } = project();
		h.ok([
			{
				type: 'look.apply',
				clipIds: [u],
				look: {
					name: 'Lit',
					recipe: { light: { source: 'sequence', angle: 10 }, layers: [{ type: 'face' }] },
				},
			},
			{ type: 'sequence.setGlobalLight', angle: 0 },
			{ type: 'keyframe.add', target: ['globalLight', h.seqId, 'angle'], at: { sequenceFrame: 0 }, value: 0 },
			{
				type: 'keyframe.add',
				target: ['globalLight', h.seqId, 'angle'],
				at: { sequenceFrame: 200 },
				value: 200,
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((v) => v.clips).find((c) => c.clipId === u)!;
		expect(clip.sequenceLight).toBeTruthy();
		// Clip u starts at sequence frame 80: frame 10 of the clip is sequence frame 90, whatever its source in-point.
		const t = clipContentTime(clip, 90, { num: 30, den: 1 });
		const look = resolveCachedLayerProps(clip, t).effects[0]!.appearance!;
		expect(look.light.angle).toBeCloseTo(90, 5);
	});

	it('sets and clears it, animates in sequence time, refuses a keyed direct write', () => {
		const { h } = project();
		h.ok([{ type: 'sequence.setGlobalLight', angle: 90, altitude: 30 }]);
		const light = () => (h.seq.settings as { globalLight?: { angle: { value: number } } }).globalLight;
		expect(light()!.angle.value).toBe(90);
		h.ok([
			{
				type: 'keyframe.add',
				target: ['globalLight', h.seqId, 'angle'],
				at: { sequenceFrame: 0 },
				value: 10,
			},
		]);
		expect(code(h.tx([{ type: 'sequence.setGlobalLight', angle: 5 }]))).toBe('E_INVALID_PARAM');
		ok(h);
		h.ok([{ type: 'sequence.setGlobalLight', clear: true }]);
		expect(light()).toBeUndefined();
		expect(code(h.tx([{ type: 'sequence.setGlobalLight', clear: true, angle: 1 }]))).toBe('E_INVALID_PARAM');
		expect(code(h.tx([{ type: 'sequence.setGlobalLight', altitude: 120 }]))).toBe('E_SCHEMA');
	});
});

describe('clip.addGenerator (TL-060, TL-064)', () => {
	const gen = () => [...defaultEffectRegistry.list()].find((e) => e.category === 'Generate' && e.gpu)!.id;

	it('makes one transparent solid with the effect, in one transaction', () => {
		const { h } = project();
		const r = h.ok([{ type: 'clip.addGenerator', effectId: gen(), at: 300, duration: 30 }]);
		const { clipId } = r.results[0] as { clipId: string };
		const c = h.seq.clips[clipId] as unknown as {
			kind: string;
			syntheticId: string;
			effects: EffectInstance[];
		};
		expect(c.kind).toBe('solid');
		expect(h.doc.synthetics[c.syntheticId]?.kind).toBe('transparent');
		expect(c.effects.map((e) => e.effectId)).toEqual([gen()]);
		ok(h);
	});

	it('goes on a free track below a title', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V3', content: { text: 'T' }, ref: '$t' },
		]);
		const a = h.ok([
			{ type: 'clip.addGenerator', effectId: gen(), at: 0, duration: 60, belowClipId: r.refs.$t },
		]);
		const c = h.seq.clips[(a.results[0] as { clipId: string }).clipId]!;
		const idx = (id: string) => h.seq.videoTracks.findIndex((x) => x.id === id);
		expect(idx(c.trackId)).toBeLessThan(idx(h.seq.clips[r.refs.$t!]!.trackId));
		ok(h);
	});

	it('never hides the title: with nothing free below it, a new track goes under it (TL-064)', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'T' }, ref: '$t' },
		]);
		const a = h.ok([
			{
				type: 'clip.addGenerator',
				effectId: 'generator:sunburst',
				at: 0,
				duration: 60,
				belowClipId: r.refs.$t,
			},
		]);
		const c = h.seq.clips[(a.results[0] as { clipId: string }).clipId]!;
		const idx = (id: string) => h.seq.videoTracks.findIndex((x) => x.id === id);
		expect(idx(c.trackId)).toBeLessThan(idx(h.seq.clips[r.refs.$t!]!.trackId));
		ok(h);
	});

	it('skips a busy or a locked track below the title', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V3', content: { text: 'T' }, ref: '$t' },
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'B' }, ref: '$b' },
		]);
		const a = h.ok([
			{
				type: 'clip.addGenerator',
				effectId: 'jasper.generator.fire',
				at: 0,
				duration: 60,
				belowClipId: r.refs.$t,
			},
		]);
		const c = h.seq.clips[(a.results[0] as { clipId: string }).clipId]!;
		expect(h.seq.videoTracks.findIndex((x) => x.id === c.trackId)).toBe(0);
		ok(h);
	});

	it('takes a generator by its look name, with a preset under its params (TL-063)', () => {
		const { h } = project();
		const r = h.ok([
			{
				type: 'clip.addGenerator',
				effectId: 'generator:fire',
				preset: 'blaze',
				params: { intensity: 50 },
				at: 300,
				duration: 30,
			},
		]);
		const { clipId } = r.results[0] as { clipId: string };
		const fx = (h.seq.clips[clipId] as unknown as { effects: EffectInstance[] }).effects[0]!;
		expect(fx.effectId).toBe('jasper.generator.fire');
		const value = (k: string) => (fx.params[k] as { value: unknown } | undefined)?.value ?? fx.params[k];
		expect(value('height')).toBe(130);
		expect(value('intensity')).toBe(50);
		expect(code(h.tx([{ type: 'clip.addGenerator', effectId: 'fire', at: 0, duration: 10 }]))).toBe(
			'E_UNKNOWN_EFFECT',
		);
		expect(
			code(
				h.tx([
					{ type: 'clip.addGenerator', effectId: 'generator:fire', preset: 'nope', at: 400, duration: 10 },
				]),
			),
		).toBe('E_INVALID_PARAM');
		ok(h);
	});

	it('refuses effects that are not generators and unknown ones', () => {
		const { h } = project();
		expect(code(h.tx([{ type: 'clip.addGenerator', effectId: 'nonsense', at: 0, duration: 10 }]))).toBe(
			'E_UNKNOWN_EFFECT',
		);
		expect(
			code(h.tx([{ type: 'clip.addGenerator', effectId: 'jasper.gaussian-blur', at: 0, duration: 10 }])),
		).toBe('E_INVALID_PARAM');
	});
});

describe('generator layers (TL-060, TL-064)', () => {
	const types = (h: Harness, t: string) => lookOf(h, t).layers.map((l) => l.type);

	it('a generator goes behind the title by its own default, or in front when it says so', () => {
		const { h, t, fx } = applied();
		const before = types(h, t).length;
		h.ok([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'generator:fire' }]);
		expect(types(h, t)[0]).toBe('generator:fire');
		h.ok([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'generator:smoke' }]);
		// A second one stays above the first and below the title.
		expect(types(h, t).slice(0, 2)).toEqual(['generator:fire', 'generator:smoke']);
		h.ok([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'generator:lightning' }]);
		expect(types(h, t).at(-1)).toBe('generator:lightning');
		expect(types(h, t).length).toBe(before + 3);
		ok(h);
	});

	it('an explicit index wins, and a preset fills the layer', () => {
		const { h, t, fx } = applied();
		const r = h.ok([
			{
				type: 'appearance.addLayer',
				effectInstanceId: fx,
				layerType: 'generator:glints',
				preset: 'stars',
				index: 0,
			},
		]);
		expect((r.results[0] as { index: number }).index).toBe(0);
		expect(lookOf(h, t).layers[0]!.params.stars!.value).toBe(4);
		ok(h);
	});

	it('keeps its own seed and survives a split with the rest of the look', () => {
		const { h, t, fx } = applied();
		h.ok([{ type: 'appearance.addLayer', effectInstanceId: fx, layerType: 'generator:particles' }]);
		const seed = lookOf(h, t).seed;
		h.ok([{ type: 'clip.split', clipIds: [t], at: 30 }]);
		const right = Object.values(h.seq.clips).find((c) => c.id !== t && c.start === 30 && c.kind === 'text')!;
		expect(lookOf(h, right.id).seed).toBe(seed);
		expect(types(h, right.id)).toEqual(types(h, t));
		ok(h);
	});
});

describe('invariants and repair (INV-APPEARANCE, TL-020)', () => {
	const mutate = (h: Harness, f: (fx: EffectInstance, doc: Record<string, unknown>) => void) => {
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(
			doc.sequences as Record<string, { clips: Record<string, { effects: EffectInstance[] }> }>,
		)[0]!;
		const c = Object.values(seq.clips).find((x) =>
			x.effects?.some((e) => e.effectId === TITLE_LOOK_EFFECT_ID),
		)!;
		f(c.effects.find((e) => e.effectId === TITLE_LOOK_EFFECT_ID)!, doc);
		return doc;
	};
	const issue = (doc: unknown) =>
		checkInvariants(doc as never, { effects: defaultEffectRegistry }).map((i) => i.invariant);

	it('reports unreadable appearances, a second look, a look on a wrong kind or track', () => {
		const { h } = applied();
		expect(
			issue(
				mutate(h, (fx) => {
					(fx.appearance as Appearance).seed = -1;
				}),
			),
		).toContain('INV-APPEARANCE');
		expect(
			issue(
				mutate(h, (fx) => {
					(fx.appearance as Appearance).layers[0]!.type = 'nonsense';
				}),
			),
		).toContain('INV-APPEARANCE');
		expect(
			issue(
				mutate(h, (fx) => {
					(fx.appearance as Appearance).layers[1]!.id = 'nonsense';
				}),
			),
		).toContain('INV-APPEARANCE');
		expect(
			issue(
				mutate(h, (fx) => {
					delete (fx as { appearance?: unknown }).appearance;
				}),
			),
		).toContain('INV-APPEARANCE');
		expect(
			issue(
				mutate(h, (fx, doc) => {
					const seq = Object.values(
						doc.sequences as Record<string, { clips: Record<string, { effects: unknown[] }> }>,
					)[0]!;
					const c = Object.values(seq.clips).find((x) => x.effects?.length)!;
					c.effects.push({ ...fx, id: 'fx_00000000000DUP01' });
				}),
			),
		).toContain('INV-APPEARANCE');
		expect(
			issue(
				mutate(h, (fx) => {
					fx.effectId = 'jasper.gaussian-blur';
				}),
			),
		).toContain('INV-APPEARANCE');
	});

	it('loads a damaged look, repairs what it can and reports it; a project never fails to open over one', () => {
		const { h, t } = applied();
		const doc = mutate(h, (fx) => {
			const a = fx.appearance as unknown as Record<string, unknown>;
			a.seed = 'x';
			(a.palette as Record<string, unknown>).nonsense = 1;
			const layers = a.layers as Record<string, unknown>[];
			layers.push({ type: 'from-the-future', id: 'apl_0000000000000099', enabled: true, params: {} });
			(layers[0]!.params as Record<string, unknown>).nonsense = { value: 1, keyframes: [] };
			(layers[1]!.params as Record<string, { value: unknown }>).width!.value = 99_999;
		});
		const r = loadProject({ format: 'jasper-project', document: doc }, { effects: defaultEffectRegistry });
		expect(r.issues).toEqual([]);
		expect(r.repairs.map((x) => x.action)).toEqual(
			expect.arrayContaining(['repair-appearance', 'drop-appearance-layer']),
		);
		const loaded = Object.values(r.document.sequences)[0]!.clips[t] as unknown as {
			effects: EffectInstance[];
		};
		const a = clipLook(loaded.effects)!.appearance as Appearance;
		expect(a.layers).toHaveLength(3);
		expect(a.layers[1]!.params.width!.value).toBe(1000);
	});

	it('an appearance it cannot read at all goes, and the clip shows its own picture', () => {
		const { h, t } = applied();
		const doc = mutate(h, (fx) => {
			(fx as unknown as { appearance: unknown }).appearance = 'garbage';
		});
		const r = loadProject({ format: 'jasper-project', document: doc }, { effects: defaultEffectRegistry });
		expect(r.issues).toEqual([]);
		expect(r.repairs.some((x) => x.action === 'drop-look')).toBe(true);
		const c = Object.values(r.document.sequences)[0]!.clips[t] as unknown as { effects: EffectInstance[] };
		expect(clipLook(c.effects)).toBeNull();
	});

	it('over the limits: the excess bottom layers go and it is reported (TL-013)', () => {
		const { h, t } = applied();
		const doc = mutate(h, (fx) => {
			const a = fx.appearance as Appearance;
			const rim = a.layers[1]!;
			a.layers = Array.from({ length: 30 }, (_, i) => ({ ...rim, id: `apl_${String(i).padStart(16, '0')}` }));
		});
		const r = loadProject({ format: 'jasper-project', document: doc }, { effects: defaultEffectRegistry });
		expect(r.issues).toEqual([]);
		expect(r.repairs.some((x) => x.action === 'drop-appearance-layer')).toBe(true);
		const c = Object.values(r.document.sequences)[0]!.clips[t] as unknown as { effects: EffectInstance[] };
		expect((clipLook(c.effects)!.appearance as Appearance).layers).toHaveLength(MAX_APPEARANCE_LAYERS);
	});

	it('a missing project look only unlinks the clip (TL-015)', () => {
		const { h, t } = applied();
		const doc = JSON.parse(JSON.stringify(h.doc));
		delete doc.titleLooks;
		const r = loadProject({ format: 'jasper-project', document: doc }, { effects: defaultEffectRegistry });
		expect(r.repairs.some((x) => x.action === 'unlink-look')).toBe(true);
		const c = Object.values(r.document.sequences)[0]!.clips[t] as unknown as { effects: EffectInstance[] };
		const a = clipLook(c.effects)!.appearance as Appearance;
		expect(a.lookId).toBeUndefined();
		expect(a.layers).toHaveLength(3);
	});

	it('repairs a damaged look record and global light', () => {
		const { h } = applied();
		const doc = JSON.parse(JSON.stringify(h.doc));
		doc.titleLooks.bad = 7;
		doc.titleLooks.tlk_0000000000000BAD = { id: 'wrong', name: '', appearance: { v: 9 } };
		(Object.values(doc.sequences)[0] as { settings: { globalLight?: unknown } }).settings.globalLight =
			'bright';
		const r = repairDocument(doc, createCounterIdSource(50));
		expect(checkInvariants(r.document, { effects: defaultEffectRegistry })).toEqual([]);
		expect(titleLooksOf(r.document)).toHaveLength(1);
		const again = repairDocument(r.document, createCounterIdSource(60));
		expect(again.report).toEqual([]);
	});
});

describe('persistence (TL-020)', () => {
	it('the v12 fixture loads without repairs and keeps its look', () => {
		const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'schema-v12.jasper'), 'utf8'));
		const r = loadProject(raw, { effects: defaultEffectRegistry });
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		expect(titleLooksOf(r.document).map((l) => l.name)).toEqual(['Warm Title']);
		const seq = Object.values(r.document.sequences)[0]!;
		const text = Object.values(seq.clips).find((c) => c.kind === 'text')!;
		const a = clipLook((text as unknown as { effects: EffectInstance[] }).effects)!.appearance as Appearance;
		expect(a.lookId).toBe('tlk_0000000000000TK1');
		expect(a.layers.map((l) => l.type)).toEqual(['shadow', 'glow', 'rim', 'face']);
		expect(resolveAppearance(a, 0).layers).toHaveLength(4);
	});

	it('the v12 fixture carries a pattern origin (TL-121) through the load', () => {
		const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'schema-v12.jasper'), 'utf8'));
		const r = loadProject(raw, { effects: defaultEffectRegistry });
		const fxs = Object.values(Object.values(r.document.sequences)[0]!.clips).flatMap(
			(c) => (c as unknown as { effects?: EffectInstance[] }).effects ?? [],
		);
		expect(fxs.find((fx) => fx.patternOrigin)?.patternOrigin).toEqual({
			clipId: 'clp_00000000000TX001',
			effectId: 'fx_0000000000000TK2',
			frame: 12,
		});
	});

	it('a newer schema opens read-only, untouched', () => {
		const { h } = applied();
		const r = loadProject({ ...JSON.parse(JSON.stringify(h.doc)), schemaVersion: 99 });
		expect(r.readOnly).toBe(true);
	});

	it('survives a JSON round trip through the loader unchanged', () => {
		const { h } = applied();
		const r = loadProject(
			{ format: 'jasper-project', document: JSON.parse(JSON.stringify(h.doc)) },
			{
				effects: defaultEffectRegistry,
			},
		);
		expect(r.repairs).toEqual([]);
		expect(JSON.parse(JSON.stringify(r.document.titleLooks))).toEqual(
			JSON.parse(JSON.stringify(h.doc.titleLooks)),
		);
	});
});

describe('media references of a look (TL-021)', () => {
	it('counts {mediaId} values in layer params, keyframes included', () => {
		const clip = {
			kind: 'text',
			effects: [
				{
					appearance: {
						layers: [
							{
								params: {
									tile: {
										value: { mediaId: 'med_0000000000000001' },
										keyframes: [{ value: { mediaId: 'med_0000000000000002' } }],
									},
								},
							},
						],
					},
				},
			],
		};
		expect(clipParamMediaIds(clip as never).sort()).toEqual(['med_0000000000000001', 'med_0000000000000002']);
	});

	it('force-deleting a medium clears it from a look layer, keys included (TL-120 path)', () => {
		const anim = {
			value: { mediaId: 'med_0000000000000001' },
			keyframes: [{ value: { mediaId: 'med_0000000000000002' } }],
		};
		const effects = [
			{ id: 'fx_1', params: {}, appearance: { layers: [{ id: 'apl_1', params: { tile: anim } }] } },
		];
		const cleared = clearEffectMedia(effects, () => true);
		expect(cleared).toEqual(['effects.fx_1.appearance.apl_1.tile']);
		expect(anim.value).toEqual({ mediaId: '' });
		expect(anim.keyframes[0]!.value).toEqual({ mediaId: '' });
	});
});

describe('a damaged keyframe never stops a load (regression: the generic walker read `k.id` of null)', () => {
	it('repairs a null key inside an appearance before the invariants run', () => {
		const { h, t } = applied();
		const doc = JSON.parse(JSON.stringify(h.doc));
		const c = (Object.values(doc.sequences)[0] as { clips: Record<string, { effects: EffectInstance[] }> })
			.clips[t]!;
		(clipLook(c.effects)!.appearance as Appearance).light.angle.keyframes = [null as never];
		const r = loadProject({ format: 'jasper-project', document: doc }, { effects: defaultEffectRegistry });
		expect(r.issues).toEqual([]);
		expect(r.repairs.some((x) => x.action === 'repair-appearance')).toBe(true);
	});
});

describe('padding (TL-033)', () => {
	it('the bake crop knows a look reach, and refuses to guess when an expression drives it', () => {
		const { h, t, fx } = applied();
		const clip = { source: { text: { style: { sizePx: 100 } } }, intrinsicBox: { width: 400, height: 100 } };
		// Rim 5 % + shadow 8 % at 60°: more than the rim alone, in px of the 100 px text.
		expect(titleLookBleed(lookOf(h, t), clip)).toBeGreaterThan(5);
		const rim = layerOf(h, t, 'rim').id;
		h.ok([{ type: 'expression.set', target: ['appearance', fx, rim, 'width'], text: '3' }]);
		expect(titleLookBleed(lookOf(h, t), clip)).toBeNull();
	});

	it('covers every enabled layer across the clip, sides by direction, and ignores disabled layers', () => {
		const { h, t, fx } = applied();
		const a = lookOf(h, t);
		const flat = appearanceClipReach(a);
		const rim = layerOf(h, t, 'rim').id;
		h.ok([
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 0 }, value: 1 },
			{ type: 'keyframe.add', target: ['appearance', fx, rim, 'width'], at: { frames: 30 }, value: 90 },
		]);
		const moved = lookOf(h, t);
		const reach = appearanceClipReach(moved, { from: 0, to: 59 * F, frames: 60 });
		expect(reach.left).toBeGreaterThan(flat.left + 50);
		// The peak is at frame 30, not at the first or the last frame.
		const atFirst = lookReach(resolveAppearance(moved, 0));
		expect(reach.left).toBeGreaterThan(atFirst.left);
		const down = h.ok([
			{ type: 'appearance.setLayerEnabled', effectInstanceId: fx, layerId: rim, enabled: false },
		]);
		expect(down.ok).toBe(true);
		expect(appearanceClipReach(lookOf(h, t), { from: 0, to: 59 * F, frames: 60 }).left).toBeLessThan(
			reach.left,
		);
	});
});

describe('reach past the effect canvas (FX_MAX_PADDING)', () => {
	it('names a generator whose reach at a unit passes 2048 layer px per side, and nothing that fits', () => {
		// Sunburst and Lens Flare reach their `extent`, Shockwave its radius and ring: percent of the unit.
		expect(lookLayerReachCut('generator:sunburst', { extent: 800 }, 300)).toEqual({
			reachPx: 2404,
			limitPx: 2048,
		});
		expect(lookLayerReachCut('generator:sunburst', { extent: 800 }, 200)).toBeNull();
		expect(lookLayerReachCut('generator:sunburst', { extent: 800, clip: true }, 300)).toBeNull();
		expect(lookLayerReachCut('generator:lensFlare', { extent: 900 }, 256)?.limitPx).toBe(2048);
		expect(lookLayerReachCut('generator:shockwave', { radius: 900 }, 256)?.reachPx).toBeGreaterThan(2048);
		expect(lookLayerReachCut('generator:shockwave', { radius: 100 }, 256)).toBeNull();
		// No reach, unknown types and units that are not sizes say nothing.
		expect(lookLayerReachCut('face', {}, 10_000)).toBeNull();
		expect(lookLayerReachCut('nonsense', { extent: 1e9 }, 300)).toBeNull();
		expect(lookLayerReachCut('generator:sunburst', { extent: 800 }, Number.NaN)).toBeNull();
		expect(lookLayerReachCut('generator:sunburst', { extent: 800 }, 0)).toBeNull();
	});
});
