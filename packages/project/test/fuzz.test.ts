// S01 AC-25: invariants hold under random command fuzzing. Every committed document passes
// INV-001…INV-015, every rejected transaction leaves the document reference unchanged, and handlers
// never produce an invalid document (no E_INVARIANT / E_INTERNAL rejections).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	checkInvariants,
	createRandomIdSource,
	type ProjectDocument,
} from '../src/index.ts';
import { Harness, makeCtx } from './helpers.ts';

const FUZZ = process.env.FUZZ === '1';
const RUNS = FUZZ ? 10_000 : 2_000;

type Abstract =
	| { k: 'place'; media: number; at: number; track: number; insert: boolean; audio: boolean }
	| { k: 'solid'; at: number; dur: number; track: number }
	| { k: 'text'; at: number; dur: number; track: number }
	| { k: 'move'; clip: number; n: number; delta: number; dt: number; insert: boolean; create: boolean }
	| {
			k: 'trim';
			clip: number;
			edge: boolean;
			delta: number;
			ripple: boolean;
			clamp: boolean;
			linked: boolean;
	  }
	| { k: 'split'; at: number; clip: number; all: boolean }
	| { k: 'lift'; clip: number }
	| { k: 'extract'; clip: number; cut: boolean }
	| { k: 'lock'; track: number; audio: boolean; locked: boolean; sync: boolean }
	| { k: 'marker'; at: number }
	| { k: 'inout'; a: number; b: number }
	| { k: 'opacity'; clip: number; v: number; animate: boolean; frame: number }
	| { k: 'addTrack'; audio: boolean }
	| { k: 'update'; clip: number; enabled: boolean };

const frame = fc.integer({ min: 0, max: 900 });
const idx = fc.nat(1000);
const abstract: fc.Arbitrary<Abstract> = fc.oneof(
	fc.record({
		k: fc.constant('place' as const),
		media: fc.nat(2),
		at: frame,
		track: fc.integer({ min: 1, max: 4 }),
		insert: fc.boolean(),
		audio: fc.boolean(),
	}),
	fc.record({
		k: fc.constant('solid' as const),
		at: frame,
		dur: fc.integer({ min: 1, max: 200 }),
		track: fc.integer({ min: 1, max: 4 }),
	}),
	fc.record({
		k: fc.constant('text' as const),
		at: frame,
		dur: fc.integer({ min: 1, max: 200 }),
		track: fc.integer({ min: 1, max: 3 }),
	}),
	fc.record({
		k: fc.constant('move' as const),
		clip: idx,
		n: fc.integer({ min: 1, max: 3 }),
		delta: fc.integer({ min: -150, max: 150 }),
		dt: fc.integer({ min: -2, max: 2 }),
		insert: fc.boolean(),
		create: fc.boolean(),
	}),
	fc.record({
		k: fc.constant('trim' as const),
		clip: idx,
		edge: fc.boolean(),
		delta: fc.integer({ min: -120, max: 120 }),
		ripple: fc.boolean(),
		clamp: fc.boolean(),
		linked: fc.boolean(),
	}),
	fc.record({ k: fc.constant('split' as const), at: frame, clip: idx, all: fc.boolean() }),
	fc.record({ k: fc.constant('lift' as const), clip: idx }),
	fc.record({ k: fc.constant('extract' as const), clip: idx, cut: fc.boolean() }),
	fc.record({
		k: fc.constant('lock' as const),
		track: fc.integer({ min: 1, max: 3 }),
		audio: fc.boolean(),
		locked: fc.boolean(),
		sync: fc.boolean(),
	}),
	fc.record({ k: fc.constant('marker' as const), at: frame }),
	fc.record({ k: fc.constant('inout' as const), a: frame, b: frame }),
	fc.record({
		k: fc.constant('opacity' as const),
		clip: idx,
		v: fc.integer({ min: -20, max: 140 }),
		animate: fc.boolean(),
		frame: fc.integer({ min: 0, max: 100 }),
	}),
	fc.record({ k: fc.constant('addTrack' as const), audio: fc.boolean() }),
	fc.record({ k: fc.constant('update' as const), clip: idx, enabled: fc.boolean() }),
);

