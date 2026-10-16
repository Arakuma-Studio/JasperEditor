// Proposal store (spec 12 §2.5, P3-R2): persistence, atomic writes, the 50-per-project limit and eviction, 30-day
// expiry, corrupt files moved aside, and deletion with the project.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appdirPaths } from '@jasper/config';
import type { Proposal } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { ProposalStore } from '../src/proposals/store.ts';
import { tempAppdir } from './helpers.ts';

const PID = 'prj_000000000000000P';
let n = 0;
function proposal(over: Partial<Proposal> = {}): Proposal {
	const id = `prp_${String(++n).padStart(16, '0')}`;
	return {
		version: 1,
		id,
		projectId: PID,
		sequenceId: null,
		feature: 'sound-design',
		title: `P${n}`,
		summary: '',
		author: { agent: 'a' },
		createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
		updatedAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
		baseRevision: 0,
		docHash: '0',
		items: [
			{
				id: 'a',
				label: 'A',
				group: '',
				commands: [{ type: 'marker.add', frame: 1 }],
				requires: [],
				state: 'pending',
			},
		],
		...over,
	};
}

function setup(opts: { now?: () => Date; max?: number; inUse?: (pid: string, id: string) => boolean } = {}) {
	const appdir = tempAppdir('jasper-proposals-');
	const paths = appdirPaths(appdir);
	mkdirSync(join(paths.projectFile(PID), '..'), { recursive: true });
	writeFileSync(paths.projectFile(PID), '{}');
	const removed: [string, string][] = [];
	const logs: string[] = [];
	const store = new ProposalStore({
		paths,
		now: opts.now ?? (() => new Date('2026-10-02T00:00:00.000Z')),
		log: (m) => logs.push(m),
		...(opts.max ? { maxPerProject: opts.max } : {}),
		...(opts.inUse ? { inUse: opts.inUse } : {}),
		onRemoved: (_pid, p, why) => removed.push([p.id, why]),
	});
	return { store, paths, dir: paths.projectProposalsDir(PID), removed, logs };
}

