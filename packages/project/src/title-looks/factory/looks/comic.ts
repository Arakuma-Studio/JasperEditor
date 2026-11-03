// Comic: flat inked shapes. Black line first, colour second, and a hard offset instead of any blur.
import { face, font, generator, gradient, hardShadow, JA, rim, role } from '../build.ts';
import { defineLook } from './define.ts';

const comic = (l: Parameters<typeof defineLook>[1]) => defineLook('comic', l);

export const COMIC_LOOKS = [
	comic({
		slug: 'comic-burst',
		name: 'Comic Burst',
		nameEs: 'Estallido de cómic',
		tags: ['superhero', 'superhéroe', 'action', 'acción', 'pop art', 'sound effect', 'onomatopeya'],
		description: 'A bright inked sound effect with a light outer line and a hard drop.',
		sampleText: 'KAPOW',
		colorways: ['gold', 'crimson', 'cobalt', 'emerald'],
		font: font('Bangers', 400, 'Lilita One', ...JA.pop, 0.04),
		layers: [
			hardShadow(6, 50),
			rim(3.6, role('accent1')),
			rim(3.2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.4, 'face'], [1, 'faceAlt'])),
		],
	}),
	comic({
		slug: 'flat-ink',
		name: 'Flat Ink',
		nameEs: 'Tinta plana',
		tags: ['flat', 'plano', 'manga', 'cel', 'dibujos', 'マンガ'],
		description: 'One colour, one inked line, one offset. A cel on a page.',
		sampleText: 'Meanwhile...',
		colorways: ['pure-white', 'gold', 'ocean', 'crimson'],
		font: font('Lilita One', 400, 'Poppins', ...JA.pop, 0.01),
		layers: [hardShadow(3.5, 50), rim(3.2, role('keyline')), face()],
	}),
	comic({
		slug: 'halftone-pop',
		name: 'Halftone Pop',
		nameEs: 'Trama pop',
		tags: ['halftone', 'trama', 'dots', 'puntos', 'pop art', 'retro print', 'impresión'],
		description: 'Printed letters with a halftone dot screen, an inked line and a hard offset.',
		sampleText: 'ZAP!',
		colorways: ['crimson', 'gold', 'cobalt', 'ocean'],
		font: font('Bangers', 400, 'Lilita One', ...JA.pop, 0.05),
		layers: [
			hardShadow(5, 45),
			rim(3, role('keyline')),
			face(role('face'), {
				finish: 'pattern',
				patternKind: 'dots',
				patternScale: 4,
				patternAngle: 45,
				patternInk: role('accent3'),
				patternInkAlt: role('face'),
				patternOpacity: 55,
			}),
		],
	}),
	comic({
		slug: 'manga-impact',
		name: 'Manga Impact',
		nameEs: 'Impacto manga',
		tags: ['manga', 'マンガ', 'anime', 'focus lines', 'líneas de enfoque', '集中線', 'impact', 'impacto'],
		description: 'Inked lettering at the centre of a burst of focus lines.',
		sampleText: 'ドーン',
		colorways: ['pure-white', 'gold', 'crimson', 'electric'],
		font: font('Bangers', 400, 'Lilita One', ...JA.pop, 0.03),
		layers: [
			generator('speedLines', {
				kind: 'focus',
				focus: 'title',
				padding: 14,
				count: 120,
				extent: 150,
				paint: role('glow'),
			}),
			hardShadow(4, 60),
			rim(3.4, role('keyline')),
			face(),
		],
	}),
];
