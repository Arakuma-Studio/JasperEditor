// Corporate: restraint. Brand colour appears once, shadows stay soft, and no gradient draws attention to itself.
import { face, font, gradient, hardShadow, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const corporate = (l: Parameters<typeof defineLook>[1]) => defineLook('corporate', l);

export const CORPORATE_LOOKS = [
	corporate({
		slug: 'boardroom',
		name: 'Boardroom',
		nameEs: 'Sala de juntas',
		tags: ['headline', 'titular', 'keynote', 'presentation', 'presentación'],
		description: 'Confident bold sans with a fine navy line that holds on any footage.',
		sampleText: 'Quarterly Review',
		colorways: ['corporate-navy', 'graphite', 'pure-white', 'cobalt'],
		font: font('Montserrat', 700, 'Inter', ...JA.gothic),
		layers: [shadow({ angle: 90, distance: 1.6, blur: 9, opacity: 42 }), rim(2.6, role('keyline')), face()],
	}),
	corporate({
		slug: 'polished-gradient',
		name: 'Polished Gradient',
		nameEs: 'Degradado pulido',
		tags: ['gradient', 'degradado', 'product', 'producto', 'launch', 'lanzamiento'],
		description: 'A slow top-to-bottom shift gives the letters weight without becoming an effect.',
		sampleText: 'Product Launch',
		colorways: ['corporate-navy', 'silver', 'rose', 'ocean'],
		font: font('Poppins', 600, 'Inter', ...JA.gothic),
		layers: [
			shadow({ angle: 90, distance: 1.4, blur: 8, opacity: 40 }),
			face(gradient(90, [0, 'face'], [1, 'faceAlt'])),
		],
	}),
	corporate({
		slug: 'offset-accent',
		name: 'Offset Accent',
		nameEs: 'Acento desplazado',
		tags: ['brand', 'marca', 'accent', 'acento', 'startup'],
		description: 'A crisp offset in the brand colour, the one graphic gesture the title makes.',
		sampleText: 'Meet the Team',
		colorways: ['corporate-navy', 'ocean', 'crimson', 'gold'],
		font: font('Montserrat', 800, 'Inter', ...JA.gothic),
		layers: [hardShadow(3.2, 45, role('accent2')), face()],
	}),
];
