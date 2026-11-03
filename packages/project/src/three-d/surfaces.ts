// Physically based surfaces of Advanced 3D (spec 19 TL-071, TL-074): factories, the material presets, evaluation at a
// time, and the surface slots a solid's mesh is drawn with. The presets' numbers are Pachislop's `model/defaults.ts`
// (licenses/ported/pachislop-three-d.md), in percent.
import { anim } from '../factories.ts';
import { evaluate } from '../keyframes.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import type {
	Backplate,
	BevelBand,
	Layer3D,
	SurfaceBase,
	SurfaceMaterial,
	SurfaceRamp,
	SurfaceRelief,
} from '../schema/three-d.ts';
import { MAX_BACKPLATES, MAX_BEVEL_BANDS, SURFACE_RELIEFS } from '../schema/three-d.ts';
import { finiteOr } from './math.ts';

/** Surface slots of a solid: `Mesh` vertices store one of these as their kind. */
export const SLOT_FACE = 0;
export const SLOT_SIDE = 1;
export const SLOT_BACK = 2;
export const SLOT_BAND0 = 3;
export const SLOT_PLATE0 = SLOT_BAND0 + MAX_BEVEL_BANDS;
/** Slots of one solid. */
export const MAX_SLOTS = SLOT_PLATE0 + 2 * MAX_BACKPLATES;
export const plateFaceSlot = (k: number) => SLOT_PLATE0 + 2 * k;
export const plateSideSlot = (k: number) => SLOT_PLATE0 + 2 * k + 1;

const hex = (s: string): RGBA => [
	Number.parseInt(s.slice(1, 3), 16) / 255,
	Number.parseInt(s.slice(3, 5), 16) / 255,
	Number.parseInt(s.slice(5, 7), 16) / 255,
	1,
];

/** Plain values of a surface: what presets and commands set. */
export type SurfaceValues = {
	base?: SurfaceBase;
	baseColor?: RGBA;
	ramp?: SurfaceRamp | null;
	metalness?: number;
	roughness?: number;
	reflectivity?: number;
	specularBoost?: number;
	clearcoat?: number;
	clearcoatRoughness?: number;
	flakes?: number;
	flakeScale?: number;
	relief?: SurfaceRelief;
	reliefAmount?: number;
	reliefScale?: number;
	reliefSeed?: number;
	iridescence?: number;
	iridescenceThickness?: number;
	transmission?: number;
	ior?: number;
	thickness?: number;
	dispersion?: number;
	attenuationColor?: RGBA;
	emissive?: RGBA;
	emissiveIntensity?: number;
};

/** Numeric fields of a surface: name, label, unit, range and default. */
export const SURFACE_NUMBERS = [
	{ key: 'metalness', label: 'Metalness', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'roughness', label: 'Roughness', unit: '%', min: 0, max: 100, def: 30 },
	{ key: 'reflectivity', label: 'Reflectivity', unit: '%', min: 0, max: 400, def: 100 },
	{ key: 'specularBoost', label: 'Specular Boost', unit: '%', min: 0, max: 400, def: 100 },
	{ key: 'clearcoat', label: 'Clearcoat', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'clearcoatRoughness', label: 'Clearcoat Roughness', unit: '%', min: 0, max: 100, def: 3 },
	{ key: 'flakes', label: 'Flakes', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'flakeScale', label: 'Flake Size', unit: 'px', min: 0.25, max: 200, def: 4 },
	{ key: 'reliefAmount', label: 'Relief Amount', unit: '%', min: 0, max: 100, def: 50 },
	{ key: 'reliefScale', label: 'Relief Size', unit: 'px', min: 1, max: 2000, def: 40 },
	{ key: 'iridescence', label: 'Iridescence', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'iridescenceThickness', label: 'Film Thickness', unit: 'nm', min: 50, max: 1200, def: 400 },
	{ key: 'transmission', label: 'Transmission', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'ior', label: 'Index of Refraction', min: 1, max: 2.5, def: 1.5 },
	{ key: 'thickness', label: 'Thickness', unit: 'px', min: 0, max: 2000, def: 40 },
	{ key: 'dispersion', label: 'Dispersion', unit: '%', min: 0, max: 100, def: 0 },
	{ key: 'emissiveIntensity', label: 'Emissive Intensity', unit: '%', min: 0, max: 2000, def: 0 },
] as const;
export type SurfaceNumberKey = (typeof SURFACE_NUMBERS)[number]['key'];
/** Colour fields of a surface. */
export const SURFACE_COLORS = [
	{ key: 'baseColor', label: 'Base Color', def: [1, 1, 1, 1] as RGBA },
	{ key: 'attenuationColor', label: 'Attenuation Color', def: [1, 1, 1, 1] as RGBA },
	{ key: 'emissive', label: 'Emissive', def: [0, 0, 0, 1] as RGBA },
] as const;
export type SurfaceColorKey = (typeof SURFACE_COLORS)[number]['key'];

