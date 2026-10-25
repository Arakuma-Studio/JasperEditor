// spec 13 SH-003 / AS-032: batch styling commands, batch effect edits and linked project text styles.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyStylePatch,
	type Clip,
	checkInvariants,
	createCounterIdSource,
	DEFAULT_TEXT_SHADOW,
	defaultEffectRegistry,
	defaultTextStyle,
	diffStyle,
	type EffectInstance,
	loadProject,
	makeEnvelope,
	repairDocument,
	sameValue,
	type TextStyle,
	TextStylePatchSchema,
	textStyleUsage,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }> & {
	styleId?: string;
	styleOverrides?: Record<string, unknown>;
};
const F30 = 23_520_000; // flicks per frame at 30 fps

function project(n = 3) {
	const h = new Harness();
	const cmds: unknown[] = [];
	for (let i = 0; i < n; i++)
		cmds.push({
			type: 'clip.addText',
			at: i * 40,
			duration: 30 + i * 10,
			track: 'V2',
			content: { text: `Word ${i}` },
			ref: `$t${i}`,
		});
	cmds.push({ type: 'clip.addSolid', at: 0, duration: 200, track: 'V1', color: [0, 0, 0, 1], ref: '$solid' });
	const r = h.ok(cmds);
	const ids = Array.from({ length: n }, (_, i) => r.refs[`$t${i}`]!);
	return { h, ids, solid: r.refs.$solid! };
}
const text = (h: Harness, id: string) => h.seq.clips[id] as TextClip;
const ok = (h: Harness) => expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
const err = (r: { ok: boolean; errors?: { code: string; message: string }[] }) =>
	r.ok ? null : r.errors![0]!;

