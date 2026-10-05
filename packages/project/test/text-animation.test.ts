// Text animators in the model (S11:TXA-002…009, FIX-004, ANA-007): the catalogue, clip.addText / clip.update
// `textAnimation`, razor, duplicate, trims and frame-rate changes, the `textAnimation` property group with
// param.set, invariants/repair, the snapshot and the agent query.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	type Clip,
	checkInvariants,
	clipPropertiesJsonSchema,
	defaultEffectRegistry,
	getPropertySpec,
	LATEST_TEXT_ANIMATION_SPECS,
	latestTextAnimationSpec,
	loadProject,
	runAgentQuery,
	TEXT_ANIMATION_SPECS,
	type TextAnimationInput,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;

const PRESETS = [
	'fade',
	'slide-up',
	'slide-down',
	'slide-left',
	'slide-right',
	'pop',
	'blur',
	'typewriter',
	'tracking',
	'mask-reveal',
	'rotate-in',
	'drop',
];

function withText(h: Harness, extra: Record<string, unknown> = {}, duration = 90): string {
	const r = h.tx([
		{
			type: 'clip.addText',
			at: 0,
			duration,
			track: 'V1',
			content: { text: 'Hello brave world' },
			ref: '$t',
			...extra,
		},
	]);
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return r.refs.$t!;
}
const textClip = (h: Harness, id: string) => h.seq.clips[id] as TextClip;
const err = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);

describe('catalogue (S11:TXA-002/003)', () => {
	it('accepts the documented presets on both sides and rejects unknown parameters', () => {
		expect(LATEST_TEXT_ANIMATION_SPECS.map((s) => s.id).sort()).toEqual([...PRESETS].sort());
		for (const s of TEXT_ANIMATION_SPECS) {
			expect(s.phases).toEqual(['in', 'out']);
			expect(s.paramsSchema.safeParse({}).success).toBe(true);
			expect(s.defaultDurationFrames).toBeGreaterThanOrEqual(1);
			// strict schemas: unknown params are rejected
			expect(s.paramsSchema.safeParse({ bogus: 1 }).success).toBe(false);
		}
		expect(latestTextAnimationSpec('fade')?.id).toBe('fade');
		expect(latestTextAnimationSpec('nope')).toBeUndefined();
	});
	it('common params are bounded (stagger 0…1, units, orders, eases)', () => {
		const slide = latestTextAnimationSpec('slide-up')!;
		expect(slide.paramsSchema.safeParse({ stagger: 1.5 }).success).toBe(false);
		expect(slide.paramsSchema.safeParse({ unit: 'line', order: 'random', ease: 'steps' }).success).toBe(true);
		expect(slide.paramsSchema.safeParse({ ease: 'bouncy' }).success).toBe(false);
		expect(latestTextAnimationSpec('typewriter')!.paramsSchema.safeParse({ unit: 'line' }).success).toBe(
			false,
		);
	});
});

describe('clip.addText textAnimation (S11:TXA-006)', () => {
	it('writes both sides: params = defaults ⊕ given, window = default scaled to the sequence fps', () => {
		const h = new Harness({ preset: 'hd-1080p-60' });
		const id = withText(h, {
			textAnimation: {
				in: { preset: 'slide-up', params: { stagger: 0.5 } },
				out: { preset: 'fade', durationFrames: 12 },
			},
		});
		expect(textClip(h, id).textAnimation).toEqual({
			in: {
				preset: 'slide-up',
				version: 1,
				durationFrames: 40,
				params: { unit: 'word', stagger: 0.5, order: 'forward', ease: 'outExpo', distance: 60 },
			},
			out: {
				preset: 'fade',
				version: 1,
				durationFrames: 12,
				params: { unit: 'word', stagger: 0, order: 'forward', ease: 'out' },
			},
		});
	});
	it('refuses unknown presets (E_UNKNOWN_EFFECT) and bad params (E_INVALID_PARAM with the path)', () => {
		const h = new Harness();
		const unknown = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: { text: 'x' },
				textAnimation: { in: { preset: 'zoom' } },
			},
		]);
		expect(err(unknown)).toMatchObject({ code: 'E_UNKNOWN_EFFECT', path: ['textAnimation', 'in', 'preset'] });
		const wrongVersion = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: { text: 'x' },
				textAnimation: { out: { preset: 'fade', version: 9 } },
			},
		]);
		expect(err(wrongVersion)?.code).toBe('E_UNKNOWN_EFFECT');
		const bad = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V1',
				content: { text: 'x' },
				textAnimation: { in: { preset: 'pop', params: { bounce: 3 } } },
			},
		]);
		expect(err(bad)).toMatchObject({
			code: 'E_INVALID_PARAM',
			path: ['textAnimation', 'in', 'params', 'bounce'],
		});
	});
	it('warns W_ANIMATION_COMPRESSED when in + out exceed the clip (no invariant failure)', () => {
		const h = new Harness();
		const r = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 20,
				track: 'V1',
				content: { text: 'x' },
				textAnimation: {
					in: { preset: 'fade', durationFrames: 15 },
					out: { preset: 'fade', durationFrames: 15 },
				},
			},
		]);
		expect(r.ok).toBe(true);
		expect(r.ok && r.warnings.map((w) => [w.code, w.commandIndex])).toEqual([['W_ANIMATION_COMPRESSED', 0]]);
	});
});

