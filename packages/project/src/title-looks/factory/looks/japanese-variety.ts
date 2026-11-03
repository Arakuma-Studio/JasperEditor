// Japanese Variety: telops. Heavy gothic faces in stacked outlines (袋文字): the face, a dark line, a light line, a colour
// frame. Thin strokes in kanji fill in fast, so rims stay under the stroke width. Practice sources in the wp note.
import { face, font, gradient, hardShadow, JA, layer, rim, role, shadow } from '../build.ts';
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
	variety({
		slug: 'variety-round-pop',
		name: 'Variety Round Pop',
		nameEs: 'Pop redondo de variedades',
		tags: ['telop', 'テロップ', 'cute', 'かわいい', 'round', '丸文字', 'food', 'comida', 'グルメ'],
		description:
			'A soft rounded telop: light letters in a coloured frame and a darker edge, for food and kids.',
		sampleText: 'おいしい！',
		colorways: ['rose', 'sunset', 'ocean', 'emerald'],
		font: font('Zen Maru Gothic', 900, 'Fredoka', ...JA.round),
		layers: [
			shadow({ angle: 80, distance: 2.4, blur: 4, opacity: 55 }),
			rim(4.4, role('face')),
			rim(2.2, role('accent2')),
			face(role('accent1')),
		],
	}),
	variety({
		slug: 'variety-point-band',
		name: 'Variety Point Band',
		nameEs: 'Banda de punto clave',
		tags: ['telop', 'テロップ', 'band', 'banda', 'point', 'ポイント', 'explain', 'explicación', '帯'],
		description: 'A heavy gothic on a slanted dark band with a coloured drop, for the point of a segment.',
		sampleText: 'ここがポイント',
		colorways: ['gold', 'cobalt', 'crimson', 'emerald'],
		font: font('Zen Kaku Gothic New', 900, 'Dela Gothic One', ...JA.gothic),
		layers: [
			layer('plate', { kind: 'slant', grow: 12, skew: 14, corner: 3, paint: role('keyline') }),
			hardShadow(2.6, 60, role('accent2')),
			rim(2.2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.5, 'face'], [1, 'face'])),
		],
	}),
];
