// Spec 19 TL-112: what a frame becomes in Photoshop, decided before any pixel is drawn, so the dialog can list what is
// baked and refuse with blockers. Idea of Pachislop's layered export (src/io/psd.ts, port record pachislop-interchange):
// one raster layer per picture, every layer rendered alone into the full frame so they all register, the layer's blend
// mode and opacity on the PSD layer, and what Photoshop cannot hold baked with a name. Pure.
//
// - A clip is a raster layer. Text, shapes, graphics, effects and masks are in its pixels: rasterised, and the plan says so.
// - An adjustment layer, a blend mode Photoshop lacks, a track matte or a 3D scene needs what is below it: a pixel layer
//   "<name> (baked)" holds the composite up to there, and what it stands in for stays below it, hidden.
// - A transition at this frame is one layer: its two sides do not exist apart.
// - `splitTitles`: a title with a look becomes a group, bottom → top, of each rim and the face (hidden) and `fx`, the
//   whole clip (shown). A part keeps every other layer of the look at zero opacity, so rims keep growing from what is
//   above them and register exactly.
import { MAX_PSD_LAYERS, MAX_PSD_PIXELS, MAX_PSD_SIDE, type PsdPlan, type PsdPlanLayer } from '@jasper/api';
import {
	type Appearance,
	type AppearanceLayer,
	type BlendMode,
	clipLook,
	colorSpace,
	contentTimeAt,
	defaultEffectRegistry,
	type EffectRegistry,
	evaluate,
	isHdrSpace,
	isPaintParam,
	type RenderSnapshot,
	type RenderVisualClip,
	TITLE_LOOK_EFFECT_ID,
	titleLayerType,
	trackMatteTracksOf,
} from '@jasper/project';
import { neutralClip, onlyClips, opacityIsPortable } from './frames.ts';

/** ag-psd's blend mode of each editor blend mode (`null`: Photoshop has none). */
const PSD_BLEND: Partial<Record<BlendMode, string>> = {
	normal: 'normal',
	dissolve: 'dissolve',
	darken: 'darken',
	multiply: 'multiply',
	'color-burn': 'color burn',
	'linear-burn': 'linear burn',
	'darker-color': 'darker color',
	lighten: 'lighten',
	screen: 'screen',
	'color-dodge': 'color dodge',
	add: 'linear dodge',
	'linear-dodge': 'linear dodge',
	'lighter-color': 'lighter color',
	overlay: 'overlay',
	'soft-light': 'soft light',
	'hard-light': 'hard light',
	'vivid-light': 'vivid light',
	'linear-light': 'linear light',
	'pin-light': 'pin light',
	'hard-mix': 'hard mix',
	difference: 'difference',
	exclusion: 'exclusion',
	subtract: 'subtract',
	divide: 'divide',
	hue: 'hue',
	saturation: 'saturation',
	color: 'color',
	luminosity: 'luminosity',
} as Partial<Record<BlendMode, string>>;

export type PsdRender = {
	/** Clips drawn, in stack order. */
	clips: string[];
	/** The sequence background under them. */
	background: boolean;
	/** With the tracks' transition mattes. */
	mattes?: boolean;
	/** Drawn in Normal at 100 %: the PSD layer carries blend mode and opacity. */
	neutral?: string[];
	/** Of the clip's look, only these layers paint; the others are at zero opacity. */
	part?: { clipId: string; layerId: string };
};

export type PsdNode =
	| ({ kind: 'pixels'; render: PsdRender } & Omit<PsdPlanLayer, 'kind' | 'children'>)
	| ({ kind: 'group'; children: PsdNode[] } & Omit<PsdPlanLayer, 'kind' | 'children'>);

export type PsdLayout = {
	nodes: PsdNode[];
	/** The composite of the frame, the PSD's flattened picture. */
	composite: PsdRender;
	plan: PsdPlan;
};

/** Drawn at `frame`: a transition's handles draw a clip past its own span, so a dissolve's other side counts. */
const activeAt = (
	c: Pick<RenderVisualClip, 'start' | 'duration' | 'headHandle' | 'tailHandle'>,
	frame: number,
) => frame >= c.start - (c.headHandle ?? 0) && frame < c.start + c.duration + (c.tailHandle ?? 0);

