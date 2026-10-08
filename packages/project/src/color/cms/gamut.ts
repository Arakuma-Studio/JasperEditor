// RGB gamuts (workstream color-mgmt): primaries and white points as published, their RGB → XYZ matrices (SMPTE RP 177)
// and the linear-light conversion between any two (via CIE XYZ, Bradford-adapted when the whites differ, as in the ACES
// and OCIO studio configurations).
//
// Sources: ITU-R BT.709-6 Table 1 item 1.3; ITU-R BT.2020-2 Table 3; SMPTE EG 432-1:2010 (P3, D65 and DCI white);
// SMPTE ST 2065-1:2012 (ACES AP0, ACES white); Academy S-2014-004 (ACEScg AP1); Sony S-Gamut3/S-Gamut3.Cine technical
// summary (2014); Panasonic V-Log/V-Gamut reference manual (2014); Canon Cinema Gamut white paper (2018); ARRI Log C
// (2017) and LogC4 (2022) specifications; DJI D-Gamut white paper (2017); RED "REDWideGamutRGB and Log3G10" (2017);
// Blackmagic "Generation 5 Color Science" (2021); Blackmagic "DaVinci Wide Gamut" (2020). Fujifilm F-Gamut, Nikon
// N-Log and Apple Log use the BT.2020 primaries (their data sheets say so).
import { bradford, type ColorMatrix, IDENTITY3, inv3, isIdentity3, mul3, npm, type Xy } from './matrix.ts';

export const D65: Xy = [0.3127, 0.329];
export const ACES_WHITE: Xy = [0.32168, 0.33767];
export const DCI_WHITE: Xy = [0.314, 0.351];

type GamutDef = { label: string; primaries: readonly [Xy, Xy, Xy]; white: Xy };

export const GAMUTS = {
	bt709: {
		label: 'Rec. 709 / sRGB',
		primaries: [
			[0.64, 0.33],
			[0.3, 0.6],
			[0.15, 0.06],
		],
		white: D65,
	},
	bt2020: {
		label: 'Rec. 2020',
		primaries: [
			[0.708, 0.292],
			[0.17, 0.797],
			[0.131, 0.046],
		],
		white: D65,
	},
	p3d65: {
		label: 'P3-D65',
		primaries: [
			[0.68, 0.32],
			[0.265, 0.69],
			[0.15, 0.06],
		],
		white: D65,
	},
	p3dci: {
		label: 'DCI-P3',
		primaries: [
			[0.68, 0.32],
			[0.265, 0.69],
			[0.15, 0.06],
		],
		white: DCI_WHITE,
	},
	ap0: {
		label: 'ACES AP0',
		primaries: [
			[0.7347, 0.2653],
			[0, 1],
			[0.0001, -0.077],
		],
		white: ACES_WHITE,
	},
	ap1: {
		label: 'ACES AP1',
		primaries: [
			[0.713, 0.293],
			[0.165, 0.83],
			[0.128, 0.044],
		],
		white: ACES_WHITE,
	},
	sgamut3: {
		label: 'Sony S-Gamut3',
		primaries: [
			[0.73, 0.28],
			[0.14, 0.855],
			[0.1, -0.05],
		],
		white: D65,
	},
	sgamut3cine: {
		label: 'Sony S-Gamut3.Cine',
		primaries: [
			[0.766, 0.275],
			[0.225, 0.8],
			[0.089, -0.087],
		],
		white: D65,
	},
	vgamut: {
		label: 'Panasonic V-Gamut',
		primaries: [
			[0.73, 0.28],
			[0.165, 0.84],
			[0.1, -0.03],
		],
		white: D65,
	},
	cinemagamut: {
		label: 'Canon Cinema Gamut',
		primaries: [
			[0.74, 0.27],
			[0.17, 1.14],
			[0.08, -0.1],
		],
		white: D65,
	},
	awg3: {
		label: 'ARRI Wide Gamut 3',
		primaries: [
			[0.684, 0.313],
			[0.221, 0.848],
			[0.0861, -0.102],
		],
		white: D65,
	},
	awg4: {
		label: 'ARRI Wide Gamut 4',
		primaries: [
			[0.7347, 0.2653],
			[0.1424, 0.8576],
			[0.0991, -0.0308],
		],
		white: D65,
	},
	dgamut: {
		label: 'DJI D-Gamut',
		primaries: [
			[0.71, 0.31],
			[0.21, 0.88],
			[0.09, -0.08],
		],
		white: D65,
	},
	rwg: {
		label: 'REDWideGamutRGB',
		primaries: [
			[0.780308, 0.304253],
			[0.121595, 1.493994],
			[0.095612, -0.084589],
		],
		white: D65,
	},
	bmdwg5: {
		label: 'Blackmagic Wide Gamut Gen 5',
		primaries: [
			[0.7177215, 0.3171181],
			[0.228041, 0.861569],
			[0.1005841, -0.0820452],
		],
		white: [0.312717, 0.3290312],
	},
	dwg: {
		label: 'DaVinci Wide Gamut',
		primaries: [
			[0.8, 0.313],
			[0.1682, 0.9877],
			[0.079, -0.1155],
		],
		white: D65,
	},
} as const satisfies Record<string, GamutDef>;

export type GamutId = keyof typeof GAMUTS;
export const GAMUT_IDS = Object.keys(GAMUTS) as GamutId[];

const npmCache = new Map<GamutId, ColorMatrix>();
/** Linear RGB → CIE XYZ under the gamut's own white (Y of white = 1). */
export function gamutToXyz(g: GamutId): ColorMatrix {
	let m = npmCache.get(g);
	if (!m) {
		m = npm(GAMUTS[g].primaries, GAMUTS[g].white);
		npmCache.set(g, m);
	}
	return m;
}

/** Linear RGB → CIE XYZ adapted to D65 (Bradford) — the reference space of every conversion here. */
export function gamutToXyzD65(g: GamutId): ColorMatrix {
	const w = GAMUTS[g].white;
	const m = gamutToXyz(g);
	return w[0] === D65[0] && w[1] === D65[1] ? m : mul3(bradford(w, D65), m);
}

/** Luminance weights (the Y row of the RGB → XYZ matrix). */
export function gamutLuma(g: GamutId): [number, number, number] {
	const m = gamutToXyz(g);
	return [m[3], m[4], m[5]];
}

const pairCache = new Map<string, ColorMatrix>();
/** Linear RGB in `src` → linear RGB in `dst`. */
export function gamutMatrix(src: GamutId, dst: GamutId): ColorMatrix {
	if (src === dst) return IDENTITY3;
	const key = `${src}>${dst}`;
	let m = pairCache.get(key);
	if (!m) {
		m = mul3(inv3(gamutToXyzD65(dst)), gamutToXyzD65(src));
		if (isIdentity3(m, 1e-12)) m = IDENTITY3;
		pairCache.set(key, m);
	}
	return m;
}

/**
 * Whether every colour of gamut `a` is inside gamut `b` (the triangle of `a`'s primaries inside `b`'s, compared in
 * D65-adapted xy). Decides whether a conversion needs gamut mapping.
 */
export function gamutWithin(a: GamutId, b: GamutId): boolean {
	if (a === b) return true;
	const m = gamutMatrix(a, b);
	// Each primary of `a` expressed in `b` must have no (meaningfully) negative component: P3's red is 0.1 % outside
	// BT.2020 by the published chromaticities, which every standard treats as inside.
	for (let c = 0; c < 3; c++) if (m[c]! < -0.005 || m[3 + c]! < -0.005 || m[6 + c]! < -0.005) return false;
	return true;
}