describe('clip.update textAnimation (S11:TXA-006)', () => {
	it('replaces a side with preset (params reset), merges without preset, removes with null', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'slide-up', params: { stagger: 0.8 } } } });
		const upd = (patch: unknown) => h.tx([{ type: 'clip.update', clipId: id, patch }]);
		expect(upd({ textAnimation: { in: { durationFrames: 9, params: { distance: 200 } } } }).ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in).toMatchObject({
			preset: 'slide-up',
			durationFrames: 9,
			params: { stagger: 0.8, distance: 200 },
		});
		expect(upd({ textAnimation: { in: { preset: 'slide-left' } } }).ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in).toEqual({
			preset: 'slide-left',
			version: 1,
			durationFrames: 20,
			params: { unit: 'word', stagger: 0.3, order: 'forward', ease: 'outExpo', distance: 60 },
		});
		expect(upd({ textAnimation: { out: { preset: 'blur', params: { blur: 4 } } } }).ok).toBe(true);
		expect(upd({ textAnimation: { in: null } }).ok).toBe(true);
		expect(textClip(h, id).textAnimation).toEqual({ out: expect.objectContaining({ preset: 'blur' }) });
		expect(upd({ textAnimation: { out: null } }).ok).toBe(true);
		expect(textClip(h, id).textAnimation).toBeUndefined();
		expect(upd({ textAnimation: { in: { preset: 'drop' }, out: { preset: 'fade' } } }).ok).toBe(true);
		expect(upd({ textAnimation: null }).ok).toBe(true);
		expect(textClip(h, id).textAnimation).toBeUndefined();
	});
	it('validates: merge without a side, bad params, non-text clips', () => {
		const h = new Harness();
		const id = withText(h);
		const upd = (patch: unknown, clipId = id) => err(h.tx([{ type: 'clip.update', clipId, patch }]));
		expect(upd({ textAnimation: { in: { durationFrames: 5 } } })).toMatchObject({
			code: 'E_INVALID_PARAM',
			path: ['textAnimation', 'in', 'preset'],
		});
		expect(upd({ textAnimation: { in: { preset: 'fade', params: { stagger: -1 } } } })).toMatchObject({
			code: 'E_INVALID_PARAM',
			path: ['textAnimation', 'in', 'params', 'stagger'],
		});
		const solid = h.tx([
			{ type: 'clip.addSolid', at: 100, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		]);
		const solidId = solid.ok ? solid.refs.$s! : '';
		expect(upd({ textAnimation: { in: { preset: 'fade' } } }, solidId)?.code).toBe('E_INVALID_PARAM');
	});
	it('applies to many clips in one transaction (clipIds) and warns when it compresses', () => {
		const h = new Harness();
		const a = withText(h);
		const r = h.tx([
			{ type: 'clip.addText', at: 100, duration: 10, track: 'V1', content: { text: 'b' }, ref: '$b' },
		]);
		const b = r.ok ? r.refs.$b! : '';
		const u = h.tx([
			{
				type: 'clip.update',
				clipIds: [a, b],
				patch: { textAnimation: { in: { preset: 'pop' }, out: { preset: 'pop' } } },
			},
		]);
		expect(u.ok).toBe(true);
		expect(textClip(h, a).textAnimation?.in?.preset).toBe('pop');
		expect(textClip(h, b).textAnimation?.out?.preset).toBe('pop');
		// only the 10-frame clip is compressed (20 + 20 > 10)
		expect(u.ok && u.warnings.filter((w) => w.code === 'W_ANIMATION_COMPRESSED')).toHaveLength(1);
	});
	it('keeps unknown presets (durations editable, params refused)', () => {
		const h = new Harness();
		const id = withText(h);
		const doc = JSON.parse(JSON.stringify(h.doc));
		Object.values(doc.sequences as Record<string, { clips: Record<string, TextClip> }>)[0]!.clips[
			id
		]!.textAnimation = {
			in: { preset: 'hologram', version: 2, durationFrames: 10, params: { glow: 1 } },
		};
		h.doc = loadProject(doc, { effects: defaultEffectRegistry }).document;
		const upd = (patch: unknown) => h.tx([{ type: 'clip.update', clipId: id, patch }]);
		expect(upd({ textAnimation: { in: { durationFrames: 14 } } }).ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in).toEqual({
			preset: 'hologram',
			version: 2,
			durationFrames: 14,
			params: { glow: 1 },
		});
		expect(err(upd({ textAnimation: { in: { params: { glow: 2 } } } }))?.code).toBe('E_UNKNOWN_EFFECT');
	});
});

