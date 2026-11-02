// Neon & Retro. A tube is a near-white core in a saturated sheath with two falloffs of light; retro chrome is a hard horizon
// between a light sky and a dark ground (structure from Pachislop's neon looks, licenses/ported/pachislop-looks.md).
import { face, font, glow, gradient, JA, longShadow, rim, role } from '../build.ts';
import { defineLook } from './define.ts';

const neon = (l: Parameters<typeof defineLook>[1]) => defineLook('neon-retro', l);

export const NEON_RETRO_LOOKS = [
	neon({
		slug: 'neon-tube',
		name: 'Neon Tube',
		nameEs: 'Tubo de neón',
		tags: ['neon', 'neón', 'sign', 'letrero', 'bar', 'night', 'noche', 'ネオン'],
		description: 'A glass tube sign: a white-hot core, a saturated sheath and light on the air around it.',
		sampleText: 'Open Late',
		colorways: ['electric', 'violet', 'sunset', 'crimson'],
		font: font('Pacifico', 400, 'Poppins', ...JA.round),
		layers: [glow(58, 58), glow(15, 120), rim(2.2, role('glow')), face(role('accent3'))],
	}),
	neon({
		slug: 'hollow-neon',
		name: 'Hollow Neon',
		nameEs: 'Neón hueco',
		tags: ['outline', 'contorno', 'hollow', 'hueco', 'arcade', 'tube', 'tubo'],
		description: 'Only the tube outline, so the footage stays visible through the letters.',
		sampleText: 'TONIGHT',
		colorways: ['violet', 'electric', 'ember', 'emerald'],
		font: font('Righteous', 400, 'Poppins', ...JA.round, 0.03),
		layers: [
			glow(46, 52),
			glow(12, 110),
			rim(1.7, role('glow')),
			rim(1.5, role('accent3')),
			face(role('face'), { opacity: 0 }),
		],
	}),
	neon({
		slug: 'horizon-chrome',
		name: 'Horizon Chrome',
		nameEs: 'Cromo de horizonte',
		tags: ['synthwave', '80s', 'años 80', 'chrome', 'cromo', 'vaporwave', 'レトロ'],
		description: 'Eighties chrome: a bright sky meeting a hard horizon, with a solid extrusion.',
		sampleText: 'RETRO WAVE',
		colorways: ['sunset', 'electric', 'violet', 'silver'],
		font: font('Bungee', 400, 'Righteous', ...JA.heavy),
		layers: [
			longShadow(7, 60, role('accent2')),
			rim(2.4, role('keyline')),
			face(
				gradient(90, [0, 'accent3'], [0.46, 'face'], [0.49, 'keyline'], [0.53, 'faceAlt'], [1, 'accent3']),
			),
		],
	}),
];
