// Horror: wet dark reds that sink into the frame. The glow is low and wide, like light through fog.
import { face, font, generator, glow, gradient, JA, layer, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const horror = (l: Parameters<typeof defineLook>[1]) => defineLook('horror', l);

export const HORROR_LOOKS = [
	horror({
		slug: 'blood-drip',
		name: 'Blood Drip',
		nameEs: 'Goteo de sangre',
		tags: ['blood', 'sangre', 'halloween', 'slasher', 'gore', 'zombie', 'zombi'],
		description: 'Dripping letters soaking from bright to almost black.',
		sampleText: 'DO NOT ENTER',
		colorways: ['crimson', 'emerald', 'violet', 'ember'],
		font: font('Creepster', 400, 'Bangers', ...JA.brush, 0.03),
		layers: [
			shadow({ angle: 90, distance: 3, blur: 10, opacity: 80 }),
			glow(34, 38),
			rim(2, role('base')),
			face(gradient(90, [0, 'face'], [1, 'faceAlt'])),
		],
	}),
	horror({
		slug: 'haunted-mist',
		name: 'Haunted Mist',
		nameEs: 'Niebla encantada',
		tags: ['ghost', 'fantasma', 'fog', 'niebla', 'haunted', 'encantado', 'mystery', 'misterio', '幽霊'],
		description: 'Pale engraved capitals rising out of slow drifting fog.',
		sampleText: 'MIDNIGHT',
		colorways: ['silver', 'emerald', 'violet', 'cobalt'],
		font: font('Cinzel', 900, 'Playfair Display', ...JA.mincho, 0.07),
		layers: [
			generator('smoke', { height: 70, softness: 75, speed: 0.3, paint: role('glow'), opacity: 70 }),
			glow(22, 40, { paint: role('shadow') }),
			face(gradient(90, [0, 'accent3'], [1, 'face'])),
		],
	}),
	horror({
		slug: 'cursed-flame',
		name: 'Cursed Flame',
		nameEs: 'Llama maldita',
		tags: ['fire', 'fuego', 'hell', 'infierno', 'demon', 'demonio', 'burning', 'ardiendo', '炎'],
		description: 'Charred letters in a red rim with real flames licking up behind them.',
		sampleText: 'BURN',
		colorways: ['crimson', 'ember', 'violet', 'emerald'],
		font: font('Black Ops One', 400, 'Anton', ...JA.heavy, 0.04),
		layers: [
			generator('fire', { height: 60, intensity: 120 }, [1, 0.45, 0.08, 1]),
			rim(2.6, role('accent2')),
			rim(1.6, role('keyline')),
			face(gradient(90, [0, 'faceAlt'], [1, 'base']), { finish: 'bevel', bevelSize: 3, bevelHighlight: 40 }),
			layer('innerGlow', { radius: 8, intensity: 120, paint: role('glow') }),
		],
	}),
	horror({
		slug: 'rotten-print',
		name: 'Rotten Print',
		nameEs: 'Impresión podrida',
		tags: ['worn', 'gastado', 'grunge', 'decay', 'descomposición', 'thriller', 'found footage'],
		description: 'A heavy serif eaten away at its edges, as if printed on rotten paper.',
		sampleText: 'DO NOT OPEN',
		colorways: ['crimson', 'graphite', 'emerald', 'gold'],
		font: font('Abril Fatface', 400, 'Playfair Display', ...JA.mincho, 0.02),
		layers: [
			shadow({ angle: 90, distance: 2, blur: 10, opacity: 70 }),
			face(gradient(90, [0, 'face'], [1, 'faceAlt'])),
			layer('texture', { kind: 'erosion', scale: 4, amount: 42, length: 26, edge: 12 }),
		],
	}),
];
