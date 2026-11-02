// Browser side of the Title Looks test harness (`../title-look-harness.ts`): runs one look on a painted input through
// the real planner and GPU host, and returns the pixels. Everything a look test needs goes through `render`.
import {
	appearanceClipReach,
	appearanceFromRecipe,
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	type FxPadding,
	fxBuiltinUniforms,
	fxOffsetBuiltins,
	type LookRecipe,
	planGpuEffect,
	resolveAppearance,
	TITLE_LOOK_EFFECT,
} from '@jasper/project';
import { fxHost, runShaderPlan } from '../../src/fx/host.ts';
import { fxCanvasLayout } from '../../src/fx/plan.ts';

export type LookInput =
	/** Bold text on transparent, `size` layer px (default 96). */
	| { kind: 'text'; text?: string; size?: number; opacity?: number }
	/** Letter-like vector shapes: the same geometry at every size, for resolution tests (text hints per size). */
	| { kind: 'shapes'; dx?: number; dy?: number }
	/**
	 * Rectangular "letters" placed one by one (fractions of the box, like per-character animators): exact geometry,
	 * each with its own offset and opacity, and a brighter corner so highlights have a place to be.
	 */
	| {
			kind: 'letters';
			letters: { x: number; y: number; w: number; h: number; opacity?: number; color?: string }[];
	  }
	/** A rectangle inside the box (fractions), for exact edges. */
	| { kind: 'rect'; x: number; y: number; w: number; h: number; color?: string }
	/** The golden test card. */
	| { kind: 'card' };

export type LookRequest = {
	recipe: LookRecipe;
	input: LookInput;
	/** Layer box in layer px. */
	box: { width: number; height: number };
	/** TL-012: the unit in layer px, or null for the alpha bounds. Default: the text size, else null. */
	unitPx?: number | null;
	/** Canvas px per layer px (the preview scale). */
	pxScale?: number;
	seed?: number;
	contentSeconds?: number;
	/** Extra padding in layer px beyond the look's own. */
	pad?: number;
	/** Timings only: no pixels back (a 1080p frame through `page.evaluate` costs more than drawing it). */
	timingOnly?: boolean;
	/** With `timingOnly`: time every pass (each ends in a read-back, so the total is higher). */
	perPass?: boolean;
};

export type LookResult = {
	width: number;
	height: number;
	/** Base64 of RGBA8 rows, top first. */
	rgba: string;
	padding: FxPadding;
	passes: number;
	/** The layer box inside the canvas, canvas px. */
	box: { x: number; y: number; w: number; h: number };
	/** Upload, every pass and the copy out, until the GPU has finished (read-back as the sync point). */
	ms: number;
	/** With the pixels read back into JavaScript. */
	totalMs: number;
	passLog?: string[];
};

