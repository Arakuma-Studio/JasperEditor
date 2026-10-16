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
		const envelope = {
			format: 'jasper-project' as const,
			schemaVersion: 1,
			savedAt: 't',
			savedBy: { app: 'JasperEditor', version: '1', platform: 'web' },
			revision: 3,
			document: {},
		};
		await c.putProject('prj_1', envelope, 2);
		const call = m.calls[0]!;
		expect(call.url).toBe('http://127.0.0.1:47900/api/projects/prj_1');
		expect(call.init.method).toBe('PUT');
		const h = call.init.headers as Record<string, string>;
		expect(h['if-match']).toBe('2');
		expect(h.authorization).toBe('Bearer tok');
		expect(JSON.parse(String(call.init.body))).toEqual(envelope);
	});

	it('maps error shapes, invalid responses and API mismatches', async () => {
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
			fetch: async () => {
				throw new TypeError('connect ECONNREFUSED');
			},
		});
		await expect(down.health()).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
	});

	it('rejects binary routes before a JSON call sends a request', async () => {
		const m = mockFetch(() => new Response('bytes'));
		await expect(
			new EngineClient({ fetch: m.fetch }).call('mediaFile', { params: { mediaKey: 'mk_test' } }),
		).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(m.calls).toHaveLength(0);
	});

	it('builds media and output URLs', () => {
		const c = new EngineClient({ fetch: async () => new Response() });
		expect(c.mediaUrl('mk_abc')).toBe('/media/mk_abc');
		expect(c.mediaUrl('mk_abc', { proxy: '720' })).toBe('/media/mk_abc/proxy/720');
		expect(c.mediaUrl('mk_abc', 'poster')).toBe('/media/mk_abc/poster.jpg');
		expect(c.mediaUrl('mk_abc', { sprite: 2 })).toBe('/media/mk_abc/sprite/2.jpg');
		expect(c.mediaUrl('mk_abc', { peaks: 1 })).toBe('/media/mk_abc/peaks/1.bin');
		expect(c.renderOutputUrl('job_1')).toBe('/renders/job_1/output');
		expect(c.eventsUrl({ since: 5, projectId: 'p' })).toBe('/events?since=5&projectId=p');
		expect(c.soundAudioUrl('snd_0123456789abcdef')).toBe('/api/sounds/snd_0123456789abcdef/audio');
	});

	it('searches sounds with a typed request and posts sound routes', async () => {
		const empty = {
			snapshotHash: 'h',
			librarySize: 0,
			total: 0,
			offset: 0,
			results: [],
			facets: { types: {}, families: {}, licenses: {}, sources: {} },
			indexing: false,
		};
		const m = mockFetch((url, init) => {
			if (url.startsWith('/api/sounds?')) return json(empty);
			if (url === '/api/sounds/index' && init.method === 'POST') return json({ ...job, kind: 'sound-index' });
			if (url === '/api/sounds/roots' && init.method === 'PUT')
				return json({ roots: [], local: true, job: null, removedSounds: 0 });
			return json({ code: 'NOT_FOUND', message: 'nope', retryable: false }, 404);
		});
		const c = new EngineClient({ fetch: m.fetch });
		expect(
			(await c.searchSounds({ q: 'door slam', types: ['hit', 'thump'], sources: [], limit: 5 })).total,
		).toBe(0);
		expect(m.calls[0]!.url).toBe('/api/sounds?q=door%20slam&types=hit%2Cthump&limit=5');
		expect((await c.indexSounds({ full: true })).kind).toBe('sound-index');
		expect(JSON.parse(String(m.calls[1]!.init.body))).toEqual({ full: true });
		expect((await c.putSoundRoots({ roots: [] })).removedSounds).toBe(0);
		await expect(c.getSound('snd_0123456789abcdef')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('posts the cue derivation request (spec 12 §2.8)', async () => {
		const m = mockFetch((url, init) =>
			url === '/api/sound-design/cues' && init.method === 'POST'
				? json({
						projectId: 'p1',
						sequenceId: 'seq_1',
						revision: 3,
						frameRate: { num: 30, den: 1 },
						durationFrames: 90,
						density: 'balanced',
						respectDialogue: true,
						cues: [],
						stats: {
							bySource: {},
							dropped: { rate: 0, gap: 0, maxCues: 0, confidence: 0, range: 0 },
							heroesDemoted: 0,
							found: 0,
							kept: 0,
						},
						warnings: [],
						dialogue: [],
						storedCues: 0,
					})
				: json({ code: 'NOT_FOUND', message: 'nope', retryable: false }, 404),
		);
		const c = new EngineClient({ fetch: m.fetch });
		const r = await c.soundDesignCues({ projectId: 'p1', opts: { density: 'sparse', sources: ['edits'] } });
		expect(r.revision).toBe(3);
		expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual({
			projectId: 'p1',
			opts: { density: 'sparse', sources: ['edits'] },
		});
	});

	it('starts a sound-design plan job (spec 12 §2.8, P3-R3)', async () => {
		const m = mockFetch((url, init) =>
			url === '/api/sound-design/plan' && init.method === 'POST'
				? json({ ...job, kind: 'sound-design', title: 'Sound design plan' }, 202)
				: json({ code: 'NOT_FOUND', message: 'nope', retryable: false }, 404),
		);
		const c = new EngineClient({ fetch: m.fetch });
		const body = {
			projectId: 'prj_0000000000000001',
			cues: 'auto' as const,
			style: {
				density: 'sparse' as const,
				sources: ['starter' as const],
				seed: 4,
				palette: 'project' as const,
			},
			maxCues: 20,
		};
		expect((await c.planSoundDesign(body)).kind).toBe('sound-design');
		expect(JSON.parse(String(m.calls[0]!.init.body))).toEqual(body);
	});

	it('calls the proposal routes (spec 12 §2.5) with their paths, queries and bodies', async () => {
		const proposal = {
			version: 1,
			id: 'prp_0000000000000001',
			projectId: 'prj_0000000000000001',
			sequenceId: null,
			feature: 'sound-design',
			title: 'T',
			summary: '',
			author: 'user',
			createdAt: 'x',
			updatedAt: 'x',
			baseRevision: 0,
			docHash: '0',
			items: [
				{
					id: 'a',
					label: 'A',
					group: '',
					commands: [{ type: 'marker.add' }],
					requires: [],
					state: 'pending',
				},
			],
		};
		const m = mockFetch((url, init) => {
			if (url.endsWith('/accept'))
				return json({
					proposal,
					applied: [],
					added: [],
					skipped: [],
					stale: [],
					result: null,
					appliedBy: null,
					revision: 3,
				});
			if (
				url.endsWith('/note') ||
				url.endsWith('/reject') ||
				url.endsWith('/select') ||
				url.endsWith('/reopen') ||
				url.endsWith('/applied')
			)
				return json({ proposal, changed: ['a'] });
			if (init.method === 'DELETE') return json({ proposalId: proposal.id, deleted: true });
			if (url.includes('/proposals/')) return json({ proposal, expiresAt: 'y', revision: 2 });
			return json({ proposals: [], warnings: [] });
		});
		const c = new EngineClient({ fetch: m.fetch });
		const base = '/api/projects/prj_0000000000000001/proposals';
		await c.listProposals('prj_0000000000000001');
		expect((await c.getProposal('prj_0000000000000001', proposal.id, { revalidate: true })).revision).toBe(2);
		expect(m.calls[1]!.url).toBe(`${base}/${proposal.id}?revalidate=1`);
		const acc = await c.acceptProposal('prj_0000000000000001', proposal.id, {
			itemIds: 'all',
			partial: true,
		});
		expect(acc.revision).toBe(3);
		expect([m.calls[2]!.url, m.calls[2]!.init.method]).toEqual([`${base}/${proposal.id}/accept`, 'POST']);
		expect(JSON.parse(String(m.calls[2]!.init.body))).toEqual({ itemIds: 'all', partial: true });
		await c.noteProposalItem('prj_0000000000000001', proposal.id, { itemId: 'a', note: 'quieter' });
		expect(JSON.parse(String(m.calls[3]!.init.body))).toEqual({ itemId: 'a', note: 'quieter' });
		await c.selectProposalAlternative('prj_0000000000000001', proposal.id, { itemId: 'a', alternative: 1 });
		await c.rejectProposal('prj_0000000000000001', proposal.id, { itemIds: ['a'] });
		await c.reopenProposal('prj_0000000000000001', proposal.id, { itemIds: 'all' });
		await c.markProposalApplied('prj_0000000000000001', proposal.id, {
			itemIds: ['a'],
			revision: 4,
			refs: { $x: 'trk_0000000000000001' },
		});
		expect(JSON.parse(String(m.calls[7]!.init.body))).toEqual({
			itemIds: ['a'],
			revision: 4,
			refs: { $x: 'trk_0000000000000001' },
		});
		expect((await c.deleteProposal('prj_0000000000000001', proposal.id)).deleted).toBe(true);
		expect(m.calls.map((x) => x.url.slice(base.length))).toEqual([
			'',
			`/${proposal.id}?revalidate=1`,
			`/${proposal.id}/accept`,
			`/${proposal.id}/note`,
			`/${proposal.id}/select`,
			`/${proposal.id}/reject`,
			`/${proposal.id}/reopen`,
			`/${proposal.id}/applied`,
			`/${proposal.id}`,
		]);
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
		const fetchImpl: typeof fetch = async (url) => {
			urls.push(String(url));
			n++;
			if (n === 1) {
				return streamResponse([
					'{"id":1,"type":"engine.heartbeat","createdAt":"t","payload":{}}\n{"id":2,"type":"deriv',
					'ative.ready","createdAt":"t","payload":{"mediaKey":"mk_12345678","kind":"poster","url":"/p"}}\n',
				]);
			}
			if (n === 2) throw new TypeError('down');
			return streamResponse(['{"id":3,"type":"future.event","createdAt":"t","payload":{"x":1}}\n'], true);
		};
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
		const fetchImpl: typeof fetch = async (_url, init) => {
			n++;
			if (n === 1) {
				// open but silent: the watchdog must abort it
				return new Response(
					new ReadableStream({
						start(ctrl) {
							init?.signal?.addEventListener('abort', () => ctrl.error(new Error('aborted')));
						},
					}),
					{ status: 200 },
				);
			}
			throw new TypeError('down');
		};
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

describe('upload contract failures', () => {
	it.each([0, 3, 9, 11])('rejects an acknowledgement at unexpected offset %d', async (offset) => {
		let puts = 0;
		const m = mockFetch((_url, init) => {
			if (init.method === 'POST') return json({ uploadId: 'up', chunkSize: 4, offset: 0 });
			if (++puts > 1) throw new Error('Repeated invalid chunk');
			return json({ offset });
		});
		await expect(
			new EngineClient({ fetch: m.fetch }).uploadFile(new Blob([new Uint8Array(10)]), { projectId: 'p' }),
		).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
		expect(puts).toBe(1);
	});

	it('rejects a resumed offset beyond the file', async () => {
		const m = mockFetch((_url, init) =>
			init.method === 'POST'
				? json({ uploadId: 'up', chunkSize: 4, offset: 0 })
				: json(
						{
							code: 'UPLOAD_OFFSET_MISMATCH',
							message: 'offset',
							detail: { expectedOffset: 11 },
							retryable: false,
						},
						409,
					),
		);
		await expect(
			new EngineClient({ fetch: m.fetch }).uploadFile(new Blob([new Uint8Array(10)]), { projectId: 'p' }),
		).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
	});

	it('reports cleanup failures together with the original cancellation', async () => {
		const controller = new AbortController();
		controller.abort();
		const m = mockFetch((_url, init) =>
			init.method === 'POST'
				? json({ uploadId: 'up', chunkSize: 4, offset: 0 })
				: json({ code: 'DISK_FULL', message: 'cleanup failed', retryable: true }, 507),
		);
		await expect(
			new EngineClient({ fetch: m.fetch }).uploadFile(new Blob(['abc']), {
				projectId: 'p',
				signal: controller.signal,
			}),
		).rejects.toMatchObject({
			name: 'AggregateError',
			errors: [
				expect.objectContaining({ name: 'AbortError' }),
				expect.objectContaining({ code: 'DISK_FULL' }),
			],
		});
	});

	it('resumes image sequence frame uploads through the same offset protocol', async () => {
		let puts = 0;
		const m = mockFetch((_url, init) => {
			if (init.method === 'POST') return json({ uploadId: 'up', chunkSize: 4, offset: 0 });
			if (++puts === 1)
				return json(
					{
						code: 'UPLOAD_OFFSET_MISMATCH',
						message: 'offset',
						detail: { expectedOffset: 2 },
						retryable: false,
					},
					409,
				);
			return json({ offset: 3 });
		});
		await expect(
			new EngineClient({ fetch: m.fetch }).uploadSequenceFrame(new Blob(['abc']), { projectId: 'p' }),
		).resolves.toBe('up');
		expect(m.calls[2]?.url).toBe('/api/uploads/up?offset=2');
	});

	it('rejects an invalid chunk size before sending chunks', async () => {
		const m = mockFetch(() => json({ offset: 0 }));
		await expect(
			new EngineClient({ fetch: m.fetch }).uploadChunks(new Blob(['abc']), {
				uploadId: 'up',
				offset: 0,
				chunkSize: 0,
			}),
		).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
		expect(m.calls).toHaveLength(0);
	});
});
