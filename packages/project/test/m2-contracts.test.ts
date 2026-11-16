import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	applyLut,
	applyLutMix,
	applyMat3,
	bakeLut,
	boxToQuad,
	buildRenderSnapshot,
	type Clip,
	CORNER_PIN_EFFECT_ID,
	CubeParseError,
	defaultEffectRegistry,
	invertMat3,
	isConvexQuad,
	loadProject,
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
		expect(r.migration.steps).toEqual([
			'v3→v4',
			'v4→v5',
			'v5→v6',
			'v6→v7',
			'v7→v8',
			'v8→v9',
			'v9→v10',
			'v10→v11',
			'v11→v12',
			'v12→v13',
			'v13→v14',
			'v14→v15',
			'v15→v16',
			'v16→v17',
		]);
		const d = r.document;
		expect(d.media.med_00000000000000C1!.lut?.size).toBe(33);
		expect(d.media.med_00000000000000M1?.mgBundle?.compositions[0]?.id).toBe('Title');
		const seq = Object.values(d.sequences)[0]!;
		const v = seq.clips.clp_0000000000000039 as { trackers?: { samples: { stride: number } | null }[] };
		expect(v.trackers?.[0]?.samples?.stride).toBe(8);
	});
});

describe('curve parameter values (S06:CG-030)', () => {
	function grade() {
		const h = new Harness();
		const mediaId = h.registerVideo({ seconds: 2, audio: false });
		const { refs } = h.ok([
			{ type: 'clip.place', source: { mediaId }, at: 0, ref: '$clip' },
			{ type: 'effect.add', target: { clipId: '$clip' }, effectId: 'jasper.lumetri', ref: '$grade' },
		]);
		return { h, clipId: refs.$clip!, effectId: refs.$grade! };
	}
	it('accepts, sorts and clamps control points', () => {
		const { h, clipId, effectId } = grade();
		h.ok([
			{
				type: 'param.set',
				target: ['effect', effectId, 'curveMaster'],
				value: {
					curve: [
						[1, 1.2],
						[0, -0.1],
						[0.5, 0.6],
					],
				},
			},
		]);
		const clip = h.seq.clips[clipId] as Extract<Clip, { kind: 'video' }>;
		expect(clip.effects[0]!.params.curveMaster!.value).toEqual({
			curve: [
				[0, 0],
				[0.5, 0.6],
				[1, 1],
			],
		});
	});
	it('rejects duplicate x, too few points and junk', () => {
		const { h, effectId } = grade();
		for (const value of [
			{
				curve: [
					[0, 0],
					[0, 1],
				],
			},
			{ curve: [[0, 0]] },
			[0, 1],
		]) {
			const r = h.tx([{ type: 'param.set', target: ['effect', effectId, 'curveMaster'], value }]);
			expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM');
		}
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
		expect(back.data.length).toBe(lut.data.length);
		for (let i = 0; i < lut.data.length; i++)
			expect(Math.abs(lut.data[i]! - back.data[i]!)).toBeLessThan(1e-6);
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
		expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(CubeParseError);
		expect(() => parseCube('LUT_3D_SIZE 1\n')).toThrow(CubeParseError);
		expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n')).toThrow(
			expect.objectContaining({ name: 'CubeParseError', line: 2 }),
		);
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
		const same = applyMat3(quadToQuad(q, q)!, [333, 444]);
		expect(same[0]).toBeCloseTo(333, 9);
		expect(same[1]).toBeCloseTo(444, 9);
		const affine = mat3FromMat2D({ a: 2, b: 0, c: 0, d: 2, e: 5, f: 6 });
		const transformed = applyMat3(multiplyMat3(affine, m), [1, 1]);
		expect(transformed[0]).toBeCloseTo(1705, 9);
		expect(transformed[1]).toBeCloseTo(1206, 9);
	});
	it('detects convex quads and writes CSS matrix3d', () => {
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
		const h2 = new Harness();
		h2.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] }]);
		const s2 = buildRenderSnapshot(h2.doc, h2.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(resolveSceneAt(s2, 0)[0]!.props.projective).toBeNull();
	});
});
