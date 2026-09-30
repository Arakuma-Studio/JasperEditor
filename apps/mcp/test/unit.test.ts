// jasper-mcp units without an engine: discovery (runtime files, stale pids, explicit targets), error
// mapping, export presets, the text timeline, and version sync.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineClient, EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { candidateAppdirs, discoverEngine, findEngineEntry, probeHealth } from '../src/discovery.ts';
import { ToolError, toErrorResult } from '../src/errors.ts';
import { buildExportSettings, EXPORT_PRESETS, findExportPreset } from '../src/export-presets.ts';
import { projectSummary, timelineTable } from '../src/format.ts';
import { EngineLink, EngineRequestAborted, FixedEngineLink, guardedFetch, withEngine } from '../src/link.ts';
import { MCP_SERVER_VERSION } from '../src/version.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** A fetch that answers /health for the given origins. */
function fakeFetch(healthy: string[]): typeof fetch {
	return (async (input: string | URL) => {
		const url = String(input);
		if (healthy.some((h) => url === `${h}/health`))
			return new Response(JSON.stringify({ ok: true, version: '9.9.9', apiVersion: 1 }), {
				headers: { 'content-type': 'application/json' },
			});
		throw new TypeError('fetch failed: ECONNREFUSED');
	}) as typeof fetch;
}

function writeRuntime(appdir: string, info: Record<string, unknown>) {
	mkdirSync(join(appdir, 'engine'), { recursive: true });
	writeFileSync(join(appdir, 'engine', 'runtime.json'), JSON.stringify(info));
}

