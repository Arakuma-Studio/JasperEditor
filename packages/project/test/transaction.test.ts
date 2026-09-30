import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	applyTransaction,
	COMMAND_CATALOG,
	COMMAND_TYPES,
	createEmptyProject,
	createSeededIdSource,
	createStaticMgRegistry,
	defaultRegistries,
	exportAgentSchema,
	requiresApproval,
} from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 0, 1, 1],
});

describe('transactions (S01 §16)', () => {
	it('AC-09: a failing third command applies nothing and reports commandIndex 2', () => {
		const h = new Harness();
		const before = h.doc;
		const r = h.tx(
			[
				solid(0, 30, 'V1'),
				{ type: 'marker.add', frame: 10 },
				{ type: 'clip.lift', clipIds: ['clp_0000000000NOPE'] },
			],
			{ origin: { agent: 'bot' } },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]!.commandIndex).toBe(2);
			expect(r.errors[0]!.code).toBe('E_NOT_FOUND');
			expect(r.revision).toBe(0);
		}
		expect(h.doc).toBe(before);
	});

	it('AC-10: temp refs create a text clip and target it in later commands', () => {
		const h = new Harness();
		const r = h.ok(
			[
				{
					type: 'clip.addText',
					ref: '$title',
					at: '00:00:01:00',
					duration: { seconds: 4 },
					track: 'V2',
					content: { text: 'Launch Day' },
					box: { width: 1400, height: 160, autoSize: 'height' },
				},
				{
					type: 'param.setAnimated',
					target: ['clip', '$title', 'opacity'],
					animated: true,
					at: { frames: 0 },
				},
				{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 0, at: { frames: 0 } },
				{ type: 'param.set', target: ['clip', '$title', 'opacity'], value: 100, at: { frames: 15 } },
				{
					type: 'marker.add',
					frame: 30,
					name: 'Title added',
					markerType: 'agent-note',
					comment: 'Fades in over 0.5 s.',
				},
			],
			{ origin: { agent: 'editor-assistant', runId: 'run_42' }, label: 'Add title and fade in' },
		);
		expect(r.refs.$title).toMatch(/^clp_/);
		const clip = h.seq.clips[r.refs.$title!] as Extract<(typeof h.seq.clips)[string], { kind: 'text' }>;
		expect([clip.start, clip.duration]).toEqual([30, 120]);
		expect(clip.opacity.keyframes.map((k) => k.value)).toEqual([0, 100]);
		expect(clip.layoutPending).toBe(true);
		expect(h.seq.markers[0]!.author).toEqual({ agent: 'editor-assistant' });
		// The blur half of AC-10 (effect.add, WP-2D) is covered in keyframe-effect.test.ts.
	});

	it('AC-11: stale expectedRevision is refused when it touches a changed clip, fast-forwards otherwise', () => {
		const h = new Harness();
		h.ok([solid(0, 30, 'V1'), solid(100, 30, 'V2')]);
		const base = h.revision;
		const [moved] = h.clips('V1');
		const [other] = h.clips('V2');
		h.ok([{ type: 'clip.move', clipIds: [moved!.id], deltaFrames: 5 }]);
		const stale = h.tx([{ type: 'clip.update', clipId: moved!.id, patch: { name: 'x' } }], {
			origin: { agent: 'a' },
			expectedRevision: base,
		});
		expect(stale.ok).toBe(false);
		if (!stale.ok) {
			expect(stale.errors[0]!.code).toBe('E_REVISION_MISMATCH');
			expect(stale.errors[0]!.blocking).toContain(moved!.id);
		}
		const ff = h.tx([{ type: 'clip.update', clipId: other!.id, patch: { name: 'y' } }], {
			origin: { agent: 'a' },
			expectedRevision: base,
		});
		expect(ff.ok).toBe(true);
	});

	it('dry runs return the result without changing the document', () => {
		const h = new Harness();
		const before = h.doc;
		const r = h.tx([solid(0, 30, 'V1')], { dryRun: true });
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.created.length).toBeGreaterThan(0);
		expect(h.doc).toBe(before);
	});

	it('enforces the command limit and schemas', () => {
		const doc = createEmptyProject({ ids: createSeededIdSource(1), name: 'x' });
		const many = Array.from({ length: 5001 }, () => ({ type: 'project.rename', name: 'n' }));
		const { result } = applyTransaction(doc, { label: 'l', origin: 'user', commands: many }, makeCtx());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0]!.code).toBe('E_LIMIT');
		const bad = applyTransaction(
			doc,
			{ label: 'l', origin: 'user', commands: [{ type: 'clip.move', clipIds: 'x' }] },
			makeCtx(),
		).result;
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors.every((e) => e.code === 'E_SCHEMA' && e.commandIndex === 0)).toBe(true);
		const unknown = applyTransaction(
			doc,
			{ label: 'l', origin: 'user', commands: [{ type: 'clip.teleport' }] },
			makeCtx(),
		).result;
		expect(unknown.ok).toBe(false);
	});

	it('resolves $selection and $selection.primary', () => {
		const h = new Harness();
		h.ok([solid(0, 30, 'V1'), solid(40, 30, 'V1')]);
		const ids = h.clips('V1').map((c) => c.id);
		h.ok([{ type: 'clip.update', clipIds: '$selection', patch: { label: 'rose' } }], {
			ctx: { selection: { clips: ids, primaryClip: ids[1]! } },
		});
		expect(h.clips('V1').every((c) => c.label === 'rose')).toBe(true);
		h.ok([{ type: 'clip.lift', clipIds: ['$selection.primary'] }], {
			ctx: { selection: { clips: ids, primaryClip: ids[1]! } },
		});
		expect(h.clips('V1').map((c) => c.id)).toEqual([ids[0]]);
	});

	it('does not substitute $-strings in text content', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: '$5 off' } }]);
		const id = (r.results[0] as { clipId: string }).clipId;
		expect((h.seq.clips[id] as unknown as { content: { text: string } }).content.text).toBe('$5 off');
	});
});

