// Manual SwiftShader measurements recorded in docs/performance.md and docs/wp-notes/three-d.md.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LookRecipe, type Paint, TITLE_GENERATORS } from '@jasper/project';
import { CHROME, openGlPage } from '../test/gl-browser.ts';
import type { TitleScene } from '../test/three-d-title/entry.ts';
import { type LookImage, type LookPage, type LookRequest, openLookPage } from '../test/title-look-harness.ts';

const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const palette = {
	face: [0.95, 0.75, 0.2, 1],
	keyline: [0.1, 0.2, 0.9, 1],
	shadow: [0, 0, 0, 1],
	glow: [1, 0.2, 0.6, 1],
} as NonNullable<LookRecipe['palette']>;
const six: LookRecipe = {
	palette,
	layers: [
		{ type: 'shadow', params: { distance: 10, blur: 8, angle: 60 } },
		{ type: 'glow', params: { radius: 24 } },
		{ type: 'rim', params: { width: 8 } },
		{ type: 'rim', params: { width: 4, paint: { kind: 'role', role: 'accent1' } } },
		{ type: 'rim', params: { width: 2, paint: { kind: 'role', role: 'accent2' } } },
		{ type: 'face', params: {} },
	],
};
const face = () => ({
	type: 'face',
	params: { paint: { kind: 'color', color: [0.95, 0.75, 0.2, 1] } as Paint },
});
const FACE = { type: 'face', params: { paint: { kind: 'color', color: [0.3, 0.3, 0.3, 1] } as Paint } };
const layer = (id: string, params: Record<string, unknown> = {}, front = false): LookRecipe =>
	({
		layers: front
			? [FACE, { type: `generator:${id}`, params: { ownColors: true, ...params } }]
			: [{ type: `generator:${id}`, params: { ownColors: true, ...params } }, FACE],
	}) as LookRecipe;
const MOVING: Record<string, Record<string, number>> = {
	shockwave: { cycle: 1.2 },
	inkSplatter: { revealTime: 2 },
	brushSwirl: { writeTime: 2 },
	lensFlare: { flicker: 60, flickerRate: 8 },
};

async function look(tl: LookPage) {
	const req = (pxScale: number): LookRequest => ({
		recipe: six,
		input: { kind: 'text', text: 'Title Look', size: 200 },
		box: { width: 1920, height: 1080 },
		pxScale,
		timingOnly: true,
	});
	await tl.render(req(1));
	const profile = await tl.render({ ...req(1), perPass: true });
	console.info(`[title-look-perf] passes:\n${(profile as { passLog?: string[] }).passLog?.join('\n')}`);
	const face = (pxScale: number): LookRequest => ({
		...req(pxScale),
		recipe: { palette, layers: [{ type: 'face' }] },
	});
	// A title's real box: the text and the look's padding, not the whole frame.
	const tight = (pxScale: number): LookRequest => ({
		...req(pxScale),
		box: { width: 1200, height: 280 },
	});
	for (const [name, pxScale] of [
		['full', 1],
		['1/2', 0.5],
		['1/4', 0.25],
	] as const) {
		for (const [what, r] of [
			['six layers, frame-sized box', req(pxScale)],
			['six layers, title-sized box', tight(pxScale)],
			['field + face, frame-sized box', face(pxScale)],
		] as const) {
			const first = await tl.render(r);
			const runs: number[] = [];
			for (let i = 0; i < 7; i++) runs.push((await tl.render(r)).ms);
			runs.sort((a, b) => a - b);
			console.info(
				`[title-look-perf] ${name}, ${what}: canvas ${first.width}×${first.height}, ${first.passes} passes, first ${first.ms.toFixed(0)} ms, median ${runs[3]!.toFixed(0)} ms, min ${runs[0]!.toFixed(0)} ms, max ${runs[6]!.toFixed(0)} ms`,
			);
		}
	}
}

async function deepGlow(tl: LookPage) {
	const text = { kind: 'text', text: 'Title Look', size: 200 } as const;
	const median = async (run: () => Promise<LookImage>) => {
		const first = await run();
		const times: number[] = [];
		for (let i = 0; i < 5; i++) times.push((await run()).ms);
		times.sort((a, b) => a - b);
		return `canvas ${first.width}×${first.height}, ${first.passes} passes, median ${times[2]!.toFixed(0)} ms`;
	};
	const box = { width: 1200, height: 280 };
	const frame = { width: 1920, height: 1080 };
	for (const pxScale of [1, 0.5]) {
		const fx = (b: { width: number; height: number }, input: LookRequest['input']) =>
			median(() =>
				tl.effect({
					id: 'jasper.deep-glow',
					params: { radius: 200 },
					input,
					box: b,
					pxScale,
					timingOnly: true,
				}),
			);
		console.info(`[glows-perf] ${pxScale} effect, title box: ${await fx(box, text)}`);
		console.info(`[glows-perf] ${pxScale} effect, full frame: ${await fx(frame, { kind: 'card' })}`);
		const layer = median(() =>
			tl.render({
				recipe: { layers: [face(), { type: 'deepGlow', params: { from: 'stack', radius: 100 } }] },
				input: text,
				box,
				pxScale,
				timingOnly: true,
			}),
		);
		console.info(`[glows-perf] ${pxScale} look layer, title box: ${await layer}`);
	}
}

