// wp captions: export of caption tracks — planner routing (burn-in = layer bake, `hybrid`), embedded caption
// streams (mov_text in MP4/MOV, WebVTT in WebM) checked with ffprobe and read back by ffmpeg (oracle), sidecar
// files, and the HTTP route serving them. Burned-in pixels are checked by the opt-in Remotion E2E and Playwright.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RenderPlanSchema } from '@jasper/api';
import { parseCaptionFile, plainCaptionText } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedArgs, iso639_2, sidecarName, subtitleCodecFor } from '../src/export/captions.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, ensureFixtures, H, JSON_H, makeApp, type TestApp } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

const settings = (seqId: string, extra: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 30 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	...extra,
});

/** 4 s of blue with two caption tracks (English active, French hidden). */
function captionedDoc(): DocBuilder {
	const d = new DocBuilder('hd-720p-30');
	d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0, 0, 1, 1] },
		{ type: 'caption.addTrack', name: 'English', language: 'en' },
		{ type: 'caption.add', track: 'C1', at: 15, duration: 30, text: 'Hello <i>there</i>' },
		{ type: 'caption.add', track: 'C1', at: 60, duration: 45, text: 'Second line' },
		{ type: 'caption.addTrack', name: 'Français', language: 'fr', active: false },
		{ type: 'track.update', trackId: 'C2', patch: { visible: false } },
		{ type: 'caption.add', track: 'C2', at: 30, duration: 30, text: 'Bonjour' },
	]);
	return d;
}

function probeStreams(file: string) {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'stream=index,codec_type,codec_name:stream_tags=language,title,handler_name:stream_disposition=default',
		'-of',
		'json',
		file,
	]);
	return JSON.parse(r.stdout.toString()).streams as Array<{
		codec_type: string;
		codec_name: string;
		tags?: { language?: string; title?: string; handler_name?: string };
		disposition?: { default?: number };
	}>;
}

