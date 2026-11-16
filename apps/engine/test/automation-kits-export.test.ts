// Cut kits through export (spec 15 EA-033, EA-050; AGENTS §4): one kit of every family (Shake, Jolt, Whip, Zoom blur,
// Zoom through, Spin), planned by Decorate Cuts and accepted, exported through the route the planner chooses (native
// for the long-form families, whose geometric effects run as the adjustment kernel's GL chain, blend/passes.ts; the
// Remotion path for Shake, whose S_Shake motion blur the kernel does not draw) and compared frame by frame with the
// Program composition (the Remotion still of the same document); the kit must also be visible (frames differ from the
// undecorated edit). Opt-in: REMOTION_E2E=1 (headless Chrome with GL, ffmpeg).
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningEngine } from '../src/index.ts';
import type { DocBuilder } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const enabled = process.env.REMOTION_E2E === '1';
let engineApi: typeof import('../src/index.ts');
let services: typeof import('../src/tools/services.ts');
let helpers: typeof import('./helpers.ts');
let project: typeof import('@jasper/project');
if (enabled)
	[engineApi, services, helpers, project] = await Promise.all([
		import('../src/index.ts'),
		import('../src/tools/services.ts'),
		import('./helpers.ts'),
		import('@jasper/project'),
	]);

const W = 640;
const H = 360;
const CUT = 40;
const settings = (sequenceId: string) => ({
	sequenceId,
	range: { type: 'entire' },
	container: 'mov',
	engine: 'auto',
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
});

function decodeFrames(file: string, frames: number[]): Buffer[] {
	const r = spawnSync(
		'ffmpeg',
		[
			...['-v', 'error', '-i', file, '-vf'],
			`select=${frames.map((f) => `eq(n\\,${f})`).join('+')}`,
			...[
				'-fps_mode',
				'passthrough',
				'-frames:v',
				String(frames.length),
				'-pix_fmt',
				'rgb24',
				'-f',
				'rawvideo',
			],
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	expect(r.status, r.stderr.toString()).toBe(0);
	const stride = W * H * 3;
	expect(r.stdout.length).toBe(stride * frames.length);
	return frames.map((_, i) => r.stdout.subarray(i * stride, (i + 1) * stride));
}

function compare(rgb: Uint8Array, rgba: Uint8Array, tol: number): { share: number; mean: number } {
	let n = 0;
	let sum = 0;
	for (let i = 0; i < rgb.length; i++) {
		const d = Math.abs(rgb[i]! - rgba[Math.floor(i / 3) * 4 + (i % 3)]!);
		if (d <= tol) n++;
		sum += d;
	}
	return { share: n / rgb.length, mean: sum / rgb.length };
}

/** Mean |Δ| of two RGBA images. */
function diff(a: Uint8Array, b: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i]! - b[i]!);
	return sum / ((a.length / 4) * 3);
}

const FAMILIES: { pack: 'shorts-shake' | 'long-pack'; family: string }[] = [
	{ pack: 'shorts-shake', family: 'shake' },
	{ pack: 'long-pack', family: 'jolt' },
	{ pack: 'long-pack', family: 'whip' },
	{ pack: 'long-pack', family: 'zoom-blur' },
	{ pack: 'long-pack', family: 'zoom-through' },
	{ pack: 'long-pack', family: 'spin' },
];