/** A surface from plain values; everything else at its default. */
export function newSurface(v: SurfaceValues = {}): SurfaceMaterial {
	const num = (k: SurfaceNumberKey) => {
		const spec = SURFACE_NUMBERS.find((s) => s.key === k)!;
		return anim(v[k] ?? spec.def);
	};
	return {
		base: v.base ?? 'picture',
		baseColor: anim<RGBA>(v.baseColor ?? [1, 1, 1, 1]),
		...(v.ramp ? { ramp: v.ramp } : {}),
		metalness: num('metalness'),
		roughness: num('roughness'),
		reflectivity: num('reflectivity'),
		specularBoost: num('specularBoost'),
		clearcoat: num('clearcoat'),
		clearcoatRoughness: num('clearcoatRoughness'),
		flakes: num('flakes'),
		flakeScale: num('flakeScale'),
		relief: v.relief ?? 'none',
		reliefAmount: num('reliefAmount'),
		reliefScale: num('reliefScale'),
		reliefSeed: v.reliefSeed ?? 1,
		iridescence: num('iridescence'),
		iridescenceThickness: num('iridescenceThickness'),
		transmission: num('transmission'),
		ior: num('ior'),
		thickness: num('thickness'),
		dispersion: num('dispersion'),
		attenuationColor: anim<RGBA>(v.attenuationColor ?? [1, 1, 1, 1]),
		emissive: anim<RGBA>(v.emissive ?? [0, 0, 0, 1]),
		emissiveIntensity: num('emissiveIntensity'),
	};
}

const ramp = (...stops: [number, string][]): SurfaceRamp => ({
	angle: 90,
	stops: stops.map(([at, c]) => ({ at, color: hex(c) })),
});

const color = (s: string) => ({ base: 'color' as const, baseColor: hex(s) });
const metal = (s: string, roughness: number, r: SurfaceRamp, more: SurfaceValues = {}): SurfaceValues => ({
	...color(s),
	metalness: 100,
	roughness,
	ramp: r,
	...more,
});