describe('typewriter versions (blinking caret = typewriter@2)', () => {
	it('new animations get @2 with its defaults; saved @1 animators keep their version, params and snapshot', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'typewriter' } } });
		expect(textClip(h, id).textAnimation?.in).toEqual({
			preset: 'typewriter',
			version: 2,
			durationFrames: 45,
			params: { unit: 'char', caret: true, caretBlink: true, blinkRate: 2, delay: 0, typing: 0.6 },
		});
		const v1 = withText(h, { at: 200, textAnimation: { out: { preset: 'typewriter', version: 1 } } });
		expect(textClip(h, v1).textAnimation?.out).toEqual({
			preset: 'typewriter',
			version: 1,
			durationFrames: 30,
			params: { unit: 'char', caret: true },
		});
		// @1 has no blink params (strict schema) and its snapshot carries exactly its own params
		expect(
			err(
				h.tx([
					{
						type: 'clip.update',
						clipId: v1,
						patch: { textAnimation: { out: { params: { blinkRate: 1 } } } },
					},
				]),
			)?.code,
		).toBe('E_INVALID_PARAM');
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const sources = snap.videoTracks
			.flatMap((t) => t.clips)
			.map((c) => ('text' in c.source ? c.source : null));
		expect(sources.map((s) => s?.animation?.out ?? s?.animation?.in)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ version: 1, params: { unit: 'char', caret: true } }),
				expect.objectContaining({ version: 2, params: expect.objectContaining({ caretBlink: true }) }),
			]),
		);
		expect(snap.warnings).toEqual([]);
		// upgrading in place keeps the @1 params and adds the @2 defaults
		expect(
			h.tx([{ type: 'clip.update', clipId: v1, patch: { textAnimation: { out: { version: 2 } } } }]).ok,
		).toBe(true);
		expect(textClip(h, v1).textAnimation?.out?.params).toEqual({
			unit: 'char',
			caret: true,
			caretBlink: true,
			blinkRate: 2,
			delay: 0,
			typing: 0.6,
		});
	});
	it('pickers list only the latest version (one Typewriter entry)', () => {
		const options = getPropertySpec('textAnimation.in.preset')!.options as string[];
		expect(options.filter((o) => o === 'typewriter')).toHaveLength(1);
		const tw = latestTextAnimationSpec('typewriter')!.paramsSchema;
		expect(tw.safeParse({ blinkRate: 0.2 }).success).toBe(false);
		expect(tw.safeParse({ blinkRate: 5 }).success).toBe(false);
		expect(tw.safeParse({ delay: 0.95 }).success).toBe(false);
		expect(tw.safeParse({ typing: 0 }).success).toBe(false);
	});
});

