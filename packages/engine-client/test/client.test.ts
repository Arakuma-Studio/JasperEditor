import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineClient, EngineError } from '../src/index.ts';

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'x-jasper-api': '1', ...headers },
	});
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fn: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return handler(String(input), init ?? {});
	};
	return { fetch: fn, calls };
}

const job = {
	id: 'job_1',
	kind: 'export',
	title: 'Export',
	origin: { type: 'user' },
	state: 'queued',
	progress: null,
	createdAt: 't',
	priority: 'user',
	cpuSlots: 6,
};

describe('EngineClient requests', () => {
	it('calls typed routes with relative URLs and parses responses', async () => {
		const m = mockFetch((url) => {
			if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
			if (url === '/api/jobs?active=1&projectId=prj_1') return json({ jobs: [job] });
			if (url === '/api/projects/prj_1')
				return json({
					envelope: {
						format: 'jasper-project',
						schemaVersion: 1,
						savedAt: 't',
						savedBy: { app: 'a', version: 'v', platform: 'web' },
						revision: 2,
						document: {},
					},
					view: null,
					revision: 2,
				});
			return json({ code: 'NOT_FOUND', message: 'nope', retryable: false }, 404);
		});
		const c = new EngineClient({ fetch: m.fetch });
		expect((await c.health()).apiVersion).toBe(1);
		expect((await c.listJobs({ active: '1', projectId: 'prj_1' })).jobs[0]!.id).toBe('job_1');
		expect((await c.getProject('prj_1')).revision).toBe(2);
		await expect(c.getJob('x')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
	});

	it('sends If-Match, JSON bodies and bearer tokens', async () => {
		const m = mockFetch(() => json({ revision: 3 }));
		const c = new EngineClient({ fetch: m.fetch, baseUrl: 'http://127.0.0.1:47900/', token: 'tok' });
		await c.putProject('prj_1', { a: 1 }, 2);
		const call = m.calls[0]!;
		expect(call.url).toBe('http://127.0.0.1:47900/api/projects/prj_1');
		expect(call.init.method).toBe('PUT');
		const h = call.init.headers as Record<string, string>;
		expect(h['if-match']).toBe('2');
		expect(h.authorization).toBe('Bearer tok');
		expect(JSON.parse(String(call.init.body))).toEqual({ a: 1 });
	});

	it('maps error shapes, 501 stubs, invalid responses and API mismatches', async () => {
		const m = mockFetch((url) => {
			if (url.endsWith('/api/capabilities'))
				return json({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }, 501);
			if (url.endsWith('/api/fonts')) return json({ wrong: true });
			return json({ ok: true, version: '9', apiVersion: 2 }, 200, { 'x-jasper-api': '2' });
		});
		const c = new EngineClient({ fetch: m.fetch });
		const e = await c.capabilities().catch((x) => x);
		expect(e).toBeInstanceOf(EngineError);
		expect([e.code, e.status]).toEqual(['NOT_IMPLEMENTED', 501]);
		await expect(c.listFonts()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
		await expect(c.health()).rejects.toMatchObject({ code: 'API_VERSION_MISMATCH' });
		const down = new EngineClient({
			fetch: (async () => {
				throw new TypeError('connect ECONNREFUSED');
			}) as unknown as typeof fetch,
		});
		await expect(down.health()).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
	});

	it('builds media and output URLs', () => {
		const c = new EngineClient({ fetch: (() => {}) as unknown as typeof fetch });
		expect(c.mediaUrl('mk_abc')).toBe('/media/mk_abc');
		expect(c.mediaUrl('mk_abc', { proxy: '720' })).toBe('/media/mk_abc/proxy/720');
		expect(c.mediaUrl('mk_abc', 'poster')).toBe('/media/mk_abc/poster.jpg');
		expect(c.mediaUrl('mk_abc', { sprite: 2 })).toBe('/media/mk_abc/sprite/2.jpg');
		expect(c.mediaUrl('mk_abc', { peaks: 1 })).toBe('/media/mk_abc/peaks/1.bin');
		expect(c.renderOutputUrl('job_1')).toBe('/renders/job_1/output');
		expect(c.eventsUrl({ since: 5, projectId: 'p' })).toBe('/events?since=5&projectId=p');
	});
});

describe('uploadFile (S04:IN-005)', () => {
	it('uploads in chunks, resumes on offset mismatch and completes', async () => {
		const data = new Uint8Array(25).map((_, i) => i);
		const blob = new Blob([data]);
		let serverOffset = 0;
		let mismatchSent = false;
		const registered = {
			mediaKey: 'mk_12345678',
			fingerprint: 'q1:x',
			originalName: 'a.bin',
			sizeBytes: 25,
			container: 'mov,mp4',
			kind: 'video',
			probe: {
				durationFlicks: 1,
				startTimecode: null,
				streams: [],
				rotationDegrees: 0,
				hasAlpha: false,
				variableFrameRate: false,
			},
			locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_12345678' }],
			browserPlayable: 'yes',
		};
		const m = mockFetch(async (url, init) => {
			if (url === '/api/uploads') return json({ uploadId: 'up1', chunkSize: 10, offset: 0 });
			if (url.startsWith('/api/uploads/up1?offset=')) {
				const offset = Number(url.split('=')[1]);
				if (offset === 10 && !mismatchSent) {
					mismatchSent = true;
					serverOffset = 15; // the server already had more bytes
					return json(
						{
							code: 'UPLOAD_OFFSET_MISMATCH',
							message: 'offset',
							detail: { expectedOffset: 15 },
							retryable: false,
						},
						409,
					);
				}
				const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
				expect(body[0]).toBe(offset);
				serverOffset = offset + body.length;
				return json({ offset: serverOffset });
			}
			if (url === '/api/uploads/up1/complete') return json(registered);
			return json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
		});
		const c = new EngineClient({ fetch: m.fetch });
		const progress: number[] = [];
		const r = await c.uploadFile(blob, {
			projectId: 'prj_1',
			fileName: 'a.bin',
			onProgress: (p) => progress.push(p.loaded),
		});
		expect(r.mediaKey).toBe('mk_12345678');
		expect(progress).toEqual([0, 10, 15, 25]);
		const puts = m.calls.filter((x) => x.init.method === 'PUT').map((x) => x.url);
		expect(puts).toEqual([
			'/api/uploads/up1?offset=0',
			'/api/uploads/up1?offset=10',
			'/api/uploads/up1?offset=15',
		]);
	});

	it('aborts the upload session when cancelled', async () => {
		const ctrl = new AbortController();
		const m = mockFetch(async (url, init) => {
			if (url === '/api/uploads') return json({ uploadId: 'up2', chunkSize: 4, offset: 0 });
			if (init.method === 'PUT') {
				ctrl.abort();
				return json({ offset: 4 });
			}
			if (init.method === 'DELETE') return json({ ok: true });
			return json({}, 500);
		});
		const c = new EngineClient({ fetch: m.fetch });
		await expect(
			c.uploadFile(new Blob([new Uint8Array(10)]), { projectId: 'p', signal: ctrl.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(m.calls.some((x) => x.init.method === 'DELETE' && x.url === '/api/uploads/up2')).toBe(true);
	});
});

describe('openEvents (NDJSON, S04:ENG-023)', () => {
	afterEach(() => vi.useRealTimers());

	function streamResponse(chunks: string[], keepOpen = false) {
		const enc = new TextEncoder();
		let i = 0;
		return new Response(
			new ReadableStream({
				pull(ctrl) {
					if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]!));
					else if (!keepOpen) ctrl.close();
					else return new Promise(() => {});
				},
			}),
			{ status: 200, headers: { 'content-type': 'application/x-ndjson' } },
		);
	}

	it('parses events split across chunks, reconnects with backoff and resumes with since', async () => {
		vi.useFakeTimers();
		const urls: string[] = [];
		let n = 0;
		const fetchImpl = (async (url: string) => {
			urls.push(url);
			n++;
			if (n === 1) {
				return streamResponse([
					'{"id":1,"type":"engine.heartbeat","createdAt":"t","payload":{}}\n{"id":2,"type":"deriv',
					'ative.ready","createdAt":"t","payload":{"mediaKey":"mk_12345678","kind":"poster","url":"/p"}}\n',
				]);
			}
			if (n === 2) throw new TypeError('down');
			return streamResponse(['{"id":3,"type":"future.event","createdAt":"t","payload":{"x":1}}\n'], true);
		}) as unknown as typeof fetch;
		const c = new EngineClient({ fetch: fetchImpl });
		const types: string[] = [];
		const envs: number[] = [];
		const states: string[] = [];
		const s = c.openEvents(
			{ projectId: 'prj_1' },
			{
				onEvent: (e) => types.push(e.type),
				onEnvelope: (e) => envs.push(e.id),
				onStateChange: (st, info) =>
					states.push(`${st}${info.delayMs !== undefined ? `:${info.delayMs}` : ''}`),
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(types).toEqual(['engine.heartbeat', 'derivative.ready']);
		expect(s.lastEventId).toBe(2);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);
		expect(envs).toEqual([1, 2, 3]);
		expect(urls).toEqual([
			'/events?projectId=prj_1',
			'/events?since=2&projectId=prj_1',
			'/events?since=2&projectId=prj_1',
		]);
		expect(states).toEqual(['connecting', 'open', 'reconnecting:1000', 'reconnecting:2000', 'open']);
		s.close();
		expect(s.state).toBe('closed');
	});

	it('reconnects when heartbeats stop and caps the backoff at 30 s', async () => {
		vi.useFakeTimers();
		let n = 0;
		const fetchImpl = (async (_url: string, init: RequestInit) => {
			n++;
			if (n === 1) {
				// open but silent: the watchdog must abort it
				return new Response(
					new ReadableStream({
						start(ctrl) {
							init.signal?.addEventListener('abort', () => ctrl.error(new Error('aborted')));
						},
					}),
					{ status: 200 },
				);
			}
			throw new TypeError('down');
		}) as unknown as typeof fetch;
		const c = new EngineClient({ fetch: fetchImpl });
		const delays: number[] = [];
		const s = c.openEvents(
			{},
			{ onStateChange: (st, info) => st === 'reconnecting' && delays.push(info.delayMs!) },
		);
		await vi.advanceTimersByTimeAsync(37_500);
		expect(delays).toEqual([1000]);
		for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(30_000);
		expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
		s.close();
	});
});
