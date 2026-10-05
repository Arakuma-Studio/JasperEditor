// Visual check of the Premiere Adjust/Color/Keying family (dev tool, not a test): renders effects with the real GPU
// host in headless Chrome (WebGL2, SwiftShader) on test pictures and writes one PNG per shot plus an optional
// labelled contact sheet.
//   pnpm exec tsx packages/compositions/test/fx-pacg/shots.ts <shots.json> <outDir> [--sheet <file.png>] [--cols N]
// shots.json: [{ "name": "levels-gamma", "id": "jasper.levels", "params": {…}, "picture": {"kind": "image",
// "file": "/abs/photo.jpg"} | {"kind": "bars"|"ramp"|"disc"|"solid", …}, "box": {"width": 480, "height": 270},
// "media": {"paramName": {…picture…}}, "background": "checker" }]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const [shotsFile, outDir, ...rest] = process.argv.slice(2);
if (!shotsFile || !outDir) throw new Error('usage: shots.ts <shots.json> <outDir> [--sheet file] [--cols N]');
const sheet = rest.includes('--sheet') ? rest[rest.indexOf('--sheet') + 1] : undefined;
const cols = rest.includes('--cols') ? Number(rest[rest.indexOf('--cols') + 1]) : 4;
const tile = rest.includes('--tile') ? Number(rest[rest.indexOf('--tile') + 1]) : 320;

type Pic = { kind: string; file?: string; url?: string; [k: string]: unknown };
type Shot = {
	name: string;
	id: string;
	params?: Record<string, unknown>;
	picture: Pic;
	box?: { width: number; height: number };
	media?: Record<string, Pic>;
	background?: string;
};

const dataUrl = (file: string) =>
	`data:image/${extname(file) === '.png' ? 'png' : 'jpeg'};base64,${readFileSync(file).toString('base64')}`;
const resolvePic = (p: Pic): Pic =>
	p.file ? { ...p, kind: 'image', url: dataUrl(p.file), file: undefined } : p;

const shots = JSON.parse(readFileSync(shotsFile, 'utf8')) as Shot[];
mkdirSync(outDir, { recursive: true });

const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
const esbuild = req('esbuild') as {
	build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};
const bundle = await esbuild.build({
	entryPoints: [join(here, 'entry.ts')],
	bundle: true,
	write: false,
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	define: { 'process.env.NODE_ENV': '"production"' },
	logLevel: 'silent',
});
const CHROME = [process.env.JASPER_BROWSER_EXECUTABLE, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
	(p): p is string => !!p && existsSync(p),
);
const browser = await chromium.launch({
	executablePath: CHROME,
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: bundle.outputFiles[0]!.text });

const results: { name: string; url: string }[] = [];
for (const s of shots) {
	const request = {
		id: s.id,
		params: s.params ?? {},
		picture: resolvePic(s.picture),
		box: s.box ?? { width: 480, height: 320 },
		media: s.media
			? Object.fromEntries(Object.entries(s.media).map(([k, v]) => [k, resolvePic(v)]))
			: undefined,
		background: s.background ?? 'checker',
	};
	try {
		const r = (await page.evaluate(
			([q, w]) =>
				(
					window as unknown as {
						__pacg: { png(q: unknown, w: number): Promise<{ url: string; ms: number }> };
					}
				).__pacg.png(q, w as number),
			[request, tile] as const,
		)) as { url: string; ms: number };
		writeFileSync(join(outDir, `${s.name}.png`), Buffer.from(r.url.split(',')[1]!, 'base64'));
		results.push({ name: s.name, url: r.url });
		console.info(`${s.name}: ${r.ms.toFixed(0)} ms`);
	} catch (e) {
		console.error(`${s.name}: ${(e as Error).message}`);
	}
}

if (sheet) {
	const png = (await page.evaluate(
		async ([items, n, size]) => {
			const imgs = await Promise.all(
				(items as { name: string; url: string }[]).map(async (it) => {
					const im = new Image();
					im.src = it.url;
					await im.decode();
					return { name: it.name, im };
				}),
			);
			const cw = size as number;
			const ch = Math.max(...imgs.map((i) => (i.im.height * cw) / i.im.width)) + 18;
			const c = document.createElement('canvas');
			c.width = cw * (n as number);
			c.height = Math.ceil(imgs.length / (n as number)) * ch;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = '#222';
			ctx.fillRect(0, 0, c.width, c.height);
			imgs.forEach((it, i) => {
				const x = (i % (n as number)) * cw;
				const y = Math.floor(i / (n as number)) * ch;
				ctx.drawImage(it.im, x, y + 18, cw, (it.im.height * cw) / it.im.width);
				ctx.fillStyle = '#eee';
				ctx.font = '12px sans-serif';
				ctx.fillText(it.name, x + 4, y + 13);
			});
			return c.toDataURL('image/png');
		},
		[results, cols, tile] as const,
	)) as string;
	writeFileSync(sheet, Buffer.from(png.split(',')[1]!, 'base64'));
	console.info(`sheet: ${sheet}`);
}
await browser.close();