describe('catalog (ARCHITECTURE §5.3)', () => {
	it('registers every M1 and M2 command type', () => {
		const expected = [
			'project.rename',
			'project.updateSettings',
			'bin.create',
			'item.rename',
			'item.setLabel',
			'item.move',
			'item.delete',
			'item.setMarks',
			'media.register',
			'media.relink',
			'sequence.create',
			'sequence.updateSettings',
			'sequence.setInOut',
			'sequence.setWorkArea',
			'marker.add',
			'marker.update',
			'marker.remove',
			'track.add',
			'track.remove',
			'track.update',
			'clip.place',
			'clip.addText',
			'clip.addSolid',
			'clip.addMotionGraphic',
			'clip.move',
			'clip.trim',
			'clip.split',
			'clip.lift',
			'clip.extract',
			'clip.update',
			'param.set',
			'param.setAnimated',
			'clip.slip',
			'clip.slide',
			'clip.setSpeed',
			'clip.duplicate',
			'clip.link',
			'clip.unlink',
			'clip.fitToFrame',
			'range.lift',
			'range.extract',
			'gap.close',
			'keyframe.add',
			'keyframe.update',
			'keyframe.remove',
			'keyframe.move',
			'keyframe.setInterpolation',
			'keyframes.prune',
			'effect.add',
			'effect.remove',
			'effect.reorder',
			'effect.setEnabled',
			'transition.add',
			'transition.update',
			'transition.remove',
			'transition.applyDefault',
			'clip.nest',
			'clip.addCaptions',
			'clip.addComposition',
			'clip.addAdjustment',
			'clip.replaceSource',
			'transcript.create',
			'transcript.editText',
			'transcript.setBreak',
			'synthetic.create',
			'synthetic.update',
			'media.derive',
			'media.removeUnused',
			'sequence.duplicate',
			'sequence.delete',
		];
		for (const t of expected) expect(COMMAND_TYPES).toContain(t);
		expect(COMMAND_CATALOG['clip.slip'].owner).toBe('WP-2B');
		expect(COMMAND_CATALOG['effect.add'].owner).toBe('WP-2D');
		expect(COMMAND_CATALOG['keyframe.add'].owner).toBe('WP-2D');
		expect(COMMAND_CATALOG['transition.add'].owner).toBe('M2');
		expect(COMMAND_CATALOG['clip.place'].owner).toBe('WP-00');
	});

	it('stubs refuse with E_NOT_IMPLEMENTED', () => {
		const h = new Harness();
		h.ok([solid(0, 30, 'V1')]);
		for (const cmd of [{ type: 'sequence.delete', sequenceId: h.seqId }]) {
			const r = h.tx([cmd]);
			expect(r.ok, cmd.type).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code, cmd.type).toBe('E_NOT_IMPLEMENTED');
		}
	});

	it('flags approval-gated commands (S01:AGT-011)', () => {
		expect(requiresApproval([{ type: 'track.remove' }])).toBe(true);
		expect(requiresApproval([{ type: 'item.delete', force: true }])).toBe(true);
		expect(requiresApproval([{ type: 'clip.move' }])).toBe(false);
	});

	it('exports JSON Schemas for every command (S01:AGT-002)', () => {
		const tpl = createStaticMgRegistry([
			{
				id: 'lower-third',
				version: 1,
				name: 'Lower third',
				category: 'Titles',
				paramsSchema: z.object({ title: z.string() }),
				defaults: { title: 'Name' },
				introFrames: 15,
				outroFrames: 15,
				canvasDefault: 'sequence',
			},
		]);
		const s = exportAgentSchema(defaultRegistries(tpl));
		expect(Object.keys(s.commands)).toHaveLength(COMMAND_TYPES.length);
		expect(s.commands['clip.place'].schema.type).toBe('object');
		expect(s.mgTemplates[0]!.paramsSchema.type).toBe('object');
		expect(s.effects.map((e) => e.id)).toContain('jasper.crop');
		expect(s.errorCodes).toContain('E_SYNC_CONFLICT');
		expect(JSON.parse(JSON.stringify(s)).protocol).toBe('jasper.tx/1');
		// `implemented` reflects the handler, not the owner: wave-2 handlers are live, stubs are not.
		expect(s.commands['clip.place'].implemented).toBe(true);
		expect(s.commands['clip.slip'].implemented).toBe(true); // WP-2B
		expect(s.commands['effect.add'].implemented).toBe(true); // WP-2D
		expect(s.commands['sequence.delete'].implemented).toBe(false);
		expect(s.commands['clip.nest'].implemented).toBe(false); // M2
	});
});

