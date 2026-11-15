// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { near, PACG_GL, type PacgRequest, type PacgSession, type Px, startPacg } from './fx-pacg/harness.ts';

const box = { width: 32, height: 16 };
const solid = (color: string) => ({ kind: 'solid', color }) as const;
const ORANGE = solid('rgb(200, 100, 50)');
const O: Px = [200, 100, 50, 255];
type Pic = PacgRequest['picture'];

describe.runIf(PACG_GL)('fx family premiere-adjust-color-keying in WebGL2', { timeout: 240_000 }, () => {
	let s: PacgSession;
	beforeAll(async () => {
		s = await startPacg();
	}, 180_000);
	afterAll(async () => {
		await s?.close();
	});

	const px = (id: string, params: Record<string, unknown>, picture: Pic, x = 8, y = 8, b = box) =>
		s.px({ id, params, picture, box: b }, x, y);
	const run = (id: string, params: Record<string, unknown>, picture: Pic, at: [number, number][], b = box) =>
		s.pixels({ id, params, picture, box: b }, at);
	const grey = (p: Px, tol = 2) => Math.abs(p[0] - p[1]) <= tol && Math.abs(p[1] - p[2]) <= tol;

	it('Auto Levels / Auto Contrast / Auto Color stretch a low-contrast ramp to black and white', async () => {
		const ramp = { kind: 'ramp', from: 'rgb(70, 60, 90)', to: 'rgb(190, 170, 210)' } as const;
		const b = { width: 64, height: 8 };
		for (const id of ['jasper.auto-levels', 'jasper.auto-contrast', 'jasper.auto-color']) {
			const r = await run(
				id,
				{},
				ramp,
				[
					[0, 4],
					[63, 4],
				],
				b,
			);
			const [lo, hi] = r.pixels as [Px, Px];
			expect(Math.min(lo[0], lo[1], lo[2]), `${id} dark end`).toBeLessThan(12);
			expect(Math.max(hi[0], hi[1], hi[2]), `${id} light end`).toBeGreaterThan(243);
		}
		// Auto Levels neutralises per channel (dark end ≈ black in every channel); Auto Contrast keeps the cast.
		const lv = await px('jasper.auto-levels', {}, ramp, 0, 4, b);
		expect(Math.max(lv[0], lv[1], lv[2])).toBeLessThan(12);
		const ac = await px('jasper.auto-contrast', {}, ramp, 0, 4, b);
		expect(ac[2]).toBeGreaterThan(ac[1] + 30);
		const color = await px('jasper.auto-color', {}, ramp, 0, 4, b);
		expect(Math.max(color[0], color[1], color[2])).toBeLessThan(20);
		const orig = await px('jasper.auto-levels', { blendWithOriginal: 100 }, ramp, 0, 4, b);
		expect(near(orig, [70, 60, 90, 255], 4)).toBe(true);
	});

	it('Convolution Kernel, Extract, Levels, Lighting Effects, ProcAmp', async () => {
		expect(
			near(await px('jasper.convolution-kernel', { m22: 0, m21: 1, scale: 2 }, ORANGE), [100, 50, 25, 255]),
		).toBe(true);
		expect(near(await px('jasper.extract', {}, solid('rgb(220, 220, 220)')), [255, 255, 255, 255])).toBe(
			true,
		);
		expect(near(await px('jasper.extract', {}, solid('rgb(40, 40, 40)')), [0, 0, 0, 255])).toBe(true);
		expect(
			near(await px('jasper.extract', { invert: true }, solid('rgb(40, 40, 40)')), [255, 255, 255, 255]),
		).toBe(true);
		expect(
			near(await px('jasper.levels', { blackInput: 100 }, solid('rgb(100, 100, 100)')), [0, 0, 0, 255]),
		).toBe(true);
		const lifted = await px('jasper.levels', { gamma: 200 }, solid('rgb(64, 64, 64)'));
		expect(lifted[0]).toBeGreaterThan(110);
		expect(near(await px('jasper.levels', { whiteOutputB: 0 }, ORANGE), [200, 100, 0, 255])).toBe(true);
		const lit = await run(
			'jasper.lighting-effects',
			{},
			solid('#fff'),
			[
				[0.4 * 64, 0.4 * 36],
				[63, 35],
			],
			{ width: 64, height: 36 },
		);
		expect(lit.pixels[0]![0]).toBeGreaterThan(lit.pixels[1]![0] + 80);
		expect(grey(await px('jasper.proc-amp', { saturation: 0 }, ORANGE))).toBe(true);
	});

	it('blurs: camera, channel (alpha pads), compound (map), directional (one axis), interlace (vertical only)', async () => {
		const split = { kind: 'split', left: '#000', right: '#fff' } as const;
		const edge = await px('jasper.camera-blur', { percentBlur: 100 }, split, 15, 8);
		expect(edge[0]).toBeGreaterThan(20);
		const cb = await s.pixels(
			{ id: 'jasper.channel-blur', params: { alphaBlurriness: 4 }, picture: ORANGE, box },
			[[-3, 8]],
		);
		expect(cb.pixels[0]![3]).toBeGreaterThan(0);
		const redOnly = await px('jasper.channel-blur', { redBlurriness: 3, repeatEdge: true }, split, 15, 8);
		expect(redOnly[0]).toBeGreaterThan(20);
		expect(redOnly[1]).toBeLessThan(3);
		const media = { blurLayer: solid('#fff') };
		const comp = await s.px(
			{ id: 'jasper.compound-blur', params: { maximumBlur: 6 }, picture: split, box, media },
			15,
			8,
		);
		expect(comp[0]).toBeGreaterThan(20);
		const compInv = await s.px(
			{
				id: 'jasper.compound-blur',
				params: { maximumBlur: 6, invertBlur: true },
				picture: split,
				box,
				media,
			},
			15,
			8,
		);
		expect(compInv[0]).toBeLessThan(3);
		expect(
			(await px('jasper.directional-blur', { direction: 90, blurLength: 6 }, split, 15, 8))[0],
		).toBeGreaterThan(20);
		expect(
			(await px('jasper.directional-blur', { direction: 0, blurLength: 6 }, split, 15, 8))[0],
		).toBeLessThan(3);
		expect((await px('jasper.reduce-interlace-flicker', { softness: 3 }, split, 15, 8))[0]).toBeLessThan(3);
	});

	it('Sharpen and Unsharp Mask overshoot at an edge; Unsharp Mask respects its threshold', async () => {
		const split = { kind: 'split', left: 'rgb(100, 100, 100)', right: 'rgb(150, 150, 150)' } as const;
		expect((await px('jasper.sharpen', { sharpenAmount: 50 }, split, 15, 8))[0]).toBeLessThan(90);
		expect((await px('jasper.unsharp-mask', { amount: 200, radius: 2 }, split, 15, 8))[0]).toBeLessThan(90);
		expect(
			(await px('jasper.unsharp-mask', { amount: 200, radius: 2, threshold: 60 }, split, 15, 8))[0],
		).toBe(100);
	});

	it('Invert channels and Blend With Original', async () => {
		expect(near(await px('jasper.invert', {}, ORANGE), [55, 155, 205, 255])).toBe(true);
		expect(near(await px('jasper.invert', { channel: 'green' }, ORANGE), [200, 155, 50, 255])).toBe(true);
		expect(near(await px('jasper.invert', { blendWithOriginal: 100 }, ORANGE), O)).toBe(true);
		expect((await px('jasper.invert', { channel: 'alpha' }, ORANGE))[3]).toBe(0);
		const lum = await px('jasper.invert', { channel: 'luminance' }, solid('rgb(40, 40, 40)'));
		expect(near(lum, [215, 215, 215, 255], 3)).toBe(true);
	});

	it('Arithmetic, Calculations, Compound Arithmetic, Blend, Set Matte, Solid Composite', async () => {
		expect(
			near(
				await px(
					'jasper.arithmetic',
					{ operator: 'xor', redValue: 255, greenValue: 255, blueValue: 255 },
					ORANGE,
				),
				[55, 155, 205, 255],
			),
		).toBe(true);
		expect(
			near(
				await px(
					'jasper.arithmetic',
					{ operator: 'slice', redValue: 150, greenValue: 150, blueValue: 150 },
					ORANGE,
				),
				[255, 0, 0, 255],
			),
		).toBe(true);
		expect(
			near(
				await px('jasper.arithmetic', { operator: 'add', redValue: 100, clipResultValues: false }, ORANGE),
				[44, 100, 50, 255],
			),
		).toBe(true);
		expect(near(await px('jasper.calculations', { inputChannel: 'red' }, ORANGE), [200, 200, 200, 255])).toBe(
			true,
		);
		const blue = { secondSourceLayer: solid('rgb(0, 0, 255)') };
		const diff = await s.px(
			{
				id: 'jasper.compound-arithmetic',
				params: { operator: 'difference' },
				picture: ORANGE,
				box,
				media: blue,
			},
			8,
			8,
		);
		expect(near(diff, [200, 100, 205, 255])).toBe(true);
		const lay = { blendWithLayer: solid('rgb(0, 0, 255)') };
		expect(
			near(
				await s.px({ id: 'jasper.blend', params: {}, picture: ORANGE, box, media: lay }, 8, 8),
				[0, 0, 255, 255],
			),
		).toBe(true);
		expect(
			near(
				await s.px(
					{ id: 'jasper.blend', params: { mode: 'darkenOnly' }, picture: ORANGE, box, media: lay },
					8,
					8,
				),
				[0, 0, 50, 255],
			),
		).toBe(true);
		const m = await px('jasper.set-matte', { useForMatte: 'red' }, ORANGE);
		expect(m[3]).toBeGreaterThan(195);
		expect(m[3]).toBeLessThan(205);
		const disc = { kind: 'disc', color: '#f00' } as const;
		const sc = await run('jasper.solid-composite', { color: [0, 0, 1, 1] }, disc, [
			[1, 1],
			[16, 8],
		]);
		expect(near(sc.pixels[0]!, [0, 0, 255, 255])).toBe(true);
		expect(near(sc.pixels[1]!, [255, 0, 0, 255])).toBe(true);
	});

	it('colour corrections change what they should', async () => {
		const hue = await px(
			'jasper.change-color',
			{ colorToChange: [200 / 255, 100 / 255, 50 / 255, 1], hueTransform: 180 },
			ORANGE,
		);
		expect(hue[2]).toBeGreaterThan(hue[0]);
		const mask = await px(
			'jasper.change-color',
			{ colorToChange: [0, 1, 0, 1], view: 'colorCorrectionMask' },
			ORANGE,
		);
		expect(mask[0]).toBe(0);
		const ctc = await px(
			'jasper.change-to-color',
			{ from: [200 / 255, 100 / 255, 50 / 255, 1], to: [0, 0, 1, 1] },
			ORANGE,
		);
		expect(ctc[2]).toBeGreaterThan(ctc[0]);
		expect(
			near(
				await px('jasper.channel-mixer', { redRed: 0, redBlue: 100, blueBlue: 0, blueRed: 100 }, ORANGE),
				[50, 100, 200, 255],
			),
		).toBe(true);
		const mono = await px('jasper.channel-mixer', { monochrome: true, redRed: 50, redGreen: 50 }, ORANGE);
		expect(near(mono, [150, 150, 150, 255])).toBe(true);
		const cb = await px('jasper.color-balance', { shadowBlueBalance: 100 }, solid('rgb(30, 30, 30)'));
		expect(cb[2]).toBeGreaterThan(80);
		expect(grey(await px('jasper.color-balance-hls', { saturation: -100 }, ORANGE))).toBe(true);
		expect(
			grey(await px('jasper.leave-color', { amountToDecolor: 100, colorToLeave: [0, 1, 0, 1] }, ORANGE)),
		).toBe(true);
		expect(
			near(
				await px(
					'jasper.leave-color',
					{ amountToDecolor: 100, colorToLeave: [200 / 255, 100 / 255, 50 / 255, 1] },
					ORANGE,
				),
				O,
			),
		).toBe(true);
		const lim = await px(
			'jasper.video-limiter',
			{ clipLevel: 90, compressionBeforeClip: 'none' },
			solid('#fff'),
		);
		expect(lim[0]).toBeLessThanOrEqual(231);
		const warn = await px(
			'jasper.video-limiter',
			{ clipLevel: 90, gamutWarning: true, gamutWarningColor: [0, 1, 0, 1] },
			solid('#fff'),
		);
		expect(near(warn, [0, 255, 0, 255])).toBe(true);
		// Equalize: a narrow ramp is spread over the full range.
		const ramp = { kind: 'ramp', from: '#505050', to: '#b0b0b0' } as const;
		const eq = await run(
			'jasper.equalize',
			{},
			ramp,
			[
				[0, 4],
				[63, 4],
			],
			{ width: 64, height: 8 },
		);
		expect(eq.pixels[0]![0]).toBeLessThan(20);
		expect(eq.pixels[1]![0]).toBeGreaterThan(235);
	});

	it('Image Control: Color Balance (RGB), Color Pass, Color Replace, Gamma Correction', async () => {
		expect(
			near(await px('jasper.color-balance-rgb', { red: 50, blue: 200 }, ORANGE), [100, 100, 100, 255]),
		).toBe(true);
		const pass = { color: [200 / 255, 100 / 255, 50 / 255, 1] };
		expect(near(await px('jasper.color-pass', pass, ORANGE), O)).toBe(true);
		expect(grey(await px('jasper.color-pass', { ...pass, reverse: true }, ORANGE))).toBe(true);
		const rep = {
			targetColor: [200 / 255, 100 / 255, 50 / 255, 1],
			replaceColor: [0, 0, 1, 1],
			solidColors: true,
		};
		expect(near(await px('jasper.color-replace', rep, ORANGE), [0, 0, 255, 255])).toBe(true);
		expect((await px('jasper.gamma-correction', { gamma: 20 }, solid('rgb(128, 128, 128)')))[0]).toBeLessThan(
			80,
		);
	});

	it('Ultra Key removes the key colour, keeps other colours, and shows its matte', async () => {
		const key = { keyColor: [0.2, 0.8, 0.3, 1] };
		const green = solid('rgb(51, 204, 77)');
		expect((await px('jasper.ultra-key', key, green))[3]).toBe(0);
		expect(near(await px('jasper.ultra-key', key, ORANGE), O, 4)).toBe(true);
		expect(
			near(await px('jasper.ultra-key', { ...key, output: 'alphaChannel' }, green), [0, 0, 0, 255]),
		).toBe(true);
		expect(
			near(await px('jasper.ultra-key', { ...key, output: 'alphaChannel' }, ORANGE), [255, 255, 255, 255]),
		).toBe(true);
		// a darker shade of the screen (a shadow on it) is keyed out too at the default Shadow
		expect((await px('jasper.ultra-key', key, solid('rgb(30, 130, 48)')))[3]).toBeLessThan(40);
		// spill: a greenish grey loses its green cast
		const spill = await px('jasper.ultra-key', key, solid('rgb(150, 190, 150)'));
		expect(spill[1] - spill[0]).toBeLessThan(25);
		const clean = await px('jasper.ultra-key', { ...key, choke: 30, soften: 30, contrast: 50 }, ORANGE);
		expect(clean[3]).toBe(255);
	});

	it('Color Key, Luma Key, Non Red Key, Alpha Adjust, Remove Matte', async () => {
		expect((await px('jasper.color-key', { keyColor: [200 / 255, 100 / 255, 50 / 255, 1] }, ORANGE))[3]).toBe(
			0,
		);
		expect((await px('jasper.color-key', { keyColor: [0, 0, 1, 1] }, ORANGE))[3]).toBe(255);
		expect(
			(
				await px(
					'jasper.color-key',
					{ keyColor: [210 / 255, 100 / 255, 50 / 255, 1], colorTolerance: 20 },
					ORANGE,
				)
			)[3],
		).toBe(0);
		expect((await px('jasper.luma-key', { threshold: 20 }, solid('rgb(20, 20, 20)')))[3]).toBe(0);
		expect((await px('jasper.luma-key', { threshold: 20 }, solid('rgb(220, 220, 220)')))[3]).toBe(255);
		expect((await px('jasper.non-red-key', {}, solid('rgb(30, 220, 40)')))[3]).toBe(0);
		expect((await px('jasper.non-red-key', {}, ORANGE))[3]).toBe(255);
		const half = await px('jasper.alpha-adjust', { opacity: 50 }, ORANGE);
		expect(Math.abs(half[3] - 128)).toBeLessThanOrEqual(1);
		expect((await px('jasper.alpha-adjust', { invertAlpha: true }, ORANGE))[3]).toBe(0);
		// colour 0.75 grey premultiplied against white at 50 % alpha → its true colour is 0.5 grey
		const rm = await px('jasper.remove-matte', { matteType: 'white' }, solid('rgba(191, 191, 191, 0.5)'));
		expect(Math.abs(rm[0] - 128)).toBeLessThanOrEqual(3); // getImageData is straight colour
	});

	it('Difference Matte, Image Matte Key and Track Matte Key use their media layers', async () => {
		const same = { differenceLayer: ORANGE };
		expect(
			(await s.px({ id: 'jasper.difference-matte', params: {}, picture: ORANGE, box, media: same }, 8, 8))[3],
		).toBe(0);
		const other = { differenceLayer: solid('#00f') };
		expect(
			(
				await s.px({ id: 'jasper.difference-matte', params: {}, picture: ORANGE, box, media: other }, 8, 8)
			)[3],
		).toBe(255);
		for (const id of ['jasper.image-matte-key', 'jasper.track-matte-key']) {
			const black = { matte: solid('#000') };
			expect(
				(
					await s.px(
						{ id, params: { compositeUsing: 'matteLuma' }, picture: ORANGE, box, media: black },
						8,
						8,
					)
				)[3],
			).toBe(0);
			expect(
				(
					await s.px(
						{
							id,
							params: { compositeUsing: 'matteLuma', reverse: true },
							picture: ORANGE,
							box,
							media: black,
						},
						8,
						8,
					)
				)[3],
			).toBe(255);
			expect((await s.px({ id, params: {}, picture: ORANGE, box, media: black }, 8, 8))[3]).toBe(255);
		}
	});

	it('Drop Shadow and Radial Shadow draw into the padding', async () => {
		const b = { width: 20, height: 20 };
		const r = await s.pixels(
			{
				id: 'jasper.drop-shadow',
				params: { distance: 6, opacity: 100, direction: 90 },
				picture: solid('#fff'),
				box: b,
			},
			[
				[23, 10],
				[-3, 10],
				[10, 10],
			],
		);
		expect(near(r.pixels[0]!, [0, 0, 0, 255])).toBe(true);
		expect(r.pixels[1]![3]).toBe(0);
		expect(near(r.pixels[2]!, [255, 255, 255, 255])).toBe(true);
		// Premiere's default 135° goes to the lower right
		const d = await s.pixels(
			{ id: 'jasper.drop-shadow', params: { distance: 6, opacity: 100 }, picture: solid('#fff'), box: b },
			[[22, 22]],
		);
		expect(d.pixels[0]![3]).toBe(255);
		const rs = await s.pixels(
			{
				id: 'jasper.radial-shadow',
				params: {
					lightSource: [0.5, 0.5],
					projectionDistance: 50,
					resizeLayer: true,
					opacity: 100,
					shadowOnly: true,
				},
				picture: solid('#fff'),
				box: b,
			},
			[[-3, 10]],
		);
		expect(rs.pixels[0]![3]).toBeGreaterThan(200);
	});

	it('Bevel Alpha / Bevel Edges light the upper-left and shade the lower-right; Basic 3D; Transform; Edge Feather', async () => {
		const b = { width: 40, height: 40 };
		const grey50 = solid('rgb(128, 128, 128)');
		const be = await run(
			'jasper.bevel-edges',
			{ edgeThickness: 0.2, lightIntensity: 0.6 },
			grey50,
			[
				[20, 1],
				[20, 38],
				[20, 20],
			],
			b,
		);
		expect(be.pixels[0]![0]).toBeGreaterThan(150);
		expect(be.pixels[1]![0]).toBeLessThan(110);
		expect(near(be.pixels[2]!, [128, 128, 128, 255])).toBe(true);
		const ba = await run(
			'jasper.bevel-alpha',
			{ edgeThickness: 3, lightIntensity: 0.8 },
			{ kind: 'disc', color: 'rgb(128, 128, 128)' },
			[
				[20 - 8, 20 - 8],
				[20 + 8, 20 + 8],
			],
			b,
		);
		expect(ba.pixels[0]![0]).toBeGreaterThan(ba.pixels[1]![0] + 30);
		// Basic 3D: swivel 180° shows the back (mirrored); 90° is edge-on (nothing at the centre)
		const split = { kind: 'split', left: '#f00', right: '#00f' } as const;
		expect(near(await px('jasper.basic-3d', { swivel: 180 }, split, 4, 8), [0, 0, 255, 255])).toBe(true);
		expect((await px('jasper.basic-3d', { swivel: 90 }, split, 16, 8))[3]).toBe(0);
		// Transform: move right by a quarter; 50 % opacity
		const moved = await px('jasper.transform', { position: [0.75, 0.5] }, split, 20, 8);
		expect(near(moved, [255, 0, 0, 255])).toBe(true);
		expect((await px('jasper.transform', { position: [0.75, 0.5] }, split, 2, 8))[3]).toBe(0);
		expect(Math.abs((await px('jasper.transform', { opacity: 50 }, ORANGE))[3] - 128)).toBeLessThanOrEqual(1);
		const sc = await px('jasper.transform', { scaleHeight: 50 }, split, 2, 8);
		expect(sc[3]).toBe(0);
		const ef = await run(
			'jasper.edge-feather',
			{ amount: 50 },
			ORANGE,
			[
				[0, 0],
				[20, 20],
			],
			b,
		);
		expect(ef.pixels[0]![3]).toBeLessThan(10);
		expect(ef.pixels[1]![3]).toBe(255);
	});

	it('Cineon Converter maps the 10-bit black/white points to black/white', async () => {
		const code = (c: number) =>
			solid(
				`rgb(${Math.round((c / 1023) * 255)}, ${Math.round((c / 1023) * 255)}, ${Math.round((c / 1023) * 255)})`,
			);
		expect((await px('jasper.cineon-converter', {}, code(685)))[0]).toBeGreaterThan(245);
		expect((await px('jasper.cineon-converter', {}, code(95)))[0]).toBeLessThan(10);
		const log = await px('jasper.cineon-converter', { conversionType: 'linearToLog' }, solid('#fff'));
		expect(Math.abs(log[0] - Math.round((685 / 1023) * 255))).toBeLessThanOrEqual(2);
	});
});
