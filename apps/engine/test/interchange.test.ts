import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
	AssetRelinkResponse,
	EngineJob,
	InterchangeExportResult,
	InterchangeImportResponse,
	RelinkScanResult,
} from '@jasper/api';
import { parseAiff, parseWav } from '@jasper/interchange';
import { checkInvariants, defaultRegistries, type MediaAsset } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

let app: TestApp;
let doc: DocBuilder;

beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	doc = new DocBuilder('hd-1080p-30');
	const a = doc.addMedia(await register(app, fixture('clip-a.mp4')));
	const b = doc.addMedia(await register(app, fixture('clip-b.mp4')));
	const tone = doc.addMedia(await register(app, fixture('tone.wav')));
	doc.tx([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 30 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 30,
			sourceRange: { in: { sourceFrames: 5 }, out: { sourceFrames: 35 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: tone },
			at: 10,
			tracks: { audio: 'A2' },
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 40 } },
		},
		{ type: 'marker.add', frame: 12, name: 'Check', color: 'rose' },
	]);
}, 120_000);

afterAll(closeApps);

async function exportJob(format: string, options: Record<string, unknown> = {}, destination?: string) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/interchange/export',
		headers: JSON_H,
		payload: {
			envelope: doc.envelope(),
			sequenceId: doc.seqId,
			format,
			options,
			...(destination ? { destination: { type: 'path', path: destination } } : {}),
		},
	});
	expect(r.statusCode, r.body).toBe(202);
	const job = r.json() as EngineJob;
	const end = await until(async () => {
		const j = (
			await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: JSON_H })
		).json() as EngineJob;
		return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
	}, 60_000);
	expect(end.state, JSON.stringify(end.error)).toBe('succeeded');
	return { job: end, result: end.result as InterchangeExportResult };
}

async function download(url: string): Promise<Buffer> {
	const r = await app.inject({ method: 'GET', url, headers: JSON_H });
	expect(r.statusCode).toBe(200);
	return r.rawPayload;
}

async function importBody(body: Record<string, unknown>): Promise<InterchangeImportResponse> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/interchange/import',
		headers: JSON_H,
		payload: { projectId: 'prj_0000000000000001', ...body },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as InterchangeImportResponse;
}

function applyImport(imp: InterchangeImportResponse) {
	const target = new DocBuilder('hd-1080p-30', 77);
	const r = target.tx([{ type: 'project.importTimeline', fragment: imp.fragment }]);
	expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	return { target, seqId: (r.results[0] as { topSequenceIds: string[] }).topSequenceIds[0]! };
}