describe('project, media, markers, tracks', () => {
	it('bins, moves, cycles and deletes items; in-use media needs force', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'bin.create', name: 'A', ref: '$a' },
			{ type: 'bin.create', name: 'B', parentBinId: '$a', ref: '$b' },
		]);
		const cyc = h.tx([{ type: 'item.move', itemIds: [r.refs.$a], toBinId: r.refs.$b }]);
		expect(cyc.ok).toBe(false);
		if (!cyc.ok) expect(cyc.errors[0]!.code).toBe('E_CYCLE');
		const mediaId = h.registerVideo({ seconds: 2 });
		const itemId = Object.values(h.doc.items).find((i) => i.kind === 'media')!.id;
		h.ok([
			{ type: 'item.move', itemIds: [itemId], toBinId: r.refs.$b },
			{ type: 'clip.place', source: { projectItemId: itemId }, at: 0 },
		]);
		const refuse = h.tx([{ type: 'item.delete', itemIds: [r.refs.$a] }]);
		expect(refuse.ok).toBe(false);
		if (!refuse.ok) expect(refuse.errors[0]!.code).toBe('E_IN_USE');
		h.ok([{ type: 'item.delete', itemIds: [r.refs.$a], force: true }]);
		expect(h.doc.media[mediaId]).toBeUndefined();
		expect(Object.keys(h.seq.clips)).toHaveLength(0);
	});

	it('source marks drive clip.place ranges (S01:PRJ-005)', () => {
		const h = new Harness();
		h.registerVideo({ seconds: 10 });
		const itemId = Object.values(h.doc.items).find((i) => i.kind === 'media')!.id;
		h.ok([{ type: 'item.setMarks', itemId, in: { seconds: 1 }, out: { seconds: 3 } }]);
		h.ok([{ type: 'clip.place', source: { projectItemId: itemId }, at: 0 }]);
		expect(h.spans('V1')).toEqual([[0, 60]]);
		expect(h.clips('V1')[0]!.sourceIn).toBe(705_600_000);
	});

	it('markers on sequences and clips; tracks add/remove/update', () => {
		const h = new Harness();
		h.ok([
			solid(0, 60, 'V1'),
			{ type: 'marker.add', frame: 50, name: 'b' },
			{ type: 'marker.add', frame: 10, name: 'a', color: 'rose' },
		]);
		expect(h.seq.markers.map((m) => m.name)).toEqual(['a', 'b']);
		const clipId = h.clips('V1')[0]!.id;
		h.ok([{ type: 'marker.add', clipId, frame: 20, name: 'clip marker' }]);
		expect(h.clips('V1')[0]!.markers[0]!.flicks).toBe(20 * 23_520_000);
		const mk = h.seq.markers[0]!.id;
		h.ok([
			{ type: 'marker.update', markerId: mk, frame: 70 },
			{ type: 'marker.remove', markerIds: [h.seq.markers[1]!.id] },
		]);
		expect(h.seq.markers.map((m) => [m.name, m.frame])).toEqual([['a', 70]]);
		const add = h.ok([{ type: 'track.add', kind: 'video', index: 0, count: 2 }]);
		expect(h.seq.videoTracks).toHaveLength(5);
		expect(h.seq.videoTracks[0]!.id).toBe((add.results[0] as { trackIds: string[] }).trackIds[0]);
		const rm = h.tx([{ type: 'track.remove', trackIds: ['V3'] }]);
		expect(rm.ok).toBe(false);
		h.ok([{ type: 'track.remove', trackIds: ['V3'], force: true }]);
		expect(Object.keys(h.seq.clips)).toHaveLength(0);
		h.ok([{ type: 'track.update', trackId: 'A1', patch: { mute: true, volumeDb: -6, pan: 20 } }]);
		expect(h.seq.audioTracks[0]!.volumeDb!.value).toBe(-6);
		const bad = h.tx([{ type: 'track.update', trackId: 'V1', patch: { mute: true } }]);
		expect(bad.ok).toBe(false);
		const last = h.tx([{ type: 'track.remove', trackIds: h.seq.audioTracks.map((t) => t.id) }]);
		expect(last.ok).toBe(false);
	});

	it('param.set validates, clamps and supports effects, tracks and master', () => {
		const h = new Harness();
		h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'T' } }]);
		const id = h.clips('V1')[0]!.id;
		const r = h.ok([{ type: 'param.set', target: ['clip', id, 'opacity'], value: 150 }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect((h.seq.clips[id] as unknown as { opacity: { value: number } }).opacity.value).toBe(100);
		h.ok([
			{ type: 'param.set', target: ['clip', id, 'text', 'sizePx'], value: 64 },
			{ type: 'param.set', target: ['clip', id, 'blendMode'], value: 'screen' },
		]);
		expect(
			(h.seq.clips[id] as unknown as { content: { style: { sizePx: number } } }).content.style.sizePx,
		).toBe(64);
		const bad = h.tx([{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: 'left' }]);
		expect(bad.ok).toBe(false);
		h.ok([
			{ type: 'param.set', target: ['track', 'A1', 'volumeDb'], value: -3 },
			{ type: 'param.set', target: ['master', 'volumeDb'], value: -1 },
		]);
		expect(h.seq.master.volumeDb.value).toBe(-1);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'transform', 'rotation'],
				animated: true,
				at: { frames: 5 },
			},
			{ type: 'param.set', target: ['clip', id, 'transform', 'rotation'], value: 90, at: { frames: 25 } },
		]);
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'transform', 'rotation'],
				animated: false,
				at: { frames: 15 },
			},
		]);
		const rot = (
			h.seq.clips[id] as unknown as { transform: { rotation: { value: number; keyframes: unknown[] } } }
		).transform.rotation;
		expect(rot.keyframes).toHaveLength(0);
		expect(rot.value).toBeCloseTo(45, 6);
	});

	it('clip.update edits text and motion-graphic params through the template registry', () => {
		const mg = createStaticMgRegistry([
			{
				id: 'lower-third',
				version: 1,
				name: 'Lower third',
				category: 'Titles',
				paramsSchema: z.object({ title: z.string().min(1), accent: z.array(z.number()).length(4) }),
				defaults: { title: 'Name', accent: [1, 0, 0, 1] },
				introFrames: 15,
				outroFrames: 15,
				canvasDefault: 'sequence',
			},
		]);
		const h = new Harness({ ctx: { registries: defaultRegistries(mg) } });
		const r = h.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 150,
				track: 'V2',
				template: { id: 'lower-third', version: 1 },
				params: { title: 'Ana' },
			},
		]);
		const id = (r.results[0] as { clipId: string }).clipId;
		expect((h.seq.clips[id] as unknown as { params: { title: string; accent: number[] } }).params).toEqual({
			title: 'Ana',
			accent: [1, 0, 0, 1],
		});
		const bad = h.tx([{ type: 'clip.update', clipId: id, patch: { params: { title: '' } } }]);
		expect(bad.ok).toBe(false);
		h.ok([{ type: 'clip.update', clipId: id, patch: { params: { title: 'Bo' }, name: 'LT' } }]);
		expect((h.seq.clips[id] as unknown as { params: { title: string } }).params.title).toBe('Bo');
		const unknown = h.tx([
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 10,
				track: 'V3',
				template: { id: 'nope', version: 1 },
			},
		]);
		expect(unknown.ok).toBe(false);
	});

	it('sequence.create from media adopts its settings and places it', () => {
		const h = new Harness();
		const m = h.registerVideo({ width: 1080, height: 1920, fps: { num: 60, den: 1 } });
		const r = h.ok([{ type: 'sequence.create', name: 'Vertical', fromMediaId: m, ref: '$s' }]);
		const seq = h.doc.sequences[r.refs.$s!]!;
		expect([seq.settings.width, seq.settings.height, seq.settings.frameRate.num]).toEqual([1080, 1920, 60]);
		expect(Object.keys(seq.clips)).toHaveLength(2);
	});
});
