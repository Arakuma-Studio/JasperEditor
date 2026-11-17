// A lease the engine forgot (expiry while the tab was throttled, an engine restart) is re-acquired by the next
// heartbeat; a headless agent write may have landed in the gap. The window checks the revision on disk then: clean,
// it takes the newer document; with unsaved changes, it shows the conflict at once with what each choice discards.
import {
	applyTransaction,
	createCounterIdSource,
	defaultRegistries,
	loadProject,
	makeEnvelope,
} from '@jasper/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPersistence, type ChangeSet, EditorSession, EngineProjectStore } from '../../src/index.ts';
import { FakeEngine } from './fake-engine.ts';

const NOW = () => '2026-09-30T10:00:00.000Z';
const ctx = () => ({ ids: createCounterIdSource(1), now: NOW, registries: defaultRegistries() });
const solid = (at: number) => ({
	type: 'clip.addSolid' as const,
	at,
	duration: 30,
	track: 'V1',
	color: [1, 0, 0, 1] as [number, number, number, number],
});
const noLifecycle = { window: null, document: null } as const;
/** What one `clip.addSolid` adds: the clip and its solid item. */
const oneSolid = { clips: { added: 1, changed: 0, removed: 0 }, media: { added: 1, changed: 0, removed: 0 } };
const autoSaveOff = () => ({ enabled: false });

