import {
	applyTransaction,
	bakeLut,
	buildRenderSnapshot,
	clipContentTime,
	createCounterIdSource,
	createEmptyProject,
	defaultEffectRegistry,
	defaultRegistries,
	defineShaderEffect,
	type EffectParams,
	type EffectSpec,
	FX_FAMILIES,
	fxBuiltinUniforms,
	fxParam,
	GLSL_LUT,
	lutParam,
	planGpuEffect,
	resolveLayerProps,
} from '@jasper/project';
import { meanGrid } from '@jasper/testkit/image';
import { TRANSFORM } from '../../../project/src/registry/fx/premiere-adjust-color-keying/transform.ts';
import { chainGpuStandIn } from '../../src/fx/builtins.ts';
import { FxShaderError, fxHost, runLutPass, runShaderPlan } from '../../src/fx/host.ts';
import { fxLowered, loweredCanvasProgram } from '../../src/fx/lowered.ts';
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

/**
 * The golden test card painted into a layer box (golden-fuzz fingerprints): a horizontal colour ramp, dark and light
 * bars, a bright disc and a transparent corner — edges, gradients, highlights and alpha for every kind of effect.
 */
function testCard(ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }): void {
	const g = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
	g.addColorStop(0, '#1a2a6c');
	g.addColorStop(0.5, '#b21f1f');
	g.addColorStop(1, '#fdbb2d');
	ctx.fillStyle = g;
	ctx.fillRect(b.x, b.y, b.w, b.h);
	ctx.fillStyle = '#000';
	ctx.fillRect(b.x + b.w * 0.15, b.y, b.w * 0.08, b.h);
	ctx.fillStyle = '#fff';
	ctx.fillRect(b.x + b.w * 0.7, b.y, b.w * 0.06, b.h);
	ctx.beginPath();
	ctx.arc(b.x + b.w * 0.45, b.y + b.h * 0.5, b.h * 0.25, 0, Math.PI * 2);
	ctx.fill();
	ctx.clearRect(b.x, b.y, b.w * 0.12, b.h * 0.25);
}

/**
 * Every parameter moved off its default in a deterministic way (numbers to 70 % of their soft / hard range, the
 * next enum option, booleans flipped, colours and points set): the second fingerprint of each effect, so effects that
 * are an identity at their defaults are covered too, and parameter wiring is exercised.
 */
function perturbed(spec: EffectSpec): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of spec.params) {
		const d = p.default as unknown;
		if (p.type === 'number' && typeof d === 'number') {
			// A third of the way towards the soft maximum (else the hard one), at most ±max(|default|, 1) without a
			// soft range: visible, but never the extreme sizes that exhaust a software GPU.
			const hi = p.range?.softMax ?? p.range?.max;
			const lo = p.range?.softMin ?? p.range?.min;
			const toward =
				hi !== undefined && hi > d ? hi : lo !== undefined && lo < d ? lo : d + Math.max(Math.abs(d), 1);
			let v = d + (toward - d) / 3;
			if (p.range?.softMax === undefined)
				v = d + Math.sign(v - d) * Math.min(Math.abs(v - d), Math.max(Math.abs(d), 1));
			out[p.name] = p.range?.step === 1 || Number.isInteger(p.range?.step) ? Math.round(v) : v;
		} else if (p.type === 'boolean') out[p.name] = !d;
		else if (p.type === 'enum' && p.options?.length)
			out[p.name] = p.options[(p.options.indexOf(d as string) + 1) % p.options.length];
		else if (p.type === 'color') out[p.name] = [0.9, 0.25, 0.45, 1];
		else if (p.type === 'vec2' && Array.isArray(d)) out[p.name] = (d as number[]).map((v) => v * 0.8 + 0.1);
		else out[p.name] = d;
	}
	return out;
}

/** 4×4 mean-RGB grid of a whole canvas (the testkit fingerprint). */
function fingerprintOf(c: HTMLCanvasElement): number[] {
	const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
	return meanGrid({ width: c.width, height: c.height, data: new Uint8Array(d.buffer) }, 4);
}

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
		paramsAt?: (f: number) => EffectParams;
		samplesKey?: string;
		samplesValid?: number;
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
			...(extra.paramsAt ? { paramsAt: extra.paramsAt } : {}),
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
			samples: {
				sources: extra.samples ?? [],
				offsets: extra.offsets ?? [],
				...(extra.samplesKey ? { key: extra.samplesKey } : {}),
				...(extra.samplesValid !== undefined ? { valid: extra.samplesValid } : {}),
			},
		},
		out.getContext('2d')!,
	);
	return { out, layout, plan };
}