describe('interchange through the engine', () => {
	it('exports FCP7 XML as a job and imports it back by path with the media registered', async () => {
		const dest = join(tempAppdir('jasper-ix-'), 'out', 'Edit.xml');
		const { result } = await exportJob('fcp7', {}, dest);
		const docFile = result.files.find((f) => f.role === 'document')!;
		expect(docFile.name).toBe('Edit.xml');
		expect(existsSync(dest)).toBe(true);
		const xml = (await download(docFile.downloadUrl)).toString('utf8');
		expect(xml).toContain('<xmeml');
		expect(xml).toContain('clip-a.mp4');
		const imp = await importBody({ path: dest });
		expect(imp.format).toBe('fcp7');
		expect(imp.missing).toEqual([]);
		const media = (imp.fragment as { media: MediaAsset[] }).media;
		expect(media.every((m) => m.locators.some((l) => l.type === 'engine-store'))).toBe(true);
		const { target, seqId } = applyImport(imp);
		const s = target.doc.sequences[seqId]!;
		expect(
			Object.values(s.clips)
				.map((c) => [c.start, c.duration])
				.sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!),
		).toEqual(
			Object.values(doc.doc.sequences[doc.seqId]!.clips)
				.map((c) => [c.start, c.duration])
				.sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]!),
		);
		expect(s.markers.map((m) => [m.frame, m.name])).toEqual([[12, 'Check']]);
	});

	it('never overwrites an existing file at the destination (security review DATA-3)', async () => {
		const dir = join(tempAppdir('jasper-ix-'), 'out');
		mkdirSync(dir, { recursive: true });
		const dest = join(dir, 'Cut.xml');
		writeFileSync(dest, 'my own timeline');
		mkdirSync(join(dir, 'Cut (2) Media'));
		const { result } = await exportJob('fcp7', {}, dest);
		expect(readFileSync(dest, 'utf8')).toBe('my own timeline');
		const docFile = result.files.find((f) => f.role === 'document')!;
		// "Cut (2)" has a side folder already: the next free name is "Cut (3)".
		expect(docFile.path).toBe(join(dir, 'Cut (3).xml'));
		expect(readFileSync(docFile.path!, 'utf8')).toContain('<xmeml');
		const again = await exportJob('fcp7', {}, dest);
		expect(again.result.files.find((f) => f.role === 'document')!.path).toBe(join(dir, 'Cut (4).xml'));
	});

	it('AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files', async () => {
		const { result } = await exportJob('aaf', { audio: { mode: 'embed', handlesFrames: 5, bitDepth: 16 } });
		const bytes = await download(result.files.find((f) => f.role === 'document')!.downloadUrl);
		expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
		const imp = await importBody({ file: { name: 'Edit.aaf', contentBase64: bytes.toString('base64') } });
		expect(imp.format).toBe('aaf');
		expect(imp.extracted.length).toBeGreaterThanOrEqual(2);
		for (const e of imp.extracted) {
			const w = parseWav(new Uint8Array(readFileSync(e.path)))!;
			expect([w.sampleRate, w.bits]).toEqual([48000, 16]);
			expect(w.pcm.some((v) => v !== 0)).toBe(true);
		}
		const { target } = applyImport(imp);
		expect(Object.values(target.doc.media).some((m) => m.originalName.endsWith('.wav'))).toBe(true);
	});

	it('OMF with separate AIFF files broken out to mono, written next to the document', async () => {
		const dest = join(tempAppdir('jasper-ix-'), 'Mix.omf');
		const { result } = await exportJob(
			'omf',
			{ audio: { mode: 'separate', fileFormat: 'aiff', breakoutToMono: true, bitDepth: 24 } },
			dest,
		);
		const audio = result.files.filter((f) => f.role === 'audio');
		expect(audio.length).toBeGreaterThanOrEqual(4);
		for (const f of audio) {
			expect(existsSync(f.path!)).toBe(true);
			const a = parseAiff(new Uint8Array(readFileSync(f.path!)))!;
			expect([a.channels, a.bits]).toEqual([1, 24]);
		}
		expect(result.warnings.some((w) => /audio only/.test(w.message))).toBe(true);
		const imp = await importBody({ path: dest });
		expect(imp.missing).toEqual([]);
		applyImport(imp);
	});

	it('per-track EDLs and the pre-render plan', async () => {
		const { result } = await exportJob('edl', { edl: { perTrack: true } });
		expect(result.files.filter((f) => f.role === 'document').map((f) => f.name)).toEqual([
			'Sequence 01_V1.edl',
		]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/interchange/prerender-plan',
			headers: JSON_H,
			payload: { envelope: doc.envelope(), sequenceId: doc.seqId, format: 'edl' },
		});
		expect(r.statusCode).toBe(200);
		expect(r.json()).toEqual({ mode: 'unsupported', clips: [] });
	});

	it('imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)', async () => {
		const { result } = await exportJob('fcp7');
		const text = (await download(result.files[0]!.downloadUrl)).toString('utf8');
		// the media moved: the document's paths point at a folder that does not exist
		const moved = tempAppdir('jasper-moved-');
		mkdirSync(join(moved, 'deep', 'er'), { recursive: true });
		for (const n of ['clip-a.mp4', 'clip-b.mp4', 'tone.wav'])
			copyFileSync(fixture(n), join(moved, 'deep', 'er', n));
		const gone = text.replaceAll(fixture(''), '/nowhere/media/');
		expect(gone).not.toBe(text);
		const imp = await importBody({
			file: { name: 'Edit.xml', contentBase64: Buffer.from(gone).toString('base64') },
		});
		expect(imp.missing.map((m) => m.name).sort()).toEqual(['clip-a.mp4', 'clip-b.mp4', 'tone.wav']);
		const { target } = applyImport(imp);
		const offline = Object.values(target.doc.media).filter((m) =>
			m.fingerprint.startsWith('pending:interchange:'),
		);
		expect(offline.length).toBe(3);
		const one = offline.find((m) => m.originalName === 'clip-a.mp4')!;
		const r = await app.inject({
			method: 'POST',
			url: `/api/assets/${one.id}/relink`,
			headers: JSON_H,
			payload: {
				projectId: 'prj_0000000000000001',
				path: join(moved, 'deep', 'er', 'clip-a.mp4'),
				asset: one,
			},
		});
		expect(r.statusCode, r.body).toBe(200);
		const rl = r.json() as AssetRelinkResponse;
		expect(rl.match).toBe('placeholder');
		expect(rl.needsConfirm).toBe(false);
		const wrong = await app.inject({
			method: 'POST',
			url: `/api/assets/${one.id}/relink`,
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', path: join(moved, 'deep', 'er', 'tone.wav'), asset: one },
		});
		const w = wrong.json() as AssetRelinkResponse;
		expect(w.needsConfirm).toBe(true);
		expect(w.diff.map((d) => d.field)).toContain('kind');
		const scan = await app.inject({
			method: 'POST',
			url: '/api/projects/prj_0000000000000001/relink-scan',
			headers: JSON_H,
			payload: { folder: moved, assets: offline, match: ['name', 'duration'] },
		});
		expect(scan.statusCode, scan.body).toBe(202);
		const job = scan.json() as EngineJob;
		const end = await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: JSON_H })
			).json() as EngineJob;
			return j.state === 'succeeded' || j.state === 'failed' ? j : null;
		}, 30_000);
		expect(end.state).toBe('succeeded');
		expect(end.result).toMatchObject({ found: 3, notFound: 0, ambiguous: 0 });
		const full = await app.inject({
			method: 'GET',
			url: `/api/projects/prj_0000000000000001/relink-scan/${job.id}`,
			headers: JSON_H,
		});
		expect(full.statusCode, full.body).toBe(200);
		const res = full.json() as RelinkScanResult;
		expect(res.notFound).toEqual([]);
		expect(res.found.map((f) => f.path.split('/').pop()).sort()).toEqual([
			'clip-a.mp4',
			'clip-b.mp4',
			'tone.wav',
		]);
		target.tx(
			res.found.map((f) => {
				const reg = f.media as {
					mediaKey: string;
					fingerprint: string;
					probe: unknown;
					sizeBytes: number;
					originalName: string;
					container: string;
					locators: { type: string; path?: string }[];
				};
				const store = { type: 'engine-store', engineId: 'local', key: reg.mediaKey };
				return {
					type: 'media.relink',
					mediaId: f.assetId,
					locator: store,
					locators: [store, ...reg.locators.filter((l) => l.type === 'path')],
					probe: reg.probe,
					fingerprint: reg.fingerprint,
					sizeBytes: reg.sizeBytes,
					originalName: reg.originalName,
					container: reg.container,
				};
			}),
		);
		expect(Object.values(target.doc.media).every((m) => !m.fingerprint.startsWith('pending:'))).toBe(true);
		expect(checkInvariants(target.doc, { effects: defaultRegistries().effects })).toEqual([]);
	});

	it('refuses garbage with a named error', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/interchange/import',
			headers: JSON_H,
			payload: {
				projectId: 'p',
				file: { name: 'x.bin', contentBase64: Buffer.from('hello').toString('base64') },
			},
		});
		expect(r.statusCode).toBe(415);
		expect(r.json().code).toBe('INTERCHANGE_UNSUPPORTED');
		const edl = await app.inject({
			method: 'POST',
			url: '/api/interchange/import',
			headers: JSON_H,
			payload: {
				projectId: 'p',
				file: { name: 'x.edl', contentBase64: Buffer.from('hello').toString('base64') },
			},
		});
		expect(edl.statusCode).toBe(422);
		expect(edl.json().code).toBe('INTERCHANGE_PARSE');
	});
});

