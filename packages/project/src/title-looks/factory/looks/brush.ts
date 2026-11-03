// Brush (筆文字): ink laid by a brush. A brush face carries the stroke; frames are thin and follow it, a dry brush loses ink
// along its drag, and splashes or a swirl of the same ink sit behind. Structure adapted from Pachislop's brush looks
// (`brushLook`, `f-brush-kasure`; licenses/ported/pachislop-looks.md).
import { face, font, generator, glow, gradient, JA, layer, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const brush = (l: Parameters<typeof defineLook>[1]) => defineLook('brush', l);

/** Yuji Boku writes Latin and Japanese with the same brush, so it is its own Japanese face. */
const BRUSH_FONT = font(...JA.brush, 'Kaisei Tokumin', ...JA.brush);

export const BRUSH_LOOKS = [
	brush({
		slug: 'sumi-ink',
		name: 'Sumi Ink',
		nameEs: 'Tinta sumi',
		tags: ['sumi', 'ink', 'tinta', 'calligraphy', 'caligrafía', '書道', '墨', 'japanese', 'japonés'],
		description: 'Black brush lettering on a thin light frame, as if written on paper and cut out.',
		sampleText: '筆文字',
		colorways: ['ink', 'crimson', 'cobalt', 'graphite'],
		font: BRUSH_FONT,
		layers: [
			shadow({ angle: 60, distance: 3, blur: 10, opacity: 55 }),
			rim(2.4, role('keyline')),
			face(gradient(90, [0, 'faceAlt'], [0.5, 'face'], [1, 'face'])),
		],
	}),
	brush({
		slug: 'dry-brush',
		name: 'Dry Brush',
		nameEs: 'Pincel seco',
		tags: [
			'dry brush',
			'pincel seco',
			'かすれ',
			'rough',
			'áspero',
			'texture',
			'textura',
			'martial arts',
			'artes marciales',
		],
		description:
			'Ink that runs dry along the stroke, its frame breaking up with it, over a low coloured glow.',
		sampleText: '祭',
		colorways: ['ink', 'gold', 'crimson', 'pure-white'],
		font: BRUSH_FONT,
		layers: [
			glow(28, 70),
			rim(2.2, role('keyline')),
			face(gradient(90, [0, 'faceAlt'], [0.5, 'face'], [1, 'face'])),
			layer('texture', { kind: 'erosion', scale: 3, amount: 38, length: 35, edge: 16 }),
		],
	}),
	brush({
		slug: 'brush-and-seal',
		name: 'Brush and Seal',
		nameEs: 'Pincel y sello',
		tags: ['seal', 'sello', 'red ink', 'tinta roja', 'victory', 'victoria', '必勝', '朱'],
		description:
			'Coloured brush lettering edged in fine metal, a dark line and a light frame, with a soft drop.',
		sampleText: '必勝',
		colorways: ['crimson', 'gold', 'ink', 'violet'],
		font: BRUSH_FONT,
		layers: [
			shadow({ angle: 60, distance: 4, blur: 12, opacity: 65 }),
			rim(2.4, role('accent1')),
			rim(0.9, role('keyline')),
			rim(1.2, role('accent3'), { finish: 'metal', metalKind: 'gold', metalTint: 60, metalSize: 1.2 }),
			face(gradient(90, [0, 'accent3'], [0.45, 'face'], [1, 'faceAlt']), {
				finish: 'bevel',
				bevelSize: 1.4,
				bevelHighlight: 55,
				bevelShadow: 55,
			}),
		],
	}),
	brush({
		slug: 'ink-swirl',
		name: 'Ink Swirl',
		nameEs: 'Remolino de tinta',
		tags: ['swirl', 'remolino', 'splash', 'salpicadura', 'ink', 'tinta', 'enso', '円相', 'action', 'acción'],
		description: 'Brush lettering over a wide swirl of the same ink and a scatter of splashes.',
		sampleText: '魂',
		colorways: ['ink', 'crimson', 'gold', 'cobalt'],
		font: BRUSH_FONT,
		layers: [
			generator('brushSwirl', {
				path: 'ring',
				radius: 90,
				strokes: 3,
				strokeWidth: 22,
				paint: role('accent2'),
			}),
			generator('inkSplatter', { amount: 35, spread: 55, paint: role('face') }),
			rim(2.2, role('keyline')),
			face(),
		],
	}),
];
