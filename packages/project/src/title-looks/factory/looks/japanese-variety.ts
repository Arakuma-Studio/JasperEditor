// Japanese Variety: telops. Heavy gothic faces in stacked outlines (袋文字): the face, a dark line, a light line, a colour
// frame. Thin strokes in kanji fill in fast, so rims stay under the stroke width. Practice sources in the wp note.
import { face, font, gradient, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const variety = (l: Parameters<typeof defineLook>[1]) => defineLook('japanese-variety', l);

export const JAPANESE_VARIETY_LOOKS = [
	variety({
		slug: 'variety-double-outline',
		name: 'Variety Double Outline',
		nameEs: 'Doble contorno de variedades',
		tags: ['telop', 'テロップ', '袋文字', 'tv', 'tele', 'variety', 'bold', 'バラエティ', 'ふくろもじ'],
		description: 'The classic bagged telop: a heavy gothic in a dark line and a bright frame.',
		sampleText: 'まさかの結末',
		colorways: ['gold', 'pure-white', 'crimson', 'cobalt'],
		font: font('Dela Gothic One', 400, 'Zen Kaku Gothic New', ...JA.heavy),
		layers: [
			shadow({ angle: 80, distance: 3, blur: 6, opacity: 60 }),
			rim(3.4, role('accent2')),
			rim(2.2, role('accent1')),
			rim(2.4, role('keyline')),
			face(),
		],
	}),
	variety({
		slug: 'variety-rock-gradient',
		name: 'Variety Rock Gradient',
		nameEs: 'Degradado rock de variedades',
		tags: ['telop', 'テロップ', 'gradient', 'グラデーション', 'degradado', 'loud', 'バラエティ'],
		description: 'A loud rock-poster gothic with a two-colour fall and a fat dark outline.',
		sampleText: '衝撃の瞬間',
		colorways: ['sunset', 'gold', 'crimson', 'electric'],
		font: font('RocknRoll One', 400, 'Dela Gothic One', ...JA.rock),
		layers: [
			shadow({ angle: 80, distance: 2.6, blur: 5, opacity: 60 }),
			rim(3, role('accent1')),
			rim(4.2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.45, 'face'], [1, 'faceAlt'])),
		],
	}),
];
