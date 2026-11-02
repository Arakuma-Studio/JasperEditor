// Spec 19 TL-051: the colourways of the library. Each fills all nine roles explicitly, so a colourway works on any look
// and nothing is guessed from a colour. Structure and colour stay apart: a colourway is role values only.
//
// What the roles promise a look, checked by the library test against every colourway:
//   face         main fill                         faceAlt  deep end of a face gradient
//   accent3      highlight of a face gradient       keyline  the line touching the face, opposite in lightness
//   accent1      next ring, opposite to the keyline accent2  outer frame, apart from accent1
//   base         darkest backing                    glow     light (bright: L* ≥ 60)
//   shadow       a dark tint, never pure black: a hard black shadow reads cheap, a tinted one sits in the picture
//
// Colour rules from Pachislop's presets/colourways.ts (licenses/ported/pachislop-looks.md): blue and green take silver
// accent rings, red takes gold; red stays hue 0 with contrast from lightness only; gold runs white, yellow, orange,
// brown and never olive; rings alternate light and dark.
import type { RGBA } from '../../schema/common.ts';
import type { Role } from '../model.ts';
import type { FactoryColorway } from './build.ts';

/** `#rrggbb` as a signal colour. */
export function hex(s: string): RGBA {
	const n = Number.parseInt(s.slice(1), 16);
	const c = (v: number) => Math.round((v / 255) * 10000) / 10000;
	return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255), 1];
}

type Hexes = Record<Role, string>;

const way = (
	slug: string,
	name: string,
	nameEs: string,
	tags: readonly string[],
	c: Hexes,
): FactoryColorway => ({
	id: `colorway.${slug}`,
	name,
	nameEs,
	tags,
	palette: Object.fromEntries(Object.entries(c).map(([r, v]) => [r, hex(v)])) as Record<Role, RGBA>,
});