/** Subtitle stream `n` of a file, extracted by ffmpeg as SRT and parsed (oracle: ffmpeg's own demuxer). */
function extractSubs(file: string, n: number) {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:s:${n}`, '-f', 'srt', '-']);
	const parsed = parseCaptionFile(r.stdout.toString(), 'srt');
	if (!parsed.ok) throw new Error(parsed.error);
	// markup survives as SRT tags (<i>…</i>); compare the plain text
	return parsed.doc.cues.map((c) => [
		Math.round(c.start / 705_600),
		Math.round(c.end / 705_600),
		plainCaptionText(c.text),
	]);
}

async function exportOnce(d: DocBuilder, extra: Record<string, unknown>) {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, extra) },
	});
	expect(start.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	return { id: start.json().id as string, result: done.result as Record<string, unknown> };
}

describe('caption export helpers', () => {
	it('maps languages, codecs and file names', () => {
		expect(iso639_2('en')).toBe('eng');
		expect(iso639_2('fr-CA')).toBe('fra');
		expect(iso639_2('deu')).toBe('deu');
		expect(iso639_2('xx')).toBe('und');
		expect(subtitleCodecFor('mp4')).toBe('mov_text');
		expect(subtitleCodecFor('mov')).toBe('mov_text');
		expect(subtitleCodecFor('webm')).toBe('webvtt');
		const args = embedArgs('in.mp4', [{ path: 'a.vtt', language: 'en', title: 'English' }], 'mp4', 'out.mp4');
		expect(args.join(' ')).toContain(
			'-c:s mov_text -metadata:s:s:0 language=eng -metadata:s:s:0 title=English',
		);
		const o = { track: { language: 'fr' }, label: 'C2' } as never;
		expect(sidecarName('output', o, 'srt', true)).toBe('output.srt');
		expect(sidecarName('output', o, 'vtt', false)).toBe('output.C2.fr.vtt');
	});
});

describe('planning', () => {
	it('burned-in captions are layer-baked (hybrid); without burn-in the export stays native', async () => {
		const d = captionedDoc();
		const plan = async (extra: Record<string, unknown>) => {
			const r = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, extra) },
			});
			return { status: r.statusCode, body: r.json() };
		};
		const burned = RenderPlanSchema.parse((await plan({})).body);
		expect(burned.blockers).toEqual([]);
		expect(burned.path).toBe('hybrid');
		const items = burned.segments.flatMap((s) => s.graphicsGroups.flatMap((g) => g.itemIds));
		// only the visible track (C1) is burned in
		expect(items).toHaveLength(2);
		const plain = RenderPlanSchema.parse((await plan({ captions: { burnIn: false, embed: true } })).body);
		expect(plain.path).toBe('native');
		const both = RenderPlanSchema.parse((await plan({ captions: { burnIn: ['C1', 'C2'] } })).body);
		expect(both.segments.flatMap((s) => s.graphicsGroups.flatMap((g) => g.itemIds))).toHaveLength(3);
		const bad = await plan({ captions: { embed: ['C9'] } });
		expect(bad.status).toBe(400);
		const empty = new DocBuilder('hd-720p-30');
		empty.tx([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0, 0, 1, 1] }]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: {
				envelope: empty.envelope(),
				sequenceId: empty.seqId,
				settings: settings(empty.seqId, { captions: { embed: true } }),
			},
		});
		expect(r.json().warnings.map((w: { code: string }) => w.code)).toContain('NO_CAPTIONS');
	});
});

describe('embedded streams and sidecars', () => {
	it('MP4: mov_text streams (active track first, default), frame-exact cues, sidecars served', async () => {
		const d = captionedDoc();
		const { id, result } = await exportOnce(d, {
			captions: { burnIn: false, embed: true, sidecar: ['srt', 'vtt', 'scc'], sidecarTracks: 'all' },
		});
		const file = (await coreServices(app).exports.outputFile(id))!;
		const subs = probeStreams(file).filter((s) => s.codec_type === 'subtitle');
		expect(
			subs.map((s) => [
				s.codec_name,
				s.tags?.language,
				s.tags?.title ?? s.tags?.handler_name,
				s.disposition?.default,
			]),
		).toEqual([
			['mov_text', 'eng', 'English', 1],
			['mov_text', 'fra', 'Français', 0],
		]);
		// 15–45 and 60–105 frames at 30 fps
		expect(extractSubs(file, 0)).toEqual([
			[500, 1500, 'Hello there'],
			[2000, 3500, 'Second line'],
		]);
		expect(extractSubs(file, 1)).toEqual([[1000, 2000, 'Bonjour']]);
		const caps = result.captions as {
			embedded: unknown[];
			sidecars: Array<{ name: string; url: string; format: string }>;
		};
		expect(caps.embedded).toHaveLength(2);
		expect(caps.sidecars.map((s) => s.name).sort()).toEqual(
			[
				'output.C1.en.srt',
				'output.C1.en.vtt',
				'output.C1.en.scc',
				'output.C2.fr.srt',
				'output.C2.fr.vtt',
				'output.C2.fr.scc',
			].sort(),
		);
		const srt = caps.sidecars.find((s) => s.name === 'output.C1.en.srt')!;
		const got = await app.inject({ method: 'GET', url: srt.url, headers: H });
		expect(got.statusCode).toBe(200);
		expect(got.body).toBe(
			'1\n00:00:00,500 --> 00:00:01,500\nHello <i>there</i>\n\n2\n00:00:02,000 --> 00:00:03,500\nSecond line\n\n',
		);
		const scc = caps.sidecars.find((s) => s.name === 'output.C1.en.scc')!;
		const sccBody = (await app.inject({ method: 'GET', url: scc.url, headers: H })).body;
		const back = parseCaptionFile(sccBody, 'scc');
		expect(back.ok && back.doc.cues.map((c) => c.text)).toEqual(['Hello there', 'Second line']);
		expect(
			(await app.inject({ method: 'GET', url: `/renders/${id}/captions/..%2Fx.srt`, headers: H })).statusCode,
		).toBe(404);
	}, 180_000);

	it('an export range shifts the cues to output time', async () => {
		const d = captionedDoc();
		const { id } = await exportOnce(d, {
			range: { type: 'custom', startFrame: 30, endFrame: 90 },
			captions: { burnIn: false, embed: ['C1'] },
		});
		const file = (await coreServices(app).exports.outputFile(id))!;
		expect(extractSubs(file, 0)).toEqual([
			[0, 500, 'Hello there'],
			[1000, 2000, 'Second line'],
		]);
	}, 180_000);

	it('WebM: WebVTT streams', async () => {
		const d = captionedDoc();
		const { id, result } = await exportOnce(d, {
			container: 'webm',
			video: { ...settings(d.seqId).video, codec: 'vp9' },
			audio: { codec: 'opus', sampleRate: 48000, channels: 2 },
			captions: { burnIn: false, embed: ['C1'] },
		});
		const file = (await coreServices(app).exports.outputFile(id))!;
		expect(file.endsWith('.webm')).toBe(true);
		const subs = probeStreams(file).filter((s) => s.codec_type === 'subtitle');
		expect(subs.map((s) => [s.codec_name, s.tags?.language])).toEqual([['webvtt', 'eng']]);
		expect(extractSubs(file, 0)).toEqual([
			[500, 1500, 'Hello there'],
			[2000, 3500, 'Second line'],
		]);
		expect((result.captions as { embedded: Array<{ codec: string }> }).embedded[0]!.codec).toBe('webvtt');
		expect(readFileSync(file).length).toBeGreaterThan(0);
	}, 180_000);
});
