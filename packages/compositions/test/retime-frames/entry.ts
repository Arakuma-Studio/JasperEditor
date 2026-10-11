import { FrameSource } from '../../src/retime/frames.ts';

function code(c: HTMLCanvasElement | OffscreenCanvas, w: number, h: number, scale: number): number {
	const t = document.createElement('canvas');
	t.width = w;
	t.height = h;
	const ctx = t.getContext('2d')!;
	ctx.drawImage(c as CanvasImageSource, 0, 0, w, h);
	let v = 0;
	for (let b = 0; b < 6; b++) {
		const d = ctx.getImageData(Math.round((70 + 70 * b) * scale), Math.round(70 * scale), 1, 1).data;
		if (d[0]! > 127) v |= 1 << b;
	}
	return v;
}

const api = {
	async codes(arg?: string) {
		const { src, w, h, scale, times } = JSON.parse(arg!) as {
			src: string;
			w: number;
			h: number;
			scale: number;
			times: number[];
		};
		const s = new FrameSource(src, w, h, false);
		const out: { t: number; code: number; time: number }[] = [];
		for (const t of times) {
			const f = await s.frameAt(t);
			out.push({
				t,
				code: f ? code(f.canvas, w, h, scale) : -1,
				time: f ? Math.round(f.time * 1e4) / 1e4 : -1,
			});
		}
		const next = await s.nextAfter((await s.frameAt(times[0]!))!);
		s.dispose();
		return { out, next: next ? Math.round(next.time * 1e4) / 1e4 : null };
	},
};
(window as unknown as { __frames: typeof api }).__frames = api;
