// Horror: wet dark reds that sink into the frame. The glow is low and wide, like light through fog.
import { face, font, glow, gradient, JA, rim, role, shadow } from '../build.ts';
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
			rim(1.8, role('base')),
			face(gradient(90, [0, 'face'], [1, 'faceAlt'])),
		],
	}),
];
