// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const W = 640;
const H = 360;

type Rgb = [number, number, number];

function snapshotOf(m: FxMedia, build: (refs: { seq: string }) => Command[]) {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'text', preset: 'hd-720p-30' });
	const seqId = Object.keys(project.sequences)[0]!;
	const { document, result } = applyTransaction(
		project,
		{
			label: 'text',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: W, height: H } } as Command,
				...build({ seq: seqId }),
			],
		},
		{ ids, now: () => '2026-10-07T10:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: (f, weight) =>
			f.family === 'Inter Variable'
				? `${m.base}/inter-var.woff2`
				: `${m.base}/ss3-${weight >= 600 ? 700 : 400}.woff2`,
	});
}

const text = (s: string, extra: Record<string, unknown> = {}): Command[] => [
	{
		type: 'clip.addText',
		at: 0,
		duration: 90,
		track: 'V1',
		content: { text: s, style: { sizePx: 80, fill: [1, 1, 1, 1], align: 'center', ...extra } },
		box: { width: 600, height: 120, autoSize: 'none' },
		ref: '$t',
	} as unknown as Command,
];

describe.runIf(enabled)('text animators in Remotion renders (REMOTION_E2E=1)', { timeout: 240_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};

	beforeAll(async () => {
		media = await startFxMedia('text-animators-');
		const req = createRequire(import.meta.url);
		const dir = dirname(
			req.resolve('@fontsource/source-sans-3/package.json', { paths: [join(here, '../../../apps/engine')] }),
		);
		copyFileSync(join(dir, 'files/source-sans-3-latin-400-normal.woff2'), join(media.dir, 'ss3-400.woff2'));
		copyFileSync(join(dir, 'files/source-sans-3-latin-700-normal.woff2'), join(media.dir, 'ss3-700.woff2'));
		const vdir = dirname(
			req.resolve('@fontsource-variable/inter/package.json', { paths: [join(here, '../../../apps/engine')] }),
		);
		copyFileSync(join(vdir, 'files/inter-latin-standard-normal.woff2'), join(media.dir, 'inter-var.woff2'));
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, 'text-animators', 'entry.ts') });
		renderer = await import('@remotion/renderer');
		console.info(`[text-animators] stills in ${media.dir}`);
	}, 300_000);
	afterAll(() => media?.close());

	async function still(doc: ReturnType<typeof snapshotOf>, frame: number, name: string): Promise<Buffer> {
		const inputProps = {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false },
		};
		const composition = await renderer.selectComposition({
			serveUrl,
			id: SEQUENCE_COMPOSITION_ID,
			inputProps,
			...browser,
		});
		const output = join(media.dir, `${name}.png`);
		await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
		return execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
			maxBuffer: 1 << 26,
		});
	}
	const ink = (raw: Buffer, x0: number, x1: number, y0 = 0, y1 = H) => {
		let s = 0;
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) {
				const i = (y * W + x) * 3;
				s += raw[i]! + raw[i + 1]! + raw[i + 2]!;
			}
		return s / 765;
	};
	const bbox = (raw: Buffer, pred: (p: Rgb) => boolean) => {
		let x0 = W;
		let y0 = H;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 3;
				if (pred([raw[i]!, raw[i + 1]!, raw[i + 2]!])) {
					x0 = Math.min(x0, x);
					x1 = Math.max(x1, x);
					y0 = Math.min(y0, y);
					y1 = Math.max(y1, y);
				}
			}
		return { x0, y0, x1, y1 };
	};
	const white = (p: Rgb) => p[0] > 128 && p[1] > 128 && p[2] > 128;

	it('a typewriter reveals left to right; the rest state equals plain text glyph extents', async () => {
		const plain = await still(
			snapshotOf(media, () => text('HELLO')),
			5,
			'plain',
		);
		const doc = snapshotOf(media, () => [
			...text('HELLO'),
			{
				type: 'textAnimator.applyPreset',
				clipIds: ['$t'],
				preset: 'typewriter',
				durationFrames: 60,
			} as Command,
		]);
		const start = await still(doc, 0, 'typewriter-0');
		const mid = await still(doc, 30, 'typewriter-30');
		const end = await still(doc, 70, 'typewriter-70');
		expect(ink(start, 0, W)).toBeLessThan(5);
		const pb = bbox(plain, white);
		const eb = bbox(end, white);
		for (const k of ['x0', 'x1', 'y0', 'y1'] as const) expect(Math.abs(pb[k] - eb[k])).toBeLessThanOrEqual(1);
		const mb = bbox(mid, white);
		expect(mb.x0).toBeLessThanOrEqual(pb.x0 + 1);
		expect(mb.x1).toBeLessThan(pb.x0 + (pb.x1 - pb.x0) * 0.75);
		expect(mb.x1).toBeGreaterThan(pb.x0 + (pb.x1 - pb.x0) * 0.25);
	});

	it('position / rotation / fill colour / blur animators move and paint each character', async () => {
		const doc = snapshotOf(media, () => [
			...text('ABCD'),
			{ type: 'textAnimator.add', clipId: '$t', properties: ['position', 'fillColor'], ref: '$a' } as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'position'],
				value: [0, -100],
			} as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'fillColor'],
				value: [1, 0, 0, 1],
			} as Command,
		]);
		const raw = await still(doc, 10, 'position-fill');
		const red = bbox(raw, (p) => p[0] > 150 && p[1] < 80 && p[2] < 80);
		expect(red.x1).toBeGreaterThan(0);
		// Lifted by 100 px from the centred baseline.
		expect(red.y1).toBeLessThan(H / 2 - 20);
		expect(ink(raw, 0, W, H / 2, H)).toBeLessThan(5);
	});

	it('a range selector on the first half selects only those characters', async () => {
		const doc2 = snapshotOf(media, () => [
			...text('AAAA'),
			{
				type: 'textAnimator.add',
				clipId: '$t',
				properties: ['opacity'],
				selector: false,
				ref: '$a',
			} as Command,
			{ type: 'textSelector.add', clipId: '$t', animatorId: '$a', kind: 'range', ref: '$s' } as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'opacity'],
				value: 0,
			} as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'selectors', '$s', 'end'],
				value: 50,
			} as Command,
		]);
		const raw = await still(doc2, 1, 'range-half');
		expect(ink(raw, 0, W)).toBeGreaterThan(50);
		const b = bbox(raw, white);
		expect(b.x0).toBeGreaterThan(W / 2 - 5);
	});

	it('Path Options: characters follow a mask path (perpendicular)', async () => {
		const doc = snapshotOf(media, () => [
			...text('CIRCLE TEXT ON A PATH', { sizePx: 32 }),
			{
				type: 'mask.add',
				clipId: '$t',
				shape: 'ellipse',
				mode: 'none',
				ref: '$m',
			} as Command,
			{ type: 'text.setPathOptions', clipIds: ['$t'], maskId: '$m' } as Command,
		]);
		const raw = await still(doc, 1, 'path');
		const b = bbox(raw, white);
		// The text bends away from its straight baseline: its ink spans much more height than one line.
		expect(b.y1 - b.y0).toBeGreaterThan(60);
	});

	it('per-character 3D flip and a wiggly selector render deterministically', async () => {
		const doc = snapshotOf(media, () => [
			...text('FLIP'),
			{ type: 'textAnimator.applyPreset', clipIds: ['$t'], preset: 'flip-in-3d' } as Command,
			{ type: 'textAnimator.applyPreset', clipIds: ['$t'], preset: 'jitter' } as Command,
		]);
		const a = await still(doc, 12, 'flip-12');
		const b = await still(doc, 12, 'flip-12-again');
		expect(Buffer.compare(a, b)).toBe(0);
		expect(ink(a, 0, W)).toBeGreaterThan(50);
	});

	it('variable font axes: style wght and an animated wght offset change the stroke weight', async () => {
		const at = (wght: number, animated: number | null) =>
			snapshotOf(media, () => [
				{ type: 'font.add', family: 'Inter Variable', ref: '$f' } as Command,
				...text('WEIGHT', { fontId: '$f', fontVariations: { wght } }),
				...(animated === null
					? []
					: ([
							{ type: 'textAnimator.add', clipId: '$t', axes: ['wght'], ref: '$a' },
							{
								type: 'param.set',
								target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'axes', 'wght'],
								value: animated,
							},
						] as Command[])),
			]);
		const thin = ink(await still(at(150, null), 1, 'wght-150'), 0, W);
		const black = ink(await still(at(850, null), 1, 'wght-850'), 0, W);
		const offset = ink(await still(at(150, 700), 1, 'wght-150+700'), 0, W);
		expect(black).toBeGreaterThan(thin * 1.8);
		expect(Math.abs(offset - black) / black).toBeLessThan(0.08);
	});

	it('stroke, fill & stroke order, blur and inter-character blending render', async () => {
		const doc = snapshotOf(media, () => [
			// After Effects strokes are centred on the outline (spec 13 SH-004: an outside stroke paints only outside its
			// glyph, so only a centred stroke can cover its own fill when strokes are drawn over fills).
			...text('STROKE', { strokes: [{ color: [1, 0, 0, 1], widthPx: 12, position: 'center' }] }),
			{ type: 'textAnimator.add', clipId: '$t', properties: ['blur', 'strokeWidth'], ref: '$a' } as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'blur'],
				value: [20, 0],
			} as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textMore', 'fillAndStroke'],
				value: 'allStrokesOverAllFills',
			} as Command,
		]);
		const raw = await still(doc, 1, 'stroke-blur');
		const red = bbox(raw, (p) => p[0] > 120 && p[1] < 90);
		const plain = bbox(
			await still(
				snapshotOf(media, () => text('STROKE')),
				1,
				'stroke-plain',
			),
			white,
		);
		// Horizontal-only blur spreads the paint sideways more than vertically.
		expect(plain.x0 - red.x0).toBeGreaterThan(plain.y0 - red.y0);
		// Strokes over fills: the red outline covers the white fill.
		expect(bbox(raw, white).x1).toBeLessThan(0);
	});

	it('Expression Selector: textIndex selects every other character (QuickJS in the renderer)', async () => {
		const doc = snapshotOf(media, () => [
			...text('MMMM'),
			{
				type: 'textAnimator.add',
				clipId: '$t',
				properties: ['opacity'],
				selector: false,
				ref: '$a',
			} as Command,
			{
				type: 'param.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'opacity'],
				value: 0,
			} as Command,
			{ type: 'textSelector.add', clipId: '$t', animatorId: '$a', kind: 'expression', ref: '$s' } as Command,
			{
				type: 'expression.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'selectors', '$s', 'amount'],
				text: 'textIndex % 2 * 100',
			} as Command,
		]);
		expect(doc.expressions).toBeTruthy();
		const all = ink(
			await still(
				snapshotOf(media, () => text('MMMM')),
				1,
				'expr-plain',
			),
			0,
			W,
		);
		const half = ink(await still(doc, 1, 'expr-selector'), 0, W);
		expect(half / all).toBeGreaterThan(0.4);
		expect(half / all).toBeLessThan(0.6);
	});

	it('an expression on an animator property drives it (bound in the snapshot)', async () => {
		const doc = snapshotOf(media, () => [
			...text('EXPR'),
			{ type: 'textAnimator.add', clipId: '$t', properties: ['position'], ref: '$a' } as Command,
			{
				type: 'expression.set',
				target: ['clip', '$t', 'textAnimators', '$a', 'properties', 'position'],
				text: '[0, -120]',
			} as Command,
		]);
		const raw = await still(doc, 1, 'expr-property');
		expect(ink(raw, 0, W)).toBeGreaterThan(50);
		expect(bbox(raw, white).y1).toBeLessThan(H / 2 - 30);
	});
});
