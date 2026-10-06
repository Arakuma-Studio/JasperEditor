// Browser entry of fx-psdg-light-gl.test.ts (Vignette, Glow).
import { defaults, px, run, solid, spec } from './harness.ts';

const W = 64;
const H = 36;

const api = {
	vignette(amount: number) {
		const s = spec('jasper.vignette');
		const { out } = run(s, defaults(s, { amount }), { width: W, height: H }, solid('rgb(128,128,128)'));
		return { centre: px(out, W / 2, H / 2), corner: px(out, 1, 1) };
	},
	vignetteAlpha() {
		const s = spec('jasper.vignette');
		const { out } = run(s, defaults(s, { amount: -5 }), { width: W, height: H }, (ctx, b) => {
			ctx.fillStyle = 'rgba(255,255,255,0.5)';
			ctx.fillRect(b.x, b.y, b.w / 2, b.h);
		});
		return { left: px(out, W / 2 - 4, H / 2), right: px(out, W - 2, H / 2) };
	},
	glow(params: Record<string, unknown>) {
		const s = spec('jasper.glow');
		const { out, layout } = run(s, defaults(s, params), { width: W, height: H }, (ctx, b) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x + 28, b.y + 14, 8, 8);
		});
		const b = layout.box;
		return {
			canvas: [layout.width, layout.height],
			core: px(out, b.x + 32, b.y + 18),
			near: px(out, b.x + 40, b.y + 18),
			darkCorner: px(out, b.x + 1, b.y + 1),
			outside: px(out, b.x - 4, b.y + 18),
		};
	},
};

(window as unknown as { __psdgTest: typeof api }).__psdgTest = api;
