// Essential Graphics (gaps GR-4/5): graphic sequences, layers, align / distribute, Responsive Design (position pins,
// Intro / Outro time), Roll / Crawl and .jgt templates — commands with undo and refusals, and what renders.
import { describe, expect, it } from 'vitest';
import {
	alignOffsets,
	applyGraphics,
	buildItemsPayload,
	buildRenderSnapshot,
	checkInvariants,
	evaluate,
	GRAPHIC_TEMPLATE_FORMAT,
	graphicTemplateOf,
	intrinsicBoxOf,
	repairDocument,
	responsiveGraphicTime,
	rollPositionAt,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

/** A graphic nest with one text layer in the harness's sequence (returns ids). */
function makeGraphic(h: Harness) {
	const r = h.ok([
		{
			type: 'clip.addText',
			at: { frames: 0 },
			duration: { frames: 150 },
			track: 'V1',
			content: { text: 'Title' },
			ref: '$t',
		},
		{ type: 'clip.nest', clipIds: ['$t'], name: 'Graphic', ref: '$g' },
		{ type: 'graphic.update', sequenceId: '$g', graphic: { intro: 15, outro: 15 } },
	]);
	const gid = r.refs.$g!;
	const nest = Object.values(h.seq.clips).find((c) => c.kind === 'nest-video')!;
	return { gid, nestId: nest.id };
}

const fxList = (c: unknown) =>
	c as { transform: { position: { value: [number, number]; keyframes: unknown[] } } };

describe('essential graphics', () => {
	it('rejects a malformed template payload before importing project items', () => {
		const h = new Harness();
		const before = h.doc;
		const result = h.tx([
			{
				type: 'graphic.importTemplate',
				at: 0,
				template: {
					format: GRAPHIC_TEMPLATE_FORMAT,
					version: 1,
					name: 'Invalid graphic',
					frame: { width: 1920, height: 1080 },
					payload: {},
				},
			},
		]);
		expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_SCHEMA', path: ['payload'] }] });
		expect(h.doc).toBe(before);
	});

	it('refuses layer pins on caption clips without changing the project', () => {
		const h = new Harness();
		h.ok([
			{ type: 'graphic.update', sequenceId: h.seqId, graphic: { intro: 0, outro: 0 } },
			{ type: 'caption.add', at: 0, duration: 30, text: 'Caption' },
		]);
		const caption = Object.values(h.seq.clips).find((clip) => clip.kind === 'captions')!;
		const before = h.doc;
		const result = h.tx([
			{
				type: 'graphic.setPins',
				sequenceId: h.seqId,
				clipId: caption.id,
				target: 'frame',
				edges: ['left'],
			},
		]);
		expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });
		expect(h.doc).toBe(before);
	});

	it('align / distribute offsets', () => {
		const rects = [
			{ x: 10, y: 10, width: 100, height: 50 },
			{ x: 300, y: 80, width: 50, height: 50 },
			{ x: 150, y: 200, width: 20, height: 20 },
		];
		const frame = { x: 0, y: 0, width: 1920, height: 1080 };
		expect(alignOffsets(rects, 'left', frame).map((o) => o[0])).toEqual([-10, -300, -150]);
		expect(alignOffsets(rects, 'center', frame)[0]).toEqual([960 - 60, 0]);
		const d = alignOffsets(rects, 'distributeHorizontal', null);
		// Equal gaps between consecutive layers after the move.
		const xs = rects
			.map((r, i) => ({ l: r.x + d[i]![0], r: r.x + r.width + d[i]![0] }))
			.sort((a, b) => a.l - b.l);
		expect(xs[1]!.l - xs[0]!.r).toBeCloseTo(xs[2]!.l - xs[1]!.r, 6);
	});

	it('responsive time keeps the intro and the outro', () => {
		expect(responsiveGraphicTime(10, 300, 150, 15, 15)).toBe(10);
		expect(responsiveGraphicTime(290, 300, 150, 15, 15)).toBe(140);
		expect(responsiveGraphicTime(150, 300, 150, 15, 15)).toBeCloseTo(75, 6);
	});

	it('roll from below to above the frame with pre-roll and post-roll', () => {
		const roll = {
			mode: 'roll' as const,
			startOffScreen: true,
			endOffScreen: true,
			preRoll: 10,
			easeIn: 0,
			easeOut: 0,
			postRoll: 10,
		};
		const at = (t: number) =>
			rollPositionAt(
				roll,
				t,
				110,
				{ width: 1920, height: 1080 },
				{ width: 1920, height: 3000 },
				[960, 540],
				100,
				[960, 1500],
			);
		expect(at(0)[1]).toBeCloseTo(1080 + 1500, 6);
		expect(at(10)[1]).toBeCloseTo(1080 + 1500, 6);
		expect(at(100)[1]).toBeCloseTo(-1500, 6);
		expect(at(55)[1]).toBeCloseTo((1080 + 1500 - 1500) / 2, 6);
		const eased = rollPositionAt(
			{ ...roll, easeIn: 20 },
			15,
			110,
			{ width: 1920, height: 1080 },
			{ width: 1920, height: 3000 },
			[960, 540],
			100,
			[960, 1500],
		);
		expect(eased[1]).toBeGreaterThan(at(15)[1]);
	});

	it('commands: make a graphic, add layers, align, pin, undo, refusals', () => {
		const h = new Harness();
		const { gid, nestId } = makeGraphic(h);
		const g = () => h.doc.sequences[gid]!;
		expect((g() as { graphic?: unknown }).graphic).toEqual({ intro: 15, outro: 15, roll: null });
		const before = h.doc;
		const r = h.ok([{ type: 'graphic.addLayer', sequenceId: gid, kind: 'rectangle', ref: '$r' }]);
		const rect = r.refs.$r!;
		expect(g().videoTracks.length).toBeGreaterThanOrEqual(2);
		expect(g().clips[rect]!.duration).toBe(150);
		h.ok([{ type: 'graphic.align', sequenceId: gid, clipIds: [rect], mode: 'left', relativeTo: 'frame' }]);
		const box = intrinsicBoxOf({ clip: g().clips[rect]!, doc: h.doc, seq: g() } as never);
		expect(fxList(g().clips[rect]).transform.position.value[0]).toBeCloseTo(box.width / 2, 3);
		h.ok([
			{ type: 'graphic.setPins', sequenceId: gid, clipId: rect, target: 'frame', edges: ['right', 'bottom'] },
		]);
		expect((g().clips[rect] as { pins?: { edges: Record<string, number> } }).pins!.edges.right).toBeCloseTo(
			-(1920 - box.width),
			3,
		);
		// A resized graphic frame keeps the pinned edges (applied when rendering).
		h.ok([{ type: 'sequence.updateSettings', sequenceId: gid, settings: { width: 1280, height: 720 } }]);
		const shown = applyGraphics(h.doc, (c, s) => intrinsicBoxOf({ clip: c, doc: h.doc, seq: s } as never));
		const p = fxList(shown.sequences[gid]!.clips[rect]).transform.position.value;
		// The right edge stays 1920 − width px left of the frame's right edge.
		expect(p[0] + box.width / 2).toBeCloseTo(1280 - (1920 - box.width), 1);
		expect(
			h.tx([{ type: 'graphic.setPins', sequenceId: gid, clipId: rect, target: rect, edges: ['left'] }]).ok,
		).toBe(false);
		expect(h.tx([{ type: 'graphic.addLayer', sequenceId: h.seqId, kind: 'text' }]).ok).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.doc = before;
		expect(h.doc.sequences[gid]!.clips[rect]).toBeUndefined();
		// The nest renders with the generated Intro / Outro remap when longer than its graphic.
		h.ok([{ type: 'clip.trim', clipId: nestId, edge: 'out', deltaFrames: -60 }]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(snap.videoTracks.flatMap((t) => t.clips).some((c) => c.timeRemap?.enabled)).toBe(true);
	});

	it('roll keys on the nest; dangling pins are reported and repaired', () => {
		const h = new Harness();
		const { gid, nestId } = makeGraphic(h);
		h.ok([
			{
				type: 'graphic.update',
				sequenceId: gid,
				graphic: {
					roll: {
						mode: 'roll',
						startOffScreen: true,
						endOffScreen: true,
						preRoll: 0,
						easeIn: 0,
						easeOut: 0,
						postRoll: 0,
					},
				},
			},
		]);
		const shown = applyGraphics(h.doc, (c, s) => intrinsicBoxOf({ clip: c, doc: h.doc, seq: s } as never));
		const pos = (shown.sequences[h.seqId]!.clips[nestId] as never as { transform: { position: never } })
			.transform.position;
		expect((evaluate(pos, 0) as [number, number])[1]).toBeCloseTo(1080 + 540, 3);
		const broken = structuredClone(h.doc);
		const t = Object.values(broken.sequences[gid]!.clips)[0]! as { pins?: unknown };
		t.pins = { target: 'clp_missing', edges: { left: 0 } };
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-GRAPHIC')).toBe(true);
		expect(checkInvariants(repairDocument(broken, h.ids).document)).toEqual([]);
	});

	it('.jgt templates round-trip a graphic', () => {
		const h = new Harness();
		const { gid } = makeGraphic(h);
		const item = Object.values(h.doc.items).find(
			(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === gid,
		)!;
		const tpl = graphicTemplateOf(h.doc, item.id, 'Lower Third', (d, ids) => buildItemsPayload(d, ids))!;
		expect(tpl.format).toBe(GRAPHIC_TEMPLATE_FORMAT);
		const json = JSON.parse(JSON.stringify(tpl));
		const before = Object.values(h.doc.sequences).filter((s) => (s as { graphic?: unknown }).graphic).length;
		h.ok([{ type: 'graphic.importTemplate', template: json, at: { frames: 300 }, track: 'V2' }]);
		const graphics = Object.values(h.doc.sequences).filter((s) => (s as { graphic?: unknown }).graphic);
		expect(graphics.length).toBe(before + 1);
		expect(Object.values(h.seq.clips).filter((c) => c.kind === 'nest-video')).toHaveLength(2);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
