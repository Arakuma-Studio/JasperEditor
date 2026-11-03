// 3D: depth drawn by the look itself, so it renders on every path a look does. An extrusion from the outermost rim gives the
// walls, a bevel or a metal dome gives the face its relief, and plates stack behind like solid backings. A look is an
// appearance (TL-055): the Advanced 3D solid of a clip (spec 19 §9) stays in Properties ▸ 3D Title. Adapted from Pachislop's
// 3D looks (`赤壁` depth-fade walls, `ぷっくり` inflate candy, slanted box plates; licenses/ported/pachislop-looks.md).
import { face, font, gradient, JA, layer, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const threeD = (l: Parameters<typeof defineLook>[1]) => defineLook('3d', l);

/** Walls that run from a colour at the face to dark at the back. */
const walls = (depth: number, angle: number, front: 'accent2' | 'faceAlt' | 'keyline', params = {}) =>
	layer('extrude', {
		angle,
		depth,
		paint: gradient(0, [0, front], [1, 'shadow']),
		shading: 70,
		edge: 50,
		...params,
	});

export const THREE_D_LOOKS = [
	threeD({
		slug: 'gold-walls',
		name: 'Gold Walls',
		nameEs: 'Muros de oro',
		tags: ['extrude', 'extrusión', 'depth', 'profundidad', 'gold', 'oro', 'block', 'bloque', '立体'],
		description: 'A domed metal face on deep coloured walls that fade into the dark behind it.',
		sampleText: 'BIG WIN',
		colorways: ['gold', 'silver', 'crimson', 'cobalt'],
		font: font('Bungee', 400, 'Russo One', ...JA.heavy, 0.02),
		layers: [
			shadow({ angle: 90, distance: 5, blur: 14, opacity: 60 }),
			rim(2.2, role('keyline')),
			face(role('face'), {
				finish: 'gradientMap',
				gradientMapRamp: gradient(0, [0, 'shadow'], [0.35, 'faceAlt'], [0.7, 'face'], [1, 'accent3']),
				gradientMapSize: 10,
			}),
			walls(16, 70, 'accent2', { fade: 35 }),
		],
	}),
	threeD({
		slug: 'puffy-candy',
		name: 'Puffy Candy',
		nameEs: 'Caramelo inflado',
		tags: ['inflate', 'inflado', 'puffy', 'hinchado', 'balloon', 'globo', 'bubble', 'burbuja', 'ぷっくり'],
		description: 'Letters blown up like a balloon, with a bright cap of light and a soft shadow underneath.',
		sampleText: 'PUFFY',
		colorways: ['rose', 'ocean', 'violet', 'emerald'],
		font: font('Titan One', 400, 'Fredoka', ...JA.round),
		layers: [
			shadow({ angle: 90, distance: 4, blur: 12, opacity: 50 }),
			walls(6, 90, 'faceAlt', { shading: 50, edge: 30 }),
			face(gradient(90, [0, 'accent3'], [0.5, 'face'], [1, 'faceAlt']), {
				finish: 'bevel',
				bevelProfile: 'round',
				bevelSize: 14,
				bevelFit: true,
				bevelHighlight: 90,
				bevelShadow: 55,
			}),
			layer('gloss', { height: 42, curve: 55, intensity: 70, paint: role('accent3') }),
		],
	}),
	threeD({
		slug: 'chrome-block',
		name: 'Chrome Block',
		nameEs: 'Bloque cromado',
		tags: ['chrome', 'cromo', 'metal', 'block', 'bloque', '80s', 'años 80', 'heavy', 'pesado'],
		description: 'A mirrored chrome face over dark extruded sides, crisp at every edge.',
		sampleText: 'MAXIMUM',
		colorways: ['silver', 'cobalt', 'sunset', 'gold'],
		font: font('Archivo Black', 400, 'Anton', ...JA.heavy, 0.02),
		layers: [
			shadow({ angle: 90, distance: 4, blur: 12, opacity: 60 }),
			rim(1.6, role('accent1')),
			rim(1.2, role('keyline')),
			face(role('face'), { finish: 'metal', metalKind: 'chrome', metalTint: 25, metalSize: 10, metalCurve: 55 }),
			walls(12, 60, 'keyline', { shading: 80 }),
		],
	}),
	threeD({
		slug: 'stacked-plates',
		name: 'Stacked Plates',
		nameEs: 'Placas apiladas',
		tags: ['plates', 'placas', 'slanted', 'inclinado', 'badge', 'insignia', 'layers', 'capas', '看板'],
		description: 'A bevelled title on two leaning plates stacked like solid boards, with depth under them.',
		sampleText: 'FINAL ROUND',
		colorways: ['crimson', 'gold', 'cobalt', 'emerald'],
		font: font('Anton', 400, 'Oswald', ...JA.heavy, 0.04),
		layers: [
			shadow({ angle: 90, distance: 4, blur: 12, opacity: 60 }),
			layer('plate', { kind: 'slant', grow: 20, skew: 12, corner: 4, paint: role('keyline') }),
			layer('plate', {
				kind: 'slant',
				grow: 14,
				skew: 12,
				corner: 3,
				paint: gradient(90, [0, 'accent2'], [1, 'base']),
				finish: 'bevel',
				bevelSize: 3,
				bevelHighlight: 60,
			}),
			rim(2.2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.4, 'face'], [1, 'faceAlt']), {
				finish: 'bevel',
				bevelSize: 3,
				bevelHighlight: 75,
			}),
			walls(8, 75, 'keyline', { shading: 60 }),
		],
	}),
];
