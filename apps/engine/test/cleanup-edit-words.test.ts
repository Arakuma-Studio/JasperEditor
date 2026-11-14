// Chunked words for the repeats-in-the-edit check (docs/wp-notes/transcript-cleanup.md "Repeats at cuts"): every kept
// span decoded on its own in one sequence-mix transcription of a synthetic sequence, mapped back to media time and
// cached per media range; the cleanup job reports a check that cannot run and still completes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CleanupAnalysisFileSchema,
	CleanupAnalysisJobResultSchema,
	type EngineJob,
	type TranscribeSequenceRequest,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import {
	EDIT_SPAN_CONFIRM_PAD_S,
	EDIT_SPAN_PAD_S,
	editSpans,
	FAST_SETTINGS,
	FLICKS_PER_SECOND,
	findEditRepeats,
	flicksPerFrame,
	loadProject,
	type Sequence,
} from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { entryOfPath } from '../src/cache/layout.ts';
import { EditWordsService, type SequenceTranscriber, spanKey } from '../src/cleanup/edit-words.ts';
import type { JobContext } from '../src/jobs/types.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, register, TEST_FFMPEG } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const PROJECT = 'prj_0000000000000001';

let dir = '';
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-edit-words-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(closeApps);

/** What the speaker says in the recording (media seconds): "…de hacer, y" | 7 s later "y si buscas en internet". */
const SAID: Array<[string, number, number]> = [
	['es', 1.1, 1.3],
	['muy', 1.3, 1.6],
	['complejo', 1.6, 2.1],
	['de', 2.1, 2.25],
	['hacer,', 2.25, 2.5],
	['y', 2.6, 2.75],
	['y', 10.05, 10.2],
	['si', 10.2, 10.4],
	['buscas', 10.4, 10.8],
	['en', 10.8, 10.95],
	['internet.', 10.95, 11.5],
];

