// Luxury: quiet metal. Fine gradients, generous tracking and no heavy rings: a hard outline turns gold into a toy.
import { face, font, gradient, JA, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const luxury = (l: Parameters<typeof defineLook>[1]) => defineLook('luxury', l);

export const LUXURY_LOOKS = [
	luxury({
		slug: 'engraved-gold',
		name: 'Engraved Gold',
		nameEs: 'Oro grabado',
		tags: ['gold', 'oro', 'award', 'premio', 'gala', 'jewellery', 'joyería', '金'],
		description: 'Fine capitals in a banded gold with no outline at all.',
		sampleText: 'GRAND RESERVE',
		colorways: ['gold', 'silver', 'rose', 'graphite'],
		font: font('Cinzel', 600, 'Playfair Display', ...JA.mincho, 0.09),
		layers: [
			shadow({ angle: 90, distance: 1.2, blur: 7, opacity: 55 }),
			face(gradient(90, [0, 'accent3'], [0.34, 'face'], [0.52, 'faceAlt'], [0.68, 'face'], [1, 'accent3'])),
		],
	}),
	luxury({
		slug: 'couture-didone',
		name: 'Couture Didone',
		nameEs: 'Didona de alta costura',
		tags: ['fashion', 'moda', 'magazine', 'revista', 'perfume', 'didone'],
		description: 'A high-contrast fashion serif with a soft metallic fall of light.',
		sampleText: 'Atelier',
		colorways: ['rose', 'gold', 'pure-white', 'ink'],
		font: font('Abril Fatface', 400, 'Playfair Display', ...JA.mincho, 0.02),
		layers: [
			shadow({ angle: 90, distance: 1.6, blur: 10, opacity: 45 }),
			face(gradient(100, [0, 'accent3'], [0.55, 'face'], [1, 'faceAlt'])),
		],
	}),
];
