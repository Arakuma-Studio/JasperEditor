// Browser entry of the fx GL test (bundled with esbuild, run in headless Chrome by ../fx-gl.test.ts): drives the
// real GPU host (src/fx/host.ts) with planned effects and reports pixels. No React, no Remotion chain — the host's
// contract (passes, padding layout, orientation, premultiplied alpha, samples, media textures, LUT, errors).
import {
	bakeLut,
	defaultEffectRegistry,
	defineShaderEffect,
	type EffectSpec,
	fxBuiltinUniforms,
	fxParam,
	GLSL_LIBRARY,
	planGpuEffect,
} from '@jasper/project';
import { FxShaderError, fxHost, runLutPass, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';
import { TEST_FX } from '../fx-examples.ts';

type Px = [number, number, number, number];

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

const defaults = (spec: EffectSpec, over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
	...over,
});

/** Runs one effect on a layer of `box` size whose box is painted by `paint` (layer px = canvas px here). */
function run(
	spec: EffectSpec,
	params: Record<string, unknown>,
	box: { width: number; height: number },
	paint: (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => void,
	extra: {
		samples?: HTMLCanvasElement[];
		offsets?: number[];
		textures?: Record<string, unknown>;
		frame?: number;
	} = {},
) {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const pad = spec.gpu?.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = extra.frame ?? 0;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{
			width: box.width,
			height: box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 30,
			seed: 0.25,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = canvas(layout.width, layout.height, (ctx) => paint(ctx, layout.box));
	const out = canvas(layout.width, layout.height);
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
				{ name: 'u_seed', type: 'float', value: [0.25] },
			],
			textures: (extra.textures ?? {}) as never,
			samples: { sources: extra.samples ?? [], offsets: extra.offsets ?? [] },
		},
		out.getContext('2d')!,
	);
	return { out, layout, plan };
}

const identity = defineShaderEffect({
	id: 'test.identity',
	label: 'Identity',
	category: 'Utility',
	params: [],
	gpu: { passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }] },
});