const KIND_WORD: Record<string, string> = {
	text: 'text rasterised',
	shape: 'shape rasterised',
	'motion-graphic': 'motion graphic rasterised',
	composition: 'composition rasterised',
	captions: 'captions rasterised',
	'nest-video': 'nested sequence flattened',
};

/** The effects of a clip the user put there (the colour-management stage is not one). */
function effectNames(c: RenderVisualClip, registry: EffectRegistry): string[] {
	const out: string[] = [];
	for (const fx of c.effects) {
		if (!fx.enabled || fx.effectId === 'jasper.color-input') continue;
		if (fx.effectId === TITLE_LOOK_EFFECT_ID) {
			out.push('title look rasterised');
			continue;
		}
		out.push(`effect ${registry.get(fx.effectId, fx.effectVersion)?.label ?? fx.effectId} baked`);
	}
	return out;
}

/** What is in this clip's pixels that was not pixels in the editor. */
function bakedOf(c: RenderVisualClip, registry: EffectRegistry, frame: number): string[] {
	const out: string[] = [];
	const kind = 'nest' in c.source ? KIND_WORD['nest-video'] : KIND_WORD[c.kind];
	if (kind) out.push(kind);
	out.push(...effectNames(c, registry));
	if (c.masks?.some((m) => (m as { enabled?: boolean }).enabled !== false)) out.push('masks baked');
	if (c.fades?.some((f) => frame >= f.start && frame < f.start + f.frames)) out.push('fade baked');
	if (!opacityIsPortable(c)) out.push('opacity expression baked');
	return out;
}

const hasFlattenCause = (c: RenderVisualClip): string | null => {
	if (c.kind === 'adjustment') return 'adjustment layer';
	if (PSD_BLEND[c.blendMode] === undefined) return `blend mode ${c.blendMode}`;
	return null;
};

/** The parts of a look: rims outermost first, then the face. */
function lookParts(a: Appearance): { layer: AppearanceLayer; name: string }[] {
	const rims = a.layers.filter((l) => l.enabled && l.type === 'rim');
	const out: { layer: AppearanceLayer; name: string }[] = [];
	rims.forEach((l, i) => {
		out.push({ layer: l, name: l.name || `rim ${rims.length - i}` });
	});
	for (const l of a.layers)
		if (l.enabled && l.type === 'face') out.push({ layer: l, name: l.name || 'face' });
	return out;
}

function countNodes(nodes: readonly PsdNode[]): { records: number; renders: number } {
	let records = 0;
	let renders = 0;
	for (const n of nodes) {
		if (n.kind === 'pixels') {
			records++;
			renders++;
		} else {
			const inner = countNodes(n.children);
			records += 2 + inner.records;
			renders += inner.renders;
		}
	}
	return { records, renders };
}

function flatLayers(nodes: readonly PsdNode[]): PsdPlanLayer[] {
	const out: PsdPlanLayer[] = [];
	for (const n of nodes) {
		const { name, blend, opacity, hidden, baked } = n;
		if (n.kind === 'pixels') out.push({ name, kind: 'pixels', blend, opacity, hidden, baked });
		else {
			out.push({ name, kind: 'group', children: n.children.length, blend, opacity, hidden, baked });
			out.push(...flatLayers(n.children));
		}
	}
	return out;
}

