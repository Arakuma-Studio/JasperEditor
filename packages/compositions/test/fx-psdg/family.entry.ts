// Browser entry of fx-psdg-gl.test.ts: characteristic pixels of every effect of the premiere-stylize-distort-generate
// family through the real GPU host (Vignette/Glow: light.entry.ts). Each function returns plain data to assert on.
import { canvas, defaults, maxDiff, mean, type Paint, type Px, px, run, solid, spec } from './harness.ts';

const W = 64;
const H = 36;
const box = { width: W, height: H };

/** A colourful deterministic test picture (gradients + a few shapes). */
const picture: Paint = (ctx, b) => {
	const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
	g.addColorStop(0, 'rgb(220,40,30)');
	g.addColorStop(0.5, 'rgb(40,200,80)');
	g.addColorStop(1, 'rgb(30,60,220)');
	ctx.fillStyle = g;
	ctx.fillRect(b.x, b.y, b.w, b.h);
	ctx.fillStyle = '#fff';
	ctx.fillRect(b.x + 10, b.y + 8, 12, 8);
	ctx.fillStyle = '#000';
	ctx.fillRect(b.x + 40, b.y + 20, 10, 10);
};

const fx = (id: string, over: Record<string, unknown> = {}, paint: Paint = picture, extra = {}) => {
	const s = spec(id);
	return run(s, defaults(s, over), box, paint, extra);
};
const identityDiff = (id: string, over: Record<string, unknown> = {}) => {
	const r = fx(id, over);
	return maxDiff(r.out, r.input);
};
const at = (
	r: { out: HTMLCanvasElement; layout: { box: { x: number; y: number } } },
	x: number,
	y: number,
): Px => px(r.out, r.layout.box.x + x, r.layout.box.y + y);

const halves: Paint = (ctx, b) => {
	ctx.fillStyle = 'rgb(255,0,0)';
	ctx.fillRect(b.x, b.y, b.w / 2, b.h);
	ctx.fillStyle = 'rgb(0,0,255)';
	ctx.fillRect(b.x + b.w / 2, b.y, b.w / 2, b.h);
};
const shape: Paint = (ctx, b) => {
	ctx.fillStyle = 'rgb(200,120,60)';
	ctx.fillRect(b.x + 16, b.y + 8, 32, 20);
};

