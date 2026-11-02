// Playful: round shapes, a fat sticker edge and soft shadows. Light and dark rings still alternate, so it reads at any size.
import { face, font, gradient, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const playful = (l: Parameters<typeof defineLook>[1]) => defineLook('playful', l);

export const PLAYFUL_LOOKS = [
	playful({
		slug: 'die-cut-sticker',
		name: 'Die-Cut Sticker',
		nameEs: 'Pegatina troquelada',
		tags: ['sticker', 'pegatina', 'kids', 'niños', 'stamp', 'ステッカー'],
		description: 'A vinyl sticker: a thick light border cut around the letters, lifted off the page.',
		sampleText: 'Super Fun!',
		colorways: ['ocean', 'crimson', 'violet', 'gold'],
		font: font('Titan One', 400, 'Fredoka', ...JA.round),
		layers: [
			shadow({ angle: 80, distance: 2.4, blur: 5, opacity: 58 }),
			rim(5.4, role('accent1')),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'face'], [1, 'faceAlt'])),
		],
	}),
	playful({
		slug: 'soft-bubble',
		name: 'Soft Bubble',
		nameEs: 'Burbuja suave',
		tags: ['bubble', 'burbuja', 'round', 'redondeado', 'cute', 'tierno', 'baby', 'かわいい'],
		description: 'Rounded letters full of air, with a pale top and a soft dark edge.',
		sampleText: 'Hello There',
		colorways: ['rose', 'ocean', 'gold', 'violet'],
		font: font('Fredoka', 700, 'Poppins', ...JA.round),
		layers: [
			shadow({ angle: 90, distance: 2, blur: 8, opacity: 48 }),
			rim(3.2, role('faceAlt')),
			face(gradient(90, [0, 'accent3'], [0.7, 'face'], [1, 'face'])),
		],
	}),
];
