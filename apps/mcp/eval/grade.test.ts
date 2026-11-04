import { describe, expect, it } from 'vitest';
import {
	type Checks,
	casePasses,
	compareToBaseline,
	grade,
	needsThirdSample,
	type SampleRecord,
} from './grade.ts';

const sample = (over: Partial<SampleRecord> = {}): SampleRecord => ({
	calls: [
		{ tool: 'get_timeline', args: { projectId: 'p' }, isError: false },
		{
			tool: 'add_clip',
			args: { projectId: 'p', media: 'med_1', at: '3s' },
			isError: true,
			errorCode: 'E_OVERLAP',
		},
		{ tool: 'grade_clip', args: { basic: { exposure: 0.5 } }, isError: false, viaCallTool: true },
	],
	shell: ['ls -la', 'ffmpeg -i a.mp4 b.wav'],
	reply: 'Added the clip at 3 s.',
	...over,
});

const failures = (checks: Checks, over?: Partial<SampleRecord>) => grade(sample(over), checks).failures;

describe('call argument matching', () => {
	it('matches nested keys, regex strings and array members', () => {
		const recorded = sample({
			calls: [
				{
					tool: 'match',
					args: { nested: { b: 1, c: 2 }, text: 'hello', items: [{ x: 1 }, { x: 2 }], a: 1 },
					isError: false,
				},
			],
		});
		expect(
			grade(recorded, {
				calls: [
					{ tool: 'match', args: { nested: { b: 1 } } },
					{ tool: 'match', args: { text: '/^HEL/' } },
					{ tool: 'match', args: { items: [{ x: 2 }] } },
				],
			}).pass,
		).toBe(true);
		expect(
			grade(recorded, {
				calls: [
					{ tool: 'match', args: { a: 2 } },
					{ tool: 'match', args: { missing: 1 } },
				],
			}).failures,
		).toHaveLength(2);
	});
});

describe('grade', () => {
	it('checks calls with partial arguments, alternatives included', () => {
		expect(failures({ calls: [{ tool: 'add_clip', args: { at: '3s' } }] })).toEqual([]);
		expect(failures({ calls: [{ tool: ['nope', 'grade_clip'] }] })).toEqual([]);
		expect(failures({ calls: [{ tool: 'add_clip', args: { at: 9 } }] })[0]).toMatch(/missing call/);
	});
	it('counts a call_tool run as the tool it ran', () => {
		expect(failures({ mustNotCall: [{ tool: 'grade_clip' }] })[0]).toMatch(/forbidden call/);
	});
	it('checks order, totals and per-tool caps', () => {
		expect(failures({ order: ['get_timeline', 'add_clip'] })).toEqual([]);
		expect(failures({ order: ['add_clip', 'get_timeline'] })[0]).toMatch(/expected/);
		expect(failures({ order: ['never_called'] })[0]).toMatch(/never called/);
		expect(failures({ maxCalls: 2 })[0]).toMatch(/3 tool calls/);
		expect(failures({ maxCallsOf: { add_clip: 0 } })[0]).toMatch(/add_clip called 1/);
	});
	it('counts only what went through for maxAppliedOf', () => {
		const calls = [
			{ tool: 'apply_commands', args: { dryRun: true }, isError: false },
			{ tool: 'apply_commands', args: {}, isError: true, errorCode: 'E_SCHEMA' },
			{ tool: 'apply_commands', args: {}, isError: false },
		];
		expect(failures({ maxAppliedOf: { apply_commands: 1 } }, { calls })).toEqual([]);
		expect(failures({ maxAppliedOf: { apply_commands: 0 } }, { calls })[0]).toMatch(/applied 1 times/);
	});
	it('checks the last call', () => {
		expect(failures({ endsAfter: 'grade_clip' })).toEqual([]);
		expect(failures({ endsAfter: ['add_clip'] })[0]).toMatch(/last call grade_clip/);
		expect(failures({ endsAfter: 'x' }, { calls: [] })[0]).toMatch(/\(none\)/);
	});
	it('checks refusals by code or any', () => {
		expect(failures({ noErrors: ['E_OVERLAP'] })[0]).toMatch(/add_clip refused/);
		expect(failures({ noErrors: ['*'] })).toHaveLength(1);
		expect(failures({ noErrors: ['E_OTHER'] })).toEqual([]);
	});
	it('checks shell and reply patterns', () => {
		expect(failures({ shellMustNot: ['\\bffmpeg\\b'] })[0]).toMatch(/ffmpeg -i/);
		expect(failures({ replyMust: ['3 s'] })).toEqual([]);
		expect(failures({ replyMust: ['exported'] })[0]).toMatch(/lacks/);
		expect(failures({ replyMustNot: ['added'] })[0]).toMatch(/reply has/);
	});
	it('flags a sample that hit an unmodelled engine call as invalid, not failed', () => {
		const r = grade(
			sample({ calls: [{ tool: 'x', args: {}, isError: true, unmodelled: ['fooRoute'] }] }),
			{},
		);
		expect(r.pass).toBe(true);
		expect(r.invalid).toMatch(/fooRoute/);
	});
});

describe('sampling', () => {
	it('takes a third sample only on disagreement', () => {
		expect(needsThirdSample([true, false])).toBe(true);
		expect(needsThirdSample([true, true])).toBe(false);
		expect(needsThirdSample([false, true, true])).toBe(false);
	});
	it('fails a case when half or more of its samples fail', () => {
		expect(casePasses([true, true])).toBe(true);
		expect(casePasses([true, false])).toBe(false);
		expect(casePasses([true, true, false])).toBe(true);
		expect(casePasses([true, false, false])).toBe(false);
		expect(casePasses([])).toBe(false);
	});
});

describe('compareToBaseline', () => {
	const row = (caseId: string, pass: boolean) => ({ caseId, pass });
	it('lists only cases that passed every baseline sample and now fail, and cases now fixed', () => {
		const baseline = [
			row('a', true),
			row('a', true),
			row('b', false),
			row('b', false),
			row('c', true),
			row('c', false),
		];
		const current = [
			row('a', false),
			row('a', false),
			row('b', true),
			row('b', true),
			row('c', false),
			row('c', false),
			row('new', false),
		];
		expect(compareToBaseline(baseline, current)).toEqual({ regressions: ['a'], fixed: ['b'] });
	});
});