describe('text.setStyle (SH-003)', () => {
	it('patches only the named fields of every clip, deep for shadow / background, in one transaction', () => {
		const { h, ids } = project();
		h.ok([
			{
				type: 'clip.update',
				clipId: ids[0],
				patch: {
					content: {
						style: {
							shadow: { color: [0.1, 0.1, 0.3, 0.8], angleDeg: 90, distancePx: 0, blurPx: 12 },
							fill: [1, 0, 0, 1],
						},
					},
				},
			},
		]);
		const before = h.revision;
		h.ok([
			{ type: 'text.setStyle', clipIds: ids, patch: { shadow: { blurPx: 4, spreadPx: 3 }, sizePx: 98 } },
		]);
		expect(h.revision).toBe(before + 1);
		const a = text(h, ids[0]!).content.style;
		expect(a.shadow).toEqual({
			color: [0.1, 0.1, 0.3, 0.8],
			angleDeg: 90,
			distancePx: 0,
			blurPx: 4,
			spreadPx: 3,
		});
		expect(a.fill).toEqual([1, 0, 0, 1]);
		expect(a.sizePx).toBe(98);
		// A clip without a shadow starts from the defaults.
		const b = text(h, ids[1]!).content.style;
		expect(b.shadow).toEqual({ ...DEFAULT_TEXT_SHADOW, blurPx: 4, spreadPx: 3 });
		expect(b.fill).toEqual([1, 1, 1, 1]);
		ok(h);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { shadow: null, background: { paddingPx: 8 } } }]);
		expect(text(h, ids[2]!).content.style.shadow).toBeNull();
		expect(text(h, ids[2]!).content.style.background).toEqual({
			color: [0, 0, 0, 0.6],
			paddingPx: 8,
			radiusPx: 0,
		});
		ok(h);
	});

	it('edits stroke lists per clip: set (adds a missing stroke), remove, add', () => {
		const { h, ids } = project(2);
		h.ok([
			{
				type: 'clip.update',
				clipId: ids[0],
				patch: {
					content: {
						style: {
							strokes: [
								{ color: [1, 0, 1, 1], widthPx: 10, position: 'outside' },
								{ color: [0, 0, 0, 1], widthPx: 20, position: 'outside' },
							],
						},
					},
				},
			},
		]);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { strokes: { set: [{ index: 0, widthPx: 12 }] } } }]);
		expect(text(h, ids[0]!).content.style.strokes.map((s) => s.widthPx)).toEqual([12, 20]);
		expect(text(h, ids[1]!).content.style.strokes).toEqual([
			{ color: [0, 0, 0, 1], widthPx: 12, position: 'outside' },
		]);
		h.ok([
			{
				type: 'text.setStyle',
				clipIds: ids,
				patch: { strokes: { remove: [1], add: [{ color: [1, 1, 0, 1], widthPx: 2, position: 'inside' }] } },
			},
		]);
		expect(text(h, ids[0]!).content.style.strokes.map((s) => s.widthPx)).toEqual([12, 2]);
		expect(text(h, ids[1]!).content.style.strokes.map((s) => s.widthPx)).toEqual([12, 2]);
		ok(h);
	});

	it('refuses non-text clips naming them, and applies nothing', () => {
		const { h, ids, solid } = project();
		const doc = h.doc;
		const r = h.tx([{ type: 'text.setStyle', clipIds: [...ids, solid], patch: { sizePx: 50 } }]);
		expect(err(r)?.code).toBe('E_INVALID_PARAM');
		expect(err(r)?.message).toContain(`${solid} (solid)`);
		expect(h.doc).toBe(doc);
	});

	it('refuses unknown fields, too many strokes and a missing font', () => {
		const { h, ids } = project(1);
		expect(err(h.tx([{ type: 'text.setStyle', clipIds: ids, patch: { sizze: 3 } }]))?.code).toBe('E_SCHEMA');
		const many = Array.from({ length: 10 }, () => ({ color: [0, 0, 0, 1], widthPx: 1, position: 'outside' }));
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { strokes: many } }]);
		expect(
			err(h.tx([{ type: 'text.setStyle', clipIds: ids, patch: { strokes: { add: many } } }]))?.code,
		).toBe('E_LIMIT');
		expect(
			err(h.tx([{ type: 'text.setStyle', clipIds: ids, patch: { fontId: 'fnt_0000000000000NOPE' } }]))?.code,
		).toBe('E_NOT_FOUND');
	});

	it('runs: clear-overridden removes the patched fields from styled runs', () => {
		const { h, ids } = project(1);
		h.ok([
			{
				type: 'clip.update',
				clipId: ids[0],
				patch: { content: { runs: [{ from: 0, to: 2, style: { sizePx: 40, italic: true } }] } },
			},
		]);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { sizePx: 70 } }]);
		expect(text(h, ids[0]!).content.runs).toEqual([{ from: 0, to: 2, style: { sizePx: 40, italic: true } }]);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { sizePx: 70 }, runs: 'clear-overridden' }]);
		expect(text(h, ids[0]!).content.runs).toEqual([{ from: 0, to: 2, style: { italic: true } }]);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { italic: false }, runs: 'clear-overridden' }]);
		expect(text(h, ids[0]!).content.runs).toBeUndefined();
		ok(h);
	});

	it('refuses a locked track and resolves $selection', () => {
		const { h, ids } = project(2);
		const r = h.tx([{ type: 'text.setStyle', clipIds: '$selection', patch: { allCaps: true } }], {
			ctx: { selection: { clips: ids, primaryClip: ids[0]! } },
		});
		expect(r.ok).toBe(true);
		expect(ids.every((id) => text(h, id).content.style.allCaps)).toBe(true);
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		expect(err(h.tx([{ type: 'text.setStyle', clipIds: ids, patch: { allCaps: false } }]))?.code).toBe(
			'E_TRACK_LOCKED',
		);
	});
});

describe('clip.update style merge (existing callers)', () => {
	it('merges a whole shadow object into the current one (fields it does not name survive)', () => {
		const { h, ids } = project(1);
		h.ok([{ type: 'text.setStyle', clipIds: ids, patch: { shadow: { spreadPx: 6 } } }]);
		h.ok([
			{
				type: 'clip.update',
				clipId: ids[0],
				patch: {
					content: { style: { shadow: { color: [0, 0, 0, 1], angleDeg: 0, distancePx: 2, blurPx: 1 } } },
				},
			},
		]);
		expect(text(h, ids[0]!).content.style.shadow).toEqual({
			color: [0, 0, 0, 1],
			angleDeg: 0,
			distancePx: 2,
			blurPx: 1,
			spreadPx: 6,
		});
		h.ok([{ type: 'clip.update', clipId: ids[0], patch: { content: { style: { shadow: null } } } }]);
		expect(text(h, ids[0]!).content.style.shadow).toBeNull();
	});
});

