import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	defaultEffectRegistry,
	findUnknownKeys,
	runAgentQuery,
	suggestKey,
	unknownCommandKeyIssues,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

describe('unknown keys in agent commands', () => {
	it('flags top-level and nested unknown keys with the accepted keys', () => {
		const issues = unknownCommandKeyIssues([
			{ type: 'marker.add', frame: 1, nmae: 'x' },
			{ type: 'clip.update', clipIds: ['clp_1'], patch: { enabeld: false } },
			{ type: 'not.a.command', whatever: 1 },
		]);
		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ commandIndex: 0, code: 'E_SCHEMA' });
		expect(issues[0]!.message).toContain('nmae');
		expect(issues[0]!.message).toContain('name');
		expect(issues[1]).toMatchObject({ commandIndex: 1, code: 'E_SCHEMA', path: ['patch'] });
		expect(issues[1]!.message).toContain('enabeld');
		expect(issues[1]!.message).toContain('enabled');
	});

	it('passes valid commands', () => {
		expect(
			unknownCommandKeyIssues([
				{ type: 'marker.add', frame: 3, name: 'A' },
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'a' }, ref: '$t' },
			]),
		).toEqual([]);
	});

	it('walks unions, arrays and records; open records accept any key', () => {
		const s = z.object({
			r: z.union([z.object({ from: z.number(), to: z.number() }), z.literal('all')]),
			list: z.array(z.object({ a: z.number() })),
			bag: z.record(z.string(), z.number()),
		});
		expect(
			findUnknownKeys(s, { r: { from: 1, to: 2, by: 1 }, list: [{ a: 1, b: 2 }], bag: { x: 1 } }),
		).toEqual([
			{ path: 'r', keys: ['by'], accepted: ['from', 'to'] },
			{ path: 'list[0]', keys: ['b'], accepted: ['a'] },
		]);
		expect(suggestKey('clipID', ['clipId', 'trackId'])).toBe('clipId');
	});

	it('an unknown temp ref names the refs declared so far', () => {
		const h = new Harness();
		const r = h.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'a' }, ref: '$a' },
			{ type: 'clip.update', clipIds: ['$b'], patch: { enabled: false } },
		]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]!.code).toBe('E_NOT_FOUND');
		expect(r.errors[0]!.message).toContain('$b');
		expect(r.errors[0]!.message).toContain('$a');
	});
});

describe('clip.properties / param.get (value and evaluated)', () => {
	function setup() {
		const h = new Harness({ preset: 'hd-1080p-30' });
		const r = h.ok([
			{ type: 'clip.addText', ref: '$t', at: 30, duration: 60, track: 'V1', content: { text: 'Hi' } },
			{
				type: 'effect.add',
				target: { clipId: '$t' },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 6 },
				ref: '$fx',
			},
		]);
		const clipId = r.refs.$t!;
		const fxId = r.refs.$fx!;
		h.ok([
			{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { sequenceFrame: 30 }, value: 0 },
			{ type: 'keyframe.add', target: ['clip', clipId, 'opacity'], at: { sequenceFrame: 60 }, value: 100 },
		]);
		const env = { doc: h.doc, revision: h.revision, effects: defaultEffectRegistry };
		return { h, clipId, fxId, env };
	}

	it('lists every property with value, evaluated, keyframes in sequence frames and the param.set target', () => {
		const { clipId, fxId, env } = setup();
		const r = runAgentQuery(env, 'clip.properties', { clipId, frame: 45 }) as {
			frame: number;
			timecode: string;
			properties: {
				key: string;
				value: unknown;
				evaluated: unknown;
				animated: boolean;
				target: string[];
				keyframes?: { frame: number; timecode: string; value: unknown }[];
				rendered?: boolean;
			}[];
		};
		expect(r.frame).toBe(45);
		const op = r.properties.find((p) => p.key === 'opacity')!;
		expect(op.animated).toBe(true);
		expect(op.value).toBeCloseTo(50, 0);
		expect(op.evaluated).toBeCloseTo(50, 4);
		expect(op.keyframes?.map((k) => [k.frame, k.value])).toEqual([
			[30, 0],
			[60, 100],
		]);
		expect(op.keyframes?.[1]?.timecode).toBe('00:00:02:00');
		expect(op.target).toEqual(['clip', clipId, 'opacity']);
		const blur = r.properties.find((p) => p.key === `effects.${fxId}.radius`)!;
		expect(blur).toMatchObject({ value: 6, evaluated: 6, target: ['effect', fxId, 'radius'] });
		expect(blur.rendered).toBeUndefined();
		expect(r.properties.find((p) => p.key === 'transform.position')!.evaluated).toEqual([960, 540]);
	});

	it('reports bypassed effects and frames outside a clip', () => {
		const { h, clipId, fxId } = setup();
		h.ok([{ type: 'effect.setEnabled', effectInstanceId: fxId, enabled: false }]);
		const env = { doc: h.doc, revision: h.revision, effects: defaultEffectRegistry };
		const r = runAgentQuery(env, 'param.get', { target: ['effect', fxId, 'radius'], frame: 40 }) as {
			property: { value: unknown; rendered?: boolean; why?: string };
		};
		expect(r.property).toMatchObject({ value: 6, rendered: false });
		const out = runAgentQuery(env, 'clip.properties', { clipId, frame: 200, keys: ['opacity'] }) as {
			evaluatedAt: { frame: number; outside: boolean };
			properties: { value: unknown; rendered?: boolean; why?: string }[];
		};
		expect(out.evaluatedAt).toMatchObject({ frame: 89, outside: true });
		expect(out.properties[0]).toMatchObject({
			value: 100,
			rendered: false,
		});
	});

	it('accepts seconds and rejects unknown ids and property paths', () => {
		const { clipId, env } = setup();
		const a = runAgentQuery(env, 'param.get', {
			target: ['clip', clipId, 'opacity'],
			frame: { seconds: 1.5 },
		}) as {
			frame: number;
			property: { value: number };
		};
		expect(a.frame).toBe(45);
		expect(() => runAgentQuery(env, 'clip.properties', { clipId: 'clp_nope' })).toThrow(
			expect.objectContaining({ code: 'E_NOT_FOUND', message: expect.stringContaining('clp_nope') }),
		);
		expect(() => runAgentQuery(env, 'param.get', { target: ['clip', clipId, 'nope'] })).toThrow(
			expect.objectContaining({ code: 'E_NOT_FOUND', message: expect.stringContaining('nope') }),
		);
	});
});