/** The layer plan of `frame` in `doc`. `doc` holds the frame in its range. */
export function planPsd(
	doc: RenderSnapshot,
	frame: number,
	opts: { splitTitles?: boolean; registry?: EffectRegistry } = {},
): PsdLayout {
	const registry = opts.registry ?? defaultEffectRegistry;
	const { width, height } = doc.settings;
	const fps = doc.settings.fps;
	const hasBackground = doc.settings.backgroundColor[3] > 0;
	const nodes: PsdNode[] = [];
	const baked: string[] = [];
	const warnings: PsdPlan['warnings'] = [];
	const blockers: PsdPlan['blockers'] = [];
	const drawn: string[] = [];

	if (hasBackground)
		nodes.push({
			kind: 'pixels',
			name: 'Background',
			blend: 'normal',
			opacity: 1,
			hidden: false,
			baked: [],
			render: { clips: [], background: true },
		});

	const flatten = (name: string, why: string) => {
		for (const n of nodes) n.hidden = true;
		const label = `${name} (baked)`;
		nodes.push({
			kind: 'pixels',
			name: label,
			blend: 'normal',
			opacity: 1,
			hidden: false,
			baked: [`${why}: flattened with what is below it`],
			render: { clips: [...drawn], background: hasBackground, mattes: true },
		});
		baked.push(`${name}: ${why}, flattened with what is below it`);
	};

	const clip3d: RenderVisualClip[] = [];
	const matted2d: RenderVisualClip[] = [];
	for (const track of doc.videoTracks) {
		const clips = track.clips.filter((c) => activeAt(c, frame));
		// A transition's two sides are one picture.
		const live = (track.transitions ?? []).filter((t) => frame >= t.start && frame < t.start + t.duration);
		const inTransition = new Set<string>();
		for (const t of live) {
			const ids = [t.outgoingClipId, t.incomingClipId].filter((x): x is string => !!x);
			const sides = track.clips.filter((c) => ids.includes(c.clipId));
			if (!sides.length) continue;
			for (const c of sides) {
				inTransition.add(c.clipId);
				drawn.push(c.clipId);
			}
			const name = sides.map((c) => c.name).join(' / ');
			nodes.push({
				kind: 'pixels',
				name: `${name} (baked)`,
				blend: 'normal',
				opacity: 1,
				hidden: false,
				baked: ['transition baked'],
				render: { clips: sides.map((c) => c.clipId), background: false },
			});
			baked.push(`${name}: transition baked into one layer`);
		}
		for (const c of clips) {
			if (inTransition.has(c.clipId)) continue;
			drawn.push(c.clipId);
			if (c.threeD) {
				clip3d.push(c);
				continue;
			}
			if (trackMatteTracksOf(c).length) {
				matted2d.push(c);
				continue;
			}
			const flat = hasFlattenCause(c);
			if (flat) {
				flatten(c.name, flat);
				continue;
			}
			const here = bakedOf(c, registry, frame);
			for (const b of here) baked.push(`${c.name}: ${b}`);
			const blend = PSD_BLEND[c.blendMode]!;
			const portable = opacityIsPortable(c);
			const opacity = portable
				? Math.min(1, Math.max(0, evaluate(c.opacity, contentTimeAt(c, frame, fps)) / 100))
				: 1;
			const render: PsdRender = {
				clips: [c.clipId],
				background: false,
				...(portable ? { neutral: [c.clipId] } : {}),
			};
			const look = opts.splitTitles ? clipLook(c.effects) : null;
			const parts = look?.enabled && look.appearance ? lookParts(look.appearance as Appearance) : [];
			if (parts.length) {
				nodes.push({
					kind: 'group',
					name: c.name,
					blend: 'pass through',
					opacity: 1,
					hidden: false,
					baked: [],
					children: [
						...parts.map(
							({ layer, name }): PsdNode => ({
								kind: 'pixels',
								name,
								blend,
								opacity,
								hidden: true,
								baked: [...here],
								render: { ...render, part: { clipId: c.clipId, layerId: layer.id } },
							}),
						),
						{ kind: 'pixels', name: 'fx', blend, opacity, hidden: false, baked: [...here], render },
					],
				});
				continue;
			}
			nodes.push({ kind: 'pixels', name: c.name, blend, opacity, hidden: false, baked: here, render });
		}
	}
	// A 3D scene's layers intersect, and a track matte's source may sit above its clip: only the whole stack is right.
	if (clip3d.length) flatten(clip3d.map((c) => c.name).join(' / '), '3D scene');
	if (matted2d.length) flatten(matted2d.map((c) => c.name).join(' / '), 'track matte');

	const color = doc.settings.color;
	const space = color ? colorSpace(color.space) : undefined;
	if (space && (space.id !== 'rec709' || color?.linearize)) {
		warnings.push({
			code: 'PSD_DISPLAY_RENDITION',
			message: isHdrSpace(space)
				? `${space.label} is tone mapped to the display rendition: an 8-bit PSD cannot hold it`
				: `Layers hold the ${space.label} working space's display rendition`,
		});
	}
	if (color?.blendLinear)
		warnings.push({
			code: 'PSD_BLEND_GAMMA',
			message:
				'This sequence blends in linear light and Photoshop in gamma: layers recombined there differ where they overlap. The flattened picture is the render.',
		});
	warnings.push({
		code: 'PSD_RASTERISED',
		message: 'Everything is rasterised at 8 bits per channel: text is pixels, not editable type.',
	});

	if (width > MAX_PSD_SIDE || height > MAX_PSD_SIDE)
		blockers.push({
			code: 'PSD_FRAME_TOO_LARGE',
			message: `A PSD holds at most ${MAX_PSD_SIDE} px per side; this frame is ${width} × ${height}`,
		});
	else if (width * height > MAX_PSD_PIXELS)
		blockers.push({
			code: 'PSD_FRAME_TOO_LARGE',
			message: `A frame of ${width} × ${height} needs more memory than a PSD job may use (at most ${MAX_PSD_PIXELS / 1_000_000} megapixels)`,
		});
	if (!nodes.length)
		blockers.push({
			code: 'PSD_EMPTY',
			message: 'Nothing is visible at this frame on a transparent background',
		});
	const { records, renders } = countNodes(nodes);
	if (records > MAX_PSD_LAYERS)
		blockers.push({
			code: 'PSD_TOO_MANY_LAYERS',
			message: `This frame needs ${records} PSD layers; the limit is ${MAX_PSD_LAYERS}`,
		});

	const composite: PsdRender = { clips: drawn, background: hasBackground, mattes: true };
	return {
		nodes,
		composite,
		plan: {
			width,
			height,
			frame,
			layers: flatLayers(nodes),
			baked: [...new Set(baked)],
			blockers,
			warnings,
			estimate: { renders: renders + 1, bytes: (renders + 1) * width * height * 4 },
		},
	};
}