const halves = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => {
	ctx.fillStyle = 'rgb(255, 0, 0)';
	ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	ctx.fillStyle = 'rgb(0, 0, 255)';
	ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
};
const fx1 = (frag: string, extra: Partial<Parameters<typeof defineShaderEffect>[0]> = {}) =>
	defineShaderEffect({
		id: 'test.followup',
		label: 'Follow-up',
		category: 'Utility',
		params: [],
		gpu: { passes: [{ frag }] },
		...extra,
	});

const identity = defineShaderEffect({
	id: 'test.identity',
	label: 'Identity',
	category: 'Utility',
	params: [],
	gpu: { passes: [{ frag: 'void main() { fragColor = texture(u_source, v_uv); }' }] },
});

const api = {
	async templatePreview() {
		return (await import('./template-preview.tsx')).templatePreviewGeometry();
	},

	/** Observe the lowered Canvas 2D renderer's pixels, without depending on its tap encoding. */
	async lowered() {
		const ids = createCounterIdSource(1);
		const context = { ids, now: () => 't', revision: 0, registries: defaultRegistries() };
		const result = applyTransaction(
			createEmptyProject({ ids, name: 'Lowered', preset: 'hd-1080p-30' }),
			{
				label: 'setup',
				origin: 'user',
				commands: [
					{
						type: 'clip.addText',
						at: 0,
						duration: 30,
						track: 'V1',
						ref: '$t',
						content: {
							text: 'Paint',
							style: { shadow: { color: [0, 0, 1, 1], angleDeg: 0, distancePx: 12, blurPx: 0 } },
						},
						box: { width: 64, height: 36, autoSize: 'none' },
					},
					{
						type: 'effect.add',
						target: { clipId: '$t' },
						effectId: 'jasper.transform',
						ref: '$fx',
						params: { position: [0.75, 0.5], useCompShutterAngle: false, shutterAngle: 360 },
					},
					{
						type: 'keyframe.add',
						target: ['effect', '$fx', 'position'],
						at: { sequenceFrame: 0 },
						value: [0.25, 0.5],
					},
					{
						type: 'keyframe.add',
						target: ['effect', '$fx', 'position'],
						at: { sequenceFrame: 1 },
						value: [0.75, 0.5],
					},
				],
			},
			context,
		);
		if (!result.result.ok) throw new Error(JSON.stringify(result.result.errors));
		const snap = buildRenderSnapshot(result.document, Object.keys(result.document.sequences)[0]!, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const clip = snap.videoTracks[0]!.clips[0]!;
		const transformed = applyTransaction(
			result.document,
			{
				label: 'nonuniform scale and rotation',
				origin: 'user',
				commands: [
					{ type: 'param.set', target: ['effect', result.result.refs.$fx!, 'uniformScale'], value: false },
					{ type: 'param.set', target: ['effect', result.result.refs.$fx!, 'scaleWidth'], value: 50 },
					{ type: 'param.set', target: ['effect', result.result.refs.$fx!, 'scaleHeight'], value: 200 },
					{ type: 'param.set', target: ['effect', result.result.refs.$fx!, 'rotation'], value: 90 },
				],
			},
			context,
		);
		if (!transformed.result.ok) throw new Error(JSON.stringify(transformed.result.errors));
		const transformedClip = buildRenderSnapshot(
			transformed.document,
			Object.keys(transformed.document.sequences)[0]!,
			{ resolveMedia: () => null, resolveFont: () => null },
		).videoTracks[0]!.clips[0]!;
		const samples = [];
		const transformedSamples = [];
		let blurred: Px | null = null;
		for (const scale of [1, 0.5]) {
			const width = 128 * scale;
			const height = 100 * scale;
			const props = resolveLayerProps(clip, clipContentTime(clip, 15, { num: 30, den: 1 }));
			const program = loweredCanvasProgram({
				clip,
				props,
				frame: 15,
				fps: 30,
				layout: { padding: { left: 32, top: 32 }, pxScale: scale, width, height },
			});
			if (!program) throw new Error('the text transform was not lowered');
			const source = canvas(width, height, (ctx) => {
				ctx.scale(scale, scale);
				ctx.fillStyle = '#f00';
				ctx.fillRect(32, 32, 64, 36);
				// A painted shadow outside the text box must travel with the text.
				ctx.fillStyle = '#00f';
				ctx.fillRect(98, 40, 8, 8);
			});
			const target = canvas(width, height);
			const effect = fxLowered(program);
			await effect.definition.apply({ source, target, params: effect.params, width, height } as never);
			samples.push({
				empty: px(target, 36 * scale, 50 * scale),
				text: px(target, 52 * scale, 50 * scale),
				shadow: px(target, 116 * scale, 44 * scale),
			});
			if (scale === 1) {
				const moving = loweredCanvasProgram({
					clip,
					props: resolveLayerProps(clip, clipContentTime(clip, 0.5, { num: 30, den: 1 })),
					frame: 0.5,
					fps: 30,
					layout: { padding: { left: 32, top: 32 }, pxScale: 1, width, height },
				})!;
				const blur = fxLowered(moving);
				await blur.definition.apply({ source, target, params: blur.params, width, height } as never);
				blurred = px(target, 32, 50);
			}
			const transformedSource = canvas(width, height, (ctx) => {
				ctx.scale(scale, scale);
				ctx.fillStyle = '#f00';
				ctx.fillRect(30, 20, 64, 36);
				ctx.fillStyle = '#00f';
				ctx.fillRect(96, 28, 8, 8);
			});
			const transformedProgram = loweredCanvasProgram({
				clip: transformedClip,
				props: resolveLayerProps(transformedClip, clipContentTime(transformedClip, 15, { num: 30, den: 1 })),
				frame: 15,
				fps: 30,
				layout: { padding: { left: 30, top: 20 }, pxScale: scale, width, height },
			})!;
			const transformedEffect = fxLowered(transformedProgram);
			await transformedEffect.definition.apply({
				source: transformedSource,
				target,
				params: transformedEffect.params,
				width,
				height,
			} as never);
			// Anchor (32,18), position (48,18), scale (0.5,2), clockwise 90°:
			// layer (x,y) → canvas (114−2y,22+0.5x), before preview scaling.
			// Thus red source (36,32) lands at (50,40); blue (70,12) at (90,57).
			transformedSamples.push({
				empty: px(target, 116 * scale, 40 * scale),
				text: px(target, 50 * scale, 40 * scale),
				shadow: px(target, 90 * scale, 57 * scale),
			});
		}
		return { samples, transformedSamples, blurred };
	},

	/**
	 * Fingerprints (4×4 mean RGB) of one GPU effect at defaults and perturbed settings on the golden test card, frame 12:
	 * compared with goldens/fx-fingerprints.json by fx-gl.test.ts (JASPER_BLESS=1 re-blesses). Rendering failures propagate and fail the golden comparison.
	 */
	fingerprints({ family, id }: { family?: string; id: string }) {
		const familySpecs = FX_FAMILIES.find((f) => f.file === family)?.effects;
		const inFamily = new Set(FX_FAMILIES.flatMap((f) => f.effects.map((e) => e.id)));
		const specs = familySpecs
			? familySpecs.filter((s) => s.gpu)
			: [...defaultEffectRegistry.list().filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_FX];
		const spec = specs.find((s) => s.id === id);
		if (!spec) throw new Error(`unknown GPU effect ${id}`);
		const out: Record<string, number[]> = {};
		out[spec.id] = fingerprintOf(
			run(spec, defaults(spec), { width: 64, height: 36 }, testCard, { frame: 12 }).out,
		);
		try {
			out[`${spec.id}@perturbed`] = fingerprintOf(
				run(spec, perturbed(spec), { width: 64, height: 36 }, testCard, { frame: 12 }).out,
			);
			if (fxHost()?.gl.isContextLost()) throw new Error('the WebGL context was lost');
		} catch (e) {
			// Failing at other settings is a bug: recorded as NaNs, which no golden accepts.
			out[`${spec.id}@perturbed`] = new Array(48).fill(Number.NaN);
			console.error(`${spec.id} @perturbed: ${(e as Error).message}`);
		}
		return out;
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
		const { out, layout } = run(
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
			centre: px(out, b.x + 10, b.y + 10),
			nearOutside: px(out, b.x - 2, b.y + 10),
			farCorner: px(out, 0, 0),
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

const followups = {
	pingPong() {
		const iter = {
			output: 'acc',
			update: true,
			frag: 'void main() { fragColor = texture(u_acc, v_uv) + vec4(0.1); }',
		};
		const spec = fx1('', {
			gpu: {
				passes: [
					{ output: 'acc', format: 'rgba16f', frag: 'void main() { fragColor = vec4(0.1); }' },
					iter,
					iter,
					iter,
					{ frag: 'void main() { fragColor = texture(u_acc, v_uv); }' },
				],
			},
		});
		return px(run(spec, {}, { width: 4, height: 4 }, () => {}).out, 1, 1);
	},
	absoluteSize() {
		const spec = fx1('', {
			gpu: {
				passes: [
					{
						output: 'one',
						size: { width: 1, height: 1 },
						frag: 'void main() { fragColor = texture(u_source, vec2(0.25, 0.5)); }',
					},
					{ frag: 'void main() { fragColor = texture(u_one, v_uv); }' },
				],
			},
		});
		const { out } = run(spec, {}, { width: 8, height: 4 }, halves);
		return {
			left: px(out, 1, 1),
			right: px(out, 6, 1),
		};
	},
	mipmaps() {
		const out = run(
			fx1('', {
				gpu: {
					passes: [
						{ output: 'm', mipmaps: true, frag: 'void main() { fragColor = texture(u_source, v_uv); }' },
						{ frag: 'void main() { fragColor = textureLod(u_m, v_uv, 10.0); }' },
					],
				},
			}),
			{},
			{ width: 16, height: 16 },
			halves,
		).out;
		const src = run(
			fx1('void main() { fragColor = textureLod(u_source, v_uv, 10.0); }', {
				gpu: {
					sourceMipmaps: true,
					passes: [{ frag: 'void main() { fragColor = textureLod(u_source, v_uv, 10.0); }' }],
				},
			}),
			{},
			{ width: 16, height: 16 },
			halves,
		).out;
		return { output: px(out, 2, 2), source: px(src, 2, 2) };
	},
	ivec2() {
		const spec = fx1('', {
			gpu: {
				uniforms: () => ({ u_iv: { ivec2: [51, 102] } }),
				passes: [
					{
						frag: 'void main() { fragColor = vec4(float(u_iv.x) / 255.0, float(u_iv.y) / 255.0, 0.0, 1.0); }',
					},
				],
			},
		});
		return px(run(spec, {}, { width: 2, height: 2 }, () => {}).out, 0, 0);
	},
	lut3d() {
		const spec = fx1('', {
			params: [lutParam('look', 'Look')],
			gpu: {
				passes: [
					{
						include: [GLSL_LUT],
						frag: 'void main() { vec4 c = texture(u_source, v_uv); fragColor = vec4(fx_lut3d(u_look, u_look_size, c.rgb), 1.0); }',
					},
				],
			},
		});
		const invert = bakeLut(17, (c) => {
			c[0] = 1 - c[0];
			c[1] = 1 - c[1];
			c[2] = 1 - c[2];
		});
		const paint = (ctx: CanvasRenderingContext2D) => {
			ctx.fillStyle = 'rgb(255, 64, 0)';
			ctx.fillRect(0, 0, 4, 4);
		};
		const bound = run(spec, { look: { mediaId: 'l1' } }, { width: 4, height: 4 }, paint, {
			textures: { u_look: { lut: invert, version: 'inv' } },
		}).out;
		const none = run(spec, { look: { mediaId: '' } }, { width: 4, height: 4 }, paint, {
			textures: { u_look: null },
		}).out;
		return { bound: px(bound, 1, 1), none: px(none, 1, 1) };
	},
	/** u_sampleCount / u_sampleValid in a pass that never samples (the sampler array is not active there). */
	sampleBindings() {
		const spec = fx1(
			'void main() { fragColor = vec4(float(u_sampleCount) / 8.0, float(u_sampleValid) / 255.0, u_sampleOffsets[1] / -8.0, 1.0); }',
		);
		const pic = canvas(4, 4);
		return px(
			run(spec, {}, { width: 4, height: 4 }, () => {}, {
				samples: [pic, pic],
				offsets: [-1, -4],
				samplesValid: 1,
			}).out,
			1,
			1,
		);
	},
	/** The SVG-only Gaussian Blur (one direction) as the chain's GPU stand-in. */
	blurStandIn() {
		const builtin = defaultEffectRegistry.get('jasper.gaussian-blur')!;
		const params = { radius: 3, dimensions: 'vertical', repeatEdge: false };
		const spec = chainGpuStandIn(builtin, params)!;
		const { out, layout } = run(spec, params, { width: 21, height: 21 }, (ctx, b) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x, b.y + 10, b.w, 1);
		});
		const b = layout.box;
		return {
			onLine: px(out, b.x + 10, b.y + 10),
			above: px(out, b.x + 10, b.y + 8),
		};
	},
	/** Transform with a Shutter Angle and a moving position (paramsAt): the edge is smeared. */
	transformBlur() {
		const d = Object.fromEntries(TRANSFORM.params.map((p) => [p.name, p.default])) as EffectParams;
		const p = { ...d, useCompShutterAngle: false, shutterAngle: 360 };
		const at = (f: number) => ({ ...p, position: [0.5 + (f - 5) * 0.25, 0.5] as [number, number] });
		const paint = (ctx: CanvasRenderingContext2D) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, 20, 20);
		};
		const sharp = run(TRANSFORM, d, { width: 20, height: 20 }, paint, { frame: 5 }).out;
		const blurred = run(TRANSFORM, at(5), { width: 20, height: 20 }, paint, { frame: 5, paramsAt: at }).out;
		return { sharpEdge: px(sharp, 1, 10), blurredEdge: px(blurred, 1, 10), blurredMid: px(blurred, 10, 10) };
	},
};

(window as unknown as { __fx: typeof api }).__fx = { ...api, ...followups };