describe('engine discovery', () => {
	it('prefers explicit URL/token (flags over env)', async () => {
		const t = await discoverEngine({
			url: 'http://127.0.0.1:1',
			env: { JASPER_ENGINE_URL: 'http://127.0.0.1:2', JASPER_ENGINE_TOKEN: 'envtok' },
			fetch: fakeFetch(['http://127.0.0.1:1']),
		});
		expect(t).toMatchObject({
			url: 'http://127.0.0.1:1',
			token: 'envtok',
			source: 'explicit',
			version: '9.9.9',
		});
		const e = await discoverEngine({
			env: { JASPER_ENGINE_URL: 'http://127.0.0.1:2/' },
			fetch: fakeFetch([]),
		});
		// Down but explicit: still returned so errors name the configured URL.
		expect(e).toMatchObject({ url: 'http://127.0.0.1:2', token: null, source: 'explicit' });
	});

	it('reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries', async () => {
		const stale = mkdtempSync(join(tmpdir(), 'jasper-mcp-stale-'));
		const down = mkdtempSync(join(tmpdir(), 'jasper-mcp-down-'));
		const data = mkdtempSync(join(tmpdir(), 'jasper-mcp-data-'));
		const live = join(data, 'jasper'); // the platform appdir on Linux: $XDG_DATA_HOME/jasper
		writeRuntime(stale, { url: 'http://127.0.0.1:3', port: 3, pid: 2 ** 30, token: 'x' });
		writeRuntime(down, { url: 'http://127.0.0.1:4', port: 4, pid: process.pid, token: 'y' });
		writeRuntime(live, { url: 'http://127.0.0.1:5', port: 5, pid: process.pid, token: 'secret' });
		const env = { JASPER_APPDIR: down, XDG_DATA_HOME: data, XDG_CONFIG_HOME: data };
		expect(candidateAppdirs({ appdir: stale, env }).slice(0, 2)).toEqual([stale, down]);
		const logs: string[] = [];
		const t = await discoverEngine({
			appdir: stale,
			env,
			fetch: fakeFetch(['http://127.0.0.1:5']),
			noDefaultPort: true,
			log: (l) => logs.push(l),
		});
		expect(logs.some((l) => l.includes('stale runtime file'))).toBe(true);
		expect(logs.some((l) => l.includes('not answering'))).toBe(true);
		if (process.platform !== 'linux') return;
		expect(t).toMatchObject({ url: 'http://127.0.0.1:5', token: 'secret', source: 'runtime-file' });
		expect(t?.detail).toBe(join(live, 'engine', 'runtime.json'));
		// An explicit token wins over the runtime file's.
		const t2 = await discoverEngine({
			token: 'mine',
			env,
			fetch: fakeFetch(['http://127.0.0.1:5']),
			noDefaultPort: true,
		});
		expect(t2?.token).toBe('mine');
	});

	it('falls back to the default dev port', async () => {
		const t = await discoverEngine({
			env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', HOME: '/nonexistent' },
			fetch: fakeFetch(['http://127.0.0.1:47900']),
		});
		expect(t).toMatchObject({ url: 'http://127.0.0.1:47900', source: 'default-port', token: null });
	});

	it('probeHealth rejects non-engine answers', async () => {
		const f = (async () => new Response(JSON.stringify({ hello: 1 }))) as unknown as typeof fetch;
		expect(await probeHealth('http://x', { fetch: f })).toMatchObject({ ok: false });
	});

	it('finds the engine bundle next to the server (checkout layout) or via JASPER_ENGINE_ENTRY', () => {
		const repoLayout = join(here, '..', 'dist');
		const found = findEngineEntry({}, repoLayout);
		// apps/mcp/dist → ../../engine/dist/engine.mjs exists after `pnpm build`.
		if (found) expect(found.endsWith(join('engine', 'dist', 'engine.mjs'))).toBe(true);
		expect(findEngineEntry({ JASPER_ENGINE_ENTRY: '/definitely/missing.mjs' })).toBeNull();
	});

	it('EngineLink reports an actionable error when nothing runs', async () => {
		const link = new EngineLink({
			env: { XDG_DATA_HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' },
			fetch: fakeFetch([]),
			log: () => {},
		});
		const err = await link.client().catch((e) => e);
		expect(err).toBeInstanceOf(ToolError);
		expect(err.code).toBe('ENGINE_NOT_FOUND');
		expect(err.hint).toMatch(/--start-engine/);
	});

	it('withEngine re-discovers once after a network failure', async () => {
		let n = 0;
		const link = {
			target: null,
			invalidate: () => {},
			close: async () => {},
			client: async () => ({ id: ++n }) as never,
		};
		const seen: number[] = [];
		const out = await withEngine(link, async (client) => {
			const c = client as unknown as { id: number };
			seen.push(c.id);
			if (c.id === 1) throw new EngineError('NETWORK', 'down', { retryable: true });
			return 'ok';
		});
		expect(out).toBe('ok');
		expect(seen).toEqual([1, 2]);
	});
});

describe('engine request guard (no unbounded waits, no blind re-apply)', () => {
	const errorOf = (r: ReturnType<typeof toErrorResult>) =>
		JSON.parse((r.content[0] as { text: string }).text).error as { code: string; hint?: string };
	const failWith = (code: string) =>
		(async () => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
		}) as unknown as typeof fetch;

	it('a request that never answers ends with ENGINE_TIMEOUT instead of hanging', async () => {
		const never = ((_input: unknown, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			})) as unknown as typeof fetch;
		const link = new FixedEngineLink('http://127.0.0.1:1', 'secret-token', never, 40);
		let calls = 0;
		const t0 = Date.now();
		const err = await withEngine(link, (c) => {
			calls++;
			return c.listProjects();
		}).catch((e) => e);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(err).toBeInstanceOf(EngineRequestAborted);
		expect(calls).toBe(1);
		const body = errorOf(toErrorResult(err));
		expect(body.code).toBe('ENGINE_TIMEOUT');
		expect(JSON.stringify(body)).not.toContain('secret-token');
	});

	it('a write cut off mid-flight is reported, not retried (it may have been applied)', async () => {
		let sent = 0;
		const client = new EngineClient({
			baseUrl: 'http://127.0.0.1:1',
			fetch: guardedFetch((async () => {
				sent++;
				throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
			}) as unknown as typeof fetch),
		});
		const link = { target: null, invalidate: () => {}, close: async () => {}, client: async () => client };
		const err = await withEngine(link, (c) =>
			c.agentTx({ projectId: 'prj_x', transaction: {} as never }),
		).catch((e) => e);
		expect(sent).toBe(1);
		const body = errorOf(toErrorResult(err));
		expect(body.code).toBe('ENGINE_CONNECTION_LOST');
		expect(body.hint).toMatch(/Re-read the project/);
	});

	it('a write that never reached the engine, and any read, stay retryable NETWORK errors', async () => {
		const refused = new EngineClient({
			baseUrl: 'http://127.0.0.1:1',
			fetch: guardedFetch(failWith('ECONNREFUSED')),
		});
		await expect(refused.agentTx({ projectId: 'p', transaction: {} as never })).rejects.toMatchObject({
			code: 'NETWORK',
		});
		const reset = new EngineClient({
			baseUrl: 'http://127.0.0.1:1',
			fetch: guardedFetch(failWith('ECONNRESET')),
		});
		await expect(reset.listProjects()).rejects.toMatchObject({ code: 'NETWORK' });
	});
});

