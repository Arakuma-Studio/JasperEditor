import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appdirPaths } from '@jasper/config';
import { createCounterIdSource, createEmptyProject, invariantStats, makeEnvelope } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, engineConfig } from '../src/index.ts';

const H = { host: '127.0.0.1:47900' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

describe('GET /api/perf invariants (perf-core)', () => {
	it('counts incremental and full checks of agent transactions', async () => {
		const appdir = mkdtempSync(join(tmpdir(), 'jasper-perf-inv-'));
		const app = await createServer(
			engineConfig({ appdir, port: 47900, dev: false, token: null, webDir: null, env: {} }),
		);
		apps.push(app);
		await app.ready();
		const ids = createCounterIdSource(3);
		const doc = createEmptyProject({ ids, name: 'Perf', preset: 'hd-1080p-30' });
		const file = appdirPaths(appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 0, savedAt: '2026-10-08T00:00:00.000Z', platform: 'test' }),
			),
		);
		invariantStats(true);
		for (let i = 0; i < 3; i++) {
			const r = await app.inject({
				method: 'POST',
				url: '/api/agent/tx',
				headers: H,
				payload: {
					projectId: doc.projectId,
					transaction: {
						label: 'Solid',
						origin: { agent: 'perf' },
						commands: [{ type: 'clip.addSolid', at: i * 40, duration: 30, track: 'V1', color: [1, 0, 0, 1] }],
					},
				},
			});
			expect(r.statusCode).toBe(200);
			expect((r.json() as { result: { ok: boolean } }).result.ok).toBe(true);
		}
		const perf = await app.inject({ method: 'GET', url: '/api/perf', headers: H });
		expect(perf.statusCode).toBe(200);
		const inv = (
			perf.json() as {
				invariants: { mode: string; incremental: number; full: number; fallbacks: Record<string, number> };
			}
		).invariants;
		expect(inv.mode).toBe('verify');
		// Headless transactions (no editor open) load the project file each time: a freshly loaded document has not
		// been checked under the transaction's registries, so the full check decides (and loading dominates anyway).
		expect(inv.full).toBeGreaterThanOrEqual(3);
		expect(inv.fallbacks['unverified base']).toBeGreaterThanOrEqual(3);
	});
});