/** Like the engine's headless transaction: applies on the stored project and saves the next revision, unleased only. */
function headlessEdit(engine: FakeEngine, projectId: string, label: string, at: number) {
	if (engine.leases.has(projectId))
		throw new Error('an editor holds the lease: the engine refuses headless writes');
	const p = engine.projects.get(projectId)!;
	const { document: doc } = loadProject(p.envelope, { ids: createCounterIdSource(7000) });
	const { document, result } = applyTransaction(
		doc,
		{ label, origin: { agent: 'bot' }, commands: [solid(at)] },
		{ ids: createCounterIdSource(8000), now: NOW, revision: p.revision, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error('headless edit refused');
	p.revision = result.revision;
	p.envelope = makeEnvelope(document, { revision: p.revision, savedAt: NOW(), platform: 'engine-headless' });
	return { revision: p.revision, clipId: result.created.find((id) => id.startsWith('clp_'))! };
}

const clipsOf = (s: EditorSession) => Object.keys(Object.values(s.getCommitted().sequences)[0]!.clips);
const storedClips = (engine: FakeEngine, projectId: string) =>
	Object.keys(
		Object.values(
			(engine.projects.get(projectId)!.envelope.document as { sequences: Record<string, { clips: object }> })
				.sequences,
		)[0]!.clips,
	);

/** The two ways the project goes unleased under an open window. */
const gaps = {
	'the lease expired while the tab was throttled': (engine: FakeEngine, projectId: string) => {
		engine.leases.delete(projectId);
	},
	'the engine restarted': (engine: FakeEngine) => {
		engine.leases.clear(); // in-memory leases are gone
		engine.failures.push({ match: /heartbeat/, status: 0, network: true }); // down at the first heartbeat
	},
};

describe('re-acquiring a lapsed lease checks the revision on disk (S01:PER-040, PER-025)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	async function setup(opts: { autoSave?: boolean } = {}) {
		const engine = new FakeEngine();
		const projectId = engine.seed('Film');
		const pending = EditorSession.open({
			store: new EngineProjectStore(engine.client()),
			projectId,
			ctx: ctx(),
			sessionId: 'a',
		});
		await vi.advanceTimersByTimeAsync(0);
		const session = await pending;
		const updated: { revision: number; incoming: ChangeSet }[] = [];
		const conflicts: number[] = [];
		const p = attachPersistence(session, {
			...noLifecycle,
			...(opts.autoSave === false ? { policy: autoSaveOff } : {}),
			onUpdated: (e) => updated.push(e),
			onConflict: (r) => conflicts.push(r),
		});
		const puts = () =>
			engine.requests.filter((r) => r.method === 'PUT' && r.path === `/api/projects/${projectId}`);
		/** Lets heartbeats run past the gap (the second one re-acquires after a restart's failed one). */
		const reacquire = async () => {
			await vi.advanceTimersByTimeAsync(20_000);
			await p.idle();
		};
		return { engine, projectId, session, p, updated, conflicts, puts, reacquire };
	}

	for (const [gap, open] of Object.entries(gaps)) {
		describe(gap, () => {
			it('a window with nothing unsaved takes the newer revision, keeping the selection', async () => {
				const { engine, projectId, session, p, updated, puts, reacquire } = await setup();
				const own = session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
				await vi.advanceTimersByTimeAsync(1600);
				expect(session.getState().dirty).toBe(false);
				const ownClip = own.ok ? own.created.find((id) => id.startsWith('clp_'))! : '';
				session.select('timeline', [ownClip]);

				open(engine, projectId);
				const agent = headlessEdit(engine, projectId, 'Agent: Add title', 100);
				p.noteExternalChange({ revision: agent.revision, label: 'Agent: Add title' }); // engine event stream
				await reacquire();

				expect(engine.leases.get(projectId)?.sessionId).toBe('a');
				expect(clipsOf(session)).toEqual(expect.arrayContaining([ownClip, agent.clipId]));
				expect(session.getState()).toMatchObject({ dirty: false, revision: agent.revision });
				expect(session.getState().selection.timeline.clips).toEqual([ownClip]);
				expect(session.getState().history.canUndo).toBe(false); // undo would put the agent's change back out
				expect(updated).toEqual([
					{
						revision: agent.revision,
						incoming: { labels: ['Agent: Add title'], summary: oneSolid },
					},
				]);
				expect(p.autosaver.getStatus().conflict).toBeNull();

				// The next edit saves over the agent's revision instead of hitting a 409.
				session.apply({ label: 'Add', origin: 'user', commands: [solid(200)] });
				await vi.advanceTimersByTimeAsync(1600);
				expect(puts().at(-1)!.headers['if-match']).toBe(String(agent.revision));
				expect(p.autosaver.getStatus().conflict).toBeNull();
				expect(storedClips(engine, projectId)).toEqual(expect.arrayContaining([ownClip, agent.clipId]));
				await p.dispose();
				await session.close();
			});

			it('a window with unsaved changes shows the conflict at once, listing both sides, and loses nothing', async () => {
				const { engine, projectId, session, p, conflicts, puts, reacquire } = await setup({
					autoSave: false,
				});
				const own = session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
				const ownClip = own.ok ? own.created.find((id) => id.startsWith('clp_'))! : '';
				await vi.advanceTimersByTimeAsync(1100); // journalled

				open(engine, projectId);
				const agent = headlessEdit(engine, projectId, 'Agent: Add title', 100);
				p.noteExternalChange({ revision: agent.revision, label: 'Agent: Add title' });
				await reacquire();

				// No save attempted: the conflict comes from the check, not from a 409.
				expect(puts()).toHaveLength(0);
				expect(conflicts).toEqual([agent.revision]);
				expect(p.autosaver.getStatus()).toMatchObject({
					paused: 'conflict',
					conflict: {
						serverRevision: agent.revision,
						details: {
							serverRevision: agent.revision,
							source: 'lease',
							incoming: { labels: ['Agent: Add title'], summary: oneSolid },
							local: { labels: ['Add'], summary: oneSolid },
						},
					},
				});
				// Nothing is lost: the window keeps its edit (journalled), the project keeps the agent's.
				expect(clipsOf(session)).toEqual([ownClip]);
				expect(session.getState().dirty).toBe(true);
				expect(storedClips(engine, projectId)).toEqual([agent.clipId]);
				expect(engine.journals.get(`${projectId}/a`)).toMatchObject({ changes: ['Add'] });
				await p.flush();
				expect(puts()).toHaveLength(0);
				expect(
					session.apply({ label: 'Add', origin: { agent: 'bot' }, commands: [solid(300)] }),
				).toMatchObject({
					ok: false,
					errors: [{ code: 'E_SAVE_CONFLICT' }],
				});

				// Overwrite saves over exactly the revision whose changes were listed.
				await p.autosaver.overwrite();
				expect(puts().at(-1)!.headers['if-match']).toBe(String(agent.revision));
				expect(storedClips(engine, projectId)).toEqual([ownClip]);
				await p.dispose();
				await session.close();
			});
		});
	}

	it('a 409 from autosave says what Overwrite and Reload would discard', async () => {
		const { engine, projectId, session, p } = await setup();
		session.apply({ label: 'Add', origin: 'user', commands: [solid(0)] });
		// Saved from somewhere else while this window holds the lease (a PUT is not lease-checked).
		const lease = engine.leases.get(projectId)!;
		engine.leases.delete(projectId);
		const agent = headlessEdit(engine, projectId, 'Agent: Add title', 100);
		engine.leases.set(projectId, lease);
		await vi.advanceTimersByTimeAsync(1600);
		await p.idle();
		expect(p.autosaver.getStatus().conflict).toMatchObject({
			serverRevision: agent.revision,
			details: {
				source: 'save',
				incoming: { summary: oneSolid },
				local: { labels: ['Add'], summary: oneSolid },
			},
		});
		// Edits still made here join what Reload would discard.
		session.apply({ label: 'Add', origin: 'user', commands: [solid(300)] });
		expect(p.autosaver.getStatus().conflict?.details?.local).toEqual({
			labels: ['Add', 'Add'],
			summary: { clips: { added: 2, changed: 0, removed: 0 }, media: { added: 2, changed: 0, removed: 0 } },
		});
		await p.dispose();
		await session.close();
	});
});
