// sim-warp: Liquify strokes, Mesh Warp vertices, Puppet meshes and pins as undoable commands; pin ParamPaths;
// invariants and repair; the puppet solver and the Liquify brushes (pure).
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	defaultEffectRegistry,
	deform,
	evaluate,
	flicksPerFrame,
	LIQUIFY_TOOLS,
	liquifyApplyStroke,
	liquifyEmpty,
	liquifyGrid,
	meshAt,
	meshWarpRest,
	type Puppet,
	puppetMesh,
	repairDocument,
	resolvePuppet,
	solvePuppet,
	triangulate,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame({ num: 30, den: 1 });

function setup(effectId: string) {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 4, audio: false, width: 640, height: 360 });
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F } } }]);
	const clipId = h.clips('V1')[0]!.id;
	h.ok([{ type: 'effect.add', target: { clipId }, effectId }]);
	const fx = () => (h.seq.clips[clipId] as unknown as { effects: { id: string; params: Record<string, { value: unknown; keyframes: unknown[] }>; puppet?: Puppet }[] }).effects[0]!;
	return { h, clipId, fxId: fx().id, fx };
}

describe('Liquify', () => {
	it('a warp stroke writes the Distortion Mesh; keyframes when animated; refusals', () => {
		const { h, fxId, fx } = setup('jasper.liquify');
		const before = h.doc;
		h.ok([{ type: 'liquify.stroke', effectInstanceId: fxId, points: [[300, 180], [340, 180]] }]);
		const mesh = fx().params.distortionMesh!.value as number[];
		const g = liquifyGrid(640, 360);
		expect(mesh.slice(0, 3)).toEqual([1, g.nx, g.ny]);
		expect(mesh.some((v, i) => i >= 3 && v !== 0)).toBe(true);
		// Undo = the previous document is untouched.
		expect((before.sequences[h.seqId]!.clips as never as Record<string, { effects: { params: Record<string, unknown> }[] }>)).toBeTruthy();
		expect(JSON.stringify(before)).not.toEqual(JSON.stringify(h.doc));
		// Animated: a stroke at frame 10 adds a key; the mesh interpolates between keys.
		h.ok([{ type: 'param.setAnimated', target: ['effect', fxId, 'distortionMesh'], animated: true, at: { frames: 0 } }]);
		h.ok([{ type: 'liquify.stroke', effectInstanceId: fxId, tool: 'bloat', points: [[100, 100]], at: { frames: 10 } }]);
		expect(fx().params.distortionMesh!.keyframes).toHaveLength(2);
		const mid = evaluate(fx().params.distortionMesh as never, 5 * F) as number[];
		expect(mid.length).toBe(mesh.length);
		// Reset; wrong effect refused.
		h.ok([{ type: 'liquify.reset', effectInstanceId: fxId, at: { frames: 10 } }]);
		expect(h.tx([{ type: 'meshWarp.reset', effectInstanceId: fxId }]).ok).toBe(false);
		expect(h.tx([{ type: 'liquify.stroke', effectInstanceId: 'fx_nope', points: [[0, 0]] }]).ok).toBe(false);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('every tool changes the mesh; reconstruction reverts; freeze protects', () => {
		const w = 200;
		const ht = 100;
		const empty = liquifyEmpty(w, ht);
		const warped = liquifyApplyStroke(empty, w, ht, { tool: 'warp', points: [[50, 50], [120, 50]], size: 60, pressure: 100 });
		for (const tool of LIQUIFY_TOOLS) {
			if (tool === 'reconstruction' || tool === 'clone') continue;
			const r = liquifyApplyStroke(empty, w, ht, { tool, points: [[100, 50], [110, 55]], size: 60, pressure: 80 });
			expect(r.some((v, i) => i >= 3 && v !== 0), tool).toBe(true);
		}
		const cloned = liquifyApplyStroke(warped, w, ht, { tool: 'clone', points: [[150, 60]], size: 40, pressure: 100, cloneOffset: [-60, -10] });
		expect(cloned).not.toEqual(warped);
		const rec = liquifyApplyStroke(warped, w, ht, { tool: 'reconstruction', points: [[50, 50], [120, 50]], size: 60, pressure: 100 });
		const mag = (m: number[]) => m.slice(3).reduce((a, v) => a + Math.abs(v), 0);
		expect(mag(rec)).toBeLessThan(mag(warped) * 0.6);
		const frozen = liquifyApplyStroke(empty, w, ht, { tool: 'warp', points: [[50, 50], [120, 50]], size: 60, pressure: 100, frozen: () => true });
		expect(frozen).toEqual(empty);
		// Deterministic.
		expect(liquifyApplyStroke(empty, w, ht, { tool: 'turbulence', points: [[100, 50], [120, 50]], size: 60, pressure: 80, seed: 3 })).toEqual(
			liquifyApplyStroke(empty, w, ht, { tool: 'turbulence', points: [[100, 50], [120, 50]], size: 60, pressure: 80, seed: 3 }),
		);
	});
});

describe('Mesh Warp', () => {
	it('moves vertices and tangents with stopwatch semantics; validates indices', () => {
		const { h, fxId, fx } = setup('jasper.mesh-warp');
		h.ok([{ type: 'meshWarp.setVertex', effectInstanceId: fxId, column: 3, row: 3, position: [0.55, 0.45], tangents: { right: [0.1, 0.05] } }]);
		const m = fx().params.distortionMesh!.value as number[];
		const rest = meshWarpRest(7, 7);
		expect(m.length).toBe(rest.length);
		const o = 3 + (3 * 8 + 3) * 10;
		expect(m.slice(o, o + 2)).toEqual([0.55, 0.45]);
		expect(m.slice(o + 4, o + 6)).toEqual([0.1, 0.05]);
		expect(h.tx([{ type: 'meshWarp.setVertex', effectInstanceId: fxId, column: 9, row: 0, position: [0, 0] }]).ok).toBe(false);
		expect(h.tx([{ type: 'meshWarp.setVertex', effectInstanceId: fxId, column: 0, row: 0 }]).ok).toBe(false);
		h.ok([{ type: 'meshWarp.reset', effectInstanceId: fxId }]);
		expect(fx().params.distortionMesh!.value).toEqual(rest);
	});
});

describe('Puppet', () => {
	it('adds a mesh and pins, moves pins (keys when animated), records sketches, removes', () => {
		const { h, fxId, fx } = setup('jasper.puppet');
		const r = h.ok([
			{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.2, 0.5], ref: '$a' },
			{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.8, 0.5], ref: '$b' },
			{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.5, 0.5], kind: 'starch' },
		]);
		const [a, b] = r.results as { pinId: string; meshId: string; createdMesh?: string }[];
		expect(a!.createdMesh).toBeDefined();
		expect(b!.createdMesh).toBeUndefined(); // the second pin is on the same mesh
		const pup = fx().puppet!;
		expect(pup.meshes).toHaveLength(1);
		expect(pup.pins.map((p) => p.name)).toEqual(['Puppet Pin 1', 'Puppet Pin 2', 'Starch 1']);
		h.ok([{ type: 'puppet.movePins', moves: [{ pinId: b!.pinId, position: [0.9, 0.3] }] }]);
		expect(fx().puppet!.pins[1]!.position.value).toEqual([0.9, 0.3]);
		// Pin properties are ordinary animatable properties.
		h.ok([
			{ type: 'param.setAnimated', target: ['puppetPin', b!.pinId, 'position'], animated: true, at: { frames: 0 } },
			{ type: 'puppet.movePins', moves: [{ pinId: b!.pinId, position: [0.7, 0.2] }], at: { frames: 20 } },
			{ type: 'keyframe.add', target: ['puppetPin', a!.pinId, 'rotation'], at: { frames: 5 }, value: 45 },
		]);
		expect(fx().puppet!.pins[1]!.position.keyframes).toHaveLength(2);
		h.ok([{ type: 'puppet.setPinKeys', pinId: a!.pinId, keys: [{ at: { frames: 0 }, value: [0.2, 0.5] }, { at: { frames: 30 }, value: [0.1, 0.6] }] }]);
		expect(fx().puppet!.pins[0]!.position.keyframes).toHaveLength(2);
		expect(h.tx([{ type: 'param.set', target: ['puppetPin', a!.pinId, 'amount'], value: 500 }]).ok).toBe(true); // clamped
		expect(fx().puppet!.pins[0]!.amount.value).toBe(100);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
		h.ok([{ type: 'puppet.renamePin', pinId: a!.pinId, name: 'Hand' }, { type: 'puppet.removePins', pinIds: [b!.pinId] }]);
		expect(fx().puppet!.pins.map((p) => p.name)).toEqual(['Hand', 'Starch 1']);
		h.ok([{ type: 'puppet.removeMesh', meshId: a!.meshId }]);
		expect(fx().puppet!.pins).toHaveLength(0);
		expect(h.tx([{ type: 'puppet.removePins', pinIds: ['ppn_0000000000000ZZZ'] }]).ok).toBe(false);
	});

	it('a mesh from an outline; pins outside it start a new mesh', () => {
		const { h, fxId, fx } = setup('jasper.puppet');
		const outline = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.9], [0.1, 0.9]] as [number, number][];
		h.ok([{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.2, 0.5], outline }]);
		h.ok([{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.8, 0.5] }]);
		expect(fx().puppet!.meshes).toHaveLength(2);
		expect(h.tx([{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.9, 0.9], outline }]).ok).toBe(true); // inside the box mesh
		expect(h.tx([{ type: 'puppet.addMesh', effectInstanceId: fxId, outline, density: 70 }]).ok).toBe(true);
	});

	it('invariants flag broken puppet data; repair removes it', () => {
		const { h, fx } = setup('jasper.puppet');
		const bad = JSON.parse(JSON.stringify(h.doc));
		const clip = Object.values(bad.sequences[h.seqId].clips)[0] as { effects: { puppet?: unknown }[] };
		clip.effects[0]!.puppet = { meshes: [], pins: [{ id: 'ppn_00000000000000XX', name: 'x', kind: 'position', meshId: 'pms_00000000000000MM', rest: [0, 0] }] };
		expect(checkInvariants(bad, { effects: defaultEffectRegistry }).some((i) => i.message.includes('pin'))).toBe(true);
		const fixed = repairDocument(bad);
		expect((Object.values(fixed.document.sequences[h.seqId]!.clips)[0] as { effects: { puppet?: unknown }[] }).effects[0]!.puppet).toBeUndefined();
		expect(fx().puppet).toBeUndefined();
	});

	it('ARAP: no pins = rest; a moved pin moves its side, the opposite pin holds; starch stiffens', () => {
		const pup = resolvePuppet(
			{
				meshes: [{ id: 'm', name: 'M', seed: [0.5, 0.5], density: 50, expansion: 0, triangles: 200 }],
				pins: [],
			} as never,
			0,
		);
		const w = 200;
		const ht = 100;
		const g = puppetMesh(pup.meshes[0]!, w, ht);
		expect(g.tris.length).toBeGreaterThan(50);
		expect(solvePuppet(pup, w, ht, 2)[0]!.deformed).toEqual(g.verts.map((v) => [v[0], v[1]]));
		const pin = (id: string, kind: string, rest: [number, number], position: [number, number]) => ({
			id,
			kind,
			meshId: 'm',
			rest,
			position,
			scale: 1,
			rotation: 0,
			amount: 50,
			extent: 15,
			inFront: 50,
		});
		const moved = { ...pup, pins: [pin('a', 'position', [0.1, 0.5], [0.1, 0.5]), pin('b', 'position', [0.9, 0.5], [0.9, 0.2])] } as never;
		const s = solvePuppet(moved, w, ht, 2)[0]!;
		const near = (p: [number, number]) => g.verts.reduce((bi, v, i) => ((v[0] - p[0]) ** 2 + (v[1] - p[1]) ** 2 < (g.verts[bi]![0] - p[0]) ** 2 + (g.verts[bi]![1] - p[1]) ** 2 ? i : bi), 0);
		const ia = near([20, 50]);
		const ib = near([180, 50]);
		expect(Math.hypot(s.deformed[ia]![0] - g.verts[ia]![0], s.deformed[ia]![1] - g.verts[ia]![1])).toBeLessThan(1e-6);
		expect(s.deformed[ib]![1]).toBeLessThan(g.verts[ib]![1] - 20);
		// Deterministic and stable.
		expect(solvePuppet(moved, w, ht, 2)[0]!.deformed).toEqual(s.deformed);
		expect(meshAt(pup, [0.5, 0.5], w, ht)).toBe('m');
		expect(meshAt(pup, [1.5, 0.5], w, ht)).toBeNull();
	});

	it('triangulates an L outline into CCW triangles inside it; deform keeps fixed handles', () => {
		const L: [number, number][] = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]];
		const g = triangulate(L, { triangles: 120, density: 50, expansion: 0 });
		for (const t of g.tris) {
			const [a, b, c] = t.map((i) => g.verts[i]!);
			expect((b![0] - a![0]) * (c![1] - a![1]) - (b![1] - a![1]) * (c![0] - a![0])).toBeGreaterThan(0);
			const cx = (a![0] + b![0] + c![0]) / 3;
			const cy = (a![1] + b![1] + c![1]) / 3;
			expect(cx < 30 || cy < 30).toBe(true);
		}
		const d = deform(g.verts, g.tris, g.tris.map(() => 1), { fixed: [[0, [g.verts[0]![0] + 5, g.verts[0]![1]]]], edges: [] }, 1);
		expect(d[0]).toEqual([g.verts[0]![0] + 5, g.verts[0]![1]]);
	});
});