/** Every other layer of the look at zero opacity. A layer that grows the silhouette stays enabled, so nothing moves. */
function soloAppearance(a: Appearance, layerId: string): Appearance {
	return {
		...a,
		layers: a.layers.map((l) => {
			if (l.id === layerId) return l;
			const def = titleLayerType(l.type);
			if (!def?.grows) return { ...l, enabled: false };
			const params = { ...l.params };
			for (const spec of def.params)
				if (isPaintParam(spec))
					params[spec.name] = { value: { kind: 'color', color: [0, 0, 0, 0] }, keyframes: [] } as never;
			if (params.opacity) params.opacity = { value: 0, keyframes: [] } as never;
			return { ...l, params };
		}),
	};
}

/** The render document of one PSD layer. */
export function psdRenderDoc(doc: RenderSnapshot, render: PsdRender): RenderSnapshot {
	const narrowed = onlyClips(doc, new Set(render.clips), { mattes: render.mattes === true });
	const neutral = new Set(render.neutral ?? []);
	const videoTracks = narrowed.videoTracks.map((t) => ({
		...t,
		clips: t.clips.map((c) => {
			let out = neutral.has(c.clipId) ? neutralClip(c) : c;
			if (render.part?.clipId === c.clipId) {
				const layerId = render.part.layerId;
				out = {
					...out,
					effects: out.effects.map((fx) =>
						fx.effectId === TITLE_LOOK_EFFECT_ID && fx.appearance
							? { ...fx, appearance: soloAppearance(fx.appearance as Appearance, layerId) }
							: fx,
					),
				};
			}
			return out;
		}),
	}));
	return {
		...narrowed,
		videoTracks,
		settings: {
			...narrowed.settings,
			backgroundColor: render.background ? narrowed.settings.backgroundColor : [0, 0, 0, 0],
		},
	};
}
