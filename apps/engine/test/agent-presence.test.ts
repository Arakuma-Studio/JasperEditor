// Spec 18 AF-BRF-005: GET /api/agent/presence lists the agents that called the engine recently (named by jasper-mcp's
// x-jasper-agent header), most recent first; unauthenticated requests and requests without the header count for
// nothing; the tracker keeps at most 32 names and forgets agents silent for longer than the window.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PRESENCE_MAX, AgentPresenceSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentPresenceTracker } from '../src/agent/presence.ts';
import { createServer, engineConfig } from '../src/index.ts';

const H = { host: '127.0.0.1:47911' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
	for (const a of apps.splice(0)) await a.close();
});

async function makeEngine(token: string) {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-presence-'));
	const app = await createServer(
		engineConfig({ appdir, port: 47911, dev: true, token, webDir: null, env: {} }),
	);
	apps.push(app);
	await app.ready();
	return app;
}

describe('GET /api/agent/presence (AF-BRF-005)', () => {
	it('lists agents that called the engine with the token, most recent first', async () => {
		const token = 'presence-token';
		const app = await makeEngine(token);
		const auth = { ...H, authorization: `Bearer ${token}` };
		const get = async () => {
			const r = await app.inject({ method: 'GET', url: '/api/agent/presence', headers: auth });
			expect(r.statusCode).toBe(200);
			return AgentPresenceSchema.parse(r.json());
		};
		expect((await get()).agents).toEqual([]);
		// no token: refused before the hook records anything
		await app.inject({
			method: 'GET',
			url: '/api/projects',
			headers: { ...H, 'x-jasper-agent': 'intruder' },
		});
		await app.inject({
			method: 'GET',
			url: '/api/projects',
			headers: { ...auth, 'x-jasper-agent': encodeURIComponent('claude-code') },
		});
		await app.inject({
			method: 'GET',
			url: '/api/agent/mcp-info',
			headers: { ...auth, 'x-jasper-agent': encodeURIComponent('codex cli') },
		});
		const p = await get();
		expect(p.agents.map((a) => a.name)).toEqual(['codex cli', 'claude-code']);
		expect(p.windowSec).toBe(900);
		expect(Number.isFinite(Date.parse(p.agents[0]!.lastSeenAt))).toBe(true);
	});
});

describe('AgentPresenceTracker', () => {
	it('forgets agents silent for longer than the window and keeps at most 32 names', () => {
		let now = 1_000_000;
		const t = new AgentPresenceTracker(() => now);
		t.note('a');
		now += 1000;
		t.note('b');
		expect(t.list(60).agents.map((x) => x.name)).toEqual(['b', 'a']);
		now += 59_500;
		expect(t.list(60).agents.map((x) => x.name)).toEqual(['b']);
		t.note('a');
		expect(t.list(60).agents.map((x) => x.name)).toEqual(['a', 'b']);
		for (let i = 0; i < 40; i++) {
			now += 1;
			t.note(`agent-${i}`);
		}
		const all = t.list(3600).agents;
		expect(all).toHaveLength(AGENT_PRESENCE_MAX);
		expect(all[0]!.name).toBe('agent-39');
		expect(all.some((x) => x.name === 'a')).toBe(false);
	});

	it('ignores requests without the agent header', () => {
		const t = new AgentPresenceTracker(() => 0);
		t.noteRequest({ headers: {}, query: {} } as never);
		t.noteRequest({ headers: { 'x-jasper-agent': '' }, query: {} } as never);
		expect(t.list().agents).toEqual([]);
		t.noteRequest({ headers: { 'x-jasper-agent': 'cursor' }, query: {} } as never);
		expect(t.list().agents.map((x) => x.name)).toEqual(['cursor']);
	});
});
