// Sports: heavy condensed letters, stacked rings in team colours and hard extrusion. Multi-ring contrast is the look: dark
// keyline, light line, team frame.
import { face, font, gradient, JA, longShadow, rim, role } from '../build.ts';
import { defineLook } from './define.ts';

const sports = (l: Parameters<typeof defineLook>[1]) => defineLook('sports', l);

export const SPORTS_LOOKS = [
	sports({
		slug: 'varsity-block',
		name: 'Varsity Block',
		nameEs: 'Bloque universitario',
		tags: ['varsity', 'college', 'jersey', 'camiseta', 'universidad', 'team colours'],
		description: 'A team-jersey stack: dark keyline, light line, team frame, solid extrusion.',
		sampleText: 'GAME DAY',
		colorways: ['crimson', 'cobalt', 'emerald', 'gold'],
		font: font('Anton', 400, 'Oswald', ...JA.heavy, 0.03),
		layers: [
			longShadow(8, 55),
			rim(3.6, role('accent2')),
			rim(2.6, role('accent1')),
			rim(2.2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.32, 'face'], [1, 'face'])),
		],
	}),
	sports({
		slug: 'final-score',
		name: 'Final Score',
		nameEs: 'Marcador final',
		tags: ['scoreboard', 'marcador', 'broadcast', 'retransmisión', 'highlights', 'resumen'],
		description: 'Square athletic letters with a metallic break across the middle, made for a scoreboard.',
		sampleText: 'FULL TIME',
		colorways: ['cobalt', 'crimson', 'silver', 'ocean'],
		font: font('Russo One', 400, 'Oswald', ...JA.heavy),
		layers: [
			longShadow(6, 90, role('shadow')),
			rim(2.4, role('accent1')),
			rim(2, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.48, 'face'], [0.52, 'faceAlt'], [1, 'face'])),
		],
	}),
];
