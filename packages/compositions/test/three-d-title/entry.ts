// Browser entry of the 3D title GL tests (spec 19 §9): real text drawn on a canvas, traced, built and rendered by the
// Advanced 3D renderer, with the scene described by JSON.
import {
	anim,
	buildTitleSolid,
	defaultCamera,
	type Layer3D,
	layerSurfacesAt,
	layerWorldMatrix,
	lightStateOf,
	lookAtCamera,
	materialAt,
	type Mesh,
	mat4Mul,
	newLayer3D,
	newLightData,
	newSurface,
	type SolidGeometry,
	SURFACE_PRESETS,
	type SurfaceValues,
	type Vec3,
	sceneLookAt,
	shapesOfAlpha,
} from '@jasper/project';
import { fxHost } from '../../src/fx/host.ts';
import { renderAdvancedGL } from '../../src/three-d/advanced.ts';
import { extrudedMesh, solidBuilds } from '../../src/three-d/extruded.ts';
import type { EnvSource } from '../../src/three-d/hdr-passes.ts';

const FPS = { num: 30, den: 1 };
const RIG = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };

export type TitleScene = {
	W: number;
	H: number;
	text?: string;
	font?: string;
	/** Instead of text: filled rectangles (x, y, w, h). */
	rects?: [number, number, number, number][];
	fill?: string;
	/** `Partial<SolidGeometry>`, loosely typed: scenes are JSON. */
	geometry: Record<string, unknown>;
	/** Preset ids or `SurfaceValues` per surface: base, face, side, back, band0…, plate0Face, plate0Side… */
	surfaces?: Record<string, unknown>;
	envPreset?: number;
	envRotation?: number;
	envColor?: Vec3;
	envFloat?: { width: number; height: number; data: number[] };
	envBackground?: boolean;
	noEnv?: boolean;
	toneMapping?: 'none' | 'aces' | 'agx' | 'neutral' | 'hue';
	exposure?: number;
	glint?: Record<string, number | number[]>;
	supersampling?: number;
	rotX?: number;
	rotY?: number;
	rotZ?: number;
	backdrop?: 'none' | 'stripes' | 'grey' | 'gradient';
	lights?: { type: 'parallel' | 'point' | 'spot' | 'ambient'; intensity?: number; pos?: Vec3; poi?: Vec3 }[];
	orbit?: number;
};

const surfaceOf = (v: unknown) =>
	newSurface(typeof v === 'string' ? SURFACE_PRESETS[v]!.values : (v as SurfaceValues));

