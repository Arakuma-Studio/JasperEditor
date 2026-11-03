// Pachinko & Arcade. The gold ladder is the five-layer stack Pachislop's outline looks use: a banded face, a dark keyline, a
// light line, a thick colour frame at 1 : 2 and a dropped base, with a warm tinted shadow and glow behind
// (licenses/ported/pachislop-looks.md). Every colour is a role, so it takes any colourway, except the rainbow face, which is
// fixed (TL-051) because a rainbow is every hue: its rings still follow the colourway.
import type { Paint } from '../../model.ts';
import { face, font, generator, glow, gradient, hardShadow, JA, rim, role, shadow } from '../build.ts';
import { defineLook } from './define.ts';

/**
 * Pachislop's uneven rainbow (`GRADIENTS.rainbowFill`): seven hues with a white band inside. A fixed colour (TL-051): a
 * rainbow is every hue, so no colourway could fill it; the rings around it follow the colourway.
 */
const RAINBOW: Paint = {
	kind: 'gradient',
	gradient: {
		type: 'linear',
		span: 'block',
		angle: 90,
		stops: [
			{ at: 0, paint: { color: [1, 0.16, 0.2, 1] } },
			{ at: 0.18, paint: { color: [1, 0.55, 0.1, 1] } },
			{ at: 0.32, paint: { color: [1, 0.92, 0.2, 1] } },
			{ at: 0.42, paint: { color: [1, 1, 1, 1] } },
			{ at: 0.52, paint: { color: [0.25, 0.9, 0.35, 1] } },
			{ at: 0.68, paint: { color: [0.15, 0.6, 1, 1] } },
			{ at: 0.84, paint: { color: [0.45, 0.25, 1, 1] } },
			{ at: 1, paint: { color: [0.85, 0.2, 0.9, 1] } },
		],
	},
};

/** One pixel of an 8×8 font on the diagonal, percent of the size. */
const PIXEL_DIAGONAL = 12.5 * Math.SQRT2;

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
		// One and two font pixels (an eighth of the size) to the lower right, so the shadow stays on the font's grid.
		layers: [
			hardShadow(PIXEL_DIAGONAL * 2, 45, role('accent2')),
			hardShadow(PIXEL_DIAGONAL, 45, role('faceAlt')),
			face(),
		],
	}),
	arcade({
		slug: 'rainbow-confirm',
		name: 'Rainbow Confirm',
		nameEs: 'Confirmación arcoíris',
		tags: ['rainbow', 'arcoíris', '虹', '確定', 'premium', 'jackpot', 'bonus', 'パチンコ'],
		description: 'A bevelled rainbow face in a ladder of metal rings: the rarest result on the screen.',
		sampleText: '確定',
		colorways: ['gold', 'silver', 'violet', 'cobalt'],
		font: font('Reggae One', 400, 'Dela Gothic One', ...JA.pop),
		layers: [
			shadow({ angle: 90, distance: 5, blur: 12, opacity: 60 }),
			glow(26, 60, { paint: role('accent3') }),
			hardShadow(2.6, 90),
			rim(3, role('face'), { finish: 'metal', metalKind: 'gold', metalTint: 70, metalSize: 3 }),
			rim(1.4, role('keyline')),
			rim(1.6, role('accent3')),
			{
				type: 'face',
				fixedColor: true,
				params: { paint: RAINBOW, finish: 'bevel', bevelSize: 3, bevelHighlight: 70 },
			},
		],
	}),
	arcade({
		slug: 'ray-burst',
		name: 'Ray Burst',
		nameEs: 'Estallido de rayos',
		tags: ['rays', 'rayos', 'burst', 'estallido', 'sparkle', 'destello', 'bonus', '大当たり', 'スロット'],
		description: 'A banded metal word in front of turning rays, sparkling where the light hits it.',
		sampleText: 'BONUS',
		colorways: ['gold', 'crimson', 'cobalt', 'emerald'],
		font: font('Bungee', 400, 'Russo One', ...JA.heavy, 0.02),
		layers: [
			generator('sunburst', {
				rays: 18,
				spin: 10,
				inner: 30,
				extent: 150,
				rayOpacity: 55,
				paint: role('glow'),
			}),
			shadow({ angle: 90, distance: 4, blur: 10, opacity: 60 }),
			rim(3, role('accent2')),
			rim(1.8, role('accent1')),
			rim(1.4, role('keyline')),
			face(gradient(90, [0, 'accent3'], [0.32, 'face'], [0.55, 'faceAlt'], [0.75, 'face'], [1, 'accent3'])),
			generator('glints', { placement: 'highlights', large: 3, small: 5, size: 22 }),
		],
	}),
];