describe('style patch semantics (property tests)', () => {
	const rgba = fc.tuple(
		fc.double({ min: 0, max: 1, noNaN: true }),
		fc.double({ min: 0, max: 1, noNaN: true }),
		fc.double({ min: 0, max: 1, noNaN: true }),
		fc.double({ min: 0, max: 1, noNaN: true }),
	);
	const stroke = fc.record({
		color: rgba,
		widthPx: fc.integer({ min: 0, max: 50 }),
		position: fc.constantFrom('outside', 'center', 'inside'),
	});
	const style: fc.Arbitrary<TextStyle> = fc
		.record({
			sizePx: fc.integer({ min: 1, max: 400 }),
			weight: fc.constantFrom(400, 700),
			fill: rgba,
			strokes: fc.array(stroke, { maxLength: 4 }),
			shadow: fc.option(
				fc.record(
					{
						color: rgba,
						angleDeg: fc.integer({ min: -180, max: 180 }),
						distancePx: fc.integer({ min: 0, max: 40 }),
						blurPx: fc.integer({ min: 0, max: 40 }),
						spreadPx: fc.integer({ min: 0, max: 20 }),
					},
					{ requiredKeys: ['color', 'angleDeg', 'distancePx', 'blurPx'] },
				),
				{ nil: null },
			),
			background: fc.option(
				fc.record({
					color: rgba,
					paddingPx: fc.integer({ min: 0, max: 50 }),
					radiusPx: fc.integer({ min: 0, max: 50 }),
				}),
				{ nil: null },
			),
			kerning: fc.option(fc.constantFrom('metrics', 'optical'), { nil: undefined }),
			openType: fc.option(fc.record({ swash: fc.boolean(), titling: fc.boolean() }, { requiredKeys: [] }), {
				nil: undefined,
			}),
		})
		.map((p) => {
			const s = { ...defaultTextStyle('fnt_0000000000000001'), ...p } as Record<string, unknown>;
			for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
			return s as unknown as TextStyle;
		});

	it('diffStyle is the inverse of applyStylePatch: apply(a, diff(a, b)) = b', () => {
		fc.assert(
			fc.property(style, style, (a, b) => {
				expect(sameValue(applyStylePatch(a, diffStyle(a, b)), b)).toBe(true);
				expect(diffStyle(a, a)).toEqual({});
			}),
			{ numRuns: 300 },
		);
	});

	it('a patch changes only the fields it names; applying it twice changes nothing more', () => {
		const patch = fc.record(
			{
				sizePx: fc.integer({ min: 1, max: 400 }),
				shadow: fc.record({ blurPx: fc.integer({ min: 0, max: 40 }) }),
				strokes: fc.record({ set: fc.constant([{ index: 0, widthPx: 3 }]) }),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(style, patch, (a, p) => {
				expect(TextStylePatchSchema.safeParse(p).success).toBe(true);
				const once = applyStylePatch(a, p as never);
				expect(sameValue(applyStylePatch(once, p as never), once)).toBe(true);
				const changed = Object.keys(diffStyle(a, once));
				for (const k of changed) expect(Object.keys(p)).toContain(k);
				if (p.shadow && a.shadow) {
					const { blurPx: _x, ...rest } = once.shadow as Record<string, unknown>;
					const { blurPx: _y, ...was } = a.shadow as Record<string, unknown>;
					expect(rest).toEqual(was);
				}
			}),
			{ numRuns: 300 },
		);
	});
});

describe('linked project text styles (SH-002, AS-032)', () => {
	function linked() {
		const p = project(3);
		const { h, ids } = p;
		h.ok([{ type: 'text.setStyle', clipIds: [ids[0]], patch: { sizePx: 98, fill: [1, 1, 1, 1] } }]);
		const r = h.ok([
			{ type: 'textStyle.create', name: 'Pixel Pop', fromClipId: ids[0], ref: '$s' },
			{ type: 'textStyle.apply', styleId: '$s', clipIds: ids },
		]);
		return { ...p, styleId: r.refs.$s! };
	}

	it('create + apply link the clips with the style as their effective style', () => {
		const { h, ids, styleId } = linked();
		expect(styleId).toMatch(/^tsy_/);
		for (const id of ids) {
			expect(text(h, id).styleId).toBe(styleId);
			expect(text(h, id).styleOverrides).toBeUndefined();
			expect(text(h, id).content.style.sizePx).toBe(98);
		}
		expect(textStyleUsage(h.doc).get(styleId)).toEqual(ids);
		ok(h);
	});

	it('editing the style updates every linked clip in one step and keeps per-clip deviations', () => {
		const { h, ids, styleId } = linked();
		h.ok([{ type: 'text.setStyle', clipIds: [ids[1]], patch: { fill: [1, 0, 0, 1] } }]);
		expect(text(h, ids[1]!).styleOverrides).toEqual({ fill: [1, 0, 0, 1] });
		const before = h.revision;
		h.ok([
			{
				type: 'textStyle.update',
				styleId,
				patch: {
					sizePx: 120,
					fill: [0, 1, 0, 1],
					strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }],
				},
			},
		]);
		expect(h.revision).toBe(before + 1);
		expect(ids.map((id) => text(h, id).content.style.sizePx)).toEqual([120, 120, 120]);
		expect(text(h, ids[0]!).content.style.fill).toEqual([0, 1, 0, 1]);
		expect(text(h, ids[1]!).content.style.fill).toEqual([1, 0, 0, 1]);
		expect(text(h, ids[2]!).content.style.strokes[0]!.widthPx).toBe(11.5);
		expect(text(h, ids[1]!).styleOverrides).toEqual({ fill: [1, 0, 0, 1] });
		ok(h);
		// Reset to style drops the deviation; detach keeps the look and removes the link.
		h.ok([{ type: 'textStyle.reset', clipIds: [ids[1]] }]);
		expect(text(h, ids[1]!).content.style.fill).toEqual([0, 1, 0, 1]);
		expect(text(h, ids[1]!).styleOverrides).toBeUndefined();
		h.ok([{ type: 'textStyle.detach', clipIds: [ids[2]] }]);
		expect(text(h, ids[2]!).styleId).toBeUndefined();
		h.ok([{ type: 'textStyle.update', styleId, patch: { sizePx: 60 } }]);
		expect(text(h, ids[2]!).content.style.sizePx).toBe(120);
		expect(text(h, ids[0]!).content.style.sizePx).toBe(60);
		ok(h);
	});

	it('a deviation made by any command (clip.update, param.set) is recorded and survives style edits', () => {
		const { h, ids, styleId } = linked();
		h.ok([{ type: 'clip.update', clipId: ids[0], patch: { content: { style: { italic: true } } } }]);
		h.ok([{ type: 'param.set', target: ['clip', ids[1]!, 'text', 'trackingEm'], value: 25 }]);
		expect(text(h, ids[0]!).styleOverrides).toEqual({ italic: true });
		expect(text(h, ids[1]!).styleOverrides).toEqual({ trackingEm: 25 });
		h.ok([{ type: 'textStyle.update', styleId, patch: { italic: false, trackingEm: 0, weight: 700 } }]);
		expect(text(h, ids[0]!).content.style.italic).toBe(true);
		expect(text(h, ids[1]!).content.style.trackingEm).toBe(25);
		expect(ids.map((id) => text(h, id).content.style.weight)).toEqual([700, 700, 700]);
	});

	it('reset of chosen fields, rename with unique names, delete unlinks and keeps the look', () => {
		const { h, ids, styleId } = linked();
		h.ok([{ type: 'text.setStyle', clipIds: [ids[0]], patch: { italic: true, sizePx: 10 } }]);
		h.ok([{ type: 'textStyle.reset', clipIds: [ids[0]], fields: ['sizePx'] }]);
		expect(text(h, ids[0]!).content.style.sizePx).toBe(98);
		expect(text(h, ids[0]!).content.style.italic).toBe(true);
		h.ok([{ type: 'textStyle.create', name: 'Other' }]);
		expect(err(h.tx([{ type: 'textStyle.rename', styleId, name: ' other ' }]))?.code).toBe('E_INVALID_PARAM');
		expect(err(h.tx([{ type: 'textStyle.create', name: 'PIXEL POP' }]))?.code).toBe('E_INVALID_PARAM');
		h.ok([{ type: 'textStyle.rename', styleId, name: 'Pixel Pop 2025' }]);
		expect(h.doc.textStyles![styleId]!.name).toBe('Pixel Pop 2025');
		const r = h.ok([{ type: 'textStyle.delete', styleId }]);
		expect(r.results[0]).toEqual({ styleId, unlinked: 3 });
		expect(ids.every((id) => text(h, id).styleId === undefined)).toBe(true);
		expect(text(h, ids[1]!).content.style.sizePx).toBe(98);
		ok(h);
	});

	it('refuses apply to non-text clips, reset of unlinked clips and a missing style', () => {
		const { h, ids, solid, styleId } = linked();
		h.ok([{ type: 'textStyle.detach', clipIds: [ids[0]] }]);
		expect(err(h.tx([{ type: 'textStyle.apply', styleId, clipIds: [solid] }]))?.message).toContain(
			`${solid} (solid)`,
		);
		expect(err(h.tx([{ type: 'textStyle.reset', clipIds: [ids[0]] }]))?.message).toContain(ids[0]);
		expect(
			err(h.tx([{ type: 'textStyle.apply', styleId: 'tsy_0000000000000000', clipIds: ids }]))?.code,
		).toBe('E_NOT_FOUND');
		expect(err(h.tx([{ type: 'textStyle.apply', styleId, clipIds: ids, groupId: 'g' }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
	});

	it('linked clips on a locked track keep their look (warning) and record the deviation later', () => {
		const { h, ids, styleId } = linked();
		h.ok([{ type: 'track.update', trackId: 'V2', patch: { locked: true } }]);
		const r = h.ok([{ type: 'textStyle.update', styleId, patch: { sizePx: 20 } }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_CLIP_SKIPPED');
		expect(text(h, ids[0]!).content.style.sizePx).toBe(98);
		ok(h);
	});

	it('creates from a partial style over the defaults and redefines from a clip', () => {
		const { h, ids, styleId } = linked();
		const r = h.ok([
			{ type: 'textStyle.create', name: 'Big', style: { sizePx: 300, shadow: { blurPx: 2 } }, ref: '$b' },
		]);
		const big = h.doc.textStyles![r.refs.$b!]!;
		expect(big.style.sizePx).toBe(300);
		expect(big.style.shadow).toEqual({ ...DEFAULT_TEXT_SHADOW, blurPx: 2 });
		h.ok([
			{ type: 'clip.update', clipId: ids[2], patch: { content: { style: { allCaps: true, sizePx: 55 } } } },
		]);
		h.ok([{ type: 'textStyle.update', styleId, fromClipId: ids[2] }]);
		expect(ids.map((id) => text(h, id).content.style.sizePx)).toEqual([55, 55, 55]);
		expect(ids.every((id) => text(h, id).content.style.allCaps)).toBe(true);
		expect(ids.every((id) => text(h, id).styleOverrides === undefined)).toBe(true);
	});
});

describe('load: lenient reading, invariants and repair of text styles', () => {
	const roundTrip = (doc: unknown) =>
		loadProject(
			JSON.parse(JSON.stringify(makeEnvelope(doc as never, { revision: 1, savedAt: 'x', platform: 'test' }))),
			{
				ids: createCounterIdSource(900),
				effects: defaultEffectRegistry,
			},
		);

	it('a linked project round-trips unchanged', () => {
		const { h, ids } = project(2);
		h.ok([
			{ type: 'textStyle.create', name: 'S', fromClipId: ids[0], ref: '$s' },
			{ type: 'textStyle.apply', styleId: '$s', clipIds: ids },
			{ type: 'text.setStyle', clipIds: [ids[1]], patch: { sizePx: 12 } },
		]);
		const r = roundTrip(h.doc);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		expect(r.document.textStyles).toEqual(h.doc.textStyles);
		expect((r.document.sequences[h.seqId]!.clips[ids[1]!] as TextClip).styleOverrides).toEqual({
			sizePx: 12,
		});
	});

	it('repairs unreadable styles, malformed keys, dangling links and bad overrides; idempotent', () => {
		const { h, ids, solid } = project(3);
		h.ok([
			{ type: 'textStyle.create', name: 'S', fromClipId: ids[0], ref: '$s' },
			{ type: 'textStyle.apply', styleId: '$s', clipIds: ids },
		]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		const sid = Object.keys(doc.textStyles)[0]!;
		const seq = doc.sequences[h.seqId];
		doc.textStyles.broken = { ...doc.textStyles[sid], id: 'whatever', name: 'Moved' };
		doc.textStyles.tsy_00000000000000ZZ = { id: 'tsy_00000000000000ZZ', name: 'Bad', style: { sizePx: -1 } };
		seq.clips[ids[0]!].styleOverrides = 'nope';
		seq.clips[ids[1]!].styleId = 'tsy_0000000000000DEAD';
		seq.clips[solid].styleId = sid;
		seq.clips[ids[2]!].styleId = 'broken';
		expect(checkInvariants(doc, { effects: defaultEffectRegistry }).map((i) => i.invariant)).toContain(
			'INV-TEXTSTYLE',
		);
		const r = roundTrip(doc);
		expect(r.issues).toEqual([]);
		const actions = r.repairs.map((x) => x.action);
		expect(actions).toEqual(
			expect.arrayContaining(['fix-id', 'drop-text-style', 'fix-style-overrides', 'unlink-text-style']),
		);
		const out = r.document;
		const styles = Object.values(out.textStyles!);
		expect(styles.map((s) => s.name).sort()).toEqual(['Moved', 'S']);
		const moved = styles.find((s) => s.name === 'Moved')!;
		const clips = out.sequences[h.seqId]!.clips;
		expect((clips[ids[2]!] as TextClip).styleId).toBe(moved.id);
		expect((clips[ids[1]!] as TextClip).styleId).toBeUndefined();
		expect((clips[solid] as { styleId?: string }).styleId).toBeUndefined();
		expect((clips[ids[0]!] as TextClip).styleOverrides).toBeUndefined();
		const again = repairDocument(out, createCounterIdSource(950));
		expect(again.report).toEqual([]);
	});
});

describe('batch effects (SH-003)', () => {
	function withBlur() {
		const p = project(3);
		p.h.ok([
			{
				type: 'effect.addMany',
				clipIds: p.ids,
				effectId: 'jasper.gaussian-blur',
				params: { radius: 5 },
				keyframes: {},
			},
		]);
		return p;
	}
	const fxOf = (h: Harness, id: string, n = 0) =>
		(h.seq.clips[id] as { effects: EffectInstance[] }).effects.filter(
			(e) => e.effectId === 'jasper.gaussian-blur',
		)[n]!;

	it('addMany adds one instance per clip with keys timed from each clip In (and Out)', () => {
		const { h, ids } = project(3);
		const before = h.revision;
		const r = h.ok([
			{
				type: 'effect.addMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				keyframes: {
					radius: [
						{ offset: { frames: 0 }, value: 40 },
						{ offset: { frames: 6 }, value: 0 },
					],
				},
			},
		]);
		expect(h.revision).toBe(before + 1);
		expect((r.results[0] as { effectInstanceIds: string[] }).effectInstanceIds).toHaveLength(3);
		for (const id of ids)
			expect(fxOf(h, id).params.radius!.keyframes.map((k) => [k.time / F30, k.value])).toEqual([
				[0, 40],
				[6, 0],
			]);
		h.ok([
			{
				type: 'effect.addMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				anchor: 'out',
				keyframes: { radius: [{ offset: { frames: 0 }, value: 10 }] },
			},
		]);
		// Durations 30, 40, 50 → last frames 29, 39, 49.
		expect(ids.map((id) => fxOf(h, id, 1).params.radius!.keyframes[0]!.time / F30)).toEqual([29, 39, 49]);
		ok(h);
	});

	it('addMany refuses clips that do not take the effect, naming them', () => {
		const { h, ids } = project(1);
		const m = h.registerVideo({ seconds: 4 });
		const placed = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 300, tracks: { video: 'V1', audio: 'A1' } },
		]);
		const audio = (placed.results[0] as { clipIds: string[] }).clipIds.find(
			(id) => h.seq.clips[id]!.kind === 'audio',
		)!;
		const r = h.tx([{ type: 'effect.addMany', clipIds: [...ids, audio], effectId: 'jasper.gaussian-blur' }]);
		expect(err(r)?.code).toBe('E_INVALID_PARAM');
		expect(err(r)?.message).toContain(`${audio} (audio)`);
	});

	it('setParamMany: value, delta, per-target values, keys relative to each In, stopwatch, keyframes', () => {
		const { h, ids } = withBlur();
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				value: 12,
			},
		]);
		expect(ids.map((id) => fxOf(h, id).params.radius!.value)).toEqual([12, 12, 12]);
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				delta: -2,
			},
		]);
		expect(ids.map((id) => fxOf(h, id).params.radius!.value)).toEqual([10, 10, 10]);
		h.ok([
			{
				type: 'effect.setParamMany',
				targets: ids.map((id, i) => ({ clipId: id, effectInstanceId: fxOf(h, id).id, value: i * 3 })),
				param: 'radius',
			},
		]);
		expect(ids.map((id) => fxOf(h, id).params.radius!.value)).toEqual([0, 3, 6]);
		// Stopwatch on at frame 4 of each clip, then a key at frame 10 of each clip.
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				animated: true,
				at: { frames: 4 },
			},
		]);
		const keyed = h.tx([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				value: 1,
			},
		]);
		expect(err(keyed)?.message).toContain('keyframed');
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				value: 30,
				at: { frames: 10 },
			},
		]);
		for (const id of ids)
			expect(fxOf(h, id).params.radius!.keyframes.map((k) => k.time / F30)).toEqual([4, 10]);
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				keyframes: [{ offset: { seconds: 0.1 }, value: 7 }],
			},
		]);
		for (const id of ids)
			expect(fxOf(h, id).params.radius!.keyframes.map((k) => [k.time / F30, k.value])).toEqual([[3, 7]]);
		h.ok([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				param: 'radius',
				animated: false,
			},
		]);
		expect(ids.map((id) => fxOf(h, id).params.radius!.keyframes.length)).toEqual([0, 0, 0]);
		ok(h);
	});

	it('setParamMany refuses a missing occurrence naming the clips, and a bad param', () => {
		const { h, ids } = withBlur();
		const r = h.tx([
			{
				type: 'effect.setParamMany',
				clipIds: ids,
				effectId: 'jasper.gaussian-blur',
				occurrence: 1,
				param: 'radius',
				value: 1,
			},
		]);
		expect(err(r)?.code).toBe('E_NOT_FOUND');
		expect(err(r)?.message).toContain(ids[0]);
		expect(
			err(
				h.tx([
					{
						type: 'effect.setParamMany',
						clipIds: ids,
						effectId: 'jasper.gaussian-blur',
						param: 'nope',
						value: 1,
					},
				]),
			)?.code,
		).toBe('E_INVALID_PARAM');
		expect(
			err(
				h.tx([
					{
						type: 'effect.setParamMany',
						clipIds: ids,
						effectId: 'jasper.gaussian-blur',
						param: 'radius',
						value: 1,
						delta: 1,
					},
				]),
			)?.code,
		).toBe('E_INVALID_PARAM');
	});

	it('removeMany removes the matched instance on every clip; undo by the base document', () => {
		const { h, ids } = withBlur();
		h.ok([
			{ type: 'effect.addMany', clipIds: ids, effectId: 'jasper.gaussian-blur', params: { radius: 99 } },
		]);
		const base = h.doc;
		h.ok([{ type: 'effect.removeMany', clipIds: ids, effectId: 'jasper.gaussian-blur', occurrence: 0 }]);
		expect(ids.map((id) => fxOf(h, id).params.radius!.value)).toEqual([99, 99, 99]);
		expect(ids.map((id) => (h.seq.clips[id] as { effects: unknown[] }).effects.length)).toEqual([1, 1, 1]);
		expect(base).not.toBe(h.doc);
		expect((base.sequences[h.seqId]!.clips[ids[0]!] as { effects: unknown[] }).effects).toHaveLength(2);
		ok(h);
	});
});
