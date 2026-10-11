import '../gl-poison.ts';
import { defaultEffectRegistry, fxBuiltinUniforms, fxSeed, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Paint = 'image' | 'grey' | 'gradient' | 'clear' | 'half' | 'black' | 'white' | 'orange' | 'blue';

export type FilmRunOptions = {
	id: string;
	params?: Record<string, unknown>;
	frame?: number;
	width?: number;
	height?: number;
	paint?: Paint;
	/** Canvas px probes (relative to the layer box) → RGBA. */
	probes?: [number, number][];
	png?: boolean;
	/** Return every pixel of the layer box (small canvases only). */
	all?: boolean;
	clip?: string;
};

let image: HTMLImageElement | null = null;

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

function paint(
	ctx: CanvasRenderingContext2D,
	b: { x: number; y: number; w: number; h: number },
	kind: Paint,
) {
	if (kind === 'image' && image) ctx.drawImage(image, b.x, b.y, b.w, b.h);
	else if (kind === 'grey') {
		ctx.fillStyle = 'rgb(128, 128, 128)';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	} else if (kind === 'black') {
		ctx.fillStyle = '#000';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	} else if (kind === 'orange' || kind === 'blue') {
		ctx.fillStyle = kind === 'orange' ? 'rgb(220, 120, 40)' : 'rgb(20, 40, 230)';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	} else if (kind === 'white') {
		ctx.fillStyle = '#fff';
		ctx.fillRect(b.x, b.y, b.w, b.h);
	} else if (kind === 'half') {
		// left half opaque mid grey, right half transparent
		ctx.fillStyle = 'rgb(128, 128, 128)';
		ctx.fillRect(b.x, b.y, Math.floor(b.w / 2), b.h);
	} else if (kind === 'gradient') {
		const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
		g.addColorStop(0, '#000');
		g.addColorStop(1, '#fff');
		ctx.fillStyle = g;
		ctx.fillRect(b.x, b.y, b.w, b.h);
	}
}

function render(o: FilmRunOptions) {
	const spec = defaultEffectRegistry.get(o.id);
	if (!spec?.gpu) throw new Error(`unknown gpu effect ${o.id}`);
	const params = {
		...Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
		...(o.params ?? {}),
	};
	const w = o.width ?? (image ? image.naturalWidth : 64);
	const h = o.height ?? (image ? image.naturalHeight : 36);
	const box = { width: w, height: h };
	const pad = spec.gpu.padding?.(params as never, { ...box, pxScale: 1, fps: 30 }) ?? 0;
	const padding =
		typeof pad === 'number'
			? { left: pad, top: pad, right: pad, bottom: pad }
			: { left: 0, top: 0, right: 0, bottom: 0, ...pad };
	const layout = fxCanvasLayout(box, padding, 8192);
	const frame = o.frame ?? 0;
	const seed = fxSeed(o.clip ?? 'clip1', 'fx1', params as never);
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: params as never },
		{
			width: w,
			height: h,
			pxScale: layout.pxScale,
			fps: 30,
			frame,
			duration: 300,
			seed,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const hst = fxHost();
	if (!hst) throw new Error('no WebGL2');
	const input = canvas(layout.width, layout.height);
	paint(input.getContext('2d')!, layout.box, o.paint ?? (image ? 'image' : 'grey'));
	const out = canvas(layout.width, layout.height);
	runShaderPlan(
		hst,
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
					duration: 300,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: {} as never,
			samples: { sources: [], offsets: [] },
		},
		out.getContext('2d')!,
	);
	const ctx = out.getContext('2d')!;
	const b = layout.box;
	const probes = (o.probes ?? []).map(
		([x, y]) => Array.from(ctx.getImageData(Math.floor(b.x + x), Math.floor(b.y + y), 1, 1).data) as number[],
	);
	return {
		canvas: [layout.width, layout.height],
		box: [b.x, b.y, b.w, b.h],
		passes: plan.passes.length,
		probes,
		all: o.all ? Array.from(ctx.getImageData(b.x, b.y, b.w, b.h).data) : undefined,
		png: o.png ? out.toDataURL('image/png') : undefined,
	};
}

const api = {
	async loadImage(dataUrl: string | null) {
		if (!dataUrl) {
			image = null;
			return null;
		}
		const img = new Image();
		img.src = dataUrl;
		await img.decode();
		image = img;
		return [img.naturalWidth, img.naturalHeight];
	},
	ids() {
		return defaultEffectRegistry
			.list()
			.filter((s) => s.gpu && s.id.startsWith('jasper.s.'))
			.map((s) => s.id);
	},
	render,
	compileTimes(id: string, over: Record<string, unknown> = {}) {
		const spec = defaultEffectRegistry.get(id)!;
		const params = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...over };
		const ctx = {
			width: 64,
			height: 36,
			pxScale: 1,
			fps: 30,
			frame: 0,
			duration: 300,
			seed: 0.5,
			progress: 0,
		};
		const plan = planGpuEffect(spec, { id: 'fx1', params: params as never }, ctx, { width: 64, height: 36 });
		const gl = document.createElement('canvas').getContext('webgl2')!;
		const vs = gl.createShader(gl.VERTEX_SHADER)!;
		gl.shaderSource(
			vs,
			'#version 300 es\nin vec2 a;out vec2 v_uv;void main(){v_uv=a;gl_Position=vec4(a,0.,1.);}',
		);
		gl.compileShader(vs);
		return plan.passes.map((pass) => {
			const t0 = performance.now();
			const sh = gl.createShader(gl.FRAGMENT_SHADER)!;
			gl.shaderSource(sh, pass.source);
			gl.compileShader(sh);
			const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
			const t1 = performance.now();
			const prog = gl.createProgram()!;
			gl.attachShader(prog, vs);
			gl.attachShader(prog, sh);
			gl.linkProgram(prog);
			gl.useProgram(prog);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
			return {
				compile: Math.round(t1 - t0),
				linkDraw: Math.round(performance.now() - t1),
				ok,
				chars: pass.source.length,
			};
		});
	},
};

(window as unknown as { __film: typeof api }).__film = api;
