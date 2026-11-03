// Cinematic: large quiet shapes. Wide tracking, a controlled metal ramp, and light that falls off slowly.
import { face, font, generator, glow, gradient, JA, radial, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const cinematic = (l: Parameters<typeof defineLook>[1]) => defineLook('cinematic', l);

export const CINEMATIC_LOOKS = [
	cinematic({
		slug: 'trailer-steel',
		name: 'Trailer Steel',
		nameEs: 'Acero de tráiler',
		tags: ['steel', 'metal', 'acero', 'chrome', 'cromo', 'dark', 'oscuro'],
		description: 'Engraved classical capitals in cold steel with a slow rim of light.',
		sampleText: 'COMING SOON',
		colorways: ['silver', 'gold', 'ember', 'pure-white'],
		font: font('Cinzel', 700, 'Playfair Display', ...JA.mincho, 0.06),
		layers: [
			shadow({ angle: 90, distance: 2.5, blur: 16, opacity: 72 }),
			glow(34, 30),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.4, 'face'], [0.5, 'faceAlt'], [0.62, 'face'], [1, 'accent3'])),
		],
	}),
	cinematic({
		slug: 'impact-burn',
		name: 'Impact Burn',
		nameEs: 'Impacto incandescente',
		tags: ['action', 'acción', 'condensed', 'condensada', 'bold', 'fire', 'fuego'],
		description: 'Tall condensed block letters that burn from the bottom up.',
		sampleText: 'IN THEATERS',
		colorways: ['ember', 'crimson', 'silver', 'cobalt'],
		font: font('Anton', 400, 'Oswald', ...JA.heavy, 0.03),
		layers: [
			shadow({ angle: 90, distance: 3, blur: 14, opacity: 76 }),
			glow(40, 72),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.42, 'face'], [1, 'faceAlt'])),
		],
	}),
	cinematic({
		slug: 'noir-spotlight',
		name: 'Noir Spotlight',
		nameEs: 'Foco de cine negro',
		tags: ['noir', 'thriller', 'drama', 'spotlight', 'foco', 'black and white', 'blanco y negro'],
		description: 'A fat serif caught in a spotlight that falls away towards the edges.',
		sampleText: 'Scene One',
		colorways: ['graphite', 'silver', 'rose', 'crimson'],
		font: font('Abril Fatface', 400, 'Playfair Display', ...JA.mincho, 0.01),
		layers: [
			glow(16, 48, { paint: role('shadow') }),
			shadow({ angle: 75, distance: 4, blur: 12, opacity: 80 }),
			face(radial([0, 'accent3'], [0.72, 'face'], [1, 'faceAlt'])),
		],
	}),
	cinematic({
		slug: 'anamorphic-flare',
		name: 'Anamorphic Flare',
		nameEs: 'Destello anamórfico',
		tags: ['anamorphic', 'anamórfico', 'lens', 'lente', 'flare', 'destello', 'sci-fi', 'blockbuster'],
		description: 'Widely tracked capitals in brushed light, crossed by a long horizontal lens streak.',
		sampleText: 'BEYOND THE STARS',
		colorways: ['cobalt', 'electric', 'ember', 'silver'],
		font: font('Bebas Neue', 400, 'Oswald', ...JA.gothic, 0.14),
		layers: [
			shadow({ angle: 90, distance: 2, blur: 14, opacity: 64 }),
			generator('lightStreaks', {
				count: 2,
				length: 240,
				thickness: 2.5,
				brightness: 200,
				halo: 60,
				extent: 200,
			}),
			glow(30, 34),
			face(gradient(90, [0, 'accent3'], [0.55, 'accent3'], [1, 'face'])),
		],
	}),
];