/** Material presets by id: starting points, every value stays editable and animatable. */
export const SURFACE_PRESETS: Record<string, { label: string; values: SurfaceValues }> = {
	gold: {
		label: 'Gold',
		// Metals carry a banded tint (white-hot, mid tone, a dark band just below the middle, mid tone, pale), which
		// reads head-on and rotated whatever the environment happens to reflect. No clearcoat: an untinted coat lays a
		// pale, unsaturated reflection over the metal.
		values: metal(
			'#ffc000',
			8,
			ramp(
				[0, '#fff4b0'],
				[0.18, '#ffd400'],
				[0.42, '#ff9800'],
				[0.5, '#b83000'],
				[0.58, '#ff7c00'],
				[0.8, '#ffb800'],
				[1, '#ffe070'],
			),
		),
	},
	'pale-gold': {
		label: 'Pale Gold',
		values: metal(
			'#f3dc9a',
			10,
			ramp(
				[0, '#fffef5'],
				[0.22, '#fbeec0'],
				[0.45, '#d2b26a'],
				[0.52, '#7d6430'],
				[0.6, '#c9a85f'],
				[0.8, '#f7e7b0'],
				[1, '#fffbe8'],
			),
			{ clearcoat: 30 },
		),
	},
	'rose-gold': {
		label: 'Rose Gold',
		values: metal(
			'#ffb59a',
			10,
			ramp(
				[0, '#fff5f0'],
				[0.22, '#ffd0bd'],
				[0.45, '#d98a6e'],
				[0.52, '#7d3f2c'],
				[0.6, '#c97c62'],
				[0.8, '#ffcbb6'],
				[1, '#fff0ea'],
			),
			{ clearcoat: 30 },
		),
	},
	chrome: {
		label: 'Chrome',
		values: metal(
			'#ffffff',
			4,
			ramp(
				[0, '#ffffff'],
				[0.22, '#e8eef5'],
				[0.45, '#8a94a3'],
				[0.52, '#2e343d'],
				[0.6, '#7d8794'],
				[0.8, '#dde4ee'],
				[1, '#ffffff'],
			),
		),
	},
	silver: {
		label: 'Silver',
		values: metal(
			'#d8dde6',
			14,
			ramp(
				[0, '#ffffff'],
				[0.22, '#e3e7ee'],
				[0.45, '#a3abb8'],
				[0.52, '#555c68'],
				[0.6, '#9aa2af'],
				[0.8, '#dfe4eb'],
				[1, '#f7f9fc'],
			),
			{ clearcoat: 30 },
		),
	},
	copper: {
		label: 'Copper',
		values: metal(
			'#ff8a52',
			12,
			ramp(
				[0, '#fff0e0'],
				[0.22, '#ffb48a'],
				[0.45, '#d0652a'],
				[0.52, '#6e2a0c'],
				[0.6, '#c05a24'],
				[0.8, '#ffa77a'],
				[1, '#ffe6d6'],
			),
			{ clearcoat: 30 },
		),
	},
	'black-gloss': {
		label: 'Black Gloss',
		values: { ...color('#050505'), metalness: 20, roughness: 8, clearcoat: 100 },
	},
	'white-gloss': {
		label: 'White Gloss',
		values: { ...color('#ffffff'), metalness: 0, roughness: 15, clearcoat: 100 },
	},
	plastic: { label: 'Plastic', values: { ...color('#ff3b3b'), metalness: 0, roughness: 35, clearcoat: 80 } },
	candy: {
		label: 'Candy Paint',
		values: {
			...color('#e0102a'),
			metalness: 85,
			roughness: 35,
			clearcoat: 100,
			flakes: 80,
			flakeScale: 2,
			reflectivity: 140,
			specularBoost: 150,
		},
	},
	'hammered-gold': {
		label: 'Hammered Gold',
		values: { ...color('#ffc000'), metalness: 100, roughness: 22, relief: 'hammered', reliefAmount: 60 },
	},
	'liquid-chrome': {
		label: 'Liquid Chrome',
		values: {
			...color('#ffffff'),
			metalness: 100,
			roughness: 3,
			relief: 'liquid',
			reliefAmount: 55,
			reliefScale: 120,
		},
	},
	foil: {
		label: 'Crumpled Foil',
		values: {
			...color('#dfe3ea'),
			metalness: 100,
			roughness: 18,
			relief: 'crumple',
			reliefAmount: 55,
			reliefScale: 50,
		},
	},
	pearl: {
		label: 'Pearl',
		// A dark body under the film: on a white one the diffuse swamps the thin-film colours.
		values: {
			...color('#6e6a72'),
			metalness: 35,
			roughness: 22,
			clearcoat: 60,
			reflectivity: 160,
			iridescence: 100,
			iridescenceThickness: 420,
		},
	},
	glass: {
		label: 'Glass',
		values: { ...color('#ffffff'), metalness: 0, roughness: 2, transmission: 100, ior: 1.5, thickness: 40 },
	},
	diamond: {
		label: 'Diamond',
		values: {
			...color('#f4f9ff'),
			metalness: 0,
			roughness: 2,
			transmission: 100,
			ior: 2.4,
			thickness: 60,
			dispersion: 80,
			reflectivity: 160,
			specularBoost: 200,
		},
	},
	ruby: {
		label: 'Ruby',
		values: {
			...color('#ff1030'),
			metalness: 0,
			roughness: 3,
			transmission: 100,
			ior: 1.77,
			thickness: 60,
			dispersion: 30,
			attenuationColor: [1, 0.05, 0.1, 1],
			reflectivity: 150,
			specularBoost: 200,
		},
	},
};

/** A surface at a time: linear-free plain numbers, ready for the renderer. Percentages become 0…1. */
export type SurfaceState = {
	useColor: boolean;
	/** The signal's values (sRGB-encoded, as stored). */
	baseColor: RGBA;
	ramp: SurfaceRamp | null;
	metalness: number;
	roughness: number;
	reflectivity: number;
	specularBoost: number;
	clearcoat: number;
	clearcoatRoughness: number;
	flakes: number;
	flakeScale: number;
	relief: number;
	reliefAmount: number;
	reliefScale: number;
	reliefSeed: number;
	iridescence: number;
	iridescenceThickness: number;
	transmission: number;
	ior: number;
	thickness: number;
	dispersion: number;
	attenuationColor: RGBA;
	emissive: RGBA;
	emissiveIntensity: number;
};

const rgba = (a: Animatable<RGBA> | undefined, t: number, d: RGBA): RGBA => {
	const v = a ? (evaluate(a, t) as unknown) : d;
	return Array.isArray(v) && v.length >= 3
		? [finiteOr(v[0], d[0]), finiteOr(v[1], d[1]), finiteOr(v[2], d[2]), finiteOr(v[3], d[3])]
		: d;
};

