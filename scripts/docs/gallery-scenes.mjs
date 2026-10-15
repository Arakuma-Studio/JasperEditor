#!/usr/bin/env node
// Procedural pictures for the documentation contact sheets (docs/screenshots/fx, docs/screenshots/transitions): no
// photographs, only ffmpeg lavfi sources (gradients drawn with geq, mandelbrot, testsrc2, boxes), so every sheet
// rendered over them is original work (AGENTS.md §3, ATTRIBUTION.md). Retained as the
// reproducible source for the published documentation pictures.
//
//   node scripts/docs/gallery-scenes.mjs <dir>   writes <dir>/scene.png (A) and <dir>/scene-b.png (B), 640×360
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 640;
const H = 360;
const ff = (args) => execFileSync(process.env.JASPER_FFMPEG ?? 'ffmpeg', ['-v', 'error', '-y', ...args]);

/** A: a dusk sky, a sun, a fractal ridge, a green screen card, a warm oval, a test-pattern inset and point lights. */
function sceneA(file) {
	const sky = `color=c=black:s=${W}x${H},format=rgb24,geq=r='40+200*Y/${H}':g='60+110*Y/${H}':b='150-90*Y/${H}'`;
	const ridge = `mandelbrot=s=${W}x${H}:start_x=-0.745:start_y=0.11:start_scale=0.06:end_pts=1:maxiter=300,format=rgb24`;
	const lights = Array.from({ length: 24 }, (_, i) => {
		const x = 20 + ((i * 131) % 600);
		const y = 10 + ((i * 37) % 120);
		const c = ['white', '0xffe0a0', '0xa0d0ff', '0xffb0b0'][i % 4];
		return `drawbox=x=${x}:y=${y}:w=3:h=3:color=${c}:t=fill`;
	}).join(',');
	const fc = [
		// the sun: a soft bright disc
		`[0]geq=r='min(255,r(X,Y)+220*exp(-(pow(X-470,2)+pow(Y-90,2))/900))':g='min(255,g(X,Y)+200*exp(-(pow(X-470,2)+pow(Y-90,2))/900))':b='min(255,b(X,Y)+120*exp(-(pow(X-470,2)+pow(Y-90,2))/900))'[sun]`,
		// the ridge: the fractal below a wavy horizon
		`[1]colorchannelmixer=rr=0.25:rg=0.2:rb=0.05:gr=0.15:gg=0.45:gb=0.1:br=0.05:bg=0.15:bb=0.2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*gt(Y,200+25*sin(X/45)+12*sin(X/13))'[ridge]`,
		`[sun][ridge]overlay=0:0[land]`,
		`[2]scale=150:84[inset]`,
		`[land][inset]overlay=470:250,drawbox=x=30:y=170:w=140:h=150:color=0x2fbf4f:t=fill,drawbox=x=60:y=200:w=80:h=95:color=0xc8906c:t=fill,drawbox=x=78:y=215:w=12:h=10:color=0x302020:t=fill,drawbox=x=110:y=215:w=12:h=10:color=0x302020:t=fill,drawbox=x=0:y=350:w=${W}:h=10:color=0x101010:t=fill,${lights}`,
	].join(';');
	ff([
		...['-f', 'lavfi', '-i', sky],
		...['-f', 'lavfi', '-i', ridge],
		...['-f', 'lavfi', '-i', `testsrc2=s=320x180`],
		...['-filter_complex', fc, '-frames:v', '1', file],
	]);
}

/** B: a different picture for the incoming side of transitions — a cool fractal under bars. */
function sceneB(file) {
	ff([
		...[
			'-f',
			'lavfi',
			'-i',
			`mandelbrot=s=${W}x${H}:start_x=-0.088:start_y=0.654:start_scale=0.03:end_pts=1`,
		],
		...['-f', 'lavfi', '-i', `smptehdbars=s=${W}x60`],
		...[
			'-filter_complex',
			`[0]colorchannelmixer=rr=0.2:rg=0.3:gr=0.3:gg=0.5:gb=0.2:br=0.5:bg=0.3:bb=0.6[f];[f][1]overlay=0:300`,
			'-frames:v',
			'1',
			file,
		],
	]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('usage: node scripts/docs/gallery-scenes.mjs <dir>');
		process.exit(2);
	}
	mkdirSync(dir, { recursive: true });
	sceneA(join(dir, 'scene.png'));
	sceneB(join(dir, 'scene-b.png'));
	console.log(`wrote ${join(dir, 'scene.png')} and ${join(dir, 'scene-b.png')}`);
}