const glyphCache = new Map<string, HTMLCanvasElement>();
function picture(s: TitleScene): HTMLCanvasElement {
	const key = JSON.stringify([s.W, s.H, s.text, s.font, s.rects, s.fill]);
	const hit = glyphCache.get(key);
	if (hit) return hit;
	const c = document.createElement('canvas');
	c.width = s.W;
	c.height = s.H;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	ctx.fillStyle = s.fill ?? '#ffffff';
	if (s.rects) for (const r of s.rects) ctx.fillRect(r[0], r[1], r[2], r[3]);
	else {
		ctx.font = s.font ?? `900 ${Math.round(s.H * 0.5)}px "Liberation Sans", sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(s.text ?? 'GOLD', s.W / 2, s.H / 2);
	}
	glyphCache.set(key, c);
	return c;
}

function backdropOf(kind: TitleScene['backdrop'], W: number, H: number): HTMLCanvasElement | null {
	if (!kind || kind === 'none') return null;
	const c = document.createElement('canvas');
	c.width = W;
	c.height = H;
	const ctx = c.getContext('2d')!;
	if (kind === 'grey') {
		ctx.fillStyle = '#3a3f4a';
		ctx.fillRect(0, 0, W, H);
	} else if (kind === 'gradient') {
		const g = ctx.createLinearGradient(0, 0, 0, H);
		g.addColorStop(0, '#20263a');
		g.addColorStop(1, '#0b0d16');
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
	} else
		for (let x = 0; x < W; x += 12) {
			ctx.fillStyle = (x / 12) % 2 ? '#e8e8e8' : '#d02030';
			ctx.fillRect(x, 0, 12, H);
		}
	return c;
}

function layerOf(s: TitleScene): Layer3D {
	const td = newLayer3D(true, 'text');
	td.rotationY = anim(s.rotY ?? 0);
	td.rotationX = anim(s.rotX ?? 0);
	const surf = s.surfaces ?? {};
	if (surf.base) td.material.pbr = surfaceOf(surf.base);
	const g = td.geometry!;
	const sv = {} as { face?: ReturnType<typeof newSurface>; side?: ReturnType<typeof newSurface>; back?: ReturnType<typeof newSurface> };
	if (surf.face) sv.face = surfaceOf(surf.face);
	if (surf.side) sv.side = surfaceOf(surf.side);
	if (surf.back) sv.back = surfaceOf(surf.back);
	g.surfaces = sv;
	const geo = s.geometry as Partial<SolidGeometry>;
	g.bands = (geo.bands ?? []).map((b, i) => ({
		id: `bnd_${i}`,
		width: anim(b.width),
		depth: anim(b.depth),
		profile: b.profile,
		curve: anim(b.curve),
		segments: b.segments,
		...(surf[`band${i}`] ? { material: surfaceOf(surf[`band${i}`]!) } : {}),
	}));
	g.backplates = (geo.plates ?? []).map((p, i) => ({
		id: `plt_${i}`,
		enabled: p.enabled,
		shape: p.shape,
		grow: anim(p.grow),
		depth: anim(p.depth),
		gap: anim(p.gap),
		corner: anim(p.corner),
		fillCounters: p.fillCounters,
		bevelWidth: anim(p.bevelWidth),
		bevelDepth: anim(p.bevelDepth),
		bevelProfile: p.bevelProfile,
		...(surf[`plate${i}Face`] ? { face: surfaceOf(surf[`plate${i}Face`]!) } : {}),
		...(surf[`plate${i}Side`] ? { side: surfaceOf(surf[`plate${i}Side`]!) } : {}),
	}));
	return td;
}

const solid = (s: TitleScene): SolidGeometry => ({
	mode: 'extrude',
	depth: 30,
	bevelStyle: 'none',
	bevelDepth: 2,
	holeBevel: 100,
	position: 'inside',
	bands: [],
	inflate: null,
	plates: [],
	...s.geometry,
});

let lastMesh: Mesh | null = null;

function draw(s: TitleScene, out: CanvasRenderingContext2D, useCache = true): void {
	const h = fxHost()!;
	const pic = picture(s);
	const td = layerOf(s);
	const clip = {
		threeD: td,
		kind: 'text',
		transform: {
			position: anim([s.W / 2, s.H / 2]),
			scale: anim([100, 100]),
			rotation: anim(s.rotZ ?? 0),
			anchor: anim([s.W / 2, s.H / 2]),
			opacity: anim(100),
		},
	};
	const camBase = defaultCamera(s.W, s.H);
	let camera = camBase;
	if (s.orbit) {
		const c: Vec3 = [s.W / 2, s.H / 2, 0];
		const a = (s.orbit * Math.PI) / 180;
		const d = camBase.zoom;
		camera = { ...lookAtCamera([c[0] + Math.sin(a) * d, c[1], -Math.cos(a) * d], c, camBase.zoom) };
	}
	const world = layerWorldMatrix(clip as never, 0, {});
	const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const g = solid(s);
	const mesh =
		useCache
			? extrudedMesh(
					'title',
					{ canvas: pic, version: performance.now(), width: pic.width, height: pic.height },
					identity as never,
					g,
				)
			: buildTitleSolid(traced(pic), g);
	lastMesh = mesh;
	const lights = (s.lights ?? []).map((l, i) => {
		const data = newLightData(l.type, { width: s.W, height: s.H }, { intensity: l.intensity ?? 100 });
		if (l.pos) data.transform.position = anim(l.pos);
		if (l.poi) data.transform.pointOfInterest = anim(l.poi);
		return lightStateOf({ clipId: `l${i}`, name: '', trackIndex: 0, ...RIG, light: data } as never, 0, FPS);
	});
	const environment =
		s.noEnv
			? null
			: {
					source: (s.envFloat
						? { kind: 'float', width: s.envFloat.width, height: s.envFloat.height, data: Float32Array.from(s.envFloat.data) }
						: { kind: 'preset', preset: s.envPreset ?? 0 }) as EnvSource,
					key: s.envFloat ? `float:${s.envFloat.data.reduce((a, b) => a + b, 0)}` : `preset:${s.envPreset ?? 0}`,
					rotation: ((s.envRotation ?? 0) * Math.PI) / 180,
					color: s.envColor ?? ([1, 1, 1] as Vec3),
					background: !!s.envBackground,
				};
	const lookAt = sceneLookAt(
		{
			renderer: 'advanced',
			cameras: [],
			lights: [],
			toneMapping: s.toneMapping,
			...(s.exposure ? { exposure: anim(s.exposure) } : {}),
			...(s.glint
				? {
						glint: {
							enabled: true,
							threshold: anim((s.glint.threshold as number) ?? 1.5),
							intensity: anim((s.glint.intensity as number) ?? 100),
							radius: anim((s.glint.radius as number) ?? 16),
							rays: (s.glint.rays as number) ?? 4,
							length: anim((s.glint.length as number) ?? 60),
							angle: anim((s.glint.angle as number) ?? 45),
							tint: anim([1, 1, 1, 1]),
						},
					}
				: {}),
		} as never,
		0,
		FPS,
	);
	renderAdvancedGL(
		h,
		{
			setup: { width: s.W, height: s.H, scale: 1, frame: { width: s.W, height: s.H }, camera, lights, draft: false },
			members: [
				{
					key: 'title',
					picture: pic,
					pictureWidth: pic.width,
					pictureHeight: pic.height,
					layerToPicture: identity,
					world,
					mesh,
					material: materialAt(td.material, 0),
					surfaces: layerSurfacesAt(td, 0),
					opacity: 1,
					draw: true,
				},
			],
			backdrop: backdropOf(s.backdrop, s.W, s.H),
			environment,
			shadowMapSize: 1024,
			look: {
				toneMapping: lookAt.toneMapping,
				exposure: lookAt.exposure,
				glint: lookAt.glint,
				supersampling: s.supersampling ?? 1,
			},
		},
		out,
	);
}

function traced(pic: HTMLCanvasElement) {
	const ctx = pic.getContext('2d', { willReadFrequently: true })!;
	const d = ctx.getImageData(0, 0, pic.width, pic.height).data;
	return shapesOfAlpha(pic.width, pic.height, (x, y) => d[(y * pic.width + x) * 4 + 3]!);
}

function canvasOf(s: TitleScene) {
	const c = document.createElement('canvas');
	c.width = s.W;
	c.height = s.H;
	return { c, ctx: c.getContext('2d')! };
}

const api = {
	/** Straight RGBA bytes. */
	render(s: TitleScene): number[] {
		const { c, ctx } = canvasOf(s);
		draw(s, ctx);
		return Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
	},
	png(s: TitleScene): string {
		const { c, ctx } = canvasOf(s);
		draw(s, ctx);
		return c.toDataURL('image/png');
	},
	/** A contact sheet: every scene drawn into one PNG, `cols` wide, with its label. */
	sheet(scenes: (TitleScene & { label: string })[], cols: number): string {
		const w = scenes[0]!.W;
		const h = scenes[0]!.H;
		const rows = Math.ceil(scenes.length / cols);
		const sheet = document.createElement('canvas');
		sheet.width = cols * (w + 8) + 8;
		sheet.height = rows * (h + 26) + 8;
		const out = sheet.getContext('2d')!;
		out.fillStyle = '#101216';
		out.fillRect(0, 0, sheet.width, sheet.height);
		scenes.forEach((s, i) => {
			const { c, ctx } = canvasOf(s);
			draw(s, ctx);
			const x = 8 + (i % cols) * (w + 8);
			const y = 8 + Math.floor(i / cols) * (h + 26);
			out.drawImage(c, x, y);
			out.fillStyle = '#cfd3da';
			out.font = '13px "Liberation Sans", sans-serif';
			out.fillText(s.label, x + 2, y + h + 15);
		});
		return sheet.toDataURL('image/png');
	},
	builds: () => solidBuilds(),
	meshSize: () => (lastMesh ? lastMesh.vertices.length / 9 : 0),
	/** Milliseconds of `n` frames. */
	time(s: TitleScene, n: number): number {
		const { ctx } = canvasOf(s);
		const t0 = performance.now();
		for (let i = 0; i < n; i++) draw({ ...s, orbit: (s.orbit ?? 0) + i * 0.5 }, ctx);
		return performance.now() - t0;
	},
	hasFloat: () => fxHost()?.floatTargets ?? false,
};

(window as unknown as { __title: typeof api }).__title = api;
