// Browser entry of fx-warp-stabilizer-gl.test.ts: the Warp Stabilizer through the real GPU host with a synthetic
// analysis (a known camera path), returning the output's displacement against the input.
import type { WarpAnalysisData } from '@jasper/project';
import { defaults, px, run, solid, spec } from '../fx-sim-warp/harness.ts';

const W = 160;
const H = 96;

/** Frame k of the clip is shifted by path[k] (scene points move by −Δ between frames). */
function analysis(path: [number, number][], tracks: boolean): WarpAnalysisData {
	const frames: number[] = [];
	path.forEach((p, k) => {
		const d = k ? [p[0] - path[k - 1]![0], p[1] - path[k - 1]![1]] : [0, 0];
		frames.push(d[0]!, d[1]!, 1, 0, d[0]!, d[1]!, 1, 0, d[0]!, 0, 1, d[1]!, 0, 0);
	});
	const tr: { start: number; pts: number[] }[] = [];
	if (tracks)
		for (let gy = 0; gy < 6; gy++)
			for (let gx = 0; gx < 10; gx++)
				tr.push({ start: 0, pts: path.flatMap((p) => [8 + gx * 16 + p[0], 8 + gy * 16 + p[1]]) });
	return {
		version: 1,
		key: `gl-${tracks}-${path.length}`,
		start: 0,
		frameDuration: 1 / 30,
		size: [W, H],
		detailed: false,
		frames,
		tracks: tr,
	};
}

/** A checker of small coloured squares (every position distinct). */
const pattern = (ctx: CanvasRenderingContext2D, b: { x: number; y: number; w: number; h: number }) => {
	for (let y = 0; y < b.h; y += 4)
		for (let x = 0; x < b.w; x += 4) {
			ctx.fillStyle = `rgb(${(x * 3) % 256},${(y * 5) % 256},${((x + y) * 7) % 256})`;
			ctx.fillRect(b.x + x, b.y + y, 4, 4);
		}
};

const api = {
	/** Renders frame `frame` and finds the integer shift that maps the input onto the output best. */
	shift(arg: { method: string; frame: number; framing?: string; result?: string; tracks?: boolean }) {
		const path: [number, number][] = Array.from({ length: 9 }, (_, k) => [k % 2 ? 6 : 0, k % 3 ? -4 : 0]);
		const s = spec('jasper.warp-stabilizer');
		const r = run(
			s,
			defaults(s, {
				method: arg.method,
				framing: arg.framing ?? 'stabilizeOnly',
				result: arg.result ?? 'noMotion',
			}),
			{ width: W, height: H },
			pattern,
			{ frame: arg.frame, structures: { warpAnalysis: analysis(path, !!arg.tracks) } },
		);
		let best = { dx: 0, dy: 0, err: Number.POSITIVE_INFINITY };
		const bx = r.layout.box.x;
		const by = r.layout.box.y;
		const O = r.out.getContext('2d')!.getImageData(0, 0, r.out.width, r.out.height);
		const I = r.input.getContext('2d')!.getImageData(0, 0, r.input.width, r.input.height);
		const at = (d: ImageData, x: number, y: number) => {
			const i = (y * d.width + x) * 4;
			return [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!];
		};
		for (let dy = -10; dy <= 10; dy++)
			for (let dx = -10; dx <= 10; dx++) {
				let err = 0;
				for (let y = 30; y < 66; y += 3)
					for (let x = 40; x < 120; x += 3) {
						const a = at(O, bx + x, by + y);
						const b = at(I, bx + x - dx, by + y - dy);
						err += Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
					}
				if (err < best.err) best = { dx, dy, err };
			}
		// Transparent corner when the frame moved (Stabilize Only shows the edges): the right edge for a leftward shift.
		const corner = px(r.out, bx + W - 2, by + H / 2);
		return {
			...best,
			expected: [path[4]![0] - path[arg.frame]![0], path[4]![1] - path[arg.frame]![1]],
			corner,
		};
	},
	/** Without an analysis the effect passes the picture through. */
	passThrough() {
		const s = spec('jasper.warp-stabilizer');
		const r = run(s, defaults(s), { width: W, height: H }, solid('rgb(10,200,30)'));
		return px(r.out, r.layout.box.x + 50, r.layout.box.y + 40);
	},
};

(window as unknown as { __psdgTest: typeof api }).__psdgTest = api;