describe('ProposalStore', () => {
	it('round-trips proposals atomically (no temporary files left), newest first', async () => {
		const { store, dir } = setup();
		const a = proposal();
		const b = proposal();
		await store.create(PID, a);
		await store.create(PID, b);
		expect(await store.get(PID, a.id)).toEqual(a);
		expect((await store.list(PID)).proposals.map((p) => p.id)).toEqual([b.id, a.id]);
		expect(readdirSync(dir).sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
		const changed = { ...a, title: 'Renamed' };
		await store.put(PID, changed);
		expect((await store.get(PID, a.id))!.title).toBe('Renamed');
		expect(JSON.parse(readFileSync(join(dir, `${a.id}.json`), 'utf8')).title).toBe('Renamed');
		expect(await store.delete(PID, a.id)).toBe(true);
		expect(await store.delete(PID, a.id)).toBe(false);
		expect(await store.get(PID, a.id)).toBeNull();
		await expect(store.put(PID, changed)).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND', status: 404 });
		// ids are checked before any path is built
		await expect(store.get(PID, '../../etc/passwd')).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' });
	});

	it('refuses to create a proposal for a project that does not exist (never creates its folder)', async () => {
		const { store, paths } = setup();
		const other = 'prj_00000000000000QQ';
		await expect(store.create(other, { ...proposal(), projectId: other })).rejects.toMatchObject({
			code: 'PROJECT_NOT_FOUND',
		});
		expect(() => readdirSync(paths.projectDir(other))).toThrow();
		expect((await store.list(other)).proposals).toEqual([]);
	});

	it('evicts the oldest decided proposals at the limit and refuses (E_PROPOSAL_LIMIT) when all are undecided', async () => {
		const { store, removed } = setup({ max: 3 });
		const decidedOld = proposal({
			items: [{ ...proposal().items[0]!, state: 'rejected' }],
			updatedAt: '2026-10-01T00:00:01.000Z',
		});
		const decidedNew = proposal({
			items: [{ ...proposal().items[0]!, state: 'accepted' }],
			updatedAt: '2026-10-01T00:00:05.000Z',
		});
		const pending = proposal();
		for (const p of [decidedNew, pending, decidedOld]) await store.create(PID, p);
		const fourth = proposal();
		expect(await store.create(PID, fourth)).toEqual({ evicted: [decidedOld.id] });
		expect(removed).toEqual([[decidedOld.id, 'evicted']]);
		const fifth = proposal();
		expect(await store.create(PID, fifth)).toEqual({ evicted: [decidedNew.id] });
		// now all three are pending: refused, nothing evicted
		await expect(store.create(PID, proposal())).rejects.toMatchObject({
			status: 409,
			code: 'PROPOSAL_LIMIT',
			detail: { code: 'E_PROPOSAL_LIMIT', limit: 3, undecided: 3 },
		});
		expect((await store.list(PID)).proposals.map((p) => p.id).sort()).toEqual(
			[pending.id, fourth.id, fifth.id].sort(),
		);
	});

	it('expires proposals 30 days after their last change', async () => {
		let now = new Date('2026-10-02T00:00:00.000Z');
		const { store, removed, dir } = setup({ now: () => now });
		const old = proposal({ updatedAt: '2026-10-01T00:00:00.000Z' });
		const recent = proposal({ updatedAt: '2026-10-20T00:00:00.000Z' });
		await store.create(PID, old);
		await store.create(PID, recent);
		expect(store.expiresAt(old)).toBe('2026-10-31T00:00:00.000Z');
		now = new Date('2026-10-31T00:00:00.001Z');
		expect((await store.list(PID)).proposals.map((p) => p.id)).toEqual([recent.id]);
		expect(removed).toEqual([[old.id, 'expired']]);
		expect(readdirSync(dir)).toEqual([`${recent.id}.json`]);
		now = new Date('2026-11-20T00:00:00.000Z');
		expect(await store.get(PID, recent.id)).toBeNull();
	});

	it('never expires or evicts a proposal an accept or decision is working on (it does for that caller)', async () => {
		let now = new Date('2026-10-02T00:00:00.000Z');
		const busy = new Set<string>();
		const { store, removed } = setup({ now: () => now, max: 2, inUse: (_pid, id) => busy.has(id) });
		const decided = (p: Proposal): Proposal => ({
			...p,
			items: p.items.map((i) => ({ ...i, state: 'rejected' as const })),
		});
		const old = decided(proposal({ updatedAt: '2026-10-01T00:00:00.000Z' }));
		const other = decided(proposal({ updatedAt: '2026-10-01T00:00:01.000Z' }));
		await store.create(PID, old);
		await store.create(PID, other);
		busy.add(old.id);
		// over the limit: the busy one is skipped, the next decided one goes
		expect(await store.create(PID, proposal())).toEqual({ evicted: [other.id] });
		// past its expiry: a list or another reader keeps it while busy; the lock holder sees it expired
		now = new Date('2026-11-15T00:00:00.000Z');
		expect((await store.list(PID)).proposals.map((p) => p.id)).toContain(old.id);
		expect(await store.get(PID, old.id)).not.toBeNull();
		expect(await store.get(PID, old.id, { owner: true })).toBeNull();
		expect(removed.at(-1)).toEqual([old.id, 'expired']);
		busy.delete(old.id);
	});

	it('moves unreadable files aside with a warning and never throws', async () => {
		const { store, dir, logs } = setup();
		const good = proposal();
		await store.create(PID, good);
		const bad = proposal();
		const mismatched = proposal();
		const wrongSchema = proposal();
		writeFileSync(join(dir, `${bad.id}.json`), '{"version": 1, "id": ');
		writeFileSync(join(dir, `${mismatched.id}.json`), JSON.stringify({ ...mismatched, id: good.id }));
		writeFileSync(join(dir, `${wrongSchema.id}.json`), JSON.stringify({ ...wrongSchema, items: 'nope' }));
		writeFileSync(join(dir, 'notes.txt'), 'ignored');
		writeFileSync(join(dir, '__proto__.json'), '{}');
		const r = await store.list(PID);
		expect(r.proposals.map((p) => p.id)).toEqual([good.id]);
		expect(r.warnings).toHaveLength(3);
		expect(logs).toHaveLength(3);
		const names = readdirSync(dir);
		for (const p of [bad, mismatched, wrongSchema])
			expect(names.some((x) => x.startsWith(`${p.id}.json.corrupt-`))).toBe(true);
		expect(await store.get(PID, bad.id)).toBeNull();
		// a second listing is clean
		expect((await store.list(PID)).warnings).toEqual([]);
	});

	it('serializes concurrent writers per project (no lost proposal, limit respected)', async () => {
		const { store } = setup({ max: 5 });
		const all = Array.from({ length: 8 }, () => proposal());
		const out = await Promise.allSettled(all.map((p) => store.create(PID, p)));
		expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(5);
		expect(out.filter((o) => o.status === 'rejected')).toHaveLength(3);
		expect((await store.list(PID)).proposals).toHaveLength(5);
	});
});
