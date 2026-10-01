// M2 shared contracts (ARCHITECTURE §19): LUTs, colour-run fusion, homographies / corner pin, the v3 schema
// additions.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateValue } from '../src/commands/handlers/param.ts';
import {
	applyLut,
	applyLutMix,
	applyMat3,
	bakeColorRun,
	bakeLut,
	boxToQuad,
	buildRenderSnapshot,
	CORNER_PIN_EFFECT_ID,
	CubeParseError,
	colorRunKey,
	createEffectRegistry,
	defaultEffectRegistry,
	type EffectSpec,
	effectBadges,
	effectRuns,
	identityLut,
	invertMat3,
	isAffineMat3,
	isConvexQuad,
	loadProject,
	lutMaxDelta,
	M1_EFFECTS,
	mat3FromMat2D,
	mat3ToCss,
	multiplyMat3,
	parseCube,
	type Quad,
	quadToQuad,
	type Rgb,
	resolveSceneAt,
	serializeCube,
	unitSquareToQuad,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('v3 schema (ARCHITECTURE §19.1)', () => {
	it('the v3 fixture with a LUT, an mg-bundle, a tracker and a corner pin loads without repairs', () => {
		const env = JSON.parse(readFileSync(join(here, 'fixtures/v3/basic.jasper'), 'utf8'));
		const r = loadProject(env, { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		expect(r.migration.steps).toEqual([]);
		const d = r.document;
		expect(d.media.med_00000000000000C1!.lut?.size).toBe(33);
		expect(d.media.med_00000000000000M1?.mgBundle?.compositions[0]?.id).toBe('Title');
		const seq = Object.values(d.sequences)[0]!;
		const v = seq.clips.clp_0000000000000039 as { trackers?: { samples: { stride: number } | null }[] };
		expect(v.trackers?.[0]?.samples?.stride).toBe(8);
	});
});

describe('curve parameter values (S06:CG-030)', () => {
	const h = {
		fail: (code: string, msg: string): never => {
			throw new Error(`${code}: ${msg}`);
		},
	} as never;
	const rule = { kind: 'curve' as const, holdOnly: true };
	it('accepts, sorts and clamps control points', () => {
		const r = validateValue(
			{
				curve: [
					[1, 1.2],
					[0, -0.1],
					[0.5, 0.6],
				],
			},
			rule,
			h,
			'curve',
		);
		expect(r.value).toEqual({
			curve: [
				[0, 0],
				[0.5, 0.6],
				[1, 1],
			],
		});
		expect(r.clamped).toBe(true);
	});
	it('rejects duplicate x, too few points and junk', () => {
		expect(() =>
			validateValue(
				{
					curve: [
						[0, 0],
						[0, 1],
					],
				},
				rule,
				h,
				'c',
			),
		).toThrow(/E_INVALID_PARAM/);
		expect(() => validateValue({ curve: [[0, 0]] }, rule, h, 'c')).toThrow(/E_INVALID_PARAM/);
		expect(() => validateValue([0, 1], rule, h, 'c')).toThrow(/E_INVALID_PARAM/);
	});
});

describe('LUTs (S06:CG-050…056)', () => {
	const warm = (c: Rgb) => {
		c[0] = Math.min(1, c[0] * 1.1 + 0.02);
		c[2] = c[2] * 0.9;
		c[1] = c[1] ** 1.1;
	};
	it('parses what it serializes (3D) and ignores comments / vendor keywords', () => {
		const lut = bakeLut(5, warm, 'Warm');
		const text = `# made by a test\nLUT_3D_INPUT_RANGE 0 1\nVENDOR_THING 1\n${serializeCube(lut)}`;
		const back = parseCube(text);
		expect(back.dimensions).toBe(3);
		expect(back.size).toBe(5);
		expect(back.title).toBe('Warm');
		expect(lutMaxDelta(lut, back)).toBeLessThan(1e-6);
	});
	it('the identity LUT is exact at lattice points and between them (tetrahedral)', () => {
		const id = identityLut(17);
		for (const p of [
			[0, 0, 0],
			[1, 1, 1],
			[0.3, 0.7, 0.1],
			[0.51, 0.49, 0.5],
			[0.9, 0.2, 0.6],
		] as Rgb[]) {
			const c: Rgb = [...p];
			applyLut(id, c);
			for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(p[k]!, 6);
		}
	});
	it('a baked function is reproduced within LUT precision; intensity mixes linearly', () => {
		const lut = bakeLut(33, warm);
		const p: Rgb = [0.42, 0.61, 0.27];
		const want: Rgb = [...p];
		warm(want);
		const got: Rgb = [...p];
		applyLut(lut, got);
		for (let k = 0; k < 3; k++) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(2e-3);
		const half: Rgb = [...p];
		applyLutMix(lut, half, 0.5);
		for (let k = 0; k < 3; k++) expect(half[k]).toBeCloseTo((p[k]! + got[k]!) / 2, 6);
	});
	it('1D LUTs and domains', () => {
		const one = parseCube('LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 0.5 0.25\n');
		expect(one.dimensions).toBe(1);
		const c: Rgb = [1, 1, 4];
		applyLut(one, c);
		expect(c).toEqual([0.5, 0.25, 0.25]);
	});
	it('reports malformed files with a line number', () => {
		expect(() => parseCube('0 0 0\n')).toThrow(CubeParseError);
		expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/Expected 8 table entries/);
		expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(/Invalid LUT_3D_SIZE/);
		expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n')).toThrow(/line 2/);
	});
});

describe('colour-run fusion (ARCHITECTURE §19.2)', () => {
	const gain = (id: string): EffectSpec => ({
		id,
		version: 1,
		label: id,
		category: 'Color Correction',
		appliesTo: 'video',
		params: [{ name: 'k', label: 'k', type: 'number', default: 1, animatable: true }],
		preview: {},
		native: null,
		color: {
			build: (p) =>
				p.k === 1
					? null
					: (c) => {
							const k = p.k as number;
							c[0] *= k;
							c[1] *= k;
							c[2] *= k;
						},
		},
		capabilities: { preview: 'webgl', export: ['remotion', 'native'] },
	});
	const registry = createEffectRegistry([...M1_EFFECTS, gain('t.a'), gain('t.b')]);
	const fx = (id: string, effectId: string, k: number, enabled = true) => ({
		id,
		effectId,
		effectVersion: 1,
		enabled,
		params: { k },
	});
	it('groups consecutive colour effects, keeps other effects as barriers, drops disabled ones', () => {
		const runs = effectRuns(
			[
				fx('1', 't.a', 0.5),
				fx('2', 't.b', 0.8),
				fx('3', 'jasper.gaussian-blur', 0),
				fx('4', 't.a', 2, false),
				fx('5', 't.b', 1.2),
			],
			registry,
		);
		expect(runs.map((r) => (r.kind === 'color' ? r.effects.map((e) => e.id) : r.effect.id))).toEqual([
			['1', '2'],
			'3',
			['5'],
		]);
	});
	it('bakes a run into one LUT (identity runs bake to null) and keys it by params and LUT identity', () => {
		const ctx = { lut: () => null };
		expect(bakeColorRun([fx('1', 't.a', 1)], registry, ctx)).toBeNull();
		const lut = bakeColorRun([fx('1', 't.a', 0.5), fx('2', 't.b', 0.8)], registry, ctx, 9)!;
		const c: Rgb = [1, 0.5, 0.25];
		applyLut(lut, c);
		expect(c[0]).toBeCloseTo(0.4, 5);
		expect(c[2]).toBeCloseTo(0.1, 5);
		const k1 = colorRunKey([fx('1', 't.a', 0.5)], (m) => `fp:${m}`);
		const k2 = colorRunKey([fx('1', 't.a', 0.5)], (m) => `fp:${m}`);
		const k3 = colorRunKey(
			[{ ...fx('1', 't.a', 0.5), params: { k: 0.5, lut: { mediaId: 'med_1' } } }],
			(m) => `fp:${m}`,
		);
		expect(k1).toBe(k2);
		expect(k3).toContain('fp:med_1');
	});
	it('colour effects count as native in the Effects panel badges', () => {
		expect(effectBadges(gain('t.c')).native).toBe(true);
	});
});

describe('homographies and corner pin (S09:TRK-050)', () => {
	const q: Quad = [
		[100, 50],
		[900, 80],
		[850, 600],
		[120, 560],
	];
	it('maps the unit square / a box onto a quad and back', () => {
		const m = unitSquareToQuad(q)!;
		expect(applyMat3(m, [0, 0])).toEqual([100, 50]);
		const br = applyMat3(m, [1, 1]);
		expect(br[0]).toBeCloseTo(850, 9);
		expect(br[1]).toBeCloseTo(600, 9);
		const b = boxToQuad(1920, 1080, q)!;
		const tr = applyMat3(b, [1920, 0]);
		expect(tr[0]).toBeCloseTo(900, 6);
		expect(tr[1]).toBeCloseTo(80, 6);
		const inv = invertMat3(b)!;
		const back = applyMat3(inv, applyMat3(b, [333, 444]));
		expect(back[0]).toBeCloseTo(333, 6);
		expect(back[1]).toBeCloseTo(444, 6);
		const qq = quadToQuad(q, q)!;
		expect(isAffineMat3(multiplyMat3(qq, [1, 0, 0, 0, 1, 0, 0, 0, 1]), 1e-9)).toBe(true);
	});
	it('detects affine maps, convex quads and writes CSS matrix3d', () => {
		expect(isAffineMat3(mat3FromMat2D({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 6 }))).toBe(true);
		expect(isAffineMat3(unitSquareToQuad(q)!)).toBe(false);
		expect(isConvexQuad(q)).toBe(true);
		expect(isConvexQuad([q[0], q[2], q[1], q[3]])).toBe(false);
		expect(mat3ToCss([1, 0, 5, 0, 1, 6, 0, 0, 1])).toBe(
			'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)',
		);
	});
	it('a corner pin makes the scene resolver emit a projective map and the pinned quad', () => {
		const h = new Harness();
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
			{
				type: 'effect.add',
				target: { clipId: '$s' },
				effectId: CORNER_PIN_EFFECT_ID,
				params: {
					topLeft: [0.1, 0.1],
					topRight: [0.9, 0.1],
					bottomRight: [0.8, 0.9],
					bottomLeft: [0.2, 0.9],
				},
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const [layer] = resolveSceneAt(snap, 0);
		const p = layer!.props;
		expect(p.projective).not.toBeNull();
		// Solids are sequence-sized with an identity Motion: the quad is the pinned corners in frame pixels.
		expect(p.quad[0][0]).toBeCloseTo(192, 6);
		expect(p.quad[0][1]).toBeCloseTo(108, 6);
		expect(p.quad[2][0]).toBeCloseTo(1536, 6);
		expect(p.quad[2][1]).toBeCloseTo(972, 6);
		// Without a pin the map stays affine.
		const h2 = new Harness();
		h2.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const s2 = buildRenderSnapshot(h2.doc, h2.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(resolveSceneAt(s2, 0)[0]!.props.projective).toBeNull();
	});
});
