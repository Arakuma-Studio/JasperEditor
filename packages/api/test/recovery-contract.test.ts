import { describe, expect, it } from 'vitest';
import { type RecoveryInfo, RecoveryListResponseSchema } from '../src/projects.ts';

describe('recovery list contract', () => {
	it('retains unreadable-journal warnings alongside healthy recovery candidates', () => {
		const candidate: RecoveryInfo = {
			sessionId: 'healthy',
			projectId: 'project',
			projectName: 'Interview',
			baseRevision: 1,
			revision: 2,
			startedAt: '2026-10-11T12:00:00Z',
			savedAt: '2026-10-11T12:05:00Z',
			changes: ['Trim clip'],
			changeCount: 1,
			sizeBytes: 100,
			projectRevision: 1,
		};
		const response = {
			candidates: [candidate],
			warnings: [{ sessionId: 'damaged', code: 'INVALID_RECOVERY', message: 'Journal cannot be read' }],
		};
		expect(RecoveryListResponseSchema.parse(response)).toEqual(response);
		expect(RecoveryListResponseSchema.parse({ candidates: [candidate] })).toEqual({
			candidates: [candidate],
			warnings: [],
		});
	});
});
