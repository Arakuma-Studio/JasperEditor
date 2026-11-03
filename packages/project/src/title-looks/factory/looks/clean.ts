// Clean: type does the work. One soft separation from the footage at most; nothing that draws attention to itself.
import { face, font, glow, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const clean = (l: Parameters<typeof defineLook>[1]) => defineLook('clean', l);

export const CLEAN_LOOKS = [
	clean({
		slug: 'clean-sans',
		name: 'Clean Sans',
		nameEs: 'Sans limpia',
		tags: ['sans', 'modern', 'moderno', 'neutral', 'ゴシック'],
		description: 'Plain modern sans with a barely visible lift off the picture.',
		sampleText: 'Your Title Here',
		colorways: ['pure-white', 'ink', 'graphite', 'corporate-navy'],
		font: font('Inter', 600, 'Source Sans 3', ...JA.gothic, -0.01),
		layers: [shadow({ angle: 90, distance: 1.2, blur: 7, opacity: 38 }), face()],
	}),
	clean({
		slug: 'quiet-serif',
		name: 'Quiet Serif',
		nameEs: 'Serifa discreta',
		tags: ['serif', 'editorial', 'documentary', 'documental', 'serifa', '明朝'],
		description: 'A calm editorial serif for documentaries and interviews.',
		sampleText: 'Chapter One',
		colorways: ['pure-white', 'ink', 'rose', 'graphite'],
		font: font('Playfair Display', 500, 'Source Sans 3', ...JA.mincho),
		layers: [shadow({ angle: 90, distance: 1, blur: 9, opacity: 34 }), face()],
	}),
	clean({
		slug: 'soft-halo',
		name: 'Soft Halo',
		nameEs: 'Halo suave',
		tags: ['readable', 'legible', 'busy background', 'fondo complejo', 'subtitle', 'subtítulo'],
		description: 'A wide dark halo keeps text readable on busy footage, with no visible edge.',
		sampleText: 'Read Me Anywhere',
		colorways: ['pure-white', 'gold', 'rose', 'graphite'],
		font: font('Poppins', 600, 'Source Sans 3', ...JA.gothic),
		layers: [glow(22, 62, { paint: role('shadow') }), face()],
	}),
	clean({
		slug: 'outline-only',
		name: 'Outline Only',
		nameEs: 'Solo contorno',
		tags: ['outline', 'hollow', 'contorno', 'hueco', 'stroke', 'trazo', '縁取り'],
		description: 'Hollow letters: a single even line, with the footage showing through.',
		sampleText: 'OPEN LINE',
		colorways: ['pure-white', 'gold', 'electric', 'ink'],
		font: font('Montserrat', 800, 'Inter', ...JA.gothic, 0.02),
		layers: [rim(3.4, role('face')), face(role('face'), { opacity: 0 })],
	}),
];
