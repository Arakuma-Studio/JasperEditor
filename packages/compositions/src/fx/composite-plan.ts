// The GL blend compositor's planning (keyframes-blend), pure: which layers a track's blend scope composites at a
// frame and the shader plan that does it. CSS `mix-blend-mode` draws most W3C blend modes exactly; the other clip blend
// modes (Dissolve, Color Burn / Dodge, Linear Burn, Darker / Lighter Color, Linear Dodge (Add), Vivid / Linear / Pin
// Light, Hard Mix, Subtract, Divide, Saturation, the utility modes) need the pixels below them, which the DOM cannot
// give a layer. So a track holding such a layer ("GL item": a clip, or a GPU transition span whose sides share the
// mode) wraps everything below it (background, lower tracks, adjustment scopes, its own transition mattes) in a BLEND
// SCOPE: the composite below is captured (HTML-in-Canvas, like an adjustment layer's scope) and, at frames where a
// GL item of the track is drawn, every layer the track draws at that frame captures its picture (the transition
// framework's tap; GPU transition spans deliver their stage output) and is composited onto the captured backdrop,
// in drawing order, with its mode (`fx_layerBlend` = `blendPixel`, the native export kernel's formulas).
import {
	blendModeIndex,
	dissolveSeed,
	type FxEffectPlan,
	type FxUniform,
	GLSL_BLEND,
	isCssBlend,
	planPasses,
	planPassesKey,
	type RGBA,
	type ShaderPass,
} from '@jasper/project';

export type CompositeTrackInput = {
	trackId: string;
	clips: readonly {
		clipId: string;
		start: number;
		duration: number;
		headHandle?: number;
		tailHandle?: number;
		blendMode: string;
	}[];
	/** GPU transitions drawn as stages (their sides are captured by the stage, not by the compositor). */
	stages: readonly { id: string; start: number; duration: number; blendMode: string }[];
};

export type CompositeItem =
	| { kind: 'matte'; key: string; color: RGBA }
	| {
			kind: 'clip' | 'stage';
			/** Hub key: the clip id, or `transition:<id>`. */
			key: string;
			mode: string;
			/** Dissolve seed of this frame (`dissolveSeed(key, local frame)`). */
			seed: number;
	  };

const drawnAt = (c: CompositeTrackInput['clips'][number], f: number) =>
	f >= c.start - (c.headHandle ?? 0) && f < c.start + c.duration + (c.tailHandle ?? 0);
const spanAt = (s: { start: number; duration: number }, f: number) =>
	f >= s.start && f < s.start + s.duration;

/** Whether a track holds a GL item at all (its tracks below are then wrapped in a blend scope). */
export function trackHasGlBlend(t: CompositeTrackInput): boolean {
	return t.clips.some((c) => !isCssBlend(c.blendMode)) || t.stages.some((s) => !isCssBlend(s.blendMode));
}

/**
 * The layers a track's blend scope composites at sequence frame `f` (drawing order: clips, then transition stages),
 * or null when no GL item of the track is drawn there (the scope then passes the backdrop through and the track draws
 * the CSS way). `isGpuSide(clipId, f)`: the clip is a side of a GPU transition at `f` (its picture belongs to the
 * transition stage).
 */
export function compositeItemsAt(
	t: CompositeTrackInput,
	f: number,
	isGpuSide: (clipId: string, f: number) => boolean,
): CompositeItem[] | null {
	const items: CompositeItem[] = [];
	let gl = false;
	for (const c of t.clips) {
		if (!drawnAt(c, f) || isGpuSide(c.clipId, f)) continue;
		gl ||= !isCssBlend(c.blendMode);
		items.push({ kind: 'clip', key: c.clipId, mode: c.blendMode, seed: dissolveSeed(c.clipId, f - c.start) });
	}
	for (const st of t.stages) {
		if (!spanAt(st, f)) continue;
		gl ||= !isCssBlend(st.blendMode);
		const key = `transition:${st.id}`;
		items.push({ kind: 'stage', key, mode: st.blendMode, seed: dissolveSeed(key, f - st.start) });
	}
	return gl ? items : null;
}

