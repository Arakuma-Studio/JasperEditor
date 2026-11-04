// spec 13 SH-004 (docs/wp-notes/text-render.md) end to end in the engine (REMOTION_E2E=1):
// - an agent transaction applied headlessly (no editor window) gets text boxes measured in the render browser
//   (the headless measurer, JASPER_TEXT_MEASURE=on), not the 0.55 em estimate;
// - the layer bake of a measured, unanimated title is cropped to its glyphs + strokes + shadow (not the 10 %-of-
//   height bleed), and the hybrid export (bakes composited natively) and a Program still equal the Remotion
//   frame of the same document — so the tighter crop cuts nothing and every export path draws every stroke and
//   the shadow spread.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	buildRenderSnapshot,
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	makeEnvelope,
	type ProjectDocument,
	type TransactionResult,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { contentBleed, cropRect } from '../src/layer-bake/layer.ts';
import { coreServices } from '../src/tools/services.ts';
import { JSON_H, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const W = 1280;
const H = 720;
type TextClip = Extract<Clip, { kind: 'text' }>;

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
const within = (a: Uint8Array, b: Uint8Array, tol: number) => {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
};

describe.runIf(enabled)('text paint on every export path (REMOTION_E2E=1)', { timeout: 900_000 }, () => {
	let engine: RunningEngine;
	let appdir: string;
	let projectId: string;
	let seqId: string;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		appdir = tempAppdir('jasper-text-paint-');
		const ids = createCounterIdSource(5);
		const doc = createEmptyProject({ ids, name: 'Text paint', preset: 'hd-720p-30' });
		projectId = doc.projectId;
		seqId = Object.keys(doc.sequences)[0]!;
		const file = appdirPaths(appdir).projectFile(projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 0, savedAt: '2026-10-25T00:00:00.000Z', platform: 'test' }),
			),
		);
		engine = await startEngine({
			appdir,
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				JASPER_TEXT_MEASURE: 'on',
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		// a dev engine bundles the compositions on first use: build it before measuring
		await coreServices(engine.app).remotion.serveUrl();
	}, 900_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	const wait = (id: string): Promise<EngineJob> => queue().wait(id);
	const load = (): ProjectDocument =>
		JSON.parse(readFileSync(appdirPaths(appdir).projectFile(projectId), 'utf8')).document as ProjectDocument;

	async function agentTx(commands: unknown[]) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/agent/tx',
			headers: { ...JSON_H, ...hostH() },
			payload: { projectId, transaction: { label: 'Subtitles', origin: { agent: 'test-agent' }, commands } },
		});
		expect(r.statusCode, r.body).toBe(200);
		return r.json() as { result: TransactionResult; appliedBy: string };
	}

	it('headless text gets a measured box; its bake is cropped tight; hybrid, still and Remotion frames agree', async () => {
		const tx = await agentTx([
			{
				type: 'sequence.updateSettings',
				sequenceId: seqId,
				settings: { backgroundColor: [0.3, 0.32, 0.35, 1] },
			},
			{ type: 'font.add', family: 'Source Sans 3', ref: '$f' },
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: {
					text: 'Subtitle look',
					style: {
						fontId: '$f',
						sizePx: 96,
						weight: 700,
						fill: [1, 1, 1, 1],
						strokes: [
							{ color: [1, 0.85, 0, 1], widthPx: 4, position: 'inside' },
							{ color: [0.68, 0, 1, 1], widthPx: 18, position: 'outside' },
						],
						shadow: { color: [0.13, 0.11, 0.35, 0.8], angleDeg: 90, distancePx: 6, blurPx: 24, spreadPx: 12 },
					},
				},
				transform: { position: [640, 400] },
				ref: '$t',
			},
		]);
		expect(tx.result.ok, JSON.stringify(tx.result)).toBe(true);
		expect(tx.appliedBy).toBe('headless');
		const doc = load();
		const clip = Object.values(doc.sequences[seqId]!.clips).find((c) => c.kind === 'text') as TextClip;
		expect(clip.layoutPending, 'measured in the render browser').toBeUndefined();
		// the estimate would be 13 × 96 × 0.55 = 687 px; a real bold Source Sans 3 line differs
		expect(clip.box.width).not.toBe(Math.ceil(13 * 96 * 0.55));
		expect(clip.box.width).toBeGreaterThan(400);
		expect(clip.box.height).toBe(Math.ceil(96 * 1.2));

		// The bake crop: box + glyph ink + strokes + shadow, without the 10 %-of-height bleed.
		const core = coreServices(engine.app);
		const snap = buildRenderSnapshot(doc, seqId, {
			resolveMedia: () => null,
			resolveFont: (font, weight, italic) => {
				const face = core.fonts.resolve(font.family, weight, italic);
				return face ? core.signer.signUrl(`http://127.0.0.1:${engine.port}`, face.url) : null;
			},
		});
		const vc = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clip.id)!;
		const rect = cropRect(vc, { f0: 0, f1: 30 }, { width: W, height: H, fps: snap.settings.fps })!;
		expect(rect).not.toBeNull();
		console.info(
			`[text-paint-export] box ${clip.box.width}×${clip.box.height}, bake rect ${rect.w}×${rect.h}`,
		);
		// box + 2 × (ink + paint extent) + 2 × 2 px, even-aligned; the same clip with an estimated box keeps the 10 % bleed
		expect(Math.abs(rect.h - (clip.box.height + 2 * (contentBleed(vc) ?? 0) + 4))).toBeLessThanOrEqual(2);
		const pending = { ...vc, source: { ...(vc.source as object), layoutPending: true } } as typeof vc;
		const wide = cropRect(pending, { f0: 0, f1: 30 }, { width: W, height: H, fps: snap.settings.fps });
		expect(wide === null || wide.h >= rect.h + 2 * 0.1 * H - 2 * 2 - 2).toBe(true);

		// Hybrid export (the title baked, composited natively) and the Program still vs the Remotion frame.
		const settings = {
			sequenceId: seqId,
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
		};
		const envelope = makeEnvelope(doc, {
			revision: 1,
			savedAt: '2026-10-25T00:00:00.000Z',
			platform: 'test',
		});
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope, sequenceId: seqId, settings },
			})
		).json();
		expect(plan.path).toBe('hybrid');
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope, sequenceId: seqId, settings },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const out = join(core.config.paths.rendersDir, done.id, 'output.mov');
		const ref = join(tempAppdir('jasper-tp-ref-'), 'ref.png');
		await core.remotion.renderStill({
			inputProps: {
				doc: snap,
				options: { isPreview: false, useProxies: false, transparentBackground: false },
			},
			output: ref,
			frame: 10,
			signal: new AbortController().signal,
		});
		const share = within(decode(out, 10), decode(ref), 3);
		const s = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope, sequenceId: seqId, frame: 10 },
		});
		const stillJob = await wait(s.json().id);
		expect(stillJob.state, JSON.stringify(stillJob.error)).toBe('succeeded');
		const stillShare = within(
			decode(join(core.config.paths.rendersDir, stillJob.id, 'output.png')),
			decode(ref),
			3,
		);
		console.info(
			`[text-paint-export] share within 3/255 of the Remotion frame: hybrid ${share.toFixed(4)}, still ${stillShare.toFixed(4)}`,
		);
		expect(share).toBeGreaterThanOrEqual(0.99); // as layer-bake.e2e: ProRes 4444 + native composite rounding
		expect(stillShare).toBeGreaterThan(0.995);
	});
});
