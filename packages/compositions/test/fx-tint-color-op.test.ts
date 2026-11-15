// Tint is a colour op (fused into the colour run's LUT on every path, which lets the native export apply it). Its
// GLSL shader's last golden fingerprints (`goldens/tint-shader-fingerprints.json`, blessed by fx-gl.test.ts from the
// shader at default and perturbed settings on the golden test card) are the oracle: the op applied to the card's own
// fingerprint (an identity effect's, Edge Feather at 0) must give them. Tint is affine in the colour, so it commutes
// with the 4×4 cell means — exactly at defaults (black → black: no offset), and on every fully opaque cell at the
// perturbed settings (cell 0 holds the card's transparent corner, where an offset is not averaged with the opaque
// pixels' weight).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultEffectRegistry } from '@jasper/project';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
	JSON.parse(readFileSync(join(here, 'goldens', f), 'utf8')) as Record<string, number[]>;

describe('Tint colour op', () => {
	it('reproduces the GLSL shader it replaced (its golden fingerprints)', () => {
		const card = read('fx-fingerprints.json')['jasper.edge-feather']!;
		const shader = read('tint-shader-fingerprints.json');
		const spec = defaultEffectRegistry.get('jasper.tint', 1)!;
		const defaults = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
		// fx-gl/entry.ts `perturbed`: colours [0.9, 0.25, 0.45], the percentage a third of the way to its minimum.
		const perturbed = {
			mapBlackTo: [0.9, 0.25, 0.45, 1],
			mapWhiteTo: [0.9, 0.25, 0.45, 1],
			amountToTint: 200 / 3,
		};
		for (const [key, params, from] of [
			['jasper.tint', defaults, 0],
			['jasper.tint@perturbed', perturbed, 1],
		] as const) {
			const fn = spec.color!.build(params as never, { lut: () => null })!;
			for (let cell = from; cell < 16; cell++) {
				const c = [0, 1, 2].map((k) => card[cell * 3 + k]! / 255);
				fn(c as never);
				for (let k = 0; k < 3; k++)
					expect(Math.abs(c[k]! * 255 - shader[key]![cell * 3 + k]!), `${key} cell ${cell}`).toBeLessThan(
						0.5,
					);
			}
		}
	});

	it('is the identity at amount 0 (no LUT run)', () => {
		const spec = defaultEffectRegistry.get('jasper.tint', 1)!;
		expect(spec.color!.build({ amountToTint: 0 }, { lut: () => null })).toBeNull();
	});
});