/** A delivered picture and its placement (comp px → picture px, projective; opacity 0..1). */
export type CompositePicture = {
	width: number;
	height: number;
	compToCanvas: readonly number[];
	opacity: number;
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The shader plan compositing `items` (bottom → top) onto the backdrop (`u_source`, the captured composite below) or,
 * with `backdrop: false`, onto transparency: one pass per item, ping-ponging the
 * accumulated picture (`u_acc`, premultiplied RGBA8 like an 8-bit pipeline: `storePremul8`), the last one into the
 * stage canvas. A member without a
 * picture yet is left out (it draws nothing until it delivers). Texture inputs: `u_l<i>` (see `textures`).
 */
export function planComposite(
	items: readonly CompositeItem[],
	pictures: ReadonlyMap<string, CompositePicture>,
	comp: { width: number; height: number },
	opts: {
		backdrop?: boolean;
		/** Canvas px of sequence px (0, 0) and canvas px per sequence px (Dissolve hashes sequence pixels). */
		noise?: { x: number; y: number; scale: number };
	} = {},
): { plan: FxEffectPlan; textures: { uniform: string; key: string }[]; builtins: FxUniform[] } {
	const backdrop = opts.backdrop ?? true;
	const drawn = items.filter((it) => it.kind === 'matte' || pictures.has(it.key));
	const textures: { uniform: string; key: string }[] = [];
	const passes: ShaderPass[] = drawn.map((it, i): ShaderPass => {
		const first = i === 0;
		const dst = !first ? 'texture(u_acc, v_uv)' : backdrop ? 'texture(u_source, v_uv)' : 'vec4(0.0)';
		// The stack is stored premultiplied in RGBA8 between layers (= `storePremul8`, which the native kernel applies).
		const common = { output: 'acc', filter: 'nearest' as const, ...(first ? {} : { update: true }) };
		if (it.kind === 'matte') {
			const [r, g, b, a] = it.color;
			return {
				...common,
				include: [GLSL_BLEND],
				frag: /* glsl */ `
void main() {
  fragColor = fx_clampPremul(fx_layerBlend(FX_LAYER_NORMAL, ${dst}, vec4(u_matte.rgb * u_matte.a, u_matte.a), 0.0));
}`,
				uniforms: { u_matte: [r, g, b, a] },
			};
		}
		const pic = pictures.get(it.key)!;
		const name = `u_l${textures.length}`;
		textures.push({ uniform: name, key: it.key });
		const m = pic.compToCanvas.length >= 9 ? pic.compToCanvas : IDENTITY;
		return {
			...common,
			include: [GLSL_BLEND],
			frag: /* glsl */ `
void main() {
  vec4 dst = ${dst};
  // Placement (as the transition framework places its sides): comp px → picture px, edge coverage, × opacity.
  vec3 q = u_place * vec3(v_uv * u_compSize, 1.0);
  float w = abs(q.z) < 1e-6 ? 1e-6 : q.z;
  vec2 c = q.xy / w;
  vec2 fw = max(fwidth(c), vec2(1e-4));
  vec2 e = min(c, u_placeSize - c) / fw;
  bool live = q.z > 1e-6 && u_placeSize.x > 0.0 && u_placeSize.y > 0.0;
  float cov = live ? clamp(min(e.x, e.y) + 0.5, 0.0, 1.0) : 0.0;
  // A pixel-aligned layer samples texel centres exactly (float error in the map must not mix in a neighbour: modes
  // like Divide amplify a 1e-4 blend of a neighbour into a full code value).
  vec2 snap = floor(c) + 0.5;
  vec2 cc = mix(c, snap, step(abs(c - snap), vec2(1e-3)));
  vec4 src = texture(${name}, cc / max(u_placeSize, vec2(1.0))) * (cov * clamp(u_placeOpacity, 0.0, 1.0));
  uvec2 px = uvec2(max(floor((v_uv * u_compSize - u_noiseXform.xy) / u_noiseXform.z), vec2(0.0)));
  fragColor = fx_clampPremul(fx_layerBlend(u_mode, dst, src, fx_blendNoise(px, uint(u_dissolveSeed))));
}`,
			uniforms: {
				// GLSL mat3 is column-major; ours is row-major.
				u_place: { mat3: [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!] },
				u_placeSize: [pic.width, pic.height],
				u_placeOpacity: Math.min(1, Math.max(0, pic.opacity)),
				u_mode: { int: blendModeIndex(it.mode) },
				u_dissolveSeed: { int: it.seed },
				u_noiseXform: [opts.noise?.x ?? 0, opts.noise?.y ?? 0, opts.noise?.scale ?? 1],
			},
		};
	});
	if (passes.length === 0)
		passes.push({
			include: [GLSL_BLEND],
			frag: backdrop
				? 'void main() { fragColor = texture(u_source, v_uv); }'
				: 'void main() { fragColor = vec4(0.0); }',
		});
	const canvas = { width: comp.width, height: comp.height };
	const planned = planPasses(passes, { paramDecls: [], textures: textures.map((t) => t.uniform), canvas });
	const plan: FxEffectPlan = {
		fxId: 'jasper.composite',
		effectId: 'jasper.composite',
		canvas,
		passes: planned,
		uniforms: [],
		textures: textures.map((t) => ({ param: t.key, uniform: t.uniform, mediaId: '' })),
		key: `composite:${canvas.width}x${canvas.height}:${planPassesKey(planned)}`,
	};
	const builtins: FxUniform[] = [
		{ name: 'u_compSize', type: 'vec2', value: [comp.width, comp.height] },
		{ name: 'u_canvasSize', type: 'vec2', value: [comp.width, comp.height] },
		{ name: 'u_box', type: 'vec4', value: [0, 0, comp.width, comp.height] },
		{ name: 'u_pxScale', type: 'float', value: [1] },
	];
	return { plan, textures, builtins };
}