async function generators(tl: LookPage) {
	for (const g of TITLE_GENERATORS) {
		const req: LookRequest = {
			recipe: layer(g.id, MOVING[g.id] ?? {}, g.front === true),
			input: { kind: 'text', text: 'Title Look', size: 200 },
			box: { width: 1200, height: 280 },
			contentSeconds: 0.5,
			timingOnly: true,
		};
		const first = await tl.render(req);
		const runs: number[] = [];
		for (let i = 0; i < 3; i++) runs.push((await tl.render(req)).ms);
		runs.sort((a, b) => a - b);
		const half = (await tl.render({ ...req, pxScale: 0.5 })).ms;
		console.info(
			`[generator-perf] ${g.id}: canvas ${first.width}×${first.height}, ${first.passes} passes, median ${runs[1]!.toFixed(0)} ms, at 1/2 ${half.toFixed(0)} ms`,
		);
	}
	const base = await tl.render({
		recipe: { layers: [FACE] } as LookRecipe,
		input: { kind: 'text', text: 'Title Look', size: 200 },
		box: { width: 1200, height: 280 },
		timingOnly: true,
	});
	console.info(`[generator-perf] face only: ${base.ms.toFixed(0)} ms`);
}

async function lightning(tl: LookPage) {
	const cases: [string, Record<string, unknown>][] = [
		['defaults', {}],
		['alpha bounds, capture 40 %, bolts 2 units', { anchor: 'bounds', capture: 40, boltLength: 200 }],
		['along edge', { mode: 'edge' }],
		// The most area sums a frame can ask for: every arc or bolt there is, Capture at its soft maximum.
		['worst along edge: 60 arcs, capture 80 %', { mode: 'edge', arcs: 60, capture: 80 }],
		['worst crawl: 40 bolts, capture 80 %', { mode: 'crawl', count: 40, capture: 80 }],
	];
	for (const [name, params] of cases) {
		const req: LookRequest = {
			recipe: layer('lightning', params, true),
			input: { kind: 'text', text: 'Title Look', size: 200 },
			box: { width: 1200, height: 280 },
			contentSeconds: 0.5,
			timingOnly: true,
		};
		const first = await tl.render(req);
		const runs: number[] = [];
		for (let i = 0; i < 3; i++) runs.push((await tl.render(req)).ms);
		runs.sort((a, b) => a - b);
		const half = (await tl.render({ ...req, pxScale: 0.5 })).ms;
		const passes = (await tl.render({ ...req, perPass: true })).passLog ?? [];
		const ms = (line: string) => Number(/ (\d+) ms$/.exec(line)?.[1] ?? 0);
		const flat = (line: string) => line.replace(/\s+/g, ' ').trim();
		const slowest = [...passes].sort((a, b) => ms(b) - ms(a))[0] ?? '';
		// The bolts pass (`tlGenB`): one fragment per bolt end or arc point, each with its area sums.
		const bolts = passes.find((l) => l.startsWith('tlGenB')) ?? '';
		console.info(
			`[lightning-perf] ${name}: canvas ${first.width}×${first.height}, ${first.passes} passes, median ${runs[1]!.toFixed(0)} ms, at 1/2 ${half.toFixed(0)} ms; bolts pass ${flat(bolts)}; slowest pass ${flat(slowest)}`,
		);
	}
}

async function threeD() {
	const { browser, page } = await openGlPage(join(here, 'three-d-title', 'entry.ts'), {
		page: { viewport: { width: 64, height: 64 } },
	});
	const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
		page.evaluate(
			([n, a]) =>
				(window as unknown as { __title: Record<string, (...x: unknown[]) => unknown> }).__title[
					n as string
				]!(...(a as unknown[])),
			[name, args] as const,
		) as Promise<T>;
	const round = (width: number, depth: number, profile = 'round') => ({
		width,
		depth,
		profile,
		curve: 0,
		segments: 6,
	});
	const gold = {
		W: 320,
		H: 160,
		text: 'GOLD',
		rotY: -24,
		rotX: 12,
		toneMapping: 'aces',
		geometry: { depth: 26, bands: [round(5, 5)] },
		surfaces: { base: 'gold' },
		envPreset: 0,
		backdrop: 'grey',
	} as TitleScene;
	try {
		const s = {
			...gold,
			W: 1920,
			H: 1080,
			font: '900 300px "Liberation Sans", sans-serif',
			geometry: { depth: 60, bands: [round(10, 10)] },
		} as TitleScene;
		const first = await call<number>('time', s, 1);
		const warm = await call<number>('time', { ...s, orbit: 3 }, 5);
		const glass = await call<number>('time', { ...s, surfaces: { base: 'glass' }, backdrop: 'stripes' }, 3);
		const glint = await call<number>(
			'time',
			{
				...s,
				glint: { threshold: 2, intensity: 200, radius: 16, rays: 4, length: 90, angle: 45 },
			},
			3,
		);
		process.stdout.write(
			`perf 1080p first ${first.toFixed(0)} ms, warm ${(warm / 5).toFixed(0)} ms/frame, glass ${(glass / 3).toFixed(0)} ms/frame, glint ${(glint / 3).toFixed(0)} ms/frame\n`,
		);
	} finally {
		await browser.close();
	}
}

const benchmarks: Record<string, (tl: LookPage) => Promise<void>> = {
	look,
	'deep-glow': deepGlow,
	generators,
	lightning,
};
const usage =
	'Usage: pnpm exec tsx packages/compositions/bench/title-looks.ts <look|deep-glow|generators|lightning|three-d>';
const mode = process.argv[2];
if (mode === '--help' || mode === '-h') {
	console.info(usage);
} else if (!mode || (mode !== 'three-d' && !benchmarks[mode])) {
	console.error(usage);
	process.exitCode = 1;
} else {
	if (!CHROME) throw new Error('Chrome is required; set JASPER_BROWSER_EXECUTABLE to its executable.');
	if (mode === 'three-d') {
		await threeD();
	} else {
		const tl = await openLookPage(here);
		try {
			await benchmarks[mode]!(tl);
		} finally {
			await tl.browser.close();
		}
	}
}