export const FACTORY_COLORWAYS: readonly FactoryColorway[] = [
	way('pure-white', 'Pure White', 'Blanco puro', ['white', 'blanco', '白'], {
		face: '#ffffff',
		faceAlt: '#b6becc',
		accent3: '#ffffff',
		keyline: '#14171f',
		accent1: '#ffffff',
		accent2: '#58607a',
		base: '#05070c',
		glow: '#dfe6ff',
		shadow: '#1a2040',
	}),
	way('corporate-navy', 'Corporate Navy', 'Azul marino corporativo', ['navy', 'blue', 'azul marino'], {
		face: '#f4f7fb',
		faceAlt: '#b7c4d6',
		accent3: '#ffffff',
		keyline: '#0e2240',
		accent1: '#e8eef8',
		accent2: '#2f6fde',
		base: '#081426',
		glow: '#7fb0ff',
		shadow: '#081426',
	}),
	way('graphite', 'Graphite', 'Grafito', ['grey', 'gray', 'monochrome', 'gris', 'monocromo'], {
		face: '#e8e8ea',
		faceAlt: '#7e8288',
		accent3: '#ffffff',
		keyline: '#16181c',
		accent1: '#c8ccd2',
		accent2: '#3a3e46',
		base: '#0a0b0d',
		glow: '#f0f2f6',
		shadow: '#0c0d10',
	}),
	way('ink', 'Ink on Light', 'Tinta sobre claro', ['black', 'dark text', 'negro', 'texto oscuro', '黒'], {
		face: '#12141a',
		faceAlt: '#3a3e48',
		accent3: '#5a6070',
		keyline: '#ffffff',
		accent1: '#12141a',
		accent2: '#c8ccd2',
		base: '#12141a',
		glow: '#ffffff',
		shadow: '#30343c',
	}),
	way('gold', 'Gold', 'Oro', ['gold', 'yellow', 'oro', 'amarillo', '金'], {
		face: '#ffc81e',
		faceAlt: '#b84000',
		accent3: '#fff8b8',
		keyline: '#140800',
		accent1: '#ffd860',
		accent2: '#b3120a',
		base: '#120600',
		glow: '#ffb000',
		shadow: '#3a1800',
	}),
	way('silver', 'Silver', 'Plata', ['silver', 'chrome', 'steel', 'plata', 'cromo', 'acero', '銀'], {
		face: '#d6dde8',
		faceAlt: '#5a6578',
		accent3: '#ffffff',
		keyline: '#0a0c12',
		accent1: '#f0f4fa',
		accent2: '#2c4a9a',
		base: '#04060c',
		glow: '#cfe4ff',
		shadow: '#101830',
	}),
	way('crimson', 'Crimson', 'Carmesí', ['red', 'rojo', '赤'], {
		face: '#ff0000',
		faceAlt: '#9a0000',
		accent3: '#ffc4c4',
		keyline: '#140000',
		accent1: '#ffd040',
		accent2: '#8a0000',
		base: '#1a0000',
		glow: '#ff5a1a',
		shadow: '#3a0000',
	}),
	way('ember', 'Ember', 'Brasa', ['orange', 'fire', 'naranja', 'fuego', '炎'], {
		face: '#ff6a00',
		faceAlt: '#a31500',
		accent3: '#ffe0a0',
		keyline: '#140a06',
		accent1: '#ffb040',
		accent2: '#5a5a60',
		base: '#0e0a08',
		glow: '#ff7a1a',
		shadow: '#2a1006',
	}),
	way('sunset', 'Sunset', 'Atardecer', ['pink', 'orange', 'rosa', 'naranja', '夕焼け'], {
		face: '#ff8a1a',
		faceAlt: '#d6246e',
		accent3: '#ffe9b0',
		keyline: '#200a14',
		accent1: '#ffd8a0',
		accent2: '#c21e6a',
		base: '#1a0620',
		glow: '#ff7a3a',
		shadow: '#200a14',
	}),
	way('rose', 'Rose Gold', 'Oro rosa', ['rose', 'pink', 'blush', 'rosa', '桜'], {
		face: '#f7b8b0',
		faceAlt: '#b3605a',
		accent3: '#fff0ea',
		keyline: '#2e1416',
		accent1: '#fff4ee',
		accent2: '#8c3a44',
		base: '#1c0a0c',
		glow: '#ffb8a8',
		shadow: '#2e1416',
	}),
	way('violet', 'Violet', 'Violeta', ['purple', 'morado', 'púrpura', '紫'], {
		face: '#b02cff',
		faceAlt: '#3a006a',
		accent3: '#ffe0ff',
		keyline: '#12001f',
		accent1: '#ffffff',
		accent2: '#d9a520',
		base: '#08000f',
		glow: '#c86aff',
		shadow: '#20003a',
	}),
	way('cobalt', 'Cobalt', 'Cobalto', ['blue', 'azul', '青'], {
		face: '#2a7bff',
		faceAlt: '#001a5c',
		accent3: '#dff0ff',
		keyline: '#000f3a',
		accent1: '#ffffff',
		accent2: '#9aa3b2',
		base: '#000a26',
		glow: '#3aa8ff',
		shadow: '#001040',
	}),
	way('ocean', 'Ocean', 'Océano', ['teal', 'turquoise', 'coral', 'turquesa'], {
		face: '#19d3c5',
		faceAlt: '#0a6a80',
		accent3: '#d8fff8',
		keyline: '#04242e',
		accent1: '#f5fffd',
		accent2: '#ff6b5a',
		base: '#021418',
		glow: '#38e8da',
		shadow: '#04242e',
	}),
	way('emerald', 'Emerald', 'Esmeralda', ['green', 'verde', '緑'], {
		face: '#18d040',
		faceAlt: '#00601c',
		accent3: '#e6ffe6',
		keyline: '#002a0c',
		accent1: '#ffffff',
		accent2: '#9aa3b2',
		base: '#001a06',
		glow: '#3dff6a',
		shadow: '#002a10',
	}),
	way('electric', 'Electric', 'Eléctrico', ['cyan', 'magenta', 'neon', 'cian', 'neón'], {
		face: '#00e5ff',
		faceAlt: '#0050ff',
		accent3: '#e8ffff',
		keyline: '#0a0030',
		accent1: '#ff2ad0',
		accent2: '#2a0a80',
		base: '#05001c',
		glow: '#00d0ff',
		shadow: '#0a0030',
	}),
];
