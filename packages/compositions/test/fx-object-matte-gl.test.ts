// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { near, PACG_GL, type PacgRequest, type PacgSession, type Px, startPacg } from './fx-pacg/harness.ts';

const box = { width: 64, height: 16 };
const ORANGE = { kind: 'solid', color: 'rgb(200, 100, 50)' } as const;
const O: Px = [200, 100, 50, 255];
/** Matte: left half object (white), right half background. */
const HALF = { kind: 'split', left: '#fff', right: '#000' } as const;
const FULL = { kind: 'solid', color: '#fff' } as const;
const NONE = { kind: 'solid', color: '#000' } as const;
const OM = 'jasper.object-matte';
const OB = 'jasper.object-blur';

describe.runIf(PACG_GL)('object mattes in WebGL2', { timeout: 240_000 }, () => {
	let s: PacgSession;
	beforeAll(async () => {
		s = await startPacg();
	}, 180_000);
	afterAll(async () => {
		await s?.close();
	});
	const row = async (req: Omit<PacgRequest, 'box'>, xs: number[], y = 8) =>
		(
			await s.pixels(
				{ box, ...req } as PacgRequest,
				xs.map((x) => [x, y] as [number, number]),
			)
		).pixels;
	const alpha = async (req: Omit<PacgRequest, 'box'>, xs: number[]) => (await row(req, xs)).map((p) => p[3]);

	it('states: no object passes through, a matte cuts out, outside the span is transparent', async () => {
		expect(near((await row({ id: OM, picture: ORANGE }, [10]))[0]!, O)).toBe(true);
		const cut = await row({ id: OM, picture: ORANGE, mattes: { matte: { picture: HALF } } }, [8, 56]);
		expect(near(cut[0]!, O)).toBe(true);
		expect(cut[1]![3]).toBe(0);
		const outside = await row({ id: OM, picture: ORANGE, mattes: { matte: { state: 2 } } }, [8, 56]);
		expect(outside.every((p) => p[3] === 0)).toBe(true);
		const inv = await alpha(
			{ id: OM, params: { invert: true }, picture: ORANGE, mattes: { matte: { picture: HALF } } },
			[8, 56],
		);
		expect(inv).toEqual([0, 255]);
	});

	it('Shift Edge moves the edge by 10 px per 100 %, Feather softens, Contrast hardens', async () => {
		const xs = [26, 30, 34, 38];
		const base = await alpha({ id: OM, picture: ORANGE, mattes: { matte: { picture: HALF } } }, xs);
		expect(base).toEqual([255, 255, 0, 0]);
		const grown = await alpha(
			{ id: OM, params: { shiftEdge: 50 }, picture: ORANGE, mattes: { matte: { picture: HALF } } },
			xs,
		);
		expect(grown).toEqual([255, 255, 255, 0]);
		const shrunk = await alpha(
			{ id: OM, params: { shiftEdge: -50 }, picture: ORANGE, mattes: { matte: { picture: HALF } } },
			xs,
		);
		expect(shrunk).toEqual([255, 0, 0, 0]);
		const soft = await alpha(
			{ id: OM, params: { feather: 12 }, picture: ORANGE, mattes: { matte: { picture: HALF } } },
			[29, 31, 32, 34],
		);
		expect(soft[0]!).toBeGreaterThan(soft[1]!);
		expect(soft[1]!).toBeGreaterThan(soft[2]!);
		expect(soft[1]!).toBeLessThan(250);
		expect(soft[2]!).toBeGreaterThan(5);
		const hard = await alpha(
			{
				id: OM,
				params: { feather: 12, contrast: 90 },
				picture: ORANGE,
				mattes: { matte: { picture: HALF } },
			},
			[29, 34],
		);
		expect(hard[0]!).toBeGreaterThanOrEqual(soft[0]!);
		expect(hard[1]!).toBeLessThanOrEqual(soft[3]!);
	});

	it('Reduce Chatter averages towards the neighbouring frames', async () => {
		const req = (chatter: number) => ({
			id: OM,
			params: { reduceChatter: chatter },
			picture: ORANGE,
			mattes: { matte: { picture: FULL }, mattePrev: { picture: NONE }, matteNext: { picture: NONE } },
		});
		expect(await alpha(req(0), [10])).toEqual([255]);
		const a = (await alpha(req(100), [10]))[0]!;
		// m + (0 − m)·1·(2/3) = 1/3.
		expect(Math.abs(a - 85)).toBeLessThanOrEqual(3);
	});

	it('motion blur smears the edge along the neighbours’ motion', async () => {
		const left = { kind: 'split', left: '#fff', right: '#000' } as const;
		const req = (on: boolean) => ({
			id: OM,
			params: { useMotionBlur: on, shutterAngle: 360 },
			picture: ORANGE,
			mattes: {
				matte: { picture: left },
				// Previous frame = this one, next frame the whole box: the centroid moves 16 px over 2 frames → an 8 px
				// smear (360° shutter) centred on the edge at x = 32.
				mattePrev: { picture: left },
				matteNext: { picture: FULL },
			},
		});
		const still = await alpha(req(false), [30, 34]);
		expect(still).toEqual([255, 0]);
		const blurred = await alpha(req(true), [30, 34]);
		expect(blurred[0]!).toBeLessThan(255);
		expect(blurred[1]!).toBeGreaterThan(0);
	});

	it('views: alpha, overlay and boundary', async () => {
		const m = { matte: { picture: HALF } };
		const a = await row({ id: OM, params: { view: 'alpha' }, picture: ORANGE, mattes: m }, [8, 56]);
		expect(near(a[0]!, [255, 255, 255, 255])).toBe(true);
		expect(near(a[1]!, [0, 0, 0, 255])).toBe(true);
		const o = await row({ id: OM, params: { view: 'overlay' }, picture: ORANGE, mattes: m }, [8, 56]);
		expect(near(o[0]!, O)).toBe(true);
		expect(o[1]![0]).toBeGreaterThan(220); // tinted red outside, still opaque
		expect(o[1]![3]).toBe(255);
		const b = await row(
			{ id: OM, params: { view: 'boundary', overlayColor: [0, 1, 0, 1] }, picture: ORANGE, mattes: m },
			[8, 32, 56],
		);
		expect(near(b[0]!, O)).toBe(true);
		expect(b[1]![1]).toBeGreaterThan(150);
		expect(near(b[2]!, O)).toBe(true);
	});

	it('decontamination removes the background colour from soft edges', async () => {
		// Foreground red, background green; the feathered edge mixes them.
		const pic = { kind: 'split', left: 'rgb(220, 20, 20)', right: 'rgb(20, 220, 20)' } as const;
		const req = (decon: boolean) => ({
			id: OM,
			params: { feather: 8, decontaminate: decon },
			picture: pic,
			mattes: { matte: { picture: HALF } },
		});
		const [plain] = await row(req(false), [31]);
		const [clean] = await row(req(true), [31]);
		// Straight colour of the edge pixel: less green with decontamination.
		const g = (p: Px) => p[1] / Math.max(1, p[3]);
		expect(g(clean!)).toBeLessThan(g(plain!));
	});

	it('Object Blur: mosaic / fill inside, everything else, matte view', async () => {
		const bars = { kind: 'bars' } as const;
		const m = { matte: { picture: HALF } };
		const fill = await row(
			{ id: OB, params: { method: 'fill', fillColor: [0, 0, 1, 1], feather: 0 }, picture: bars, mattes: m },
			[8, 56],
		);
		expect(near(fill[0]!, [0, 0, 255, 255])).toBe(true);
		expect(fill[1]![2]).toBeLessThan(255 + 1);
		const src = await row(
			{ id: OB, params: { method: 'fill', feather: 0, opacity: 0 }, picture: bars, mattes: m },
			[56],
		);
		expect(near(fill[1]!, src[0]!)).toBe(true);
		const outside = await row(
			{
				id: OB,
				params: { method: 'fill', region: 'outside', fillColor: [1, 0, 0, 1], feather: 0 },
				picture: bars,
				mattes: m,
			},
			[8, 56],
		);
		expect(near(outside[1]!, [255, 0, 0, 255])).toBe(true);
		const mos = await row(
			{ id: OB, params: { method: 'mosaic', blockSize: 16, feather: 0 }, picture: bars, mattes: m },
			[1, 14],
		);
		expect(near(mos[0]!, mos[1]!)).toBe(true); // one block
		const g = await row(
			{ id: OB, params: { method: 'gaussian', blurriness: 20, feather: 0 }, picture: bars, mattes: m },
			[8],
		);
		const [orig] = await row({ id: OB, params: { opacity: 0 }, picture: bars, mattes: m }, [8]);
		expect(near(g[0]!, orig!)).toBe(false);
		const none = await row({ id: OB, picture: bars }, [8]);
		expect(near(none[0]!, orig!)).toBe(true);
		const mv = await row(
			{ id: OB, params: { view: 'matte', feather: 0 }, picture: bars, mattes: m },
			[8, 56],
		);
		expect(mv.map((p) => p[0])).toEqual([255, 0]);
	});
});
