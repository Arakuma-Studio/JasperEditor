// The GL layer compositor's planning (keyframes-blend), pure: which layers it composites at a frame and the shader
// plan that does it. CSS `mix-blend-mode` draws the W3C blend modes exactly; the other clip blend modes (Dissolve,
// Linear Burn, Darker / Lighter Color, Linear Dodge (Add), Vivid / Linear / Pin Light, Hard Mix, Subtract, Divide,
// Stencil / Silhouette, Alpha Add) need the pixels below them, which the DOM cannot give a layer. So at a frame where
// such a layer ("GL item": a clip, or a GPU transition span whose sides share the mode) is drawn, everything from the
// bottom track up to the highest track holding one becomes the compositor's GROUP: each member captures its picture
// (the transition framework's tap; transition spans deliver their stage output) and one sequence-sized shader stage
// composites them bottom → top onto transparency with each member's mode (`fx_layerBlend` = `blendPixel`), drawn in
// place of the group. Tracks above it draw as usual (CSS modes blend against the stage's canvas).
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
	mattes: readonly { id: string; start: number; duration: number; color: RGBA }[];
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

export type CompositeGroup = {
	/** Index of the highest track of the group (the stage is drawn in that track, after its items). */
	trackIndex: number;
	items: CompositeItem[];
};

const drawnAt = (c: CompositeTrackInput['clips'][number], f: number) =>
	f >= c.start - (c.headHandle ?? 0) && f < c.start + c.duration + (c.tailHandle ?? 0);
const spanAt = (s: { start: number; duration: number }, f: number) =>
	f >= s.start && f < s.start + s.duration;

/**
 * The compositor's group at sequence frame `f`, or null when no GL item is drawn there. `isGpuSide(clipId, f)`:
 * the clip is a side of a GPU transition at `f` (its picture belongs to the transition stage).
 */
export function compositeGroupAt(
	tracks: readonly CompositeTrackInput[],
	f: number,
	isGpuSide: (clipId: string, f: number) => boolean,
): CompositeGroup | null {
	let top = -1;
	tracks.forEach((t, i) => {
		const clipGl = t.clips.some((c) => !isCssBlend(c.blendMode) && drawnAt(c, f) && !isGpuSide(c.clipId, f));
		const stageGl = t.stages.some((s) => !isCssBlend(s.blendMode) && spanAt(s, f));
		if (clipGl || stageGl) top = i;
	});
	if (top < 0) return null;
	const items: CompositeItem[] = [];
	for (let i = 0; i <= top; i++) {
		const t = tracks[i]!;
		for (const m of t.mattes)
			if (spanAt(m, f)) items.push({ kind: 'matte', key: `matte:${m.id}`, color: m.color });
		for (const c of t.clips) {
			if (!drawnAt(c, f) || isGpuSide(c.clipId, f)) continue;
			items.push({
				kind: 'clip',
				key: c.clipId,
				mode: c.blendMode,
				seed: dissolveSeed(c.clipId, f - c.start),
			});
		}
		for (const s of t.stages) {
			if (!spanAt(s, f)) continue;
			const key = `transition:${s.id}`;
			items.push({ kind: 'stage', key, mode: s.blendMode, seed: dissolveSeed(key, f - s.start) });
		}
	}
	return { trackIndex: top, items };
}

/** Whether a document has any GL item at all (else the compositor is never mounted). */
export function hasGlBlend(tracks: readonly CompositeTrackInput[]): boolean {
	return tracks.some(
		(t) => t.clips.some((c) => !isCssBlend(c.blendMode)) || t.stages.some((s) => !isCssBlend(s.blendMode)),
	);
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
 * The shader plan compositing `items` (bottom → top) onto transparency: one pass per item, ping-ponging the
 * accumulated picture (`u_acc`, premultiplied RGBA8 like an 8-bit pipeline: `storePremul8`), the last one into the
 * stage canvas. A member without a
 * picture yet is left out (it draws nothing until it delivers). Texture inputs: `u_l<i>` (see `textures`).
 */
export function planComposite(
	items: readonly CompositeItem[],
	pictures: ReadonlyMap<string, CompositePicture>,
	comp: { width: number; height: number },
): { plan: FxEffectPlan; textures: { uniform: string; key: string }[]; builtins: FxUniform[] } {
	const drawn = items.filter((it) => it.kind === 'matte' || pictures.has(it.key));
	const textures: { uniform: string; key: string }[] = [];
	const passes: ShaderPass[] = drawn.map((it, i): ShaderPass => {
		const first = i === 0;
		const dst = first ? 'vec4(0.0)' : 'texture(u_acc, v_uv)';
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
  vec4 src = texture(${name}, c / max(u_placeSize, vec2(1.0))) * (cov * clamp(u_placeOpacity, 0.0, 1.0));
  uvec2 px = uvec2(max(floor(v_uv * u_compSize), vec2(0.0)));
  fragColor = fx_clampPremul(fx_layerBlend(u_mode, dst, src, fx_blendNoise(px, uint(u_dissolveSeed))));
}`,
			uniforms: {
				// GLSL mat3 is column-major; ours is row-major.
				u_place: { mat3: [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!] },
				u_placeSize: [pic.width, pic.height],
				u_placeOpacity: Math.min(1, Math.max(0, pic.opacity)),
				u_mode: { int: blendModeIndex(it.mode) },
				u_dissolveSeed: { int: it.seed },
			},
		};
	});
	if (passes.length === 0)
		passes.push({ include: [GLSL_BLEND], frag: 'void main() { fragColor = vec4(0.0); }' });
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
