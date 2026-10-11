import '../gl-poison.ts';
import { defaultEffectRegistry, type EffectSpec, fxBuiltinUniforms, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Px = [number, number, number, number];
type Paint = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

function canvas(w: number, h: number, paint?: Paint): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	paint?.(c.getContext('2d')!, w, h);
	return c;
}
const px = (c: HTMLCanvasElement, x: number, y: number): Px =>
	Array.from(c.getContext('2d')!.getImageData(Math.floor(x), Math.floor(y), 1, 1).data) as Px;
const fill =
	(color: string, rect?: [number, number, number, number]): Paint =>
	(ctx, w, h) => {
		ctx.fillStyle = color;
		const [x, y, rw, rh] = rect ?? [0, 0, w, h];
		ctx.fillRect(x, y, rw, rh);
	};
const spec = (id: string): EffectSpec => {
	const s = defaultEffectRegistry.get(id);
	if (!s) throw new Error(`no effect ${id}`);
	return s;
};
const params = (s: EffectSpec, over: Record<string, unknown>) => ({
	...Object.fromEntries(s.params.map((p) => [p.name, p.default])),
	...over,
});

/** Runs an effect on a W×H layer (no padding: none of the family pads). Samples are canvases of the same size. */
function run(
	id: string,
	over: Record<string, unknown>,
	size: [number, number],
	source: Paint,
	extra: {
		samples?: [number, Paint][];
		frame?: number;
		seed?: number;
		textures?: Record<string, Paint>;
	} = {},
): HTMLCanvasElement {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = spec(id);
	const p = params(s, over);
	const [W, H] = size;
	const layout = fxCanvasLayout({ width: W, height: H }, { left: 0, top: 0, right: 0, bottom: 0 }, 8192);
	const frame = extra.frame ?? 20;
	const seed = extra.seed ?? 0.25;
	const plan = planGpuEffect(
		s,
		{ id: 'fx1', params: p as never },
		{ width: W, height: H, pxScale: 1, fps: 30, frame, duration: 60, seed, progress: 0 },
		{ width: layout.width, height: layout.height },
	);
	const out = canvas(layout.width, layout.height);
	const textures: Record<string, unknown> = {};
	for (const t of plan.textures) {
		const paint = extra.textures?.[t.param];
		textures[t.uniform] = paint
			? { source: canvas(W, H, paint), width: W, height: H, version: t.param }
			: null;
	}
	runShaderPlan(
		h,
		plan,
		canvas(W, H, source),
		{
			builtins: [
				...fxBuiltinUniforms({
					canvas: layout,
					box: layout.box,
					pxScale: 1,
					frame,
					fps: 30,
					duration: 60,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: textures as never,
			samples: {
				sources: (extra.samples ?? []).map(([, paint]) => canvas(W, H, paint)),
				offsets: (extra.samples ?? []).map(([o]) => o),
			},
		},
		out.getContext('2d')!,
	);
	return out;
}

const RED = 'rgb(255, 0, 0)';
const GREEN = 'rgb(0, 255, 0)';
const BLUE = 'rgb(0, 0, 255)';
const WHITE = 'rgb(255, 255, 255)';
const BLACK = 'rgb(0, 0, 0)';
const S: [number, number] = [16, 16];

const api = {
	remaps() {
		// Pure remaps draw the (already remapped) input unchanged.
		const a = run('jasper.s.freeze-frame', {}, S, fill(RED));
		const b = run('jasper.s.reverse-clip', { swapFields: 'no' }, S, fill(GREEN));
		// Swap Fields "Yes Up1": the picture moves up one pixel.
		const c = run('jasper.s.reverse-clip', {}, S, fill(WHITE, [0, 8, 16, 8]));
		return { freeze: px(a, 8, 8), reverse: px(b, 8, 8), up1Above: px(c, 8, 7), up1Edge: px(c, 8, 6) };
	},

	getFrame() {
		const c = run('jasper.s.get-frame', { getFrame: 3.25, interpFrames: true }, S, fill(BLACK), {
			samples: [[1, fill(WHITE)]],
		});
		return { blend: px(c, 8, 8) };
	},

	trails() {
		// Max: the newest frame (red, left) and an older one (green, right) both show; Ave: weighted.
		const samples: [number, Paint][] = [[-1, fill(GREEN, [8, 0, 8, 16])]];
		const max = run(
			'jasper.s.trails',
			{ combineNew: 'max', prevBrightness: 1 },
			S,
			fill(RED, [0, 0, 8, 16]),
			{
				samples,
			},
		);
		const ave = run('jasper.s.trails', { prevBrightness: 0.5 }, S, fill(WHITE), {
			samples: [[-1, fill(BLACK)]],
		});
		const none = run('jasper.s.trails', {}, S, () => {});
		const again = run(
			'jasper.s.trails',
			{ combineNew: 'max', prevBrightness: 1 },
			S,
			fill(RED, [0, 0, 8, 16]),
			{
				samples,
			},
		);
		return {
			maxLeft: px(max, 3, 8),
			maxRight: px(max, 12, 8),
			ave: px(ave, 8, 8),
			transparent: px(none, 8, 8),
			same: px(again, 12, 8).join() === px(max, 12, 8).join(),
		};
	},

	feedback() {
		// Z Dist 0.5: the previous frame (a centred white dot) is enlarged 2×; Max keeps both.
		const dot = fill(WHITE, [14, 14, 4, 4]);
		const c = run(
			'jasper.s.feedback',
			{ combineNew: 'max', prevBrightness: 1, zDist: 0.5, rotate: 0 },
			[32, 32],
			() => {},
			{ samples: [[-1, dot]] },
		);
		const bubble = (seed: number) =>
			run(
				'jasper.s.feedback-bubble',
				{ combineNew: 'max', prevBrightness: 1, bubbleAmount: 0.3, bubbleSeed: seed },
				[32, 32],
				() => {},
				{
					samples: [[-1, fill(WHITE, [0, 0, 16, 32])]],
				},
			);
		const b1 = bubble(0.1);
		const b2 = bubble(0.7);
		let differs = 0;
		for (let y = 0; y < 32; y += 2)
			for (let x = 8; x < 24; x += 2) if (px(b1, x, y)[0] !== px(b2, x, y)[0]) differs++;
		return { grown: px(c, 13, 16), outside: px(c, 3, 3), bubbleDiffers: differs };
	},

	timeAverage() {
		const c = run('jasper.s.time-average', { aveOverFrames: 3 }, S, fill(WHITE), {
			samples: [
				[-2, fill(BLACK)],
				[-1, fill(BLACK)],
			],
		});
		return { mean: px(c, 8, 8) };
	},

	timeWarpRgb() {
		const c = run('jasper.s.time-warp-rgb', {}, S, fill(BLACK), {
			samples: [
				[-1, fill(WHITE)], // red comes from frame −1 (Red Shift Frames 1)
				[1, fill(BLACK)], // blue from frame +1
			],
		});
		return { pixel: px(c, 8, 8) };
	},

	motionDetect() {
		const same = run('jasper.s.motion-detect', {}, S, fill(RED), { samples: [[-1, fill(RED)]] });
		const moved = run('jasper.s.motion-detect', {}, S, fill(RED), { samples: [[-1, fill(BLUE)]] });
		return { same: px(same, 8, 8), moved: px(moved, 8, 8) };
	},

	nearestColor() {
		const c = run('jasper.s.nearest-color', {}, S, fill(RED), {
			samples: [
				[-2, fill(GREEN)],
				[-1, fill(BLUE)],
			],
		});
		return { pixel: px(c, 8, 8) };
	},

	timeSlice() {
		// 2 slices top→bottom: frames −1 (top) and 0 (bottom) with Slice Number 2.
		const c = run('jasper.s.time-slice', { sliceNumber: 2 }, S, fill(RED), { samples: [[-1, fill(GREEN)]] });
		return { top: px(c, 8, 3), bottom: px(c, 8, 12) };
	},

	timeDisplace() {
		// A white matte → White Time Shift (+2), black → Black Time Shift (−2).
		const matte = fill(WHITE, [0, 0, 16, 8]);
		const c = run(
			'jasper.s.time-displace',
			{ blackTimeShift: -2, whiteTimeShift: 2, blurMatte: 0, matte: { mediaId: 'm' } },
			S,
			fill(RED),
			{
				samples: [
					[-2, fill(GREEN)],
					[2, fill(BLUE)],
				],
				textures: { matte },
			},
		);
		return { white: px(c, 8, 2), black: px(c, 8, 13) };
	},

	cutToDissolve() {
		// Frame 30 = the cut (first B frame) in a 6-frame window, linear: t = 3.5 / 6.
		const c = run(
			'jasper.s.cut-to-dissolve',
			{ cutPoint: 30, dissolveLength: 6, slowInOut: 0 },
			S,
			fill(WHITE),
			{
				frame: 30,
				samples: [[-1, fill(BLACK)]],
			},
		);
		const outside = run('jasper.s.cut-to-dissolve', { cutPoint: 30 }, S, fill(GREEN), { frame: 10 });
		return { mid: px(c, 8, 8), outside: px(outside, 8, 8) };
	},

	repairFrames() {
		const c = run('jasper.s.repair-frames', { firstBadFrame: 20, badFrameCount: 1 }, [32, 32], fill(RED), {
			frame: 20,
			samples: [
				[-1, fill(BLACK)],
				[1, fill(WHITE)],
			],
		});
		const good = run('jasper.s.repair-frames', { firstBadFrame: 20 }, [32, 32], fill(RED), { frame: 25 });
		return { repaired: px(c, 16, 16), good: px(good, 16, 16) };
	},

	retime() {
		// A white square moving 6 px right between A and B; at t = 0.5 the in-between square is at +3 px.
		const sq =
			(x: number): Paint =>
			(ctx) => {
				fill(BLACK)(ctx, 64, 64);
				ctx.fillStyle = WHITE;
				ctx.fillRect(x, 20, 24, 24);
			};
		const interp = run('jasper.s.retime', { speed: 0.5 }, [64, 64], sq(16), {
			frame: 41,
			samples: [[1, sq(22)]],
		});
		const vectors = run('jasper.s.retime', { speed: 0.5, result: 'flowVectors' }, [64, 64], sq(16), {
			frame: 41,
			samples: [[1, sq(22)]],
		});
		return {
			// x = 17..19 are white only in A (cross-fade: 50 %), x = 40..42 only in B; the midpoint square covers 19..42.
			leading: px(interp, 41, 32),
			trailing: px(interp, 17, 32),
			centre: px(interp, 30, 32),
			vectorAtEdge: px(vectors, 40, 32),
		};
	},

	fieldRemove() {
		// Alternating rows (a comb) in the left half, flat grey on the right.
		const comb: Paint = (ctx) => {
			for (let y = 0; y < 16; y++) {
				ctx.fillStyle = y % 2 ? WHITE : BLACK;
				ctx.fillRect(0, y, 8, 1);
			}
			ctx.fillStyle = 'rgb(128, 128, 128)';
			ctx.fillRect(8, 0, 8, 16);
		};
		const c = run('jasper.s.field-remove', { useField: 'merge', blurMoMatte: 0 }, S, comb);
		const m = run('jasper.s.field-remove', { show: 'motionMatte', blurMoMatte: 0 }, S, comb);
		return { combFixed: px(c, 3, 8), flat: px(c, 12, 8), matteComb: px(m, 3, 8), matteFlat: px(m, 12, 8) };
	},

	flicker() {
		const doubled = run('jasper.s.flicker', { amplitude: 0, brightness: 2 }, S, fill('rgb(60, 60, 60)'));
		const a = run('jasper.s.flicker', { amplitude: 1 }, S, fill('rgb(100, 100, 100)'), {
			frame: 3,
			seed: 0.1,
		});
		const b = run('jasper.s.flicker', { amplitude: 1 }, S, fill('rgb(100, 100, 100)'), {
			frame: 3,
			seed: 0.9,
		});
		return { doubled: px(doubled, 8, 8), seeds: [px(a, 8, 8)[0], px(b, 8, 8)[0]] };
	},

	flickerTools() {
		const grey = fill('rgb(64, 64, 64)');
		const remove = run('jasper.s.flicker-remove', {}, S, grey);
		const removeColor = run('jasper.s.flicker-remove-color', {}, S, fill('rgb(50, 100, 25)'));
		const removeMatte = run('jasper.s.flicker-remove-matte', {}, S, grey);
		const rmMatteColor = run('jasper.s.flicker-rm-matte-color', {}, S, fill('rgb(50, 100, 25)'));
		const ref = run('jasper.s.flicker-remove', { holdFromFrame: true, holdFrame: 10 }, S, grey, {
			samples: [[-10, fill('rgb(32, 32, 32)')]],
		});
		const noMatch = run('jasper.s.flicker-match', {}, S, fill('rgb(100, 100, 100)'));
		const match = run('jasper.s.flicker-match', { match: { mediaId: 'm' } }, S, fill('rgb(100, 100, 100)'), {
			textures: { match: fill('rgb(64, 64, 64)') },
		});
		const matchColor = run(
			'jasper.s.flicker-match-color',
			{ match: { mediaId: 'm' } },
			S,
			fill('rgb(100, 100, 100)'),
			{
				textures: { match: fill('rgb(128, 64, 255)') },
			},
		);
		return {
			remove: px(remove, 8, 8),
			removeColor: px(removeColor, 8, 8),
			removeMatte: px(removeMatte, 8, 8),
			rmMatteColor: px(rmMatteColor, 8, 8),
			ref: px(ref, 8, 8),
			noMatch: px(noMatch, 8, 8),
			match: px(match, 8, 8),
			matchColor: px(matchColor, 8, 8),
		};
	},
};

(window as unknown as { __stf: typeof api }).__stf = api;
