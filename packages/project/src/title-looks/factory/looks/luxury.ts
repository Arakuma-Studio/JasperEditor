// Luxury: quiet metal. Fine gradients, generous tracking and no heavy rings: a hard outline turns gold into a toy.
import { face, font, generator, glow, gradient, JA, layer, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const luxury = (l: Parameters<typeof defineLook>[1]) => defineLook('luxury', l);

export const LUXURY_LOOKS = [
	luxury({
		slug: 'engraved-gold',
		name: 'Engraved Gold',
		nameEs: 'Oro grabado',
		tags: ['gold', 'oro', 'award', 'premio', 'gala', 'jewellery', 'joyería', '金'],
		description: 'Fine capitals in a banded gold with no outline at all.',
		sampleText: 'GALA NIGHT',
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
	luxury({
		slug: 'gold-leaf',
		name: 'Gold Leaf',
		nameEs: 'Pan de oro',
		tags: ['gold leaf', 'pan de oro', 'gilded', 'dorado', 'wedding', 'boda', 'invitation', 'invitación', '金箔'],
		description: 'Fine capitals in polished leaf that catches a few points of light.',
		sampleText: 'Grand Opening',
		colorways: ['gold', 'rose', 'silver', 'pure-white'],
		font: font('Cinzel', 700, 'Playfair Display', ...JA.mincho, 0.08),
		layers: [
			shadow({ angle: 90, distance: 1.4, blur: 8, opacity: 55 }),
			face(role('face'), { finish: 'metal', metalKind: 'gold', metalTint: 70, metalSize: 8, metalCurve: 30 }),
			generator('glints', { placement: 'highlights', large: 2, small: 4, size: 16, twinkle: 60 }),
		],
	}),
	luxury({
		slug: 'black-lacquer',
		name: 'Black Lacquer',
		nameEs: 'Laca negra',
		tags: ['black', 'negro', 'lacquer', 'laca', 'premium', 'gloss', 'brillo', '高級'],
		description: 'Glossy black letters edged with a thin line of polished metal.',
		sampleText: 'PRIVATE COLLECTION',
		colorways: ['gold', 'silver', 'rose', 'crimson'],
		font: font('Cinzel', 800, 'Playfair Display', ...JA.mincho, 0.05),
		layers: [
			shadow({ angle: 90, distance: 2, blur: 12, opacity: 60 }),
			glow(18, 45),
			rim(2.6, role('face'), { finish: 'metal', metalKind: 'gold', metalTint: 80, metalSize: 2.6 }),
			face(gradient(90, [0, 'keyline'], [1, 'base']), { finish: 'gloss', glossIntensity: 55, glossHeight: 46 }),
			layer('sheen', { angle: 25, position: 40, width: 14, intensity: 60, paint: role('accent3') }),
		],
	}),
];
