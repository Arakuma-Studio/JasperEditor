// @vitest-environment node
// Pixel behaviour of the Premiere Adjust / Color Correction (analysis) / Keying effects of the fx family
// premiere-adjust-color-keying in real WebGL2 (headless Chrome, SwiftShader): identity at defaults, one
// characteristic pixel per effect, alpha handling. FX_GL=0 skips it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { near, PACG_GL, type PacgSession, startPacg } from './fx-pacg/harness.ts';

const box = { width: 32, height: 16 };

describe.runIf(PACG_GL)('Premiere Adjust / Keying effects in WebGL2', { timeout: 60_000 }, () => {
	let s: PacgSession;
	beforeAll(async () => {
		s = await startPacg();
	}, 120_000);
	afterAll(async () => {
		await s?.close();
	});

	it('ProcAmp: identity at defaults; saturation 0 → grey; split screen leaves the right side', async () => {
		const pic = { kind: 'solid', color: 'rgb(200, 100, 50)' } as const;
		expect(near(await s.px({ id: 'jasper.proc-amp', picture: pic, box }, 4, 4), [200, 100, 50, 255])).toBe(true);
		const grey = await s.px({ id: 'jasper.proc-amp', params: { saturation: 0 }, picture: pic, box }, 4, 4);
		expect(Math.abs(grey[0] - grey[2])).toBeLessThan(2);
		const split = await s.pixels(
			{ id: 'jasper.proc-amp', params: { saturation: 0, splitScreen: true }, picture: pic, box },
			[
				[4, 4],
				[28, 4],
			],
		);
		expect(Math.abs(split.pixels[0]![0] - split.pixels[0]![2])).toBeLessThan(2);
		expect(near(split.pixels[1]!, [200, 100, 50, 255])).toBe(true);
	});
});
