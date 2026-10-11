import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, openGlPage } from '../gl-browser.ts';
import type { RunRequest } from './entry.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const PACG_GL = !!CHROME && process.env.FX_GL !== '0';

export type Px = [number, number, number, number];
export type PacgRequest = RunRequest;

export const near = (a: Px, b: Px, tol = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

export type PacgSession = {
	/** Runs `req` and returns the pixels at layer-px points (relative to the layer box) and the canvas size. */
	pixels(req: PacgRequest, at: [number, number][]): Promise<{ canvas: [number, number]; pixels: Px[] }>;
	px(req: PacgRequest, x: number, y: number): Promise<Px>;
	close(): Promise<void>;
};

export async function startPacg(): Promise<PacgSession> {
	const { browser, page } = await openGlPage(join(here, 'entry.ts'));
	const pixels = (r: PacgRequest, at: [number, number][]) =>
		page.evaluate(
			([q, a]) =>
				(
					window as unknown as {
						__pacg: { pixels(q: unknown, a: unknown): Promise<{ canvas: [number, number]; pixels: Px[] }> };
					}
				).__pacg.pixels(q, a),
			[r, at] as const,
		) as Promise<{ canvas: [number, number]; pixels: Px[] }>;
	return {
		pixels,
		px: async (r, x, y) => (await pixels(r, [[x, y]])).pixels[0]!,
		close: () => browser.close(),
	};
}