/** "es muy complejo de hacer, | y si buscas en internet." as two clips; the stored transcript wrote one "y". */
async function cut(name: string) {
	const app = await makeApp();
	const f = join(dir, name);
	writeFileSync(f, encodeWav([new Float32Array(16_000 * 20)], 16_000, 'f32'));
	const b = new DocBuilder();
	const mediaId = b.addMedia(await register(app, f));
	b.tx([
		{
			type: 'clip.place',
			source: { mediaId },
			sourceRange: { in: { seconds: 1 }, out: { seconds: 2.8 } },
			at: 0,
			tracks: { audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	b.tx([
		{
			type: 'clip.place',
			source: { mediaId },
			sourceRange: { in: { seconds: 10 }, out: { seconds: 11.8 } },
			at: 54,
			tracks: { audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	const stored = SAID.filter((_, i) => i !== 5).map(([text, s, e]) => ({
		text,
		start: S(s),
		end: S(e),
		confidence: 0.9,
	}));
	b.tx([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words: stored }]);
	return { app, b, mediaId };
}

/**
 * A fake speech service: checks the synthetic sequence is a loadable project, then "hears" the words said within
 * each clip's media range and writes them at sequence time.
 */
function fakeTranscriber(calls: TranscribeSequenceRequest[]): SequenceTranscriber {
	return async (req) => {
		calls.push(req);
		const doc = loadProject(req.envelope, {}).document;
		const seq = doc.sequences[req.sequenceId]!;
		const F = flicksPerFrame(seq.settings.frameRate);
		const words = Object.values(seq.clips).flatMap((c) =>
			SAID.filter(([, s, e]) => S(s) >= c.sourceIn && S(e) <= c.sourceIn + c.duration * F).map(
				([text, s, e]) => ({
					text,
					start: c.start * F + S(s) - c.sourceIn,
					end: c.start * F + S(e) - c.sourceIn,
					confidence: 0.9,
					speaker: null,
				}),
			),
		);
		return { words, jobId: `job_${calls.length}` };
	};
}

const ctx = {
	signal: new AbortController().signal,
	job: { origin: { type: 'user' } },
} as unknown as JobContext;

describe.skipIf(!HAVE_FFMPEG)('chunked words of the kept spans', () => {
	it('decodes every span on its own in one job, maps the words back and serves them from the cache', async () => {
		const { b } = await cut('words.wav');
		const seq = b.doc.sequences[b.seqId] as Sequence;
		const sp = editSpans(b.doc, seq);
		if (!sp.ok) throw new Error(sp.message);
		const calls: TranscribeSequenceRequest[] = [];
		const svc = new EditWordsService(join(dir, 'cache'), fakeTranscriber(calls));
		const pads = [EDIT_SPAN_PAD_S, EDIT_SPAN_CONFIRM_PAD_S];
		const first = await svc.spanWords(b.doc, seq, sp.spans, { language: 'es' }, ctx, pads);
		expect(first.report).toEqual({ spans: 2, cached: 0, transcribed: 2, jobId: 'job_1' });
		expect(calls.map((c) => [c.chunking, c.language])).toEqual([['vad', 'es']]);
		// the synthetic sequence: each span twice (padded 0.2 s and 0.6 s: two decodes), 2.5 s of silence between them
		const synth = (calls[0]!.envelope.document as { sequences: Record<string, Sequence> }).sequences[
			calls[0]!.sequenceId
		]!;
		const F = flicksPerFrame(synth.settings.frameRate);
		const clips = Object.values(synth.clips).sort((x, y) => x.start - y.start);
		expect(clips.map((c) => c.sourceIn / FLICKS_PER_SECOND)).toEqual([0.8, 0.4, 9.8, 9.4]);
		expect(
			((clips[1]!.start - clips[0]!.start - clips[0]!.duration) * F) / FLICKS_PER_SECOND,
		).toBeGreaterThanOrEqual(2.5);
		// media time per span: the clip's trailing "y" is there, which the stored transcript merged away
		const textOf = (i: number) =>
			first.words[0]!.get(spanKey(sp.spans[i]!))!
				.map((w) => w.text)
				.join(' ');
		expect(textOf(0)).toBe('es muy complejo de hacer, y');
		expect(textOf(1)).toBe('y si buscas en internet.');
		expect(first.words[0]!.get(spanKey(sp.spans[0]!))!.at(-1)).toMatchObject({ start: S(2.6), end: S(2.75) });
		// speech under every word said, silence between (0.1 s before the clip's trailing "y")
		const classes = new Uint8Array(2000);
		for (const [, a, e] of SAID)
			for (let k = Math.round(a * 100); k < Math.round(e * 100); k++) classes[k] = 2;
		const voice = {
			classes,
			level: new Uint8Array(2000),
			frameCount: 2000,
			levels: { floorDb: -60, speechDb: -14, speechThresholdDb: -46, breathFloorDb: -55 },
		};
		const reps = findEditRepeats({
			spans: sp.spans,
			rate: seq.settings.frameRate,
			words: (s) => first.words[0]!.get(spanKey(s)) ?? null,
			confirm: [(s) => first.words[1]!.get(spanKey(s)) ?? null],
			voice: () => voice,
			settings: FAST_SETTINGS,
			language: 'es',
		});
		expect(reps.map((r) => [r.text, r.where, r.suggested])).toEqual([['y', 'cut', 'remove']]);

		// one cache file per span, a media-cache entry (cache GC, Clean Unused and the cache move handle it)
		const files = readdirSync(join(dir, 'cache'), { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => join(d.parentPath, d.name));
		expect(files).toHaveLength(4);
		for (const f of files) expect(entryOfPath(dir, f)?.kind).toBe('media-cache');
		// again: from the cache, no job
		const again = await svc.spanWords(b.doc, seq, sp.spans, { language: 'es' }, ctx, pads);
		expect(again.report).toEqual({ spans: 2, cached: 2, transcribed: 0, jobId: null });
		expect(calls).toHaveLength(1);
		expect(again.words.map((m) => [...m.values()])).toEqual(first.words.map((m) => [...m.values()]));
		// another model is another cache entry
		await svc.spanWords(b.doc, seq, sp.spans, { language: 'es', model: 'whisper-small' }, ctx);
		expect(calls).toHaveLength(2);
	});

	it('the analysis completes and says why when the check cannot transcribe', async () => {
		const { app, b } = await cut('nospeech.wav');
		const r = await app.inject({
			method: 'POST',
			url: '/api/cleanup/analyze?wait=1',
			headers: JSON_H,
			payload: JSON.stringify({
				projectId: PROJECT,
				document: b.envelope(),
				analyzeVoice: false,
				editRepeats: 'both',
				editModel: 'no-such-model',
			}),
		});
		expect(r.statusCode).toBe(200);
		const job = r.json() as EngineJob;
		expect(job.state).toBe('succeeded');
		const res = CleanupAnalysisJobResultSchema.parse(job.result);
		expect(res.editRepeats).toMatchObject({ spans: 2, found: 0, jobIds: [] });
		expect(res.editRepeats!.missing.map((m) => m.source)).toEqual(['spans', 'mix']);
		const file = CleanupAnalysisFileSchema.parse(
			(await app.inject({ method: 'GET', url: res.url, headers: H })).json(),
		);
		expect(file.analysis.editRepeats).toEqual([]);
	});
});
