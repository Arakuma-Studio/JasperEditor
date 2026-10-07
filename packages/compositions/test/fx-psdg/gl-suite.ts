// Node side of the premiere-stylize-distort-generate GL tests: bundles a browser entry (which sets
// `window.__psdgTest = { name: (arg) => result }` using ./harness.ts) with esbuild, opens it in headless Chrome
// (SwiftShader when there is no GPU, as test/fx-gl.test.ts) and calls its functions. Chrome is found like the
// framework's GL test; FX_GL=0 skips.
import { CHROME, openGlPage } from '../gl-browser.ts';

export const psdgGlEnabled = !!CHROME && process.env.FX_GL !== '0';

export type PsdgPage = {
	call<T>(name: string, arg?: unknown): Promise<T>;
	close(): Promise<void>;
};

export async function openPsdgPage(entry: string): Promise<PsdgPage> {
	const { browser, page } = await openGlPage(entry);
	return {
		call: <T>(name: string, arg?: unknown) =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __psdgTest: Record<string, (x: unknown) => unknown> }).__psdgTest[n]!(a),
				[name, arg] as const,
			) as Promise<T>,
		close: () => browser.close(),
	};
}
