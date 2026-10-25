// EngineClient voice analysis calls (spec 14 TC-001): the job request, the analysis file fetched and validated, and
// engine errors / invalid files as EngineError.
import { encodeVoiceAnalysis, type VoiceAnalysis } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import { EngineClient, EngineError } from '../src/index.ts';

const analysis: VoiceAnalysis = {
	format: 1,
	analysisVersion: 1,
	fingerprint: 'q1:abc',
	stream: 1,
	sampleRate: 16000,
	frameStep: 160,
	window: 400,
	levelMinDb: -120,
	levelStepDb: 0.5,
	samples: 480,
	frameCount: 3,
	levels: { floorDb: -70, speechDb: -20, speechThresholdDb: -55, breathFloorDb: -65 },
	counts: { silence: 1, breath: 0, speech: 2 },
	windowFrames: 6000,
	windows: [{ startFrame: 0, frameCount: 3, floorDb: -70, speechDb: -20, speechThresholdDb: -55 }],
	level: Uint8Array.from([100, 200, 200]),
	voicing: Uint8Array.from([10, 230, 230]),
	flatness: Uint8Array.from([150, 10, 10]),
	classes: Uint8Array.from([0, 2, 2]),
};

function client(handler: (url: string, init: RequestInit) => Response) {
	const urls: string[] = [];
	const c = new EngineClient({
		baseUrl: 'http://e',
		token: 't',
		fetch: async (input, init) => {
			urls.push(String(input));
			return handler(String(input), init ?? {});
		},
	});
	return { c, urls };
}

describe('EngineClient voice analysis', () => {
	it('fetches and decodes the analysis file of a stream', async () => {
		const bytes = encodeVoiceAnalysis(analysis);
		const { c, urls } = client(
			() => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
		);
		const a = await c.getVoiceAnalysis('mk_1', 1);
		expect(urls).toEqual(['http://e/api/media/mk_1/voice-analysis?streamIndex=1']);
		expect(Array.from(a.classes)).toEqual([0, 2, 2]);
		expect(a.levels.floorDb).toBe(-70);
	});

	it('throws the engine error (VOICE_ANALYSIS_NOT_FOUND) and refuses invalid files', async () => {
		const notFound = client(
			() =>
				new Response(
					JSON.stringify({ code: 'VOICE_ANALYSIS_NOT_FOUND', message: 'none yet', retryable: false }),
					{ status: 404, headers: { 'content-type': 'application/json' } },
				),
		);
		await expect(notFound.c.getVoiceAnalysis('mk_1')).rejects.toMatchObject({
			code: 'VOICE_ANALYSIS_NOT_FOUND',
			status: 404,
		});
		expect(notFound.urls).toEqual(['http://e/api/media/mk_1/voice-analysis']);
		const broken = encodeVoiceAnalysis(analysis);
		broken[20] = (broken[20] ?? 0) ^ 1;
		const bad = client(() => new Response(broken, { status: 200 }));
		const e = await bad.c.getVoiceAnalysis('mk_1').catch((x: unknown) => x);
		expect(e).toBeInstanceOf(EngineError);
		expect((e as EngineError).code).toBe('INVALID_RESPONSE');
		const html = client(() => new Response('<html>', { status: 502 }));
		await expect(html.c.getVoiceAnalysis('mk_1')).rejects.toMatchObject({ code: 'HTTP_ERROR', retryable: true });
	});

	it('posts the analysis job', async () => {
		const job = {
			id: 'job_1',
			kind: 'voice-analysis',
			title: 'Voice analysis',
			origin: { type: 'user' },
			state: 'queued',
			progress: null,
			createdAt: 't',
			priority: 'user',
			cpuSlots: 4,
		};
		const seen: Array<{ url: string; body: unknown }> = [];
		const { c } = client((url, init) => {
			seen.push({ url, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(job), { status: 202, headers: { 'content-type': 'application/json' } });
		});
		expect((await c.analyzeVoice('mk_1', { streamIndex: 2 }, true)).kind).toBe('voice-analysis');
		expect(seen).toEqual([{ url: 'http://e/api/media/mk_1/voice-analysis?wait=1', body: { streamIndex: 2 } }]);
	});
});