describe.runIf(enabled)('cut kits export like the Program composition (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	let browser: import('../src/remotion/service.ts').SharedRenderBrowser;
	let referenceDir: string;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
	beforeAll(async () => {
		referenceDir = tempAppdir('jasper-kits-ref-');
		engine = await engineApi.startEngine({
			appdir: tempAppdir('jasper-kits-export-'),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		browser = await services.coreServices(engine.app).remotion.openSharedBrowser();
	}, 600_000);
	afterAll(async () => {
		try {
			await browser?.close();
		} finally {
			await engine?.stop();
		}
	});

	/** Two flat pictures meeting at CUT with a small square over both (structure for the kit to move). */
	function edit(): DocBuilder {
		const d = new helpers.DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'sequence.updateSettings', settings: { width: W, height: H } },
			{ type: 'clip.addSolid', at: 0, duration: CUT, track: 'V1', color: [0.1, 0.2, 0.8, 1] },
			{ type: 'clip.addSolid', at: CUT, duration: CUT, track: 'V1', color: [0.15, 0.6, 0.2, 1] },
			{ type: 'track.add', kind: 'video' },
			{
				type: 'clip.addSolid',
				at: 0,
				duration: 2 * CUT,
				track: 'V2',
				color: [0.95, 0.3, 0.1, 1],
				ref: '$sq',
			},
			{ type: 'param.set', target: ['clip', '$sq', 'transform', 'scale'], value: 20 },
			{ type: 'param.set', target: ['clip', '$sq', 'transform', 'position'], value: [W * 0.35, H * 0.4] },
		]);
		return d;
	}

	async function exportDoc(d: DocBuilder) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...helpers.JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await services.coreServices(engine.app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { done, out: (await services.coreServices(engine.app).exports.outputFile(done.id))! };
	}

	async function still(d: DocBuilder, frame: number, tag: string): Promise<Uint8Array> {
		const doc = project.buildRenderSnapshot(d.doc, d.seqId, {
			resolveFont: () => null,
			resolveMedia: () => null,
		});
		const output = join(referenceDir, `${tag}-${frame}.png`);
		await services.coreServices(engine.app).remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output,
			frame,
			signal: new AbortController().signal,
			browser,
		});
		const image = decodePng(readFileSync(output));
		expect([image.width, image.height]).toEqual([W, H]);
		return image.data;
	}

	for (const { pack, family } of FAMILIES)
		it(`${family}: the export matches the Program composition and shows the kit`, async () => {
			const plain = edit();
			const d = edit();
			const weights = Object.fromEntries(
				project.builtinKitPack(pack)!.families.map((f) => [f.id, f.id === family ? 1 : 0]),
			);
			const plan = project.planDecorateCuts(d.doc, d.seqId, {
				pack,
				families: weights,
				sfx: { enabled: false },
				seed: 3,
			});
			expect(plan.kits.map((k) => [k.frame, k.family])).toEqual([[CUT, family]]);
			const items = project.passItems(d.doc, plan);
			d.tx(items.items.flatMap((it) => it.commands));
			const kit = plan.kits[0]!;
			const frames = [kit.start + 1, CUT - 4, CUT - 1, CUT, CUT + 2, CUT + 6, kit.end - 2];
			const { done, out } = await exportDoc(d);
			expect(done.result).toMatchObject({ renderPath: pack === 'long-pack' ? 'native' : 'remotion' });
			const decoded = decodeFrames(out, frames);
			const lines: string[] = [];
			let visible = 0;
			for (const [i, frame] of frames.entries()) {
				const ref = await still(d, frame, family);
				const c = compare(decoded[i]!, ref, 4);
				const moved = diff(ref, await still(plain, frame, `${family}-plain`));
				visible = Math.max(visible, moved);
				lines.push(`f${frame} ${c.share.toFixed(4)}/${c.mean.toFixed(3)} kit Δ ${moved.toFixed(2)}`);
				expect(c.share, `${family} frame ${frame}`).toBeGreaterThanOrEqual(0.98);
			}
			const line = `[kit export parity] ${family} (${kit.variant}) share within 4/255 / mean |Δ| / kit Δ: ${lines.join('; ')}`;
			console.info(line);
			appendFileSync(join(tmpdir(), 'automation-kits-export.txt'), `${new Date().toISOString()} ${line}\n`);
			// the kit changes the picture around the cut (not a no-op); a shake or a jolt moves the small square a few
			// pixels on this flat picture (mean |Δ| over the whole frame ≈ 0.7–1.4), the other families far more
			expect(visible, `${family} visible`).toBeGreaterThan(0.3);
		}, 1_800_000);
});
