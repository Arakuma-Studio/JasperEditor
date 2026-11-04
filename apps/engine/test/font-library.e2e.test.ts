// wp fonts (REMOTION_E2E=1): a text layer in a font of the user library renders the same on every path. The
// reference is the Program monitor's composition rendered by Remotion (a still of the full sequence with the
// catalog's font URLs, as the Player loads them); the native (hybrid, layer bake) export, the forced Remotion export
// and the still route are compared with it per pixel, and each must differ clearly from the fallback rendering (the
// same layer before the font was installed), so a silent fallback cannot pass.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { makeTestTtf } from './font-fixtures.ts';
import { DocBuilder, JSON_H, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 1280;
const H = 720;

function decode(file: string, frame?: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			...(frame !== undefined ? ['-vf', `select=eq(n\\,${frame})`] : []),
			'-frames:v',
			'1',
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

/** Share of bytes within `tol` code values. */
function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

/** Pixels (rgb24) that differ by more than 64 in any channel. */
function changedPixels(a: Uint8Array, b: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < a.length; i += 3)
		if (
			Math.abs(a[i]! - b[i]!) > 64 ||
			Math.abs(a[i + 1]! - b[i + 1]!) > 64 ||
			Math.abs(a[i + 2]! - b[i + 2]!) > 64
		)
			n++;
	return n;
}

describe.runIf(enabled)('library fonts: preview vs every export path (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-fonts-e2e-'),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			// These tests drive the engine itself, not its authentication (font-library.test.ts covers auth).
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	const wait = (id: string): Promise<EngineJob> => queue().wait(id);

	const settings = (seqId: string, engineName: 'auto' | 'remotion') => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		engine: engineName,
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

	async function exportDoc(d: DocBuilder, engineName: 'auto' | 'remotion') {
		const body = { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, engineName) };
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: body,
			})
		).json();
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: body,
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { plan, done, out: join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.mov') };
	}

	async function still(d: DocBuilder, frame: number) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
		});
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.png');
	}

	/** The Program monitor's composition, rendered by Remotion with the catalog's font URLs (what the Player loads). */
	async function previewFrame(d: DocBuilder, frame: number): Promise<Buffer> {
		const core = coreServices(engine.app);
		const doc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveMedia: () => null,
			resolveFont: (font, weight, italic) => {
				const face = core.fonts.resolve(font.family, weight, italic);
				return face && !face.fallback
					? core.signer.signUrl(`http://127.0.0.1:${engine.port}`, face.url)
					: null;
			},
		});
		const out = join(tempAppdir('jasper-fonts-ref-'), 'ref.png');
		await core.remotion.renderStill({
			inputProps: { doc, options: { isPreview: false, useProxies: false, transparentBackground: false } },
			output: out,
			frame,
			signal: new AbortController().signal,
		});
		return decode(out);
	}

	it('a Pixel12x10 title renders with the installed font in the preview, the native and Remotion exports and stills', async () => {
		const d = new DocBuilder('hd-720p-30');
		d.tx([
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.3, 0.3, 0.3, 1] },
			},
			{ type: 'font.add', family: 'Pixel12x10', ref: '$f' },
			{ type: 'font.add', family: 'Source Sans 3', ref: '$fallback' },
			{
				type: 'clip.addText',
				at: 0,
				duration: 1,
				track: 'V1',
				content: {
					text: 'PIXEL TITLE 12',
					style: { fontId: '$f', sizePx: 120, fill: [1, 1, 1, 1] },
					// A visible control loads the declared fallback on every path. A failed library load then
					// matches the pre-install rendering instead of differing merely because Arial was used.
					runs: [{ from: 13, to: 14, style: { fontId: '$fallback' } }],
				},
			},
		]);
		// Neutral colours: the Remotion path's ProRes intermediate subsamples chroma, which would blur coloured edges.
		// Before the font is installed: fallback + warning (the comparison baseline for "the font is really used").
		const fallback = await exportDoc(d, 'auto');
		expect(fallback.plan.warnings.map((w: { code: string }) => w.code)).toContain('FONT_FALLBACK');
		const fallbackFrame = decode(fallback.out, 0);

		const up = await engine.app.inject({
			method: 'POST',
			url: '/api/fonts/library?fileName=Pixel12x10.ttf',
			headers: { ...hostH(), 'content-type': 'application/octet-stream' },
			payload: Buffer.from(makeTestTtf({ family: 'Pixel12x10', postscriptName: 'Pixel12x10', seed: 5 })),
		});
		expect(up.statusCode, up.body).toBe(201);

		const reference = await previewFrame(d, 0);
		const native = await exportDoc(d, 'auto');
		expect(native.plan.warnings.map((w: { code: string }) => w.code)).not.toContain('FONT_FALLBACK');
		expect(native.plan.path).toBe('hybrid');
		const remotion = await exportDoc(d, 'remotion');
		expect(remotion.plan.warnings.map((w: { code: string }) => w.code)).not.toContain('FONT_FALLBACK');
		const stillFrame = decode(await still(d, 0));

		const frames = { native: decode(native.out, 0), remotion: decode(remotion.out, 0), still: stillFrame };
		const textPixels = changedPixels(reference, fallbackFrame);
		// the library font draws visibly different glyphs than the fallback (thousands of pixels at 120 px)
		expect(textPixels).toBeGreaterThan(2000);
		for (const [name, f] of Object.entries(frames)) {
			const share = within(f, reference, 3);
			console.info(`[fonts parity] ${name} vs preview: ${(share * 100).toFixed(3)} % within 3/255`);
			expect(share, name).toBeGreaterThanOrEqual(0.99);
			expect(changedPixels(f, fallbackFrame), `${name} differs from the fallback`).toBeGreaterThan(
				textPixels * 0.8,
			);
		}
	}, 1_800_000);
});