describe('errors', () => {
	it('maps tool, engine and transaction errors to isError results with hints', () => {
		const a = toErrorResult(new ToolError('E_NOT_FOUND', 'nope', 'look it up'));
		expect(a.isError).toBe(true);
		expect(JSON.parse((a.content[0] as { text: string }).text)).toEqual({
			error: { code: 'E_NOT_FOUND', message: 'nope', hint: 'look it up' },
		});
		const b = toErrorResult(
			new EngineError('NO_SESSION', 'needs a session', { status: 409, detail: { code: 'E_NO_SESSION' } }),
		);
		const body = JSON.parse((b.content[0] as { text: string }).text);
		expect(body.error.code).toBe('E_NO_SESSION');
		expect(body.error.hint).toMatch(/open_project_in_editor/);
		const c = toErrorResult(new EngineError('NETWORK', 'down'));
		expect(JSON.parse((c.content[0] as { text: string }).text).error.hint).toMatch(/--start-engine/);
	});
});

function sampleDoc(): ProjectDocument {
	const ids = createSeededIdSource(7);
	let doc = createEmptyProject({ ids, name: 'Unit', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => '2026-09-30T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', label: 't', origin: 'user', commands } as never,
			ctx,
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
	};
	tx([
		{ type: 'clip.addText', at: 30, duration: 60, track: 'V2', content: { text: 'Hello timeline' } },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0, 0, 1] },
		{ type: 'marker.add', frame: 45, name: 'Beat', comment: 'hit' },
	]);
	return doc;
}

describe('format', () => {
	it('renders a compact timeline table with frames and timecodes', () => {
		const doc = sampleDoc();
		const seq = Object.values(doc.sequences)[0]!;
		const text = timelineTable(doc, seq, { revision: 1, live: true });
		expect(text).toMatch(/duration 00:00:03:00 \(90 frames\), revision 1, open in the editor/);
		expect(text).toMatch(/V1 \| clp_\w+ \| solid \| .* \| 00:00:00:00–00:00:03:00 \| 0–90 \| color matte/);
		expect(text).toMatch(
			/V2 \| clp_\w+ \| text \| .* \| 00:00:01:00–00:00:03:00 \| 30–90 \| text "Hello timeline"/,
		);
		expect(text).toMatch(/V3 \| \(empty\)/);
		expect(text).toMatch(/00:00:01:15 \(45\) "Beat" mrk_\w+ — hit/);
		const ranged = timelineTable(doc, seq, { from: 0, to: 30 });
		expect(ranged).not.toMatch(/Hello timeline/);
		const summary = projectSummary(doc, 1, false);
		expect(summary.sequences[0]!.clips).toHaveLength(2);
		expect(summary.sequences[0]!.tracks.map((t) => t.label)).toEqual(['V1', 'V2', 'V3', 'A1', 'A2', 'A3']);
	});
});

describe('export presets', () => {
	it('builds engine ExportSettings from a preset', () => {
		const doc = sampleDoc();
		const seq = Object.values(doc.sequences)[0]!;
		const draft = buildExportSettings(seq, findExportPreset('draft-720p-h264')!, {
			range: { type: 'entire' },
			engine: 'auto',
			outputPath: '/tmp/x.mp4',
		});
		expect(draft.video).toMatchObject({ width: 1280, height: 720, quality: { mode: 'crf', value: 28 } });
		expect(draft.destination).toEqual({ type: 'path', path: '/tmp/x.mp4' });
		const def = buildExportSettings(seq, findExportPreset(undefined)!, {
			range: { type: 'entire' },
			engine: 'auto',
		});
		expect(def.video).toMatchObject({ width: 1920, height: 1080, codec: 'h264' });
		expect(def.destination).toEqual({ type: 'download' });
		expect(new Set(EXPORT_PRESETS.map((p) => p.id)).size).toBe(EXPORT_PRESETS.length);
		// Masters: a high-bitrate H.264 and a ProRes 422 HQ MOV; quality overrides win over the preset.
		const hi = buildExportSettings(seq, findExportPreset('master-h264-high')!, {
			range: { type: 'entire' },
			engine: 'auto',
		});
		expect(hi.video).toMatchObject({ codec: 'h264', quality: { value: 14 }, bitrateKbps: 20000 });
		const tuned = buildExportSettings(seq, findExportPreset(undefined)!, {
			range: { type: 'entire' },
			engine: 'auto',
			crf: 12,
			videoBitrateKbps: 16000,
		});
		expect(tuned.video).toMatchObject({ quality: { value: 12 }, bitrateKbps: 16000 });
		const pr = buildExportSettings(seq, findExportPreset('master-prores-422hq')!, {
			range: { type: 'entire' },
			engine: 'native',
		});
		expect(pr).toMatchObject({ container: 'mov', video: { codec: 'prores' } });
		expect(pr.video!.bitrateKbps).toBeUndefined();
	});
});

it('MCP_SERVER_VERSION matches package.json', () => {
	const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
	expect(MCP_SERVER_VERSION).toBe(pkg.version);
});
