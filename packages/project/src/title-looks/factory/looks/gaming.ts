// Gaming: geometric faces, emitted light and a hard dark edge so the glow reads as light and not as blur.
import { face, font, glow, gradient, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const gaming = (l: Parameters<typeof defineLook>[1]) => defineLook('gaming', l);

export const GAMING_LOOKS = [
	gaming({
		slug: 'plasma-core',
		name: 'Plasma Core',
		nameEs: 'Núcleo de plasma',
		tags: ['sci-fi', 'cyber', 'futuristic', 'futurista', 'glow', 'resplandor', 'esports'],
		description: 'A geometric face charged from inside, with a tight edge of light.',
		sampleText: 'LEVEL UP',
		colorways: ['electric', 'violet', 'emerald', 'ember'],
		font: font('Orbitron', 900, 'Audiowide', ...JA.heavy, 0.04),
		layers: [
			glow(52, 60),
			glow(16, 150, { technique: 'precise' }),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.5, 'face'], [1, 'faceAlt'])),
		],
	}),
	gaming({
		slug: 'stencil-ops',
		name: 'Stencil Ops',
		nameEs: 'Plantilla táctica',
		tags: ['stencil', 'military', 'tactical', 'militar', 'táctico', 'shooter'],
		description: 'Stencilled military lettering in worn metal.',
		sampleText: 'GO LOUD',
		colorways: ['graphite', 'emerald', 'ember', 'gold'],
		font: font('Black Ops One', 400, 'Russo One', ...JA.heavy, 0.02),
		layers: [
			shadow({ angle: 80, distance: 2.4, blur: 8, opacity: 70 }),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.5, 'face'], [1, 'faceAlt'])),
		],
	}),
];