/** Registered metadata supplies the schema-valid input; each route receives its own offline placeholder. */
function relinkPlaceholder(
	id: string,
	path: string,
	opts: { seconds?: number; kind?: MediaAsset['kind'] } = {},
): MediaAsset {
	const asset = Object.values(doc.doc.media).find((m) => m.kind === (opts.kind ?? 'video'))!;
	return {
		...asset,
		id,
		fingerprint: `pending:interchange:${id}`,
		originalName: path.split(/[/\\]/).pop()!,
		sizeBytes: 0,
		probe: { ...asset.probe, durationFlicks: (opts.seconds ?? 2) * 705_600_000 },
		locators: [{ type: 'path', path, relativeToProject: null }],
	};
}

describe('Link Media routes', () => {
	const post = (url: string, payload: object) =>
		app.inject({ method: 'POST', url, headers: JSON_H, payload });

	it('relinking to a path of another computer is refused with a named error', async () => {
		const a = relinkPlaceholder('med_a', 'D:\\Media\\clip-a.mp4');
		const r = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: 'D:\\Media\\clip-a.mp4',
			asset: a,
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
		const rel = await post('/api/assets/med_a/relink', { projectId: 'prj_1', path: 'clip-a.mp4', asset: a });
		expect(rel.statusCode).toBe(400);
		expect(rel.json().code).toBe('VALIDATION_FAILED');
		const bad = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: fixture('clip-a.mp4'),
			asset: { id: 'med_a' },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('VALIDATION_FAILED');
	});

	it('a located file is verified against the selected match properties', async () => {
		const a = relinkPlaceholder('med_a', 'D:\\Media\\clip-a.mov', { seconds: 600 });
		const r = await post('/api/assets/med_a/relink', {
			projectId: 'prj_1',
			path: fixture('clip-a.mp4'),
			asset: a,
			match: ['name', 'extension', 'duration'],
		});
		expect(r.statusCode, r.body).toBe(200);
		expect(r.json().failed).toEqual(['extension', 'duration']);
		expect(r.json().needsConfirm).toBe(true);
	});

	it('relink-scan validates its body, folders and anchors; the result route checks the job', async () => {
		const a = relinkPlaceholder('med_a', 'D:\\Media\\clip-a.mp4');
		for (const payload of [{ assets: [] }, { assets: [a], match: ['bogus'] }]) {
			const invalid = await post('/api/projects/prj_1/relink-scan', payload);
			expect(invalid.statusCode).toBe(400);
			expect(invalid.json().code).toBe('VALIDATION_FAILED');
		}
		const far = await post('/api/projects/prj_1/relink-scan', {
			assets: [a],
			anchors: [{ from: 'D:\\a.mov', to: 'E:\\a.mov' }],
		});
		expect(far.statusCode).toBe(400);
		expect(far.json().code).toBe('VALIDATION_FAILED');
		const nofolder = await post('/api/projects/prj_1/relink-scan', {
			assets: [a],
			folder: join(tempAppdir(), 'nope'),
		});
		expect(nofolder.statusCode).toBe(404);
		expect(nofolder.json().code).toBe('NOT_FOUND');
		const missing = await app.inject({
			method: 'GET',
			url: '/api/projects/prj_1/relink-scan/job_nope',
			headers: JSON_H,
		});
		expect(missing.statusCode).toBe(404);
		expect(missing.json().code).toBe('JOB_NOT_FOUND');
	});

	it('locate one Windows-path placeholder, the job relinks the others; the result is per project', async () => {
		const mac = tempAppdir('jasper-mac-route-');
		mkdirSync(join(mac, 'Media', 'B roll'), { recursive: true });
		copyFileSync(fixture('clip-a.mp4'), join(mac, 'Media', 'clip-a.mp4'));
		copyFileSync(fixture('clip-b.mp4'), join(mac, 'Media', 'B roll', 'clip-b.mp4'));
		copyFileSync(fixture('tone.wav'), join(mac, 'Media', 'tone.wav'));
		const assets = [
			relinkPlaceholder('med_b', 'D:\\Media\\B roll\\clip-b.mp4', { seconds: 0.5 }),
			relinkPlaceholder('med_t', 'D:\\Media\\tone.wav', { kind: 'audio', seconds: 0.5 }),
		];
		const r = await post('/api/projects/prj_2/relink-scan', {
			anchors: [{ from: 'D:\\Media\\clip-a.mp4', to: join(mac, 'Media', 'clip-a.mp4') }],
			assets,
			match: ['name', 'extension', 'duration', 'streams'],
		});
		expect(r.statusCode, r.body).toBe(202);
		const job = r.json() as EngineJob;
		const end = await until(async () => {
			const j = (
				await app.inject({ method: 'GET', url: `/api/jobs/${job.id}`, headers: JSON_H })
			).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled'].includes(j.state) ? j : null;
		}, 60_000);
		expect(end.state, JSON.stringify(end.error)).toBe('succeeded');
		expect(end.result).toEqual({
			found: 2,
			needsConfirm: 0,
			ambiguous: 0,
			notFound: 0,
			scannedFiles: 0,
			truncated: false,
			timedOut: false,
		});
		const other = await app.inject({
			method: 'GET',
			url: `/api/projects/prj_1/relink-scan/${job.id}`,
			headers: JSON_H,
		});
		expect(other.statusCode).toBe(404);
		expect(other.json().code).toBe('JOB_NOT_FOUND');
		const full = (
			await app.inject({ method: 'GET', url: `/api/projects/prj_2/relink-scan/${job.id}`, headers: JSON_H })
		).json() as RelinkScanResult;
		expect(full.found.map((f) => [f.assetId, f.step, basename(f.path)])).toEqual([
			['med_b', 'mapping', 'clip-b.mp4'],
			['med_t', 'mapping', 'tone.wav'],
		]);
		const linked = await app.inject({
			method: 'GET',
			url: `/api/media/${full.found[0]!.media.mediaKey}`,
			headers: JSON_H,
		});
		expect(linked.statusCode, linked.body).toBe(200);
		expect(linked.json().status).toBe('online');
	});
});
