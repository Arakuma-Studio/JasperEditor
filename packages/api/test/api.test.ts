import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildPath, EVENT_PAYLOADS, isEnginePath, parseEvent, ROUTES } from '../src/index.ts';

describe('@jasper/api route table', () => {
	it('builds paths and classifies engine prefixes', () => {
		expect(buildPath(ROUTES.leaseHeartbeat.path, { projectId: 'prj_1', leaseId: 'l 1' })).toBe(
			'/api/projects/prj_1/lease/l%201/heartbeat',
		);
		expect(() => buildPath(ROUTES.projectGet.path)).toThrow();
		expect(isEnginePath('/api/projects')).toBe(true);
		expect(isEnginePath('/media/mk_1/poster.jpg')).toBe(true);
		expect(isEnginePath('/health')).toBe(true);
		expect(isEnginePath('/project/prj_1')).toBe(false);
		expect(isEnginePath('/apis')).toBe(false);
	});
});

describe('@jasper/api schemas', () => {
	it('parses events and ignores unknown types', () => {
		const e = parseEvent({
			id: 3,
			type: 'derivative.ready',
			createdAt: 'now',
			payload: { mediaKey: 'mk_12345678', kind: 'poster', url: '/media/mk_12345678/poster.jpg' },
		});
		expect(e?.type).toBe('derivative.ready');
		expect(parseEvent({ id: 4, type: 'future.thing', createdAt: 'now', payload: {} })).toBeNull();
		expect(parseEvent({ id: 'x' })).toBeNull();
	});
});

it('ignores unknown event names, including inherited object properties', () => {
	const unknownType = fc.oneof(
		fc.constantFrom(...Object.getOwnPropertyNames(Object.prototype)),
		fc.string().filter((name) => !Object.hasOwn(EVENT_PAYLOADS, name)),
	);
	fc.assert(
		fc.property(unknownType, fc.jsonValue(), (type, payload) => {
			expect(parseEvent({ id: 1, type, createdAt: 'now', payload })).toBeNull();
		}),
		{ seed: 0x5eed, numRuns: 100 },
	);
});