function paintInput(
	ctx: CanvasRenderingContext2D,
	input: LookInput,
	b: { x: number; y: number; w: number; h: number },
	s: number,
) {
	if (input.kind === 'text') {
		ctx.fillStyle = `rgba(255, 255, 255, ${input.opacity ?? 1})`;
		ctx.font = `bold ${(input.size ?? 96) * s}px "Liberation Sans", Arial, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(input.text ?? 'Title', b.x + b.w / 2, b.y + b.h / 2);
		return;
	}
	if (input.kind === 'letters') {
		for (const l of input.letters) {
			const x = b.x + b.w * l.x;
			const y = b.y + b.h * l.y;
			const w = b.w * l.w;
			const h = b.h * l.h;
			ctx.globalAlpha = l.opacity ?? 1;
			ctx.fillStyle = l.color ?? '#808080';
			ctx.fillRect(x, y, w, h);
			const hot = ctx.createRadialGradient(x + w * 0.3, y + h * 0.3, 0, x + w * 0.3, y + h * 0.3, h * 0.3);
			hot.addColorStop(0, '#ffffff');
			hot.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = hot;
			ctx.fillRect(x, y, w, h);
			ctx.globalAlpha = 1;
		}
		return;
	}
	if (input.kind === 'shapes') {
		const X = (u: number) => b.x + b.w * (u + (input.dx ?? 0));
		const Y = (v: number) => b.y + b.h * (v + (input.dy ?? 0));
		ctx.fillStyle = '#fff';
		ctx.beginPath();
		// A slanted, pointed stem, a ring and a dot: straight edges, curves, thin parts, a counter and a sharp corner.
		ctx.moveTo(X(0.22), Y(0.78));
		ctx.lineTo(X(0.33), Y(0.22));
		ctx.lineTo(X(0.42), Y(0.22));
		ctx.lineTo(X(0.53), Y(0.78));
		ctx.lineTo(X(0.45), Y(0.78));
		ctx.lineTo(X(0.375), Y(0.42));
		ctx.lineTo(X(0.3), Y(0.78));
		ctx.closePath();
		ctx.fill();
		ctx.beginPath();
		ctx.arc(X(0.68), Y(0.52), b.h * 0.26, 0, Math.PI * 2);
		ctx.arc(X(0.68), Y(0.52), b.h * 0.14, 0, Math.PI * 2, true);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(X(0.84), Y(0.72), b.h * 0.05, 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	if (input.kind === 'rect') {
		ctx.fillStyle = input.color ?? '#fff';
		ctx.fillRect(b.x + b.w * input.x, b.y + b.h * input.y, b.w * input.w, b.h * input.h);
		return;
	}
	const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
	g.addColorStop(0, '#1a2a6c');
	g.addColorStop(0.5, '#b21f1f');
	g.addColorStop(1, '#fdbb2d');
	ctx.fillStyle = g;
	ctx.fillRect(b.x + b.w * 0.1, b.y + b.h * 0.1, b.w * 0.8, b.h * 0.8);
}

function base64(bytes: Uint8ClampedArray): string {
	let s = '';
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step)
		s += String.fromCharCode(...(bytes.subarray(i, i + step) as unknown as number[]));
	return btoa(s);
}

function render(req: LookRequest): LookResult {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = TITLE_LOOK_EFFECT as EffectSpec;
	let n = 0;
	const stored = appearanceFromRecipe(
		req.recipe,
		() => `apl_${String(++n).padStart(16, '0')}`,
		req.seed ?? 7,
	);
	const appearance = resolveAppearance(stored, 0);
	const unitPx =
		req.unitPx !== undefined ? req.unitPx : req.input.kind === 'text' ? (req.input.size ?? 96) : null;
	const titleLook = { appearance, source: stored, unitPx, contentSeconds: req.contentSeconds ?? 0 };
	const pxScale = req.pxScale ?? 1;
	const base = {
		width: req.box.width,
		height: req.box.height,
		pxScale: 1,
		fps: 30,
		structures: { titleLook },
	};
	const pad = spec.gpu!.padding!({}, base) as Partial<FxPadding>;
	const extra = req.pad ?? 0;
	const padding: FxPadding = {
		left: (pad.left ?? 0) + extra,
		top: (pad.top ?? 0) + extra,
		right: (pad.right ?? 0) + extra,
		bottom: (pad.bottom ?? 0) + extra,
	};
	const layout = fxCanvasLayout(req.box, padding, 8192, pxScale);
	const seconds = req.contentSeconds ?? 0;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params: {} },
		{
			...base,
			pxScale: layout.pxScale,
			frame: Math.round(seconds * 30),
			duration: 150,
			seed: 0.25,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = document.createElement('canvas');
	input.width = layout.width;
	input.height = layout.height;
	paintInput(input.getContext('2d')!, req.input, layout.box, layout.pxScale);
	const out = document.createElement('canvas');
	out.width = layout.width;
	out.height = layout.height;
	const ctx = out.getContext('2d', { willReadFrequently: true })!;
	// The harness measures a warm draw: the first run of a program includes its compile.
	const gl = h.gl;
	const realDraw = gl.drawArrays;
	const passMs: number[] = [];
	if (req.perPass) {
		let tp = performance.now();
		gl.drawArrays = (...a: Parameters<typeof realDraw>) => {
			realDraw.apply(gl, a);
			const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
			const fmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
			const buf =
				type === gl.UNSIGNED_BYTE
					? new Uint8Array(4)
					: type === gl.FLOAT
						? new Float32Array(4)
						: new Uint16Array(4);
			gl.readPixels(0, 0, 1, 1, fmt, type, buf);
			const now = performance.now();
			passMs.push(now - tp);
			tp = now;
		};
	}
	const t0 = performance.now();
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
					frame: 0,
					fps: 30,
					duration: 150,
					compSize: { width: 1920, height: 1080 },
				}),
				{ name: 'u_seed', type: 'float', value: [0.25] },
			],
			textures: {},
			samples: { sources: [], offsets: [] },
		},
		ctx,
	);
	if (req.perPass) (gl as { drawArrays: unknown }).drawArrays = realDraw;
	// `finish` does not wait on ANGLE: a read-back is the sync point. Without it the work lands in the next call.
	h.gl.readPixels(0, 0, 1, 1, h.gl.RGBA, h.gl.UNSIGNED_BYTE, new Uint8Array(4));
	const ms = performance.now() - t0;
	const data = ctx.getImageData(0, 0, out.width, out.height).data;
	const totalMs = performance.now() - t0;
	if (req.timingOnly)
		return {
			width: out.width,
			height: out.height,
			rgba: '',
			padding,
			passes: plan.passes.length,
			box: layout.box,
			ms,
			totalMs,
			...(req.perPass
				? {
						passLog: plan.passes.map(
							(p, i) =>
								`${(p.output ?? 'out').padEnd(8)} ${p.width}×${p.height} ${(passMs[i] ?? 0).toFixed(0)} ms`,
						),
					}
				: {}),
		};
	return {
		width: out.width,
		height: out.height,
		rgba: base64(data),
		padding,
		passes: plan.passes.length,
		box: layout.box,
		ms,
		totalMs,
	};
}

export type EffectRequest = {
	effectId: string;
	params?: EffectParams;
	/** Layer box in layer px. */
	box: { width: number; height: number };
	/** Clip-local frame, at 30 fps. */
	frame: number;
	/** `patternOrigin.frame`: where this part of a razor cut started in the uncut clip (TL-121). */
	frameOffset?: number;
	seed?: number;
	pxScale?: number;
	/** What the effect draws over. */
	input?: LookInput;
};

/** One standalone generator effect through the real planner and host, as the Player and Remotion run it. */
function renderEffect(req: EffectRequest): LookResult {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const spec = defaultEffectRegistry.get(req.effectId) as EffectSpec | undefined;
	if (!spec?.gpu) throw new Error(`no gpu effect ${req.effectId}`);
	const params: EffectParams = { ...Object.fromEntries(spec.params.map((p) => [p.name, p.default])), ...req.params };
	const layout = fxCanvasLayout(req.box, { left: 0, top: 0, right: 0, bottom: 0 }, 8192, req.pxScale ?? 1);
	const offset = req.frameOffset ?? 0;
	const seed = req.seed ?? 0.25;
	const plan = planGpuEffect(
		spec,
		{ id: 'fx1', params },
		{
			width: req.box.width,
			height: req.box.height,
			pxScale: layout.pxScale,
			fps: 30,
			frame: req.frame,
			patternFrame: req.frame + offset,
			duration: 300,
			seed,
			progress: 0,
		},
		{ width: layout.width, height: layout.height },
	);
	const input = document.createElement('canvas');
	input.width = layout.width;
	input.height = layout.height;
	if (req.input) paintInput(input.getContext('2d')!, req.input, layout.box, layout.pxScale);
	const out = document.createElement('canvas');
	out.width = layout.width;
	out.height = layout.height;
	const ctx = out.getContext('2d', { willReadFrequently: true })!;
	const t0 = performance.now();
	runShaderPlan(
		h,
		plan,
		input,
		{
			builtins: [
				...fxOffsetBuiltins(
					fxBuiltinUniforms({
						canvas: layout,
						box: layout.box,
						pxScale: layout.pxScale,
						frame: req.frame,
						fps: 30,
						duration: 300,
						compSize: { width: 1920, height: 1080 },
					}),
					offset,
				),
				{ name: 'u_seed', type: 'float', value: [seed] },
			],
			textures: {},
			samples: { sources: [], offsets: [] },
		},
		ctx,
	);
	h.gl.readPixels(0, 0, 1, 1, h.gl.RGBA, h.gl.UNSIGNED_BYTE, new Uint8Array(4));
	const ms = performance.now() - t0;
	const data = ctx.getImageData(0, 0, out.width, out.height).data;
	return {
		width: out.width,
		height: out.height,
		rgba: base64(data),
		padding: { left: 0, top: 0, right: 0, bottom: 0 },
		passes: plan.passes.length,
		box: layout.box,
		ms,
		totalMs: performance.now() - t0,
	};
}

(window as unknown as { __tl: unknown }).__tl = {
	render,
	renderEffect,
	reach: (recipe: LookRecipe) => {
		let n = 0;
		return appearanceClipReach(appearanceFromRecipe(recipe, () => `apl_${String(++n).padStart(16, '0')}`));
	},
	float: () => !!fxHost()?.floatTargets,
	/** Pretends this GPU has no float targets (TL-032); returns what `render` then throws. */
	withoutFloat: (req: LookRequest) => {
		const h = fxHost()!;
		const was = h.floatTargets;
		h.floatTargets = false;
		try {
			render(req);
			return null;
		} catch (e) {
			return (e as Error).message;
		} finally {
			h.floatTargets = was;
		}
	},
	renderer: () => {
		const h = fxHost();
		if (!h) return null;
		const dbg = h.gl.getExtension('WEBGL_debug_renderer_info');
		return String(h.gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : h.gl.RENDERER));
	},
};