function concretize(a: Abstract, doc: ProjectDocument, media: string[]): unknown {
	const seq = Object.values(doc.sequences)[0]!;
	const clips = Object.values(seq.clips).sort((x, y) => x.id.localeCompare(y.id));
	const pick = (i: number) => clips[i % Math.max(1, clips.length)]?.id ?? 'clp_0000000000000000';
	switch (a.k) {
		case 'place':
			return {
				type: 'clip.place',
				source: { mediaId: media[a.media % media.length] },
				at: a.at,
				tracks: { video: `V${a.track}` },
				mode: a.insert ? 'insert' : 'overwrite',
				audio: a.audio,
			};
		case 'solid':
			return { type: 'clip.addSolid', at: a.at, duration: a.dur, track: `V${a.track}`, color: [1, 0, 0, 1] };
		case 'text':
			return {
				type: 'clip.addText',
				at: a.at,
				duration: a.dur,
				track: `V${a.track}`,
				content: { text: 'fuzz' },
			};
		case 'move':
			return {
				type: 'clip.move',
				clipIds: Array.from({ length: a.n }, (_, i) => pick(a.clip + i * 7)),
				deltaFrames: a.delta,
				deltaTracks: a.dt,
				mode: a.insert ? 'insert' : 'overwrite',
				createTracks: a.create,
			};
		case 'trim':
			return {
				type: 'clip.trim',
				clipId: pick(a.clip),
				edge: a.edge ? 'in' : 'out',
				deltaFrames: a.delta,
				mode: a.ripple ? 'ripple' : 'regular',
				clampToSyncLock: a.clamp,
				linked: a.linked,
			};
		case 'split':
			return a.all
				? { type: 'clip.split', at: a.at, scope: 'all-unlocked' }
				: { type: 'clip.split', at: a.at, clipIds: [pick(a.clip)] };
		case 'lift':
			return { type: 'clip.lift', clipIds: [pick(a.clip)] };
		case 'extract':
			return { type: 'clip.extract', clipIds: [pick(a.clip)], syncConflict: a.cut ? 'cut' : 'refuse' };
		case 'lock':
			return {
				type: 'track.update',
				trackId: `${a.audio ? 'A' : 'V'}${a.track}`,
				patch: { locked: a.locked, syncLock: a.sync },
			};
		case 'marker':
			return { type: 'marker.add', frame: a.at, name: 'm' };
		case 'inout':
			return { type: 'sequence.setInOut', in: Math.min(a.a, a.b), out: Math.max(a.a, a.b) + 1 };
		case 'opacity':
			return a.animate
				? {
						type: 'param.setAnimated',
						target: ['clip', pick(a.clip), 'opacity'],
						animated: true,
						at: { frames: a.frame },
					}
				: {
						type: 'param.set',
						target: ['clip', pick(a.clip), 'opacity'],
						value: a.v,
						at: { frames: a.frame },
					};
		case 'addTrack':
			return { type: 'track.add', kind: a.audio ? 'audio' : 'video' };
		case 'update':
			return { type: 'clip.update', clipId: pick(a.clip), patch: { enabled: a.enabled } };
	}
}

describe('AC-25: invariants under random transactions', () => {
	it(`holds for ${RUNS} random runs`, () => {
		const h = new Harness({ seed: 99 });
		const media = [
			h.registerVideo({ seconds: 8 }),
			h.registerVideo({ seconds: 3, audio: false }),
			h.registerVideo({ seconds: 20, kind: 'audio' }),
		];
		h.ok([
			{ type: 'clip.place', source: { mediaId: media[0] }, at: 0 },
			{ type: 'clip.addSolid', at: 100, duration: 150, track: 'V2', color: [0, 0, 0, 1] },
		]);
		const base = h.doc;
		let accepted = 0;
		const ids = createRandomIdSource();
		fc.assert(
			fc.property(
				fc.array(fc.array(abstract, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 }),
				(txs) => {
					let doc = base;
					let revision = 0;
					for (const tx of txs) {
						const commands: unknown[] = [];
						for (const a of tx) commands.push(concretize(a, doc, media));
						const { document, result } = applyTransaction(
							doc,
							{ label: 'fuzz', origin: 'user', commands },
							makeCtx({ revision }, ids),
						);
						if (result.ok) {
							accepted++;
							const issues = checkInvariants(document);
							if (issues.length)
								throw new Error(
									`invariants broken: ${JSON.stringify(issues)} after ${JSON.stringify(commands)}`,
								);
							doc = document;
							revision = result.revision;
						} else {
							if (document !== doc) throw new Error('rejected transaction changed the document');
							const bad = result.errors.filter((e) => e.code === 'E_INVARIANT' || e.code === 'E_INTERNAL');
							if (bad.length)
								throw new Error(
									`handler produced an invalid document: ${JSON.stringify(bad)} for ${JSON.stringify(commands)}`,
								);
						}
					}
				},
			),
			{ numRuns: RUNS, seed: FUZZ ? undefined : 20260930 },
		);
		expect(accepted).toBeGreaterThan(0);
	}, 600_000);
});
