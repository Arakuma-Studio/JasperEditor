import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot, LUMETRI_EFFECT_ID, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { JobError } from '../src/jobs/types.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, JSON_H, register, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1280;
const H = 720;

const FIXTURE_V4 = join(
	__dirname,
	'..',
	'..',
	'..',
	'packages',
	'project',
	'test',
	'fixtures',
	'v4',
	'basic.jasper',
);
const v4 = JSON.parse(readFileSync(FIXTURE_V4, 'utf8')).document as ProjectDocument;
const v4seq = Object.values(v4.sequences)[0]!;

function inject(
	d: DocBuilder,
	clip: Record<string, unknown>,
	o: { id: string; track: string; start: number },
) {
	const seq = d.doc.sequences[d.seqId]!;
	const c = { ...structuredClone(clip), id: o.id, trackId: d.track(o.track), start: o.start };
	d.doc = {
		...d.doc,
		sequences: { ...d.doc.sequences, [d.seqId]: { ...seq, clips: { ...seq.clips, [o.id]: c as never } } },
	};
	d.revision++;
}

/** Measurements: console and `<tmp>/layer-bake-e2e.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'layer-bake-e2e.txt'), `${new Date().toISOString()} ${line}\n`);
}

function decode(file: string, o: { frame?: number; pix: 'rgba' | 'rgb24'; decoder?: string }): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			...(o.decoder ? ['-c:v', o.decoder] : []),
			'-i',
			file,
			...(o.frame !== undefined
				? ['-vf', `select=eq(n\\,${o.frame})`, '-frames:v', '1']
				: ['-frames:v', '1']),
			'-pix_fmt',
			o.pix,
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	expect(a.length).toBe(b.length);
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

function over(fg: Uint8Array, bg: [number, number, number]): Uint8Array {
	const out = new Uint8Array((fg.length / 4) * 3);
	for (let i = 0, j = 0; i < fg.length; i += 4, j += 3) {
		const a = fg[i + 3]! / 255;
		for (let c = 0; c < 3; c++) out[j + c] = Math.round(fg[i + c]! * a + bg[c]! * (1 - a));
	}
	return out;
}

describe.runIf(enabled)('layer bake end to end (REMOTION_E2E=1, S11 §11 test 4)', () => {
	let engine: RunningEngine;
	let svc: LayerBakeService;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-lb-e2e-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		svc = engine.app.jasper.services.layerBake as LayerBakeService;
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const queue = () => coreServices(engine.app).queue;
	const children = (id: string) =>
		queue()
			.list({})
			.filter((j) => j.parentId === id);
	const wait = async (id: string): Promise<EngineJob> => {
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
			1_200_000,
			250,
		);
		return queue().get(id)!;
	};

	const proresSettings = (seqId: string, engineName: 'auto' | 'native' | 'remotion') => ({
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

	async function exportDoc(d: DocBuilder, engineName: 'auto' | 'native' | 'remotion') {
		const settings = proresSettings(d.seqId, engineName);
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			})
		).json();
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await wait(r.json().id);
		const out = join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.mov');
		return { plan, done, out, bakes: children(done.id).filter((j) => j.kind === 'layer-bake') };
	}

	async function still(d: DocBuilder, frame: number) {
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/stills',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
		});
		const done = await wait(r.json().id);
		return {
			done,
			file: join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.png'),
			bakes: children(done.id).filter((j) => j.kind === 'layer-bake'),
		};
	}

	async function mainDoc(): Promise<{ d: DocBuilder; ids: Record<string, string> }> {
		const footage = await register(engine.app, fixture('clip-a.mp4'), hostH());
		const d = new DocBuilder('hd-720p-30');
		const a = d.addMedia(footage);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			},
			{ type: 'track.add', kind: 'video', count: 3 },
		]);
		const ids: Record<string, string> = {};
		ids.static = d.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: { text: 'Static title', style: { sizePx: 64, fill: [1, 0.9, 0.2, 1] } },
				box: { width: 520, height: 90, autoSize: 'none' },
				transform: { position: [640, 120] },
				ref: '$s',
			},
		]).refs.$s!;
		ids.moving = d.tx([
			{
				type: 'clip.addText',
				at: 10,
				duration: 40,
				track: 'V3',
				content: {
					text: 'Moving title',
					style: { sizePx: 56, shadow: { color: [0, 0, 0, 0.8], angleDeg: 45, distancePx: 6, blurPx: 8 } },
				},
				box: { width: 460, height: 80, autoSize: 'none' },
				ref: '$m',
			},
		]).refs.$m!;
		d.tx([
			{
				type: 'param.setAnimated',
				target: ['clip', ids.moving, 'transform', 'position'],
				animated: true,
				at: { sequenceFrame: 10 },
			},
			{
				type: 'param.setAnimated',
				target: ['clip', ids.moving, 'opacity'],
				animated: true,
				at: { sequenceFrame: 10 },
			},
		]);
		d.tx([
			{
				type: 'param.set',
				target: ['clip', ids.moving, 'transform', 'position'],
				value: [400, 600],
				at: { sequenceFrame: 49 },
			},
			{ type: 'param.set', target: ['clip', ids.moving, 'opacity'], value: 30, at: { sequenceFrame: 49 } },
		]);
		const shape = structuredClone(v4seq.clips.clp_3ZN7BJXAHGY9J4G2) as unknown as Record<string, unknown>;
		(shape.transform as { position: { value: number[] }; scale: { value: number } }).position.value = [
			1050, 560,
		];
		(shape.transform as { scale: { value: number } }).scale.value = 40;
		inject(d, { ...shape, duration: 60 }, { id: 'clp_SHAPE0000000E2E1', track: 'V4', start: 0 });
		ids.shape = 'clp_SHAPE0000000E2E1';
		const anime = structuredClone(v4seq.clips.clp_VEYXW57CH91ZEK52) as unknown as Record<string, unknown>;
		(anime.transform as { scale: { value: number } }).scale.value = 30;
		(anime.transform as { position: { value: number[] } }).position.value = [250, 560];
		inject(
			d,
			{ ...anime, duration: 45, canvas: { width: 1280, height: 720 } },
			{ id: 'clp_ANIME0000000E2E1', track: 'V5', start: 5 },
		);
		ids.anime = 'clp_ANIME0000000E2E1';
		return { d, ids };
	}

	it('hybrid layer bakes match Remotion, preserve straight alpha and reuse masters for stills', async () => {
		const main = await mainDoc();
		const { d } = main;
		const first = await exportDoc(d, 'auto');
		expect(first.done.state, JSON.stringify(first.done.error)).toBe('succeeded');
		expect(first.plan.path).toBe('hybrid');
		expect(first.done.result).toMatchObject({ renderPath: 'hybrid', frames: 60 });
		// spec 13 AS-070/071: the static title, the shape and the moving title (static content, keyframed Motion: a
		// layer still) render as one sheet; the anime template is a master.
		expect(first.bakes).toHaveLength(2);
		const sheets = first.bakes.filter((job) => /– \d+ stills$/.test(job.title));
		expect(sheets).toHaveLength(1);
		expect(sheets[0]!.result).toMatchObject({ stills: 3, rerendered: 0 });
		const usageLog = join(coreServices(engine.app).config.paths.logsDir, 'remotion-usage.jsonl');
		const usage = readFileSync(usageLog, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.purpose === 'layer-bake');
		expect(usage.length).toBeGreaterThanOrEqual(first.bakes.length);
		expect(usage.some((entry) => entry.kind === 'media')).toBe(true);
		expect(usage.some((entry) => entry.kind === 'still')).toBe(true);

		// Chrome and ffmpeg footage decoders differ by up to 30 code values independently of the bake;
		// compare with footage disabled over grey while keeping all baked content unchanged.
		const footage = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'video')!;
		d.tx([
			{ type: 'clip.update', clipIds: [footage], patch: { enabled: false } },
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.3, 0.32, 0.35, 1] },
			},
		]);
		const native = await exportDoc(d, 'auto');
		expect(native.done.state, JSON.stringify(native.done.error)).toBe('succeeded');
		expect(native.bakes).toHaveLength(0);
		// The reference: the full sequence rendered by Remotion, frame by frame (PNG stills of the same composition the
		// Remotion export path renders; its ProRes 4:2:2 intermediate would add chroma artefacts of its own).
		const core = coreServices(engine.app);
		const referenceDoc = buildRenderSnapshot(d.doc, d.seqId, {
			resolveMedia: () => null,
			resolveFont: (font, weight, italic) => {
				const face = core.fonts.resolve(font.family, weight, italic);
				return face ? core.signer.signUrl(`http://127.0.0.1:${engine.port}`, face.url) : null;
			},
		});
		const shares: number[] = [];
		for (const f of [0, 12, 30, 45, 59]) {
			const ref = join(tempAppdir('jasper-lb-ref-'), 'ref.png');
			await coreServices(engine.app).remotion.renderStill({
				inputProps: {
					doc: referenceDoc,
					options: { isPreview: false, useProxies: false, transparentBackground: false },
				},
				output: ref,
				frame: f,
				signal: new AbortController().signal,
			});
			shares.push(within(decode(native.out, { frame: f, pix: 'rgb24' }), decode(ref, { pix: 'rgb24' }), 3));
		}
		report(
			`[LBK parity] native(hybrid) vs Remotion stills, share within 3/255 per frame: ${shares.map((s) => s.toFixed(4)).join(' ')}`,
		);
		for (const s of shares) expect(s).toBeGreaterThanOrEqual(0.99);
		d.tx([
			{ type: 'clip.update', clipIds: [footage], patch: { enabled: true } },
			{ type: 'sequence.updateSettings', sequenceId: d.seqId, settings: { backgroundColor: [0, 0, 0, 1] } },
		]);

		// The same cached master must preserve straight alpha over every background channel.
		{
			const { d, ids } = main;
			const planned = await coreServices(engine.app).exports.plan({
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: proresSettings(d.seqId, 'auto') as never,
			});
			const clip = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === ids.moving)!;
			const plan = await svc.planBake(planned, clip, { env: await svc.environment() });
			const bake = (await svc.lookup(plan.key))!;
			expect(bake.still).toBe(false);
			const doc = bake.rect ? plan.doc : (plan.fullDoc ?? plan.doc);
			expect([doc.settings.width, doc.settings.height]).toEqual([bake.width, bake.height]);
			const k = 20;
			const out = join(tempAppdir('jasper-lb-still-'), 'still.png');
			await coreServices(engine.app).remotion.renderStill({
				inputProps: {
					doc: { ...doc, range: { start: k, end: k + 1 }, durationFrames: 1 },
					options: {
						isPreview: false,
						useProxies: false,
						transparentBackground: true,
						layerFilter: [ids.moving],
					},
				},
				output: out,
				frame: 0,
				signal: new AbortController().signal,
			});
			const png = decode(out, { pix: 'rgba' });
			const mframe = decode(bake.path, { frame: k, pix: 'rgba' });
			let semi = 0;
			let worst = 0;
			for (const bg of [
				[255, 0, 0],
				[0, 255, 0],
				[0, 0, 255],
				[255, 255, 255],
			] as [number, number, number][]) {
				const a = over(mframe, bg);
				const b = over(png, bg);
				for (let i = 0, j = 0; i < png.length; i += 4, j += 3) {
					const alpha = png[i + 3]!;
					if (alpha === 0 || alpha === 255) continue;
					semi++;
					for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[j + c]! - b[j + c]!));
				}
			}
			report(`[LBK alpha] semi-transparent samples ${semi}, worst difference ${worst}/255`);
			expect(semi).toBeGreaterThan(1000); // anti-aliased glyph edges and the shadow
			expect(worst).toBeLessThanOrEqual(2);
		}

		// Stills reuse these masters (LBK-025). A fresh layer has an independent fixture below.
		{
			const { d } = main;
			const s = await still(d, 30);
			expect(s.done.state, JSON.stringify(s.done.error)).toBe('succeeded');
			expect(s.done.result).toMatchObject({ renderPath: 'hybrid' });
			expect(s.bakes).toHaveLength(0);
			const exp = await exportDoc(d, 'auto');
			expect(
				within(decode(s.file, { pix: 'rgb24' }), decode(exp.out, { frame: 30, pix: 'rgb24' }), 3),
			).toBeGreaterThanOrEqual(0.99);
		}
	}, 1_800_000);

	it('a fresh animated layer bakes the requested still frame (LBK-025)', async () => {
		const d = new DocBuilder('hd-720p-30');
		const t = d.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Fresh' }, ref: '$f' },
		]).refs.$f!;
		d.tx([
			{
				type: 'param.setAnimated',
				target: ['clip', t, 'opacity'],
				animated: true,
				at: { sequenceFrame: 0 },
			},
			{ type: 'clip.move', clipIds: [t], deltaFrames: 60 },
			{ type: 'param.set', target: ['clip', t, 'opacity'], value: 0, at: { sequenceFrame: 89 } },
		]);
		const s = await still(d, 70);
		expect(s.done.state, JSON.stringify(s.done.error)).toBe('succeeded');
		expect(s.done.result).toMatchObject({ renderPath: 'hybrid' });
		expect(s.bakes).toHaveLength(1);
		expect(s.bakes[0]!.result).toMatchObject({ still: true, frames: 1 });
		// The only layer is white over black, fading from 100 % at local frame 0 to 0 % at 29.
		// Requested sequence frame 70 is local 10: 255 × (1 − 10/29) ≈ 167. A blank or frame-zero bake fails.
		const peak = decode(s.file, { pix: 'rgb24' }).reduce((max, value) => Math.max(max, value), 0);
		expect(Math.abs(peak - 167)).toBeLessThanOrEqual(3);
	}, 600_000);

	it('a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)', async () => {
		const d = new DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'sequence.updateSettings', sequenceId: d.seqId, settings: { backgroundColor: [0, 0, 0, 1] } },
		]);
		const t = d.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 20,
				track: 'V1',
				content: { text: 'RED', style: { sizePx: 300, weight: 900, fill: [1, 0, 0, 1] } },
				box: { width: 900, height: 360, autoSize: 'none' },
				ref: '$t',
			},
		]).refs.$t!;
		d.tx([
			{ type: 'effect.add', target: { clipId: t }, effectId: LUMETRI_EFFECT_ID, params: { saturation: 0 } },
		]);
		// The glyphs: mean colour of the pixels brighter than the black background.
		const textColour = (rgb: Uint8Array) => {
			const sum = [0, 0, 0];
			let n = 0;
			for (let i = 0; i < rgb.length; i += 3) {
				if (rgb[i]! + rgb[i + 1]! + rgb[i + 2]! < 90) continue;
				for (let c = 0; c < 3; c++) sum[c]! += rgb[i + c]!;
				n++;
			}
			return sum.map((v) => Math.round(v / Math.max(1, n)));
		};
		const grey = (c: number[]) => Math.max(...c) - Math.min(...c);
		const nat = await exportDoc(d, 'auto');
		expect(nat.done.state, JSON.stringify(nat.done.error)).toBe('succeeded');
		expect(nat.done.result).toMatchObject({ renderPath: 'hybrid' });
		const natRgb = decode(nat.out, { frame: 10, pix: 'rgb24' });
		const rem = await exportDoc(d, 'remotion');
		expect(rem.done.state, JSON.stringify(rem.done.error)).toBe('succeeded');
		const remRgb = decode(rem.out, { frame: 10, pix: 'rgb24' });
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/layer-bake/preview?wait=1',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, clipId: t },
		});
		expect(r.statusCode, r.body).toBe(200);
		const pres = r.json().result as {
			key: string;
			previewUrl: string;
			rect: { w: number; h: number } | null;
		};
		const prev = svc.filePath(pres.key, 'preview.webm')!;
		const prevRgb = decode(prev, { frame: 10, pix: 'rgb24', decoder: 'libvpx-vp9' });
		const colours = [textColour(natRgb), textColour(remRgb), textColour(prevRgb)];
		report(`[LBK grade] mean glyph colour native/remotion/preview: ${JSON.stringify(colours)}`);
		// Saturation 0 turns the red title grey (luma of red ≈ 54/255); ungraded it would be (255, 0, 0).
		for (const c of colours) {
			expect(grey(c)).toBeLessThanOrEqual(12);
			expect(c[0]).toBeGreaterThan(30);
			expect(c[0]).toBeLessThan(120);
		}
		// The three paths agree (the preview is VP9 at half size: a little looser).
		expect(Math.abs(colours[0]![0]! - colours[1]![0]!)).toBeLessThanOrEqual(3);
		expect(Math.abs(colours[0]![0]! - colours[2]![0]!)).toBeLessThanOrEqual(5);
		expect(within(natRgb, remRgb, 3)).toBeGreaterThanOrEqual(0.99);
		const get = await engine.app.inject({ method: 'GET', url: pres.previewUrl, headers: hostH() });
		expect(get.statusCode).toBe(200);
		expect(get.headers['content-type']).toBe('video/webm');
	}, 1_800_000);

	it('a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)', async () => {
		// Over a grey background, so that the layer's alpha shows (the transparent part of its region must stay grey).
		const d = new DocBuilder('hd-720p-30');
		d.tx([
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.5, 0.5, 0.5, 1] },
			},
		]);
		const t = d.tx([
			{
				type: 'clip.addText',
				at: 10,
				duration: 30,
				track: 'V1',
				content: { text: 'FADE', style: { sizePx: 260, weight: 900, fill: [1, 0, 0, 1] } },
				box: { width: 1000, height: 320, autoSize: 'none' },
				ref: '$t',
			},
		]).refs.$t!;
		d.tx([
			{ type: 'effect.add', target: { clipId: t }, effectId: LUMETRI_EFFECT_ID, params: { saturation: 0 } },
			{ type: 'transition.add', clipId: t, edge: 'in', effectId: 'jasper.cross-dissolve', duration: 10 },
		]);
		// A one-sided 10-frame fade starts at the clip head (frame 10), ending at frame 20.
		const spanStart = 10;
		const mid = 15;
		const full = 35;
		const expected = 0.5;
		const bg = (rgb: Uint8Array) => rgb[0]!;
		// The glyphs: pixels of the path's own full-opacity frame clearly darker than the background (grey glyphs ≈ 54).
		const measure = (fullRgb: Uint8Array, midRgb: Uint8Array) => {
			const b = bg(fullRgb);
			let fullSum = 0;
			let midSum = 0;
			let n = 0;
			let bgOk = 0;
			let bgN = 0;
			for (let i = 0; i < fullRgb.length; i += 3) {
				if (b - fullRgb[i]! > 40) {
					fullSum += b - fullRgb[i]!;
					midSum += b - midRgb[i]!;
					n++;
				} else if (Math.abs(b - fullRgb[i]!) <= 3) {
					// Not glyph (nor an anti-aliased edge): the background must show through, also mid-fade.
					bgN++;
					if (Math.abs(midRgb[i]! - b) <= 3 && Math.abs(midRgb[i + 2]! - b) <= 3) bgOk++;
				}
			}
			expect(n).toBeGreaterThan(1000);
			return { bg: b, glyph: b - fullSum / n, ratio: midSum / fullSum, background: bgOk / bgN, bgN };
		};
		const nat = await exportDoc(d, 'auto');
		expect(nat.done.state, JSON.stringify(nat.done.error)).toBe('succeeded');
		expect(nat.done.result).toMatchObject({ renderPath: 'hybrid' });
		const rem = await exportDoc(d, 'remotion');
		expect(rem.done.state, JSON.stringify(rem.done.error)).toBe('succeeded');
		expect(rem.done.result).toMatchObject({ renderPath: 'remotion' });
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/layer-bake/preview?wait=1',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, clipId: t },
		});
		expect(r.statusCode, r.body).toBe(200);
		const prev = svc.filePath((r.json().result as { key: string }).key, 'preview.webm')!;
		// The preview is the layer alone (VP9 alpha, half size): composited over the background grey here.
		const grey = decode(nat.out, { frame: 0, pix: 'rgb24' })[0]!;
		const vp9 = (frame: number) =>
			over(decode(prev, { frame: frame - spanStart, pix: 'rgba', decoder: 'libvpx-vp9' }), [
				grey,
				grey,
				grey,
			]);
		const out = (file: string, frame: number) => decode(file, { frame, pix: 'rgb24' });
		const m = {
			native: measure(out(nat.out, full), out(nat.out, mid)),
			remotion: measure(out(rem.out, full), out(rem.out, mid)),
			preview: measure(vp9(full), vp9(mid)),
		};
		report(
			`[LBK fades] graded static title over grey, frame ${mid} of a 10-frame fade-in (expected ×${expected.toFixed(2)}): ${JSON.stringify(m)}`,
		);
		for (const [name, v] of Object.entries(m)) {
			// Graded grey glyphs at full opacity (ungraded red would be far off), faded exactly once mid-ramp (not
			// popping in, not faded twice), and the transparent part of the layer shows the background.
			expect(v.glyph, name).toBeGreaterThan(30);
			expect(v.glyph, name).toBeLessThan(80);
			expect(Math.abs(v.ratio - expected), name).toBeLessThanOrEqual(0.12);
			expect(v.background, name).toBeGreaterThanOrEqual(0.99);
		}
		expect(Math.abs(m.native.glyph - m.remotion.glyph)).toBeLessThanOrEqual(3);
		expect(Math.abs(m.native.ratio - m.remotion.ratio)).toBeLessThanOrEqual(0.03);
		for (const f of [mid, full])
			expect(within(out(nat.out, f), out(rem.out, f), 3), `frame ${f}`).toBeGreaterThanOrEqual(0.99);
	}, 1_800_000);

	it('a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)', async () => {
		const d = new DocBuilder('hd-720p-30');
		d.tx([{ type: 'clip.addText', at: 0, duration: 15, track: 'V1', content: { text: 'Fallback' } }]);
		const orig = svc.ensureBake.bind(svc);
		svc.ensureBake = async () => {
			throw new JobError('LAYER_BAKE_FAILED', 'synthetic bake failure', true);
		};
		try {
			const auto = await exportDoc(d, 'auto');
			expect(auto.done.state, JSON.stringify(auto.done.error)).toBe('succeeded');
			expect(auto.done.result).toMatchObject({
				renderPath: 'remotion',
				warnings: [{ code: 'NATIVE_FALLBACK', message: expect.stringMatching(/synthetic bake failure/) }],
			});
			const forced = await exportDoc(d, 'native');
			expect(forced.done.state).toBe('failed');
			expect(forced.done.error).toMatchObject({ code: 'LAYER_BAKE_FAILED' });
		} finally {
			svc.ensureBake = orig;
		}
	}, 1_200_000);
});
