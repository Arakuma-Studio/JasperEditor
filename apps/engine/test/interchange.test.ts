// wp interchange end to end through the engine: export jobs (FCP7, AAF with embedded and separate audio, OMF with
// AIFF files, per-track EDLs), import by path and by bytes (media registered, embedded audio written, missing media
// as offline placeholders), Link Media (relink and folder search).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
		// one by one
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
		// a different file needs confirmation and names what differs
		const wrong = await app.inject({
			method: 'POST',
			url: `/api/assets/${one.id}/relink`,
			headers: JSON_H,
			payload: { projectId: 'prj_0000000000000001', path: join(moved, 'deep', 'er', 'tone.wav'), asset: one },
		});
		const w = wrong.json() as AssetRelinkResponse;
		expect(w.needsConfirm).toBe(true);
		expect(w.diff.map((d) => d.field)).toContain('kind');
		// by folder: name + duration
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
		const res = end.result as RelinkScanResult;
		expect(res.notFound).toEqual([]);
		expect(res.found.map((f) => f.path.split('/').pop()).sort()).toEqual([
			'clip-a.mp4',
			'clip-b.mp4',
			'tone.wav',
		]);
		// apply as the Link Media dialog does
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
		expect(edl.json().code).toMatch(/^INTERCHANGE_/);
	});
});
