// Pachinko & Arcade. The gold ladder is the five-layer stack Pachislop's outline looks use: a banded face, a dark keyline, a
// light line, a thick colour frame at 1 : 2 and a dropped base, with a warm tinted shadow and glow behind
// (licenses/ported/pachislop-looks.md). Every colour is a role, so it takes any colourway.
import { face, font, glow, gradient, hardShadow, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

const arcade = (l: Parameters<typeof defineLook>[1]) => defineLook('pachinko-arcade', l);

export const PACHINKO_ARCADE_LOOKS = [
	arcade({
		slug: 'gold-ladder',
		name: 'Gold Ladder',
		nameEs: 'Escalera de oro',
		tags: ['jackpot', 'bonus', 'slots', 'casino', 'gold', 'oro', '金', '確定', '大当たり', 'パチンコ'],
		description: 'A banded metal face in a stacked ladder of rings on a dropped base.',
		sampleText: '大当たり',
		colorways: ['gold', 'crimson', 'cobalt', 'violet'],
		font: font('Reggae One', 400, 'Dela Gothic One', ...JA.pop),
		layers: [
			shadow({ angle: 90, distance: 6, blur: 14, opacity: 60 }),
			glow(26, 56),
			hardShadow(3, 90),
			rim(3.6, gradient(90, [0, 'accent2'], [0.5, 'faceAlt'], [1, 'accent2'])),
			rim(1.9, role('accent1')),
			rim(1.3, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.3, 'face'], [0.5, 'faceAlt'], [0.68, 'face'], [1, 'accent3'])),
		],
	}),
	arcade({
		slug: 'pixel-marquee',
		name: 'Pixel Marquee',
		nameEs: 'Marquesina de píxeles',
		tags: ['pixel', 'píxeles', '8-bit', 'retro game', 'arcade', 'videojuego retro', 'ドット', 'アーケード'],
		description: 'A blocky 8-bit marquee with a hard two-step shadow and no blur at all.',
		sampleText: 'INSERT COIN',
		colorways: ['gold', 'emerald', 'electric', 'crimson'],
		font: font('Press Start 2P', 400, 'Bungee', ...JA.pixel),
		layers: [hardShadow(6, 45, role('accent2')), hardShadow(3, 45, role('faceAlt')), face()],
	}),
];
