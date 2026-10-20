// @vitest-environment node
// These pixel cases port EffectCraft's keylight.rs, matte.rs and keying.rs tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { near, PACG_GL, type PacgRequest, type PacgSession, type Px, startPacg } from './fx-pacg/harness.ts';

const box = { width: 64, height: 16 };
const PLATE = { kind: 'split', left: 'rgb(204, 51, 26)', right: 'rgb(26, 230, 26)' } as const; // red fg | green screen
const MIX = { kind: 'solid', color: 'rgb(102, 153, 13)' } as const; // 50 % red over green
const SCREEN: [number, number, number, number] = [0.1, 0.9, 0.1, 1];
const SK = 'jasper.screen-keyer';
const straight = (p: Px): [number, number, number] =>
	p[3] > 0 ? [(p[0] * 255) / p[3], (p[1] * 255) / p[3], (p[2] * 255) / p[3]] : [0, 0, 0];

describe.runIf(PACG_GL)('keying and matte tools in WebGL2', { timeout: 240_000 }, () => {
	let s: PacgSession;
	beforeAll(async () => {
		s = await startPacg();
	}, 180_000);
	afterAll(async () => {
		await s?.close();
	});
	const px = async (req: Omit<PacgRequest, 'box'>, x: number, y = 8) =>
		s.px({ box, ...req } as PacgRequest, x, y);

	it('Screen Keyer: keys the screen, keeps the foreground, keys a 50 % mix by half and despills it', async () => {
		const fg = await px({ id: SK, params: { screenColour: SCREEN }, picture: PLATE }, 10);
		const bg = await px({ id: SK, params: { screenColour: SCREEN }, picture: PLATE }, 54);
		expect(fg[3]).toBeGreaterThan(250);
		expect(Math.abs(straight(fg)[0] - 204)).toBeLessThan(14);
		expect(bg[3]).toBeLessThan(6);
		const mix = await px({ id: SK, params: { screenColour: SCREEN }, picture: MIX }, 10);
		expect(mix[3]).toBeGreaterThan(70);
		expect(mix[3]).toBeLessThan(185);
		const c = straight(mix);
		expect(c[1]).toBeLessThanOrEqual(c[0] + 14);
	});

	it('Screen Keyer: clip white, gain, views, status', async () => {
		const solid = await px({ id: SK, params: { screenColour: SCREEN, clipWhite: 40 }, picture: MIX }, 10);
		expect(solid[3]).toBeGreaterThan(250);
		const base = await px({ id: SK, params: { screenColour: SCREEN }, picture: MIX }, 10);
		const gain = await px({ id: SK, params: { screenColour: SCREEN, screenGain: 150 }, picture: MIX }, 10);
		expect(gain[3]).toBeLessThan(base[3]);
		const sm = await px(
			{ id: SK, params: { screenColour: SCREEN, view: 'screenMatte' }, picture: PLATE },
			54,
		);
		expect(sm[0]).toBeLessThan(6);
		expect(sm[3]).toBe(255);
		const st = await px({ id: SK, params: { screenColour: SCREEN, view: 'status' }, picture: MIX }, 10);
		expect(Math.abs(st[0] - 128)).toBeLessThan(3);
		const src = await px({ id: SK, params: { view: 'source' }, picture: PLATE }, 54);
		expect(near(src, [26, 230, 26, 255])).toBe(true);
	});

	it('Screen Keyer: inside mask forces opacity, outside mask transparency (roto objects)', async () => {
		const left = { kind: 'split', left: '#fff', right: '#000' } as const;
		const right = { kind: 'split', left: '#000', right: '#fff' } as const;
		const inside = await px(
			{ id: SK, params: { screenColour: SCREEN }, picture: PLATE, mattes: { inMatte: { picture: right } } },
			54,
		);
		expect(inside[3]).toBeGreaterThan(250);
		const outside = await px(
			{ id: SK, params: { screenColour: SCREEN }, picture: PLATE, mattes: { outMatte: { picture: left } } },
			10,
		);
		expect(outside[3]).toBeLessThan(3);
		const inv = await px(
			{
				id: SK,
				params: { screenColour: SCREEN, invertOutsideMask: true },
				picture: PLATE,
				mattes: { outMatte: { picture: right } },
			},
			10,
		);
		expect(inv[3]).toBeLessThan(3);
	});

	it('Screen Keyer: foreground colour suppression and source crops', async () => {
		const plain = await px(
			{ id: SK, params: { screenColour: SCREEN, enableColourCorrection: true }, picture: PLATE },
			10,
		);
		const sup = await px(
			{
				id: SK,
				params: {
					screenColour: SCREEN,
					enableColourCorrection: true,
					colourSuppression: 'red',
					suppressionAmount: 100,
				},
				picture: PLATE,
			},
			10,
		);
		expect(sup[0]).toBeLessThan(plain[0] - 25);
		const crop = await px({ id: SK, params: { screenColour: SCREEN, cropLeft: 25 }, picture: PLATE }, 4);
		expect(crop[3]).toBe(0);
		const kept = await px({ id: SK, params: { screenColour: SCREEN, cropLeft: 25 }, picture: PLATE }, 20);
		expect(kept[3]).toBeGreaterThan(250);
	});

	const EDGE = { kind: 'split', left: 'rgb(220, 30, 30)', right: 'rgba(0, 0, 0, 0)' } as const;

	it('Refine Soft Matte: feathers the edge, Shift Edge grows it, Invert inverts, view edge region tints', async () => {
		const hard = await s.pixels(
			{ id: 'jasper.refine-soft-matte', params: { feather: 0, decontaminate: false }, picture: EDGE, box },
			[
				[28, 8],
				[30, 8],
				[33, 8],
				[36, 8],
			],
		);
		const soft = await s.pixels(
			{ id: 'jasper.refine-soft-matte', params: { feather: 100, decontaminate: false }, picture: EDGE, box },
			[
				[28, 8],
				[30, 8],
				[33, 8],
				[36, 8],
			],
		);
		const a = (r: { pixels: Px[] }) => r.pixels.map((p) => p[3]);
		expect(a(soft)[1]!).toBeLessThan(a(hard)[1]! + 1);
		expect(a(soft)[2]!).toBeGreaterThan(a(hard)[2]!);
		const grown = await s.pixels(
			{
				id: 'jasper.refine-soft-matte',
				params: { feather: 0, shiftEdge: 100, decontaminate: false },
				picture: EDGE,
				box,
			},
			[[33, 8]],
		);
		expect(grown.pixels[0]![3]).toBeGreaterThanOrEqual(a(hard)[2]!);
		const inv = await px(
			{ id: 'jasper.refine-soft-matte', params: { invert: true, decontaminate: false }, picture: EDGE },
			4,
		);
		expect(inv[3]).toBeLessThan(5);
		const view = await px(
			{ id: 'jasper.refine-soft-matte', params: { viewEdgeRegion: true }, picture: EDGE },
			31,
		);
		expect(view[0]).toBeGreaterThan(view[1]);
	});

	it('Key Cleaner: keeps opaque pixels, raises alpha contrast of soft ones', async () => {
		const op = await px(
			{ id: 'jasper.key-cleaner', picture: { kind: 'solid', color: 'rgb(200, 100, 50)' } },
			10,
		);
		expect(near(op, [200, 100, 50, 255])).toBe(true);
		const half = { kind: 'solid', color: 'rgba(200, 100, 50, 0.7)' } as const;
		const a = await px({ id: 'jasper.key-cleaner', params: { alphaContrast: 100 }, picture: half }, 10);
		const b = await px({ id: 'jasper.key-cleaner', params: { alphaContrast: 300 }, picture: half }, 10);
		expect(b[3]).toBeGreaterThan(a[3]);
	});

	it('Advanced Spill Suppressor: Standard finds green and removes it; Ultra respects Tolerance', async () => {
		const spilled = { kind: 'split', left: 'rgb(150, 200, 120)', right: 'rgb(30, 220, 40)' } as const;
		const before = await px(
			{ id: 'jasper.advanced-spill-suppressor', params: { suppression: 0 }, picture: spilled },
			10,
		);
		const after = await px({ id: 'jasper.advanced-spill-suppressor', picture: spilled }, 10);
		expect(after[1]).toBeLessThan(before[1] - 30);
		expect(Math.abs(after[0] - before[0])).toBeLessThan(3);
		const narrow = await px(
			{
				id: 'jasper.advanced-spill-suppressor',
				params: { method: 'ultra', keyColor: [0, 0, 1, 1], tolerance: 5 },
				picture: spilled,
			},
			10,
		);
		expect(Math.abs(narrow[1] - before[1])).toBeLessThan(3);
		const ultra = await px(
			{
				id: 'jasper.advanced-spill-suppressor',
				params: { method: 'ultra', keyColor: [0, 1, 0, 1], tolerance: 100, desaturate: 100 },
				picture: spilled,
			},
			10,
		);
		expect(Math.abs(ultra[0] - ultra[1])).toBeLessThan(Math.abs(before[0] - before[1]));
	});
});