/** The surface at content time `t`, every number clamped to its range. */
export function surfaceAt(m: SurfaceMaterial, t: number): SurfaceState {
	const n = (key: SurfaceNumberKey) => {
		const s = SURFACE_NUMBERS.find((x) => x.key === key)!;
		const a = m[key];
		const v = a ? finiteOr(evaluate(a, t), s.def) : s.def;
		return Math.min(s.max, Math.max(s.min, v));
	};
	return {
		useColor: m.base === 'color',
		baseColor: rgba(m.baseColor, t, [1, 1, 1, 1]),
		ramp: m.ramp ?? null,
		metalness: n('metalness') / 100,
		roughness: n('roughness') / 100,
		reflectivity: n('reflectivity') / 100,
		specularBoost: n('specularBoost') / 100,
		clearcoat: n('clearcoat') / 100,
		clearcoatRoughness: n('clearcoatRoughness') / 100,
		flakes: n('flakes') / 100,
		flakeScale: n('flakeScale'),
		relief: Math.max(0, SURFACE_RELIEFS.indexOf(m.relief)),
		reliefAmount: n('reliefAmount') / 100,
		reliefScale: n('reliefScale'),
		reliefSeed: finiteOr(m.reliefSeed, 1),
		iridescence: n('iridescence') / 100,
		iridescenceThickness: n('iridescenceThickness'),
		transmission: n('transmission') / 100,
		ior: n('ior'),
		thickness: n('thickness'),
		dispersion: n('dispersion') / 100,
		attenuationColor: rgba(m.attenuationColor, t, [1, 1, 1, 1]),
		emissive: rgba(m.emissive, t, [0, 0, 0, 1]),
		emissiveIntensity: n('emissiveIntensity') / 100,
	};
}

/** The surfaces of a layer's slots at `t`; a null slot draws with After Effects' Material Options. */
export function layerSurfacesAt(td: Layer3D, t: number): (SurfaceState | null)[] {
	const g = td.geometry;
	const base = td.material.pbr ? surfaceAt(td.material.pbr as SurfaceMaterial, t) : null;
	const of = (m: SurfaceMaterial | undefined) => (m ? surfaceAt(m, t) : base);
	const out = new Array<SurfaceState | null>(MAX_SLOTS).fill(base);
	const s = g?.surfaces as
		| { face?: SurfaceMaterial; side?: SurfaceMaterial; back?: SurfaceMaterial }
		| undefined;
	out[SLOT_FACE] = of(s?.face);
	out[SLOT_SIDE] = of(s?.side);
	out[SLOT_BACK] = of(s?.back);
	((g?.bands ?? []) as BevelBand[]).slice(0, MAX_BEVEL_BANDS).forEach((b, i) => {
		out[SLOT_BAND0 + i] = of(b.material);
	});
	((g?.backplates ?? []) as Backplate[]).slice(0, MAX_BACKPLATES).forEach((p, i) => {
		out[plateFaceSlot(i)] = of(p.face);
		out[plateSideSlot(i)] = of(p.side);
	});
	return out;
}

/** Every surface a layer stores, with where it lives. */
export function layerSurfaces(
	td: Layer3D,
): { id: string; label: string; path: (string | number)[]; surface: SurfaceMaterial | undefined }[] {
	const g = td.geometry;
	const out: {
		id: string;
		label: string;
		path: (string | number)[];
		surface: SurfaceMaterial | undefined;
	}[] = [
		{
			id: 'base',
			label: 'Base',
			path: ['material', 'pbr'],
			surface: td.material.pbr as SurfaceMaterial | undefined,
		},
	];
	if (!g) return out;
	const s = (g.surfaces ?? {}) as { face?: SurfaceMaterial; side?: SurfaceMaterial; back?: SurfaceMaterial };
	for (const [id, label] of [
		['face', 'Face'],
		['side', 'Side'],
		['back', 'Back'],
	] as const)
		out.push({ id, label, path: ['geometry', 'surfaces', id], surface: s[id] });
	((g.bands ?? []) as BevelBand[]).forEach((b, i) => {
		out.push({
			id: b.id,
			label: `Band ${i + 1}`,
			path: ['geometry', 'bands', i, 'material'],
			surface: b.material,
		});
	});
	((g.backplates ?? []) as Backplate[]).forEach((p, i) => {
		out.push({
			id: `${p.id}.face`,
			label: `Plate ${i + 1} Face`,
			path: ['geometry', 'backplates', i, 'face'],
			surface: p.face,
		});
		out.push({
			id: `${p.id}.side`,
			label: `Plate ${i + 1} Side`,
			path: ['geometry', 'backplates', i, 'side'],
			surface: p.side,
		});
	});
	return out;
}

/** Whether a layer draws anything physically based (it then needs the floating-point scene target). */
export function layerIsPhysical(td: Layer3D): boolean {
	return layerSurfaces(td).some((s) => !!s.surface);
}
