// perf-core: the normalizers scoped to what a transaction changed (orphan collection, caption ownership,
// cleanupSequence: src/commands/tx-delta.ts, placement.ts) produce exactly the documents, results and warnings of the
// full scans, on random chains of real commands (linked clips, groups, transitions, captions, deletions).
import fc from 'fast-check';
import { type Draft, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { HandlerContext } from '../src/commands/context.ts';
import { setDeltaScans } from '../src/commands/draft-read.ts';
import { collectOrphans } from '../src/commands/handlers/project.ts';
import { cleanupSequence } from '../src/commands/placement.ts';
import { applyTransaction, createCounterIdSource, type ProjectDocument } from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const FUZZ = process.env.FUZZ === '1';
const RUNS = FUZZ ? 2_000 : 200;

function start(): { doc: ProjectDocument; seqId: string; media: string[] } {
	const h = new Harness({ seed: 77 });
	const media = [h.registerVideo({ seconds: 12 }), h.registerVideo({ seconds: 6, kind: 'audio' })];
	h.ok([
		{ type: 'clip.place', source: { mediaId: media[0] }, at: 0 },
		{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V2', color: [1, 0, 0, 1] },
		{ type: 'caption.addTrack', name: 'English', language: 'en' },
		{ type: 'caption.add', at: 0, duration: 100, text: 'hello there friend' },
	]);
	return { doc: h.doc, seqId: h.seqId, media };
}

type Step = { k: number; a: number; b: number; c: number };

function command(doc: ProjectDocument, seqId: string, media: string[], s: Step): unknown {
	const seq = doc.sequences[seqId]!;
	const clips = Object.values(seq.clips).sort((x, y) => x.id.localeCompare(y.id));
	const pick = (i: number) => clips[i % Math.max(1, clips.length)]?.id ?? 'clp_0000000000000000';
	const caps = clips.filter((c) => c.kind === 'captions');
	const cap = caps[s.a % Math.max(1, caps.length)]?.id ?? pick(s.a);
	const items = Object.values(doc.items)
		.filter((it) => it.kind !== 'sequence')
		.map((it) => it.id)
		.sort();
	switch (s.k % 16) {
		case 0:
			return {
				type: 'clip.place',
				source: { mediaId: media[s.a % 2] },
				at: s.b % 600,
				mode: s.c % 2 ? 'insert' : 'overwrite',
			};
		case 1:
			return {
				type: 'clip.addSolid',
				at: s.b % 600,
				duration: 1 + (s.c % 90),
				track: `V${1 + (s.a % 3)}`,
				color: [0, 1, 0, 1],
			};
		case 2:
			return {
				type: 'clip.move',
				clipIds: [pick(s.a), pick(s.a + 3)],
				deltaFrames: (s.b % 160) - 80,
				mode: s.c % 2 ? 'insert' : 'overwrite',
			};
		case 3:
			return {
				type: 'clip.trim',
				clipId: pick(s.a),
				edge: s.b % 2 ? 'in' : 'out',
				deltaFrames: (s.c % 60) - 30,
				mode: s.b % 3 ? 'regular' : 'ripple',
			};
		case 4:
			return { type: 'clip.split', at: s.b % 600, scope: 'all-unlocked' };
		case 5:
			return { type: 'clip.lift', clipIds: [pick(s.a)] };
		case 6:
			return { type: 'clip.extract', clipIds: [pick(s.a)], syncConflict: 'cut' };
		case 7:
			return { type: 'clip.group', clipIds: [pick(s.a), pick(s.b)] };
		case 8:
			return { type: 'clip.ungroup', clipIds: [pick(s.a)] };
		case 9:
			return { type: 'clip.unlink', clipIds: [pick(s.a)] };
		case 10:
			return {
				type: 'transition.add',
				clipId: pick(s.a),
				edge: s.b % 2 ? 'in' : 'out',
				effectId: 'jasper.cross-dissolve',
				duration: 1 + (s.c % 20),
			};
		case 11:
			return { type: 'caption.split', clipId: cap, at: s.b % 300 };
		case 12:
			return { type: 'clip.duplicate', clipIds: [pick(s.a)] };
		case 13:
			return { type: 'item.delete', itemIds: [items[s.a % items.length]], force: true };
		case 14:
			return { type: 'param.set', target: ['clip', pick(s.a), 'opacity'], value: s.b % 100 };
		default:
			return { type: 'caption.add', at: s.b % 600, duration: 1 + (s.c % 60), text: 'more words here' };
	}
}

describe('delta-scoped normalizers (perf-core)', () => {
	it(`equal the full scans on ${RUNS} random command chains`, () => {
		const { doc: base, seqId, media } = start();
		let applied = 0;
		fc.assert(
			fc.property(
				fc.array(fc.record({ k: fc.nat(), a: fc.nat(500), b: fc.nat(1000), c: fc.nat(1000) }), {
					minLength: 1,
					maxLength: 10,
				}),
				(steps) => {
					let fast = base;
					let slow = base;
					const fastIds = createCounterIdSource(5000);
					const slowIds = createCounterIdSource(5000);
					for (const [i, s] of steps.entries()) {
						const tx = {
							label: 'x',
							origin: 'user' as const,
							sequenceId: seqId,
							commands: [command(fast, seqId, media, s)],
						};
						setDeltaScans(true);
						const a = applyTransaction(fast, tx, makeCtx({ revision: i }, fastIds));
						setDeltaScans(false);
						const b = applyTransaction(slow, tx, makeCtx({ revision: i }, slowIds));
						setDeltaScans(true);
						expect(a.result).toEqual(b.result);
						expect(a.document).toEqual(b.document);
						if (a.result.ok) applied++;
						fast = a.document;
						slow = b.document;
					}
				},
			),
			{ numRuns: RUNS, seed: FUZZ ? undefined : 20261008 },
		);
		expect(applied).toBeGreaterThan(RUNS);
	}, 600_000);

	// Raw edits no command makes today, but the normalizers must still treat like the full scans.
	const both = (doc: ProjectDocument, recipe: (d: Draft<ProjectDocument>) => void) => {
		const run = (on: boolean) => {
			setDeltaScans(on);
			try {
				return produce(doc, recipe);
			} finally {
				setDeltaScans(true);
			}
		};
		const a = run(true);
		expect(a).toEqual(run(false));
		return a;
	};
	const grouped = () => {
		const h = new Harness({ seed: 3 });
		h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 40, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
			{ type: 'clip.addSolid', at: 80, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
		]);
		const ids = h.clips('V1').map((c) => c.id);
		h.ok([{ type: 'clip.group', clipIds: ids }]);
		return { h, ids, gid: Object.keys(h.seq.groups)[0]! };
	};
	const hc = (h: Harness) => new HandlerContext(makeCtx({}, h.ids), { origin: 'user' }, new Map());

	it('collect an unused synthetic added in the transaction', () => {
		const { h } = grouped();
		const syn = Object.values(h.doc.synthetics)[0]!;
		const out = both(h.doc, (d) => {
			d.synthetics.syn_00000000000000ZZ = { ...syn, id: 'syn_00000000000000ZZ' } as never;
			collectOrphans(d);
		});
		expect(out.synthetics.syn_00000000000000ZZ).toBeUndefined();
	});

	it('clear the members of a group removed in the transaction', () => {
		const { h, ids, gid } = grouped();
		const out = both(h.doc, (d) => {
			delete d.sequences[h.seqId]!.groups[gid];
			cleanupSequence(d.sequences[h.seqId]!, hc(h));
		});
		expect(ids.map((id) => out.sequences[h.seqId]!.clips[id]!.groupId)).toEqual([null, null, null]);
	});

	it('drop a clip that left its group from the group', () => {
		const { h, ids, gid } = grouped();
		const out = both(h.doc, (d) => {
			d.sequences[h.seqId]!.clips[ids[0]!]!.groupId = null;
			cleanupSequence(d.sequences[h.seqId]!, hc(h));
		});
		expect(out.sequences[h.seqId]!.groups[gid]!.members).toEqual(ids.slice(1));
	});

	it('keep a synthetic its project item still uses when its last clip goes', () => {
		const h = new Harness({ seed: 9 });
		h.ok([{ type: 'synthetic.create', kind: 'black-video' }]);
		const item = Object.values(h.doc.items).find((it) => it.kind === 'synthetic')!;
		h.ok([{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
		const clip = h.clips('V1')[0]!.id;
		h.ok([{ type: 'clip.lift', clipIds: [clip] }]);
		expect(h.doc.synthetics[(item as { syntheticId: string }).syntheticId]).toBeDefined();
	});
});
