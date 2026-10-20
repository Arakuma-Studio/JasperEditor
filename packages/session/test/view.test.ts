import { createCounterIdSource, defaultRegistries } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EditorSession, EngineProjectStore } from '../src/index.ts';
import { readProjectView } from '../src/view.ts';
import { FakeEngine } from './persistence/fake-engine.ts';

describe('persisted view validation', () => {
	it('opens projects with malformed saved view settings and reports the reset', async () => {
		const engine = new FakeEngine();
		const projectId = engine.seed();
		engine.projects.get(projectId)!.view = { version: 1, tabs: null, views: { seq: null } };
		const session = await EditorSession.open({
			projectId,
			store: new EngineProjectStore(engine.client()),
			ctx: {
				ids: createCounterIdSource(1),
				now: () => '2026-10-11T00:00:00.000Z',
				registries: defaultRegistries(),
			},
		});
		expect(session.getState().openIssues).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'W_REPAIRED' })]),
		);
		expect(session.getState().dirty).toBe(false);
		await session.close();
	});

	it('keeps partial saved views and negative horizontal padding', () => {
		const view = {
			version: 1,
			views: { seq: { scrollFrame: -5, pxPerFrame: 3 } },
			tabs: { open: ['seq'] },
			activeSequenceId: 'seq',
		};
		expect(readProjectView(view)).toEqual({ view, issues: [] });
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid timeline zoom %s', (pxPerFrame) => {
		const result = readProjectView({
			version: 1,
			views: { seq: { pxPerFrame } },
			tabs: { open: ['seq'] },
			activeSequenceId: 'seq',
		});
		expect(result.view).toBeNull();
		expect(result.issues[0]?.code).toBe('W_REPAIRED');
	});

	it('never throws on arbitrary JSON view records', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				expect(() => readProjectView(value)).not.toThrow();
			}),
			{ numRuns: 200 },
		);
	});
});