describe('edits (S11:TXA-005)', () => {
	it('razor: left keeps In only, right keeps Out only; undo-free copies stay independent', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'fade' } } });
		const r = h.tx([{ type: 'clip.split', clipIds: [id], at: 45 }]);
		expect(r.ok).toBe(true);
		const right = r.ok ? (r.results[0] as { right: string[] }).right[0]! : '';
		expect(textClip(h, id).textAnimation).toEqual({ in: expect.objectContaining({ preset: 'slide-up' }) });
		expect(textClip(h, right).textAnimation).toEqual({ out: expect.objectContaining({ preset: 'fade' }) });
		// a clip with only an In animator: the right part has none at all
		const solo = withTextAt(h, 200, { in: { preset: 'pop' } });
		const r2 = h.tx([{ type: 'clip.split', clipIds: [solo], at: 230 }]);
		const right2 = r2.ok ? (r2.results[0] as { right: string[] }).right[0]! : '';
		expect(textClip(h, right2).textAnimation).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});
	it('duplicate copies the animators; trims keep the windows and warn when they compress', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'drop' }, out: { preset: 'fade' } } }, 60);
		const d = h.tx([{ type: 'clip.duplicate', clipIds: [id] }]);
		expect(d.ok).toBe(true);
		const copy = Object.values(h.seq.clips).find((c) => c.id !== id) as TextClip;
		expect(copy.textAnimation).toEqual(textClip(h, id).textAnimation);
		const t = h.tx([{ type: 'clip.trim', clipId: id, edge: 'out', deltaFrames: -30 }]);
		expect(t.ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in?.durationFrames).toBe(25);
		expect(t.ok && t.warnings.map((w) => w.code)).toContain('W_ANIMATION_COMPRESSED');
	});
	it('a sequence frame-rate change remaps the windows (round, ≥ 1)', () => {
		const h = new Harness();
		const id = withText(h, {
			textAnimation: {
				in: { preset: 'fade', durationFrames: 15 },
				out: { preset: 'fade', durationFrames: 1 },
			},
		});
		const r = h.tx([
			{ type: 'sequence.updateSettings', sequenceId: h.seqId, settings: { frameRate: { num: 60, den: 1 } } },
		]);
		expect(r.ok ? null : r.errors).toBeNull();
		expect(textClip(h, id).textAnimation?.in?.durationFrames).toBe(30);
		expect(textClip(h, id).textAnimation?.out?.durationFrames).toBe(2);
		h.tx([
			{ type: 'sequence.updateSettings', sequenceId: h.seqId, settings: { frameRate: { num: 24, den: 1 } } },
		]);
		expect(textClip(h, id).textAnimation?.in?.durationFrames).toBe(12);
		expect(textClip(h, id).textAnimation?.out?.durationFrames).toBe(1);
	});
});

function withTextAt(h: Harness, at: number, textAnimation: TextAnimationInput): string {
	const r = h.tx([
		{
			type: 'clip.addText',
			at,
			duration: 60,
			track: 'V1',
			content: { text: 'Solo' },
			textAnimation,
			ref: '$x',
		},
	]);
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return r.refs.$x!;
}

describe('textAnimation properties and param.set (S11:TXA-007, FIX-004)', () => {
	it('exports dynamic text animation parameter schemas for the selected preset', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'slide-up' }, out: { preset: 'typewriter' } } });
		const clip = textClip(h, id);
		const schema = clipPropertiesJsonSchema(clip).properties as Record<string, Record<string, unknown>>;
		expect(schema['textAnimation.in.params.ease']).toMatchObject({
			type: 'string',
			enum: expect.arrayContaining(['outExpo']),
		});
		expect(schema['textAnimation.in.preset']?.enum).toContain('none');
	});
	it('param.set writes presets, windows and params through clip.update (validated as a whole)', () => {
		const h = new Harness();
		const id = withText(h);
		const set = (key: string, value: unknown) =>
			h.tx([{ type: 'param.set', target: ['clip', id, ...key.split('.')], value }]);
		expect(set('textAnimation.in.preset', 'pop').ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in?.preset).toBe('pop');
		expect(set('textAnimation.in.durationFrames', 7).ok).toBe(true);
		expect(set('textAnimation.in.params.bounce', 0.2).ok).toBe(true);
		expect(textClip(h, id).textAnimation?.in).toMatchObject({
			durationFrames: 7,
			params: { bounce: 0.2, scale: 0 },
		});
		// range clamp with a warning, enums checked by the rule
		const clamped = set('textAnimation.in.params.stagger', 4);
		expect(clamped.ok && clamped.warnings[0]?.code).toBe('W_VALUE_CLAMPED');
		expect(err(set('textAnimation.in.params.order', 'sideways'))?.code).toBe('E_INVALID_PARAM');
		expect(err(set('textAnimation.out.durationFrames', 5))?.code).toBe('E_INVALID_PARAM');
		expect(err(set('textAnimation.in.preset', 'zoom'))?.code).toBe('E_INVALID_PARAM');
		expect(set('textAnimation.in.preset', 'none').ok).toBe(true);
		expect(textClip(h, id).textAnimation).toBeUndefined();
	});
	it('FIX-004: param.set on layout-affecting text style fields re-runs layout like clip.update', () => {
		const measurer = {
			measure: (content: { text: string; style: { sizePx: number } }) => ({
				width: content.text.length * content.style.sizePx * 0.5,
				height: content.style.sizePx * 1.2,
			}),
		};
		const h = new Harness({ ctx: { textMeasurer: measurer as never } });
		const id = withText(h);
		expect(textClip(h, id).box).toMatchObject({ width: 17 * 50, height: 120 });
		const r = h.tx([{ type: 'param.set', target: ['clip', id, 'text', 'sizePx'], value: 40 }]);
		expect(r.ok).toBe(true);
		expect(textClip(h, id).content.style.sizePx).toBe(40);
		expect(textClip(h, id).box).toMatchObject({ width: 17 * 20, height: 48 });
		// a stroke can be created by param.set (it used to need an existing stroke)
		expect(h.tx([{ type: 'param.set', target: ['clip', id, 'text', 'strokeWidth'], value: 3 }]).ok).toBe(
			true,
		);
		expect(textClip(h, id).content.style.strokes[0]?.widthPx).toBe(3);
		// static targets still refuse keyframes
		const at = h.tx([
			{ type: 'param.set', target: ['clip', id, 'text', 'sizePx'], value: 41, at: { sequenceFrame: 3 } },
		]);
		expect(err(at)?.code).toBe('E_INVALID_PARAM');
	});
});

