import { canvas, defaults, type Paint, picture, run, spec } from './harness.ts';

export type PreviewJob = {
	name: string;
	effect: string;
	params?: Record<string, unknown>;
	/** photo (default) | shape (photo in a rounded rect on transparency) | blank | grey */
	input?: 'photo' | 'shape' | 'blank' | 'grey';
	size?: [number, number];
	frame?: number;
	duration?: number;
	/** Media params: uniform name → 'photo' | 'gradient' | 'texture' (generated pictures). */
	media?: Record<string, 'photo' | 'gradient' | 'texture'>;
	transition?: { progress: number; side: 'out' | 'in' };
};

let photo: HTMLImageElement | null = null;
const allOuts: (HTMLCanvasElement | null)[] = [];
const allJobs: PreviewJob[] = [];

async function loadPhoto(url: string) {
	const img = new Image();
	img.src = url;
	await img.decode();
	photo = img;
}

function mediaPicture(kind: 'photo' | 'gradient' | 'texture'): HTMLCanvasElement {
	if (kind === 'photo') return canvas(640, 360, (ctx) => ctx.drawImage(photo!, 0, 0, 640, 360));
	if (kind === 'gradient')
		return canvas(640, 360, (ctx) => {
			const g = ctx.createRadialGradient(320, 180, 0, 320, 180, 360);
			g.addColorStop(0, '#000');
			g.addColorStop(1, '#fff');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, 640, 360);
		});
	return canvas(128, 128, (ctx) => {
		ctx.fillStyle = '#808080';
		ctx.fillRect(0, 0, 128, 128);
		for (let i = 0; i < 400; i++) {
			const v = (i * 97) % 255;
			ctx.fillStyle = `rgb(${v},${v},${v})`;
			ctx.fillRect((i * 37) % 128, (i * 61) % 128, 6, 3);
		}
	});
}

function paintOf(job: PreviewJob): Paint {
	const kind = job.input ?? 'photo';
	if (kind === 'blank') return () => {};
	if (kind === 'grey')
		return (ctx, b) => {
			ctx.fillStyle = '#808080';
			ctx.fillRect(b.x, b.y, b.w, b.h);
		};
	const pic = picture(photo!);
	if (kind === 'shape')
		return (ctx, b, o) => {
			ctx.save();
			ctx.beginPath();
			ctx.roundRect(b.x + b.w * 0.2 - o * 6, b.y + b.h * 0.2, b.w * 0.6, b.h * 0.6, b.h * 0.12);
			ctx.clip();
			pic(ctx, b, o);
			ctx.restore();
		};
	return pic;
}

function render(job: PreviewJob): HTMLCanvasElement {
	const s = spec(job.effect);
	const [w, h] = job.size ?? [640, 360];
	const textures: Record<string, { source: TexImageSource; width: number; height: number; version: string }> =
		{};
	for (const [u, k] of Object.entries(job.media ?? {})) {
		const c = mediaPicture(k);
		textures[u] = { source: c, width: c.width, height: c.height, version: k };
	}
	return run(s, defaults(s, job.params), { width: w, height: h }, paintOf(job), {
		frame: job.frame,
		duration: job.duration,
		textures,
		transition: job.transition ?? null,
	}).out;
}

function checker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
	for (let j = 0; j < h; j += 10)
		for (let i = 0; i < w; i += 10) {
			ctx.fillStyle = ((i + j) / 10) % 2 ? '#bbb' : '#eee';
			ctx.fillRect(x + i, y + j, Math.min(10, w - i), Math.min(10, h - j));
		}
}

const api = {
	async init(photoUrl: string) {
		await loadPhoto(photoUrl);
		return true;
	},
	render(jobs: PreviewJob[], sheet: { columns: number; cell: [number, number]; title?: string } | null) {
		const results: { name: string; png?: string; error?: string; size?: [number, number] }[] = [];
		// Jobs and outputs accumulate over calls (the CLI renders one job per call, then asks for the sheet).
		const outs = allOuts;
		for (const job of jobs) {
			allJobs.push(job);
			try {
				const out = render(job);
				const framed = canvas(out.width, out.height, (ctx) => {
					checker(ctx, 0, 0, out.width, out.height);
					ctx.drawImage(out, 0, 0);
				});
				results.push({ name: job.name, png: framed.toDataURL('image/png'), size: [out.width, out.height] });
				outs.push(out);
			} catch (e) {
				results.push({ name: job.name, error: (e as Error).message });
				outs.push(null);
			}
		}
		let sheetPng: string | undefined;
		jobs = allJobs;
		if (sheet) {
			const [cw, ch] = sheet.cell;
			const label = 18;
			const top = sheet.title ? 30 : 0;
			const rows = Math.ceil(jobs.length / sheet.columns);
			const c = canvas(sheet.columns * cw, top + rows * (ch + label), (ctx) => {
				ctx.fillStyle = '#1d1d1d';
				ctx.fillRect(0, 0, sheet.columns * cw, top + rows * (ch + label));
				if (sheet.title) {
					ctx.fillStyle = '#fff';
					ctx.font = 'bold 18px DejaVu Sans, sans-serif';
					ctx.fillText(sheet.title, 8, 21);
				}
				jobs.forEach((job, i) => {
					const x = (i % sheet.columns) * cw;
					const y = top + Math.floor(i / sheet.columns) * (ch + label);
					const out = outs[i];
					if (out) {
						const k = Math.min((cw - 4) / out.width, (ch - 4) / out.height);
						const w = out.width * k;
						const h = out.height * k;
						const ox = x + (cw - w) / 2;
						const oy = y + (ch - h) / 2;
						checker(ctx, Math.round(ox), Math.round(oy), Math.round(w), Math.round(h));
						ctx.drawImage(out, ox, oy, w, h);
					}
					ctx.fillStyle = out ? '#ddd' : '#f66';
					ctx.font = '12px DejaVu Sans, sans-serif';
					ctx.fillText(job.name, x + 4, y + ch + 13, cw - 8);
				});
			});
			sheetPng = c.toDataURL('image/png');
		}
		return { results, sheet: sheetPng };
	},
};

declare global {
	interface Window {
		__psdg: typeof api;
	}
}

window.__psdg = api;
