// Browser entry of the mask GL test (bundled with esbuild, run in headless Chrome by ../masks-gl.test.ts): the GL
// mask rasteriser (src/fx/mask.ts on the fx GPU host) against the CPU rasteriser, and the masked-effect /
// Opacity-mask descriptors inside Remotion's effect chain (as FxPicture runs them).
import { type ResolvedMask, packMasks, prepareMasks, rasterizeMaskPack, boxToCanvas } from '@jasper/project';
import { Internals } from 'remotion';
import { cssFilter } from '../../src/color/effects.ts';
import { fxHost } from '../../src/fx/host.ts';
import { fxMaskApply, fxMasked, packedMasks, runMaskPass } from '../../src/fx/mask.ts';

type Job = {
	masks: ResolvedMask[];
	width: number;
	height: number;
	box: { x: number; y: number; w: number; h: number };
	pxScale: number;
};

function canvas(w: number, h: number, fill?: string): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	if (fill) {
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, w, h);
	}
	return c;
}

const api = {
	info() {
		const h = fxHost();
		return { webgl2: !!h };
	},
	/** GL coverage (alpha 0..255 per pixel) and the CPU tiled rasteriser's (0..1), same pack. */
	coverage(json: string) {
		const j = JSON.parse(json) as Job;
		const h = fxHost()!;
		const { pack, key } = packedMasks({ masks: j.masks, box: j.box, pxScale: j.pxScale }, j.width, j.height);
		const out = canvas(j.width, j.height);
		const t0 = performance.now();
		runMaskPass(h, { pack, packKey: key, mode: 'coverage', src: null, width: j.width, height: j.height }, out.getContext('2d')!);
		const ms = performance.now() - t0;
		const gl = Array.from(out.getContext('2d')!.getImageData(0, 0, j.width, j.height).data.filter((_, i) => i % 4 === 3));
		const cpu = Array.from(
			rasterizeMaskPack(packMasks(prepareMasks(j.masks, boxToCanvas(j.box), j.pxScale), j.width, j.height)!),
		);
		return { gl, cpu, ms };
	},
	/** Opacity masks (apply) and a masked blur (mix) through Remotion's effect chain. */
	async chain(json: string) {
		const j = JSON.parse(json) as Job;
		const W = j.width;
		const H = j.height;
		// Left half red, right half blue (opaque).
		const src = canvas(W, H);
		const sctx = src.getContext('2d')!;
		sctx.fillStyle = 'rgb(255,0,0)';
		sctx.fillRect(0, 0, W / 2, H);
		sctx.fillStyle = 'rgb(0,0,255)';
		sctx.fillRect(W / 2, 0, W / 2, H);
		const geometry = { masks: j.masks, box: j.box, pxScale: j.pxScale };
		const run = async (effects: unknown[]) => {
			const state = Internals.createEffectChainState(W, H);
			const out = canvas(W, H);
			await Internals.runEffectChain({ state, source: src, effects: effects as never, output: out, width: W, height: H });
			return Array.from(out.getContext('2d')!.getImageData(0, 0, W, H).data);
		};
		const applied = await run([fxMaskApply({ key: 'm', geometry })]);
		// A masked "invert" CSS filter: inverted inside the masks only.
		const masked = await run([fxMasked({ key: 'x', geometry, inner: cssFilter({ key: 'inv', filter: 'invert(1)' }) })]);
		return { applied, masked };
	},
};

(window as unknown as { __masks: typeof api }).__masks = api;