const api = {
	info() {
		const h = fxHost();
		if (!h) return { webgl2: false };
		const dbg = h.gl.getExtension('WEBGL_debug_renderer_info');
		return {
			webgl2: true,
			renderer: String(h.gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : h.gl.RENDERER)),
			floatTargets: h.floatTargets,
		};
	},

	/** Every library chunk in one program (GLSL compilers check unused functions too). */
	library() {
		const spec = defineShaderEffect({
			id: 'test.library',
			label: 'Library',
			category: 'Utility',
			params: [],
			gpu: {
				passes: [
					{
						include: GLSL_LIBRARY,
						frag: /* glsl */ `
void main() {
  vec2 p = fx_layerPx();
  float n = fx_fbm(p * 0.1, 4, 2.0, 0.5, u_seed) + fx_cellular(p * 0.1, 1.0, u_seed).x + fx_turbulence(vec3(p, u_time), 3, 2.0, 0.5, u_seed);
  vec3 c = fx_hsv2rgb(fx_rgb2hsv(vec3(n))) + fx_hsl2rgb(fx_rgb2hsl(vec3(0.5)));
  vec4 b = fx_blend(FX_BLEND_SCREEN, texture(u_source, v_uv), vec4(c, 1.0), 0.5);
  b += fx_sampleEdge(u_source, fx_rotateAround(v_uv, vec2(0.5), 0.3), FX_EDGE_MIRROR) * 0.0;
  b += fx_gaussian1d(u_source, v_uv, vec2(1.0, 0.0), u_texel, 2.0) * 0.0;
  fragColor = fx_finish(b, texture(u_source, v_uv), fx_luma(c), 0.0, FX_SHOW_RESULT);
}`,
					},
				],
			},
		});
		try {
			run(spec, {}, { width: 16, height: 16 }, (ctx) => ctx.fillRect(0, 0, 16, 16));
			return { ok: true };
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
	},

	/** Plans and runs every registered GPU effect (+ the test effects) with default params. */
	catalogue() {
		const specs = [...defaultEffectRegistry.list().filter((s) => s.gpu), ...TEST_FX];
		const errors: string[] = [];
		for (const spec of specs) {
			try {
				run(spec, defaults(spec), { width: 64, height: 36 }, (ctx, b) => {
					ctx.fillStyle = '#c84';
					ctx.fillRect(b.x, b.y, b.w, b.h);
				});
			} catch (e) {
				errors.push(`${spec.id}: ${(e as Error).message}`);
			}
		}
		return { count: specs.length, errors };
	},

	orientation() {
		const { out } = run(identity, {}, { width: 4, height: 4 }, (ctx) => {
			ctx.fillStyle = 'rgb(255, 0, 0)';
			ctx.fillRect(0, 0, 4, 2);
			ctx.fillStyle = 'rgb(0, 0, 255)';
			ctx.fillRect(0, 2, 4, 2);
		});
		return { top: px(out, 1, 0), bottom: px(out, 1, 3) };
	},

	alpha() {
		const { out } = run(identity, {}, { width: 2, height: 2 }, (ctx) => {
			ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
			ctx.fillRect(0, 0, 2, 2);
		});
		return { pixel: px(out, 0, 0) };
	},

	glow() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.glow')!;
		const { out, layout, plan } = run(
			spec,
			defaults(spec, { radius: 4, threshold: 10 }),
			{ width: 20, height: 20 },
			(ctx, b) => {
				ctx.fillStyle = '#fff';
				ctx.fillRect(b.x + 5, b.y + 5, 10, 10);
			},
		);
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			box: [b.x, b.y, b.w, b.h],
			centre: px(out, b.x + 10, b.y + 10),
			nearOutside: px(out, b.x - 2, b.y + 10),
			farCorner: px(out, 0, 0),
			passes: plan.passes.map((p) => [p.output, p.width, p.height]),
		};
	},

	gradient() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.gradient')!;
		const { out } = run(spec, defaults(spec), { width: 100, height: 4 }, () => {});
		return { left: px(out, 0, 1), mid: px(out, 50, 1), right: px(out, 99, 1) };
	},

	shadow() {
		const spec = TEST_FX.find((s) => s.id === 'test.drop-shadow')!;
		const { out, layout } = run(
			spec,
			defaults(spec, { direction: 0, distance: 6, softness: 0, opacity: 50 }),
			{ width: 20, height: 20 },
			(ctx, b) => {
				ctx.fillStyle = '#fff';
				ctx.fillRect(b.x, b.y, b.w, b.h);
			},
		);
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			right: px(out, b.x + b.w + 3, b.y + 10),
			left: px(out, b.x - 3, b.y + 10),
			inside: px(out, b.x + 10, b.y + 10),
		};
	},

	samples() {
		const spec = TEST_FX.find((s) => s.id === 'test.s.trails')!;
		const sample = (color: string) =>
			canvas(8, 8, (ctx) => {
				ctx.fillStyle = color;
				ctx.fillRect(4, 0, 4, 8);
			});
		const { out } = run(
			spec,
			defaults(spec, { count: 2, decay: 1 }),
			{ width: 8, height: 8 },
			(ctx) => {
				ctx.fillStyle = '#f00';
				ctx.fillRect(0, 0, 4, 8);
			},
			{ samples: [sample('#0f0'), sample('#00f')], offsets: [-1, -2] },
		);
		return { source: px(out, 1, 4), sample: px(out, 6, 4) };
	},

	media() {
		const spec = defineShaderEffect({
			id: 'test.media',
			label: 'Media',
			category: 'Utility',
			params: [fxParam.media('map', 'Map')],
			gpu: {
				passes: [
					{
						frag: 'void main() { fragColor = u_map_size.x > 0.0 ? texture(u_map, v_uv) : vec4(1.0, 0.0, 1.0, 1.0); }',
					},
				],
			},
		});
		const map = canvas(3, 2, (ctx) => {
			ctx.fillStyle = 'rgb(0, 200, 100)';
			ctx.fillRect(0, 0, 3, 2);
		});
		const bound = run(spec, { map: { mediaId: 'm1' } }, { width: 4, height: 4 }, () => {}, {
			textures: { u_map: { source: map, width: 3, height: 2, version: '1' } },
		}).out;
		const missing = run(spec, { map: { mediaId: '' } }, { width: 4, height: 4 }, () => {}, {
			textures: { u_map: null },
		}).out;
		return { bound: px(bound, 1, 1), missing: px(missing, 1, 1) };
	},

	lut() {
		const h = fxHost()!;
		const lut = bakeLut(5, (c) => {
			c[0] = 1 - c[0];
			c[1] = 1 - c[1];
			c[2] = 1 - c[2];
		});
		const input = canvas(2, 2, (ctx) => {
			ctx.fillStyle = 'rgb(255, 64, 0)';
			ctx.fillRect(0, 0, 2, 2);
		});
		const out = canvas(2, 2);
		runLutPass(h, lut, 'invert', input, out.getContext('2d')!, 2, 2);
		return { pixel: px(out, 0, 0) };
	},

	error() {
		const broken = defineShaderEffect({
			id: 'test.broken',
			label: 'Broken',
			category: 'Utility',
			params: [],
			gpu: { passes: [{ frag: 'void main() { fragColor = undefinedThing; }' }] },
		});
		try {
			run(broken, {}, { width: 2, height: 2 }, () => {});
			return { thrown: false };
		} catch (e) {
			return { thrown: e instanceof FxShaderError, message: (e as Error).message };
		}
	},

	halfFloat() {
		const spec = defineShaderEffect({
			id: 'test.hdr',
			label: 'HDR',
			category: 'Utility',
			params: [],
			gpu: {
				passes: [
					{
						output: 'hdr',
						format: 'rgba16f',
						frag: 'void main() { fragColor = texture(u_source, v_uv) * 4.0; }',
					},
					{ frag: 'void main() { fragColor = texture(u_hdr, v_uv) * 0.25; }' },
				],
			},
		});
		const { out } = run(spec, {}, { width: 2, height: 2 }, (ctx) => {
			ctx.fillStyle = 'rgb(200, 100, 40)';
			ctx.fillRect(0, 0, 2, 2);
		});
		return { pixel: px(out, 0, 0) };
	},
};

(window as unknown as { __fx: typeof api }).__fx = api;