const api = {
	identities() {
		const ids: [string, Record<string, unknown>][] = [
			['jasper.lens-distortion', {}],
			['jasper.spherize', {}],
			['jasper.median', {}],
			['jasper.noise', {}],
			['jasper.noise-alpha', {}],
			['jasper.noise-hls', {}],
			['jasper.noise-hls-auto', {}],
			['jasper.offset', {}],
			['jasper.texturize', {}],
			['jasper.block-dissolve', {}],
			['jasper.gradient-wipe', {}],
			['jasper.linear-wipe', {}],
			['jasper.radial-wipe', {}],
			['jasper.venetian-blinds', {}],
			['jasper.magnify', {}],
			['jasper.strobe-light', {}],
			['jasper.echo', { numberOfEchoes: 0 }],
			['jasper.posterize-time', {}],
			['jasper.dust-and-scratches', { radius: 0 }],
			['jasper.twirl', { angle: 0 }],
			['jasper.wave-warp', { waveHeight: 0 }],
			['jasper.turbulent-displace', { amount: 0 }],
			['jasper.simple-text', { text: '' }],
		];
		// Strobe at frame 10 (off: Duration 0.05 s of every 1 s period).
		return Object.fromEntries(
			ids.map(([id, over]) => [
				id,
				id === 'jasper.strobe-light' ? maxDiffAt(id, over, 10) : identityDiff(id, over),
			]),
		);
	},

	distort() {
		const mirror = fx('jasper.mirror', {}, halves);
		const offset = fx('jasper.offset', { shiftCenterTo: [0, 0.5] }, halves);
		const ld = fx('jasper.lens-distortion', { curvature: 80 });
		const ldFill = fx('jasper.lens-distortion', { curvature: 80, fillAlpha: true, fillColor: [0, 1, 0, 1] });
		const mag = fx('jasper.magnify', { magnification: 400, size: 20 }, halves);
		const sph = fx('jasper.spherize', { radius: 15 });
		const tw = fx('jasper.twirl', { angle: 180 });
		const ww0 = fx('jasper.wave-warp', {}, picture, { frame: 0 });
		const ww5 = fx('jasper.wave-warp', {}, picture, { frame: 5 });
		const td = fx('jasper.turbulent-displace', { amount: 60, size: 20 });
		const td2 = fx('jasper.turbulent-displace', { amount: 60, size: 20 });
		const td3 = fx('jasper.turbulent-displace', { amount: 60, size: 20, seed: 7 });
		return {
			mirrorRight: at(mirror, 56, 18),
			mirrorLeft: at(mirror, 8, 18),
			offsetLeft: at(offset, 8, 18),
			ldCorner: at(ld, 0, 0),
			ldCentre: maxDiff(ld.out, ld.input) > 0,
			ldFillCorner: at(ldFill, 0, 0),
			magLeft: at(mag, 30, 18),
			magRight: at(mag, 34, 18),
			sphere: maxDiff(sph.out, sph.input),
			twirl: maxDiff(tw.out, tw.input),
			waveCanvas: [ww0.layout.width, ww0.layout.height],
			waveMoves: maxDiff(ww0.out, ww5.out),
			turb: maxDiff(td.out, td.input),
			turbDet: maxDiff(td.out, td2.out),
			turbSeed: maxDiff(td.out, td3.out),
		};
	},

	generate() {
		const blank: Paint = () => {};
		const g4 = fx('jasper.4-color-gradient', {}, blank);
		const circle = fx('jasper.circle', { radius: 10 }, blank);
		const circleStencil = fx(
			'jasper.circle',
			{ radius: 10, blendingMode: 'stencilAlpha' },
			solid('rgb(0,0,255)'),
		);
		const checker = fx('jasper.checkerboard', { width: 8 }, blank);
		const grid = fx('jasper.grid', { sizeFrom: 'widthSlider', width: 16, border: 2 }, blank);
		const ramp = fx('jasper.ramp', {}, blank);
		const eye = fx('jasper.eyedropper-fill', { samplePoint: [0.25, 0.5], sampleRadius: 2 }, halves);
		const cell = fx('jasper.cell-pattern', { size: 10 }, blank);
		const cell2 = fx('jasper.cell-pattern', { size: 10, seed: 3 }, blank);
		const ellipse = fx('jasper.ellipse', { width: 40, height: 20, thickness: 4 }, blank);
		const flare = fx('jasper.lens-flare', { flareCenter: [0.5, 0.5] }, solid('rgb(20,20,20)'));
		const bolt = fx(
			'jasper.lightning',
			{ startPoint: [0, 0.5], endPoint: [1, 0.5], amplitude: 0, width: 4 },
			solid('#000'),
		);
		const bolt2 = fx('jasper.lightning', {}, solid('#000'), { frame: 3 });
		const bolt3 = fx('jasper.lightning', {}, solid('#000'), { frame: 3 });
		const bolt4 = fx('jasper.lightning', {}, solid('#000'), { frame: 9 });
		// Two white rooms split by a black wall: the fill must stay in the room of the Fill Point.
		const rooms: Paint = (ctx, b) => {
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = '#000';
			ctx.fillRect(b.x + 30, b.y, 4, b.h);
		};
		const bucket = fx('jasper.paint-bucket', { fillPoint: [0.2, 0.5] }, rooms);
		const write = fx('jasper.write-on', { brushSize: 10, color: [1, 0, 0, 1] }, solid('#000'));
		return {
			g4TopLeft: at(g4, 1, 1),
			g4BottomRight: at(g4, W - 2, H - 2),
			circleIn: at(circle, 32, 18),
			circleOut: at(circle, 2, 2),
			stencilIn: at(circleStencil, 32, 18),
			stencilOut: at(circleStencil, 2, 2),
			checkerA: at(checker, 33, 19),
			checkerB: at(checker, 41, 19),
			gridLine: at(grid, 32, 10),
			gridCell: at(grid, 40, 10),
			rampTop: at(ramp, 32, 0),
			rampBottom: at(ramp, 32, H - 1),
			eyeRight: at(eye, 60, 30),
			cellSeed: maxDiff(cell.out, cell2.out),
			cellMean: mean(cell.out),
			ellipseRing: at(ellipse, 32 + 20, 18),
			ellipseCentre: at(ellipse, 32, 18),
			flareCanvas: [flare.layout.width, flare.layout.height],
			flareCentre: at(flare, 32, 18),
			flareCorner: at(flare, 0, 0),
			boltOn: at(bolt, 20, 18),
			boltOff: at(bolt, 20, 2),
			boltDet: maxDiff(bolt2.out, bolt3.out),
			boltAnim: maxDiff(bolt2.out, bolt4.out),
			bucketLeft: at(bucket, 10, 18),
			bucketRight: at(bucket, 50, 18),
			writeCentre: at(write, 32, 18),
			writeEdge: at(write, 2, 2),
		};
	},

	noise() {
		const speck: Paint = (ctx, b) => {
			ctx.fillStyle = 'rgb(128,128,128)';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = '#fff';
			ctx.fillRect(b.x + 20, b.y + 10, 1, 1);
		};
		const dust = fx('jasper.dust-and-scratches', { radius: 2, threshold: 10 }, speck);
		const med = fx('jasper.median', { radius: 2 }, speck);
		const n0 = fx('jasper.noise', { amount: 50 }, solid('rgb(128,128,128)'), { frame: 0 });
		const n1 = fx('jasper.noise', { amount: 50 }, solid('rgb(128,128,128)'), { frame: 1 });
		const na = fx('jasper.noise-alpha', { amount: 80 }, solid('rgb(128,128,128)'));
		const hls = fx('jasper.noise-hls', { lightness: 60 }, solid('rgb(128,128,128)'));
		const hlsA = fx('jasper.noise-hls-auto', { lightness: 60 }, solid('rgb(128,128,128)'), { frame: 0 });
		const hlsB = fx('jasper.noise-hls-auto', { lightness: 60 }, solid('rgb(128,128,128)'), { frame: 6 });
		return {
			dustSpeck: at(dust, 20, 10),
			medianSpeck: at(med, 20, 10),
			noiseAnim: maxDiff(n0.out, n1.out),
			noiseMean: mean(n0.out),
			noiseAlpha: mean(na.out)[3],
			noiseAlphaVar: maxDiff(na.out, na.input),
			hls: maxDiff(hls.out, hls.input),
			hlsAuto: maxDiff(hlsA.out, hlsB.out),
		};
	},

	stylize() {
		const ag = fx('jasper.alpha-glow', { glow: 8 }, shape);
		const bs = fx('jasper.brush-strokes');
		const emb = fx('jasper.emboss', {}, solid('rgb(90,160,30)'));
		const cemb = fx('jasper.color-emboss', {}, solid('rgb(90,160,30)'));
		const fe = fx('jasper.find-edges', {}, solid('rgb(90,160,30)'));
		const feEdge = fx('jasper.find-edges', {}, halves);
		const mo = fx('jasper.mosaic', { horizontalBlocks: 2, verticalBlocks: 1 });
		const po = fx('jasper.posterize', { level: 2 }, solid('rgb(200,60,140)'));
		const rep = fx('jasper.replicate', { count: 2 }, halves);
		const rough = fx('jasper.roughen-edges', { border: 6 }, shape);
		const sol = fx('jasper.solarize', { threshold: 50 }, solid('rgb(200,60,140)'));
		const st0 = fx('jasper.strobe-light', {}, solid('rgb(10,20,30)'), { frame: 0 });
		const stT = fx('jasper.strobe-light', { strobe: 'transparent' }, solid('rgb(10,20,30)'), { frame: 0 });
		const tex = canvas(8, 8, (ctx) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, 8, 8);
			ctx.fillStyle = '#fff';
			ctx.fillRect(0, 0, 4, 8);
		});
		const tx = fx('jasper.texturize', { textureLayer: { mediaId: 'm' } }, solid('rgb(128,128,128)'), {
			textures: { u_textureLayer: { source: tex, width: 8, height: 8, version: '1' } },
		});
		const th = fx('jasper.threshold', {}, halves);
		return {
			glowOutside: at(ag, 12, 18),
			glowFar: at(ag, 2, 2),
			glowInside: at(ag, 32, 18),
			glowCanvas: [ag.layout.width, ag.layout.height],
			brushDiff: maxDiff(bs.out, bs.input),
			brushMean: mean(bs.out),
			pictureMean: mean(bs.input),
			emboss: at(emb, 32, 18),
			colorEmboss: at(cemb, 32, 18),
			findEdgesFlat: at(fe, 32, 18),
			findEdgesEdge: at(feEdge, 32, 18),
			mosaicA: at(mo, 4, 4),
			mosaicB: at(mo, 28, 30),
			mosaicC: at(mo, 36, 4),
			posterize: at(po, 32, 18),
			replicate: [at(rep, 8, 9), at(rep, 24, 9), at(rep, 40, 9), at(rep, 56, 9)],
			roughCentre: at(rough, 32, 18),
			roughEdgeAlpha: mean(rough.out, rough.layout.box.x + 16, rough.layout.box.y + 8, 32, 2)[3],
			solarize: at(sol, 32, 18),
			strobe: at(st0, 32, 18),
			strobeTransparent: at(stT, 32, 18),
			texturize: [at(tx, 3, 18), at(tx, 4, 18), at(tx, 2, 18)],
			threshold: [at(th, 8, 18), at(th, 56, 18)],
		};
	},

	transitions() {
		const full = (id: string, over: Record<string, unknown>) => mean(fx(id, over).out)[3];
		const lw = fx('jasper.linear-wipe', { completion: 50 });
		const rw = fx('jasper.radial-wipe', { completion: 25 });
		const vb = fx('jasper.venetian-blinds', { completion: 50, width: 8 });
		const gw = fx('jasper.gradient-wipe', { completion: 15 }, halves);
		return {
			done: [
				'jasper.block-dissolve',
				'jasper.gradient-wipe',
				'jasper.linear-wipe',
				'jasper.radial-wipe',
				'jasper.venetian-blinds',
			].map((id) => full(id, { completion: 100 })),
			blockHalf: full('jasper.block-dissolve', { completion: 50 }),
			linearLeft: at(lw, 4, 18)[3],
			linearRight: at(lw, 60, 18)[3],
			// Clockwise from 12 o'clock: the upper-right quadrant goes first.
			radialUpperRight: at(rw, 48, 4)[3],
			radialUpperLeft: at(rw, 16, 4)[3],
			blinds: mean(vb.out)[3],
			gradientRed: at(gw, 8, 18)[3],
			gradientBlue: at(gw, 56, 18)[3],
		};
	},

	time() {
		const red = solid('rgb(255,0,0)');
		// Samples: the harness paints them with their frame offset; draw a green bar that moves with time.
		const moving: Paint = (ctx, b, o) => {
			ctx.fillStyle = 'rgb(0,0,0)';
			ctx.fillRect(b.x, b.y, b.w, b.h);
			ctx.fillStyle = 'rgb(0,200,0)';
			ctx.fillRect(b.x + 30 + o * 10, b.y, 4, b.h);
		};
		const add = fx('jasper.echo', { numberOfEchoes: 2, echoTime: -1 / 30 }, moving);
		const front = fx(
			'jasper.echo',
			{ numberOfEchoes: 1, echoOperator: 'compositeInBack', startingIntensity: 1 },
			red,
		);
		return {
			current: at(add, 31, 18),
			echo1: at(add, 21, 18),
			echo2: at(add, 11, 18),
			nothing: at(add, 50, 18),
			composite: at(front, 32, 18),
		};
	},

	video() {
		const tc = fx('jasper.timecode', { size: 40, opacity: 100 }, solid('rgb(128,128,128)'), { frame: 31 });
		const tc2 = fx('jasper.timecode', { size: 40, opacity: 100 }, solid('rgb(128,128,128)'), { frame: 32 });
		const text = fx('jasper.simple-text', { text: 'HHHH', size: 60 }, solid('rgb(0,0,0)'));
		const name = fx('jasper.clip-name', { size: 30, opacity: 100 }, solid('rgb(128,128,128)'));
		const t = text.out.getContext('2d')!.getImageData(0, 0, text.out.width, text.out.height).data;
		let white = 0;
		for (let i = 0; i < t.length; i += 4) if (t[i]! > 200) white++;
		return {
			timecodeChanges: maxDiff(tc.out, tc2.out),
			timecodeBox: at(tc, 1, Math.round(0.85 * H)),
			timecodeAbove: at(tc, 32, 2),
			textWhitePixels: white,
			textCorner: at(text, 0, 0),
			clipName: maxDiff(name.out, name.input),
		};
	},
};

function maxDiffAt(id: string, over: Record<string, unknown>, frame: number) {
	const r = fx(id, over, picture, { frame });
	return maxDiff(r.out, r.input);
}

(window as unknown as { __psdgTest: typeof api }).__psdgTest = api;