describe('invariants, repair, snapshot and agents (S11:TXA-008/009, ANA-007)', () => {
	it('flags and repairs invalid params of known presets; unknown presets are kept', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { in: { preset: 'fade' }, out: { preset: 'fade' } } });
		const doc = JSON.parse(JSON.stringify(h.doc));
		const clip = Object.values(doc.sequences as Record<string, { clips: Record<string, TextClip> }>)[0]!
			.clips[id]!;
		clip.textAnimation = {
			in: { preset: 'fade', version: 1, durationFrames: 10, params: { stagger: 9 } },
			out: { preset: 'mystery', version: 1, durationFrames: 10, params: { any: true } },
		};
		expect(checkInvariants(doc).map((i) => i.invariant)).toEqual(['INV-012']);
		const loaded = loadProject(doc, { effects: defaultEffectRegistry });
		expect(loaded.issues).toEqual([]);
		expect(loaded.repairs.map((r) => r.action)).toEqual(['reset-params']);
		const fixed = Object.values(loaded.document.sequences)[0]!.clips[id] as TextClip;
		expect(fixed.textAnimation?.in?.params).toEqual({
			unit: 'word',
			stagger: 0,
			order: 'forward',
			ease: 'out',
		});
		expect(fixed.textAnimation?.out?.params).toEqual({ any: true });
	});
	it('the snapshot carries resolved, compressed animators; styled runs load their faces', () => {
		const h = new Harness();
		withText(
			h,
			{
				content: {
					text: 'Bold move',
					runs: [{ from: 0, to: 4, style: { weight: 700 } }],
				},
				textAnimation: {
					in: { preset: 'slide-up', durationFrames: 40 },
					out: { preset: 'fade', durationFrames: 40 },
				},
			},
			60,
		);
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: () => null,
			resolveFont: (_f, w) => `https://fonts.test/${w}.woff2`,
		});
		const text = snap.videoTracks.flatMap((t) => t.clips)[0]!;
		expect('text' in text.source && text.source.animation).toEqual({
			in: {
				preset: 'slide-up',
				version: 1,
				params: { unit: 'word', stagger: 0.3, order: 'forward', ease: 'outExpo', distance: 60 },
				frames: 30,
			},
			out: {
				preset: 'fade',
				version: 1,
				params: { unit: 'word', stagger: 0, order: 'forward', ease: 'out' },
				frames: 29, // In + Out share 59 frames: one stays at rest
			},
		});
		expect(snap.warnings).toEqual([]);
		expect(snap.fonts.map((f) => f.weight).sort()).toEqual([400, 700]);
	});
	it('agent queries report text animation and shape/composition sources', () => {
		const h = new Harness();
		const id = withText(h, { textAnimation: { out: { preset: 'tracking', durationFrames: 12 } } });
		const out = runAgentQuery({ doc: h.doc, revision: 1 }, 'sequence.clipsInRange', { from: 0, to: 100 }) as {
			clips: { id: string; source: Record<string, unknown> }[];
		};
		const row = out.clips.find((c) => c.id === id)!;
		expect(row.source).toMatchObject({
			text: 'Hello brave world',
			animation: {
				in: null,
				out: {
					preset: 'tracking',
					version: 1,
					durationFrames: 12,
					params: expect.objectContaining({ spacing: 0.5 }),
				},
			},
		});
	});
});
