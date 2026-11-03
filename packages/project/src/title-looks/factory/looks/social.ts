// Social: words read on a phone over anything, in a second. A thick even outline beats every other device.
import { face, font, hardShadow, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const social = (l: Parameters<typeof defineLook>[1]) => defineLook('social', l);

export const SOCIAL_LOOKS = [
	social({
		slug: 'bold-outline',
		name: 'Bold Outline',
		nameEs: 'Contorno grueso',
		tags: [
			'caption',
			'subtítulo',
			'vertical video',
			'vídeo vertical',
			'outline',
			'contorno',
			'hook',
			'gancho',
		],
		description: 'Heavy white words in a thick black outline, readable on any clip.',
		sampleText: 'Wait for it',
		colorways: ['pure-white', 'gold', 'emerald', 'electric'],
		font: font('Poppins', 800, 'Montserrat', ...JA.heavy),
		layers: [shadow({ angle: 90, distance: 2, blur: 7, opacity: 50 }), rim(8.5, role('keyline')), face()],
	}),
	social({
		slug: 'pop-block',
		name: 'Pop Block',
		nameEs: 'Bloque pop',
		tags: ['hook', 'gancho', 'bold', 'negrita', 'punchy', 'contundente', 'thumbnail', 'miniatura'],
		description: 'A loud heavy word on a solid offset block, built for the first second.',
		sampleText: "DON'T SKIP",
		colorways: ['gold', 'crimson', 'electric', 'ocean'],
		font: font('Montserrat', 900, 'Poppins', ...JA.heavy, -0.01),
		layers: [hardShadow(4.2, 60, role('keyline')), rim(3, role('keyline')), face()],
	}),
];
