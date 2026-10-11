// Visual preview tool of the premiere-stylize-distort-generate family (development aid, not a test): renders jobs
// through the real fx GPU host in headless Chrome and writes one PNG per job plus a labelled contact sheet.
//   pnpm tsx packages/compositions/test/fx-psdg/preview.ts <jobs.json> <outDir> [photo.png] [--columns 4] [--title T]
// jobs.json: PreviewJob[] (see preview-entry.ts). The photo defaults to $PSDG_PHOTO, else a generated test card.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type {} from './preview-entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, d: string) => {
	const i = args.indexOf(`--${name}`);
	if (i < 0) return d;
	const v = args[i + 1]!;
	args.splice(i, 2);
	return v;
};
const columns = Number(opt('columns', '4'));
const title = opt('title', '');
const cell = opt('cell', '320x200').split('x').map(Number) as [number, number];
const [jobsFile, outDir, photoArg] = args;
if (!jobsFile || !outDir) {
	console.error('usage: preview.ts <jobs.json> <outDir> [photo.png] [--columns n] [--title t] [--cell WxH]');
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });
let photo = photoArg ?? process.env.PSDG_PHOTO ?? '';
if (!photo || !existsSync(photo)) {
	photo = join(outDir, '_testcard.png');
	execFileSync('ffmpeg', [
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=s=640x360',
		'-frames:v',
		'1',
		photo,
	]);
}

const req = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
const esbuild = req('esbuild') as {
	build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};
const bundle = await esbuild.build({
	entryPoints: [join(here, 'preview-entry.ts')],
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
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
	if (errors.length) throw new Error(errors.join('\n'));
	const photoUrl = `data:image/png;base64,${readFileSync(photo).toString('base64')}`;
	await page.evaluate((u) => window.__psdg.init(u), photoUrl);
	const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
	const t0 = Date.now();
	const write = (file: string, dataUrl: string) =>
		writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(',')[1]!, 'base64'));
	// One job per call: progress and per-job timing (slow shaders show up immediately).
	for (const job of jobs) {
		const t = Date.now();
		const r = await page.evaluate(([j]) => window.__psdg.render(j, null), [[job]] as const);
		const res = r.results[0]!;
		if (res.png) write(`${res.name.replace(/[^\w.-]+/g, '_')}.png`, res.png);
		console.log(
			res.error
				? `FAIL ${res.name}: ${res.error}`
				: `ok   ${res.name} ${res.size?.join('x')} ${Date.now() - t} ms`,
		);
	}
	const sheet = await page.evaluate(([s]) => window.__psdg.render([], s), [
		{ columns, cell, title: title || undefined },
	] as const);
	if (sheet.sheet) write('_sheet.png', sheet.sheet);
	console.log(`rendered ${jobs.length} jobs in ${Date.now() - t0} ms → ${outDir}`);
} finally {
	await browser.close();
}
