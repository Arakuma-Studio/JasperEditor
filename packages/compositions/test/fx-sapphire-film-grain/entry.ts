import { defaultEffectRegistry, fxBuiltinUniforms, fxSeed, planGpuEffect } from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

type Paint = 'grey' | 'gradient' | 'clear' | 'half' | 'black' | 'white' | 'orange' | 'blue';

export type FilmRunOptions = {
	id: string;
	params?: Record<string, unknown>;
	frame?: number;
	width?: number;
	height?: number;
	paint?: Paint;
	/** Canvas px probes (relative to the layer box) → RGBA. */
	probes?: [number, number][];
	/** Return every pixel of the layer box (small canvases only). */
	all?: boolean;
	clip?: string;
};

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
	if (kind === 'grey') {
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
	const w = o.width ?? 64;
	const h = o.height ?? 36;
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
	paint(input.getContext('2d')!, layout.box, o.paint ?? 'grey');
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
		probes,
		all: o.all ? Array.from(ctx.getImageData(b.x, b.y, b.w, b.h).data) : undefined,
	};
}

const api = {
	render,
};

(window as unknown as { __film: typeof api }).__film = api;
