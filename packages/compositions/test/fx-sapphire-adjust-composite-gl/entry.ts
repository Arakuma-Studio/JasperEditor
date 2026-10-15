import {
	defaultEffectRegistry,
	type EffectSpec,
	fxBuiltinUniforms,
	fxSeed,
	planGpuEffect,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Paint = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => void;

function canvas(w: number, h: number, paint?: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	paint?.(ctx);
	return c;
}

const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;

const spec = (id: string): EffectSpec => {
	const s = defaultEffectRegistry.get(id);
	if (!s) throw new Error(`no effect ${id}`);
	return s;
};

const withDefaults = (s: EffectSpec, over: Record<string, unknown>) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

/** A solid media picture (or two halves: left / right colours). */
function picture(w: number, h: number, left: string, right = left): HTMLCanvasElement {
	return canvas(w, h, (ctx) => {
		ctx.fillStyle = left;
		ctx.fillRect(0, 0, Math.ceil(w / 2), h);
		ctx.fillStyle = right;
		ctx.fillRect(Math.ceil(w / 2), 0, w - Math.ceil(w / 2), h);
	});
}

type Media = Record<string, HTMLCanvasElement>;

function run(
	id: string,
	over: Record<string, unknown>,
	size: [number, number],
	paint: Paint | string,
	media: Media = {},
	frame = 0,
) {
	const s = spec(id);
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const params = withDefaults(s, {
		...over,
		...Object.fromEntries(Object.keys(media).map((k) => [k, { mediaId: `m-${k}` }])),
	});
	const box = { width: size[0], height: size[1] };
	const layout = fxCanvasLayout(box, { left: 0, top: 0, right: 0, bottom: 0 }, 8192);
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: params as never },
		{ ...box, pxScale: layout.pxScale, fps: 30, frame, duration: 30, seed: 0.25, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const painter: Paint =
		typeof paint === 'string'
			? (ctx, b) => {
					ctx.fillStyle = paint;
					ctx.fillRect(b.x, b.y, b.w, b.h);
				}
			: paint;
	const input = canvas(layout.width, layout.height, (ctx) => painter(ctx, layout.box));
	const out = canvas(layout.width, layout.height);
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		const m = media[t.param];
		textures[t.uniform] = m ? { source: m, width: m.width, height: m.height, version: '1' } : null;
	}
	runShaderPlan(
		h,
		plan,
		input,
		{
			builtins: [
				...fxBuiltinUniforms({
					canvas: layout,
					box: layout.box,
					pxScale: layout.pxScale,
					frame,
					fps: 30,
					duration: 30,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [fxSeed('clip1', 'fx1', params as never)] },
			],
			textures: textures as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	return { out, at: (x: number, y: number) => px(out, x, y) };
}

const allPixels = (c: HTMLCanvasElement) =>
	Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);

/** A white w×h square centred in the layer, transparent around it. */
const square =
	(w: number, color = '#fff'): Paint =>
	(ctx, b) => {
		ctx.fillStyle = color;
		ctx.fillRect(b.x + (b.w - w) / 2, b.y + (b.h - w) / 2, w, w);
	};

const api = {
	adjust() {
		const r = (id: string, over: Record<string, unknown>, color: string) =>
			run(id, over, [8, 8], color).at(4, 4);
		return {
			invert: r('jasper.s.invert', {}, 'rgb(255, 0, 0)'),
			invertLumaOnly: r('jasper.s.invert', { invertChroma: false }, 'rgb(128, 128, 128)'),
			invertRedOnly: r(
				'jasper.s.invert',
				{ invertLuma: false, invertChroma: false, invertRed: true },
				'rgb(255, 100, 0)',
			),
			channel: r(
				'jasper.s.channel-switcher',
				{ redFrom: 'green', greenFrom: 'zero', blueFrom: 'one' },
				'rgb(10, 200, 30)',
			),
			clampChroma: r('jasper.s.clamp-chroma', {}, 'rgb(255, 0, 0)'),
			duoBlack: r('jasper.s.duo-tone', {}, 'rgb(0, 0, 0)'),
			duoWhite: r('jasper.s.duo-tone', {}, 'rgb(255, 255, 255)'),
			duoMixed: r('jasper.s.duo-tone', { mixWithOriginal: 1 }, 'rgb(0, 0, 0)'),
			gamma2: r('jasper.s.gamma', { gamma: 2 }, 'rgb(64, 64, 64)'),
			mono: r('jasper.s.monochrome', {}, 'rgb(255, 0, 0)'),
			hueHalf: r('jasper.s.hue-sat-bright', { hueShift: 1 / 3 }, 'rgb(255, 0, 0)'),
			satZero: r('jasper.s.hue-sat-bright', { saturation: 0 }, 'rgb(255, 0, 0)'),
			thresholdHigh: r('jasper.s.threshold', {}, 'rgb(153, 153, 153)'),
			thresholdLow: r('jasper.s.threshold', {}, 'rgb(102, 102, 102)'),
			hotDark: r('jasper.s.hotspots', {}, 'rgb(100, 100, 100)'),
			hotBright: r('jasper.s.hotspots', {}, 'rgb(250, 120, 40)'),
			tint: r('jasper.s.tint', { tintLights: [1, 0.5, 0, 1] }, 'rgb(255, 255, 255)'),
			tri: r('jasper.s.tri-tone', { color1: [1, 0, 0, 1] }, 'rgb(128, 128, 128)'),
			quadLow: r('jasper.s.quad-tone', { color0: [0, 0, 1, 1] }, 'rgb(0, 0, 0)'),
			quadPoster: r('jasper.s.quad-tone', { softness: 0.001, color1: [0, 1, 0, 1] }, 'rgb(110, 110, 110)'),
			badHigh: r('jasper.s.show-bad-colors', { max: 0.9 }, 'rgb(255, 255, 255)'),
			badLow: r('jasper.s.show-bad-colors', { minLuma: 0.1 }, 'rgb(5, 5, 5)'),
			badMatte: r('jasper.s.show-bad-colors', { max: 0.9, outputMatte: true }, 'rgb(255, 255, 255)'),
			ocioSrgbToLinear: r('jasper.s.ocio-transform', { from: 'srgb', to: 'linRec709' }, 'rgb(188, 188, 188)'),
			ocioSwitched: r(
				'jasper.s.ocio-transform',
				{ from: 'srgb', to: 'linRec709', switchToAndFrom: true },
				'rgb(55, 55, 55)',
			),
		};
	},

	alphaAndMask() {
		// Semi-transparent red under Invert: colour inverted, alpha kept.
		const half = run('jasper.s.invert', {}, [8, 8], 'rgba(255, 0, 0, 0.5)').at(4, 4);
		// Transparent stays transparent.
		const clear = run('jasper.s.invert', {}, [8, 8], () => {}).at(4, 4);
		// Invert Alpha makes it opaque white (inverted black).
		const invAlpha = run('jasper.s.invert', { invertAlpha: true }, [8, 8], () => {}).at(4, 4);
		// Mask: left half white (effect), right half black (source).
		const mask = picture(16, 8, '#fff', '#000');
		const m = run('jasper.s.invert', { blurMask: 0 }, [16, 8], 'rgb(255, 0, 0)', { mask });
		const mi = run('jasper.s.invert', { blurMask: 0, invertMask: true }, [16, 8], 'rgb(255, 0, 0)', { mask });
		const soft = run('jasper.s.invert', { blurMask: 0.5 }, [16, 8], 'rgb(255, 0, 0)', { mask });
		return {
			half,
			clear,
			invAlpha,
			maskLeft: m.at(2, 4),
			maskRight: m.at(13, 4),
			invMaskLeft: mi.at(2, 4),
			invMaskRight: mi.at(13, 4),
			softMid: soft.at(8, 4),
		};
	},

	layer() {
		const bg = picture(8, 8, 'rgb(128, 128, 128)');
		const r = (over: Record<string, unknown>, fg: string, media: Media = { background: bg }) =>
			run('jasper.s.layer', over, [8, 8], fg, media).at(4, 4);
		const matte = picture(16, 8, '#fff', '#000');
		const withMatte = run('jasper.s.layer', { matteUse: 'luma' }, [16, 8], 'rgb(255, 0, 0)', {
			background: bg,
			matte,
		});
		return {
			normal: r({}, 'rgb(255, 0, 0)'),
			multiply: r({ effect: 'multiply' }, 'rgb(255, 128, 0)'),
			screen: r({ effect: 'screen' }, 'rgb(0, 0, 0)'),
			subtract: r({ effect: 'subtract' }, 'rgb(64, 64, 64)'),
			opacity: r({ fgOpacity: 0 }, 'rgb(255, 0, 0)'),
			swap: r({ swapInputs: true }, 'rgb(255, 0, 0)'),
			overTransparent: r({}, 'rgba(255, 0, 0, 0)'),
			luminance: r({ effect: 'luminance' }, 'rgb(255, 255, 255)'),
			resultSat: r({ resultSaturation: 0 }, 'rgb(255, 0, 0)'),
			matteLeft: withMatte.at(2, 4),
			matteRight: withMatte.at(13, 4),
			dissolveRedFraction: (() => {
				const d = run('jasper.s.layer', { effect: 'dissolve', fgOpacity: 0.5 }, [32, 32], 'rgb(255, 0, 0)', {
					background: picture(32, 32, 'rgb(0, 0, 255)'),
				}).out;
				const px = allPixels(d);
				let red = 0;
				for (let i = 0; i < px.length; i += 4) if (px[i]! > 200) red++;
				return red / (px.length / 4);
			})(),
		};
	},

	mathOps() {
		const b = picture(8, 8, 'rgb(100, 50, 200)');
		const r = (op: string, over: Record<string, unknown> = {}) =>
			run('jasper.s.math-ops', { operation: op, ...over }, [8, 8], 'rgb(200, 100, 100)', { sourceB: b }).at(
				4,
				4,
			);
		return {
			add: r('add'),
			subtract: r('subtract'),
			subtractOpaque: r('subtract', { opacity: 'allOpaque' }),
			multiply: r('multiply'),
			difference: r('difference', { opacity: 'allOpaque' }),
			minimum: r('minimum'),
			maximum: r('maximum'),
			average: r('average'),
			andBits: r('andBits'),
			mod: r('mod', { opacity: 'allOpaque' }),
			swap: r('subtract', { swapInputs: true, opacity: 'allOpaque' }),
		};
	},

	matteOps() {
		// A 30×30 white opaque square in a 60×60 transparent layer: edges at x = 15 and x = 45 (pixels 15…44 inside).
		const L: [number, number] = [60, 60];
		const at = (over: Record<string, unknown>, x: number) =>
			run('jasper.s.matte-ops', over, L, square(30)).at(x, 30)[3];
		const grow = { shrinkGrow: 4, edgeSoftness: 1 };
		const filters = ['box', 'triangle', 'gauss'];
		const noise = { shrinkGrow: 1, noiseAmplitude: 2, noiseWidth: 0.2, frequency: 3 };
		const noisy = (over: Record<string, unknown>, frame = 0) =>
			allPixels(run('jasper.s.matte-ops', { ...noise, ...over }, L, square(30), {}, frame).out);
		return {
			identityEdge: [at({}, 44), at({}, 45)],
			growOut: Object.fromEntries(
				filters.map((f) => [f, [at({ ...grow, filter: f }, 47), at({ ...grow, filter: f }, 50)]]),
			),
			shrink: Object.fromEntries(
				filters.map((f) => [
					f,
					[at({ shrinkGrow: -3, filter: f }, 43), at({ shrinkGrow: -3, filter: f }, 40)],
				]),
			),
			matteOut: run('jasper.s.matte-ops', { output: 'matte' }, L, square(30)).at(2, 2),
			invert: at({ invertMatte: true }, 2),
			postBlurEdge: at({ postBlur: 3 }, 46),
			noiseA: noisy({}),
			noiseB: noisy({}),
			noiseSeed: noisy({ seed: 7 }),
			noiseFrame: noisy({}, 5),
			noiseStatic: noisy({ jitterFrames: 0 }, 5),
			noiseStatic0: noisy({ jitterFrames: 0 }, 0),
		};
	},

	matteOpsComp() {
		const bg = picture(60, 60, 'rgb(0, 0, 255)');
		const r = run('jasper.s.matte-ops-comp', { shrinkGrow: 3 }, [60, 60], square(30, 'rgb(255, 0, 0)'), {
			background: bg,
		});
		return { inside: r.at(30, 30), grown: r.at(46, 30), outside: r.at(55, 30) };
	},

	edgeFlash() {
		const bg = picture(40, 40, 'rgb(0, 0, 200)');
		const res: Record<string, Px> = {};
		for (const mode of ['original', 'lightWrap']) {
			const r = run(
				'jasper.s.edge-flash',
				{ effect: mode, flashWidth: 0.3 },
				[40, 40],
				square(16, 'rgb(128, 128, 128)'),
				{ background: bg },
			);
			res[`${mode}NearOut`] = r.at(30, 20);
			res[`${mode}Far`] = r.at(1, 1);
			res[`${mode}EdgeIn`] = r.at(27, 20);
			res[`${mode}Centre`] = r.at(20, 20);
		}
		const plain = run(
			'jasper.s.edge-flash',
			{ fgFlashAmp: 0, bgFlashAmp: 0 },
			[40, 40],
			square(16, 'rgb(128, 128, 128)'),
			{ background: bg },
		);
		res.plainNearOut = plain.at(30, 20);
		res.plainCentre = plain.at(20, 20);
		const fgOnly = run('jasper.s.edge-flash', { output: 'foreground' }, [40, 40], square(16), {
			background: bg,
		});
		res.fgOnlyOutside = fgOnly.at(1, 1);
		const grown = run(
			'jasper.s.edge-flash',
			{ shrinkGrow: 4, fgFlashAmp: 0, bgFlashAmp: 0 },
			[40, 40],
			square(16, 'rgb(128, 128, 128)'),
			{ background: bg },
		);
		res.grownOut = grown.at(30, 20);
		return res;
	},

	zComp() {
		const b = picture(8, 8, 'rgb(0, 0, 255)');
		const near = picture(8, 8, 'rgb(50, 50, 50)');
		const far = picture(8, 8, 'rgb(200, 200, 200)');
		const r = (media: Media, over: Record<string, unknown> = {}) =>
			run('jasper.s.z-comp', over, [8, 8], 'rgb(255, 0, 0)', { sourceB: b, ...media }).at(4, 4);
		return {
			aNear: r({ depthA: near, depthB: far }),
			bNear: r({ depthA: far, depthB: near }),
			inverted: r({ depthA: near, depthB: far }, { invertZ: true }),
			blended: r({ depthA: near, depthB: near }, { antiAlias: 0.5 }),
			noDepth: r({}),
		};
	},
};

(window as unknown as { __sac: typeof api }).__sac = api;
