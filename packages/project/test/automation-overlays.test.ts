// Overlay passes of editing automation (spec 15 EA-023…EA-026, EA-030, EA-032, EA-050): reactions (triggers, snapping
// to cuts within 0.5 s, measured slots, flip on the left, scale, wobble, rate cap, no overlaps, subtitle regions read
// defensively, face tracking, folder assets, alternatives), overlay slides (free edges only, one-sided Smooth Slide,
// direction / easing weights), music beds (switch at the first cut after 52 s, −33 dB, intro step, ducking), stingers
// (loudness peaks over the local median, "!" phrases, snapping, rate) and the signals they read; proposals (accept =
// one transaction, invariants), Refresh and Reroll; determinism and fast-check properties.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	AUTOMATION_PARAM_SCHEMAS,
	type Clip,
	checkInvariants,
	createProposal,
	defaultRegistries,
	type EffectInstance,
	type FolderAsset,
	flicksPerFrame,
	loudPeaks,
	markerTriggers,
	nearestCut,
	normalizeTriggerWord,
	type Proposal,
	type ProposalContext,
	parsePassParams,
	passDraft,
	passItems,
	planAccept,
	planMusicBed,
	planReactions,
	planSlides,
	planStingers,
	REACTION_SLOTS,
	refreshAutomationItems,
	refreshProposalItems,
	resolveVideoTransitions,
	sfxNeeds,
	subtitleRegions,
	wordLists,
	wordTriggers,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const NOW = '2026-10-26T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

function propose(h: Harness, draft: unknown): Proposal {
	const r = createProposal(
		h.doc,
		draft,
		{ id: nextId(), projectId: h.doc.projectId, author: { agent: 'test' }, now: NOW, revision: h.revision },
		{ ...CTX, revision: h.revision },
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors).slice(0, 3000));
	return r.proposal;
}

function acceptAll(h: Harness, p: Proposal) {
	const plan = planAccept(h.doc, p, 'all', { agent: 'test' }, { ...CTX, revision: h.revision });
	if (!plan.ok || !plan.composed)
		throw new Error(JSON.stringify(plan.ok ? 'nothing' : plan.errors).slice(0, 3000));
	return h.ok(plan.composed.tx.commands, { label: plan.composed.tx.label });
}

/** Clips of `lengths` frames on V1 alternating two sources (every boundary a cut); vertical with `vertical`. */
function edit(lengths: number[], opts: { vertical?: boolean } = {}) {
	const h = new Harness(opts.vertical ? { preset: 'vertical-1080x1920-30' } : {});
	const size = opts.vertical ? { width: 1080, height: 1920 } : {};
	const a = h.registerVideo({ seconds: 36_000, audio: false, ...size });
	const b = h.registerVideo({ seconds: 36_000, audio: false, ...size });
	const F = flicksPerFrame(h.seq.settings.frameRate);
	let at = 0;
	const cuts: number[] = [];
	const r = h.ok(
		lengths.map((len, i) => {
			const c = {
				type: 'clip.place',
				source: { mediaId: i % 2 ? b : a },
				at,
				tracks: { video: 'V1' },
				sourceRange: { in: { flicks: at * F }, out: { flicks: (at + len) * F } },
			};
			at += len;
			if (i < lengths.length - 1) cuts.push(at);
			return c;
		}),
	);
	return { h, F, cuts, ids: r.results.map((x) => (x as { clipIds: string[] }).clipIds[0]!), end: at };
}

/** Transcript words on A1 (an audio media with a transcript): [text, startFrame, endFrame][]. */
function words(h: Harness, list: [string, number, number][], language = 'es') {
	const F = flicksPerFrame(h.seq.settings.frameRate);
	const aud = (
		h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio', seconds: 3600 }) }]).results[0] as {
			mediaId: string;
		}
	).mediaId;
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: aud },
			at: 0,
			tracks: { audio: 'A1' },
			video: false,
			audio: true,
			// as long as the words (never longer than the picture of the tests)
			sourceRange: { in: { flicks: 0 }, out: { flicks: (Math.max(...list.map((w) => w[2])) + 1) * F } },
		},
		{
			type: 'transcript.create',
			mediaId: aud,
			language,
			origin: 'manual',
			words: list.map(([text, a, b]) => ({ text, start: a * F, end: b * F })),
		},
	]);
	return aud;
}

/** A bin with `n` images (`names`); returns the media ids. */
function reactionBin(h: Harness, names: string[], size = { width: 400, height: 400 }) {
	const r = h.ok([
		{ type: 'bin.create', name: 'Reactions', ref: '$b' },
		...names.map((n, i) => ({
			type: 'media.register',
			asset: { ...videoAsset({ kind: 'image', ...size }), originalName: `${n}.png` },
			binId: '$b',
			name: n,
			ref: `$m${i}`,
		})),
	]);
	return r.results.slice(1).map((x) => (x as { mediaId: string }).mediaId);
}

function markers(h: Harness, list: [number, string][]) {
	h.ok(list.map(([frame, name]) => ({ type: 'marker.add', frame, name })));
}

const reactionsOf = (h: Harness) =>
	Object.values(h.seq.clips)
		.filter((c) => c.kind === 'still')
		.sort((a, b) => a.start - b.start);
const fx = (c: Clip) => ((c as { effects?: EffectInstance[] }).effects ?? []).map((e) => e.effectId);

// ---------------------------------------------------------------------------------------------------------------

describe('signals', () => {
	it('normalises words (case, accents, punctuation) and finds calls to action, exclamations and "!" words', () => {
		expect(normalizeTriggerWord('¡Suscríbete!')).toBe('suscribete');
		const w = [
			['Hola', 0, 10],
			['dale', 10, 20],
			['like', 20, 30],
			['y', 30, 35],
			['¡SUSCRÍBETE!', 40, 60],
			['madre', 70, 80],
			['mía', 80, 90],
			['vale!', 100, 110],
		].map(([text, start, end], index) => ({
			text: text as string,
			start: start as number,
			end: end as number,
			clipId: 'c',
			index,
		}));
		const t = wordTriggers(w, wordLists('es'));
		expect(t.map((x) => [x.kind, x.frame, x.text])).toEqual([
			['cta', 10, 'dale like'],
			['cta', 40, '¡SUSCRÍBETE!'],
			['exclamation', 70, 'madre mía'],
			['exclamation', 100, 'vale!'],
		]);
		// editable lists replace the built-ins
		expect(wordTriggers(w, wordLists('es', { cta: ['hola'], exclamations: [] })).map((x) => x.text)).toEqual([
			'Hola',
			'¡SUSCRÍBETE!',
			'vale!',
		]);
	});

	it('markers match by name (case / accents ignored) or a picture name', () => {
		const { h } = edit([300]);
		markers(h, [
			[10, 'Reacción aquí'],
			[20, 'reaction'],
			[30, ''],
			[40, 'Happy'],
			[50, 'other'],
		]);
		expect(markerTriggers(h.seq, 'reaction', ['happy']).map((m) => m.frame)).toEqual([20, 40]);
		expect(markerTriggers(h.seq, 'reacc').map((m) => m.frame)).toEqual([10]);
	});

	it('nearestCut: the nearest cut within the distance (property)', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 5000 }), { maxLength: 60 }),
				fc.integer({ min: 0, max: 5000 }),
				fc.integer({ min: 0, max: 200 }),
				(raw, f, d) => {
					const cuts = [...raw].sort((a, b) => a - b);
					const got = nearestCut(cuts, f, d);
					const within = cuts.filter((c) => Math.abs(c - f) <= d);
					if (!within.length) return got === null;
					const best = Math.min(...within.map((c) => Math.abs(c - f)));
					return got !== null && Math.abs(got - f) === best && within.includes(got);
				},
			),
		);
	});

	it('loud peaks: runs ≥ threshold over the local median, silence never peaks', () => {
		const lufs: (number | null)[] = Array.from({ length: 300 }, (_, k) => (k % 7 === 0 ? -24.5 : -25));
		for (let k = 100; k < 105; k++) lufs[k] = -16; // +9 LU
		for (let k = 200; k < 203; k++) lufs[k] = -21; // +4 LU: under 6
		for (let k = 250; k < 260; k++) lufs[k] = null; // silence
		const p = loudPeaks({ startSec: 0, hopSec: 0.1, lufs }, 30, { thresholdLu: 6, windowSec: 10 });
		expect(p).toHaveLength(1);
		expect(p[0]).toMatchObject({ start: 300, end: 315, excessLu: 9 });
		expect(p[0]!.peak).toBeGreaterThanOrEqual(300);
	});
});

describe('reactions (EA-023)', () => {
	it('places pictures on triggers: on a cut within 0.5 s, else on the word; slot, flip, scale, wobble, length', () => {
		const { h, cuts } = edit([90, 90, 90, 90, 90, 300]);
		const media = reactionBin(h, ['Happy', 'Surprised', 'Thinking', 'Serious']);
		// "suscríbete" 10 frames after the cut at 90 (≤ 15 = 0.5 s) → on the cut; "wow" at 200, 20 frames after 180 → word
		words(h, [
			['suscríbete', 100, 110],
			['wow', 200, 210],
			['nada', 300, 310],
		]);
		const plan = planReactions(h.doc, null, { assets: { bin: 'Reactions' }, seed: 3, maxPerMinute: 12 });
		expect(plan.assets.map((a) => a.key)).toEqual(media);
		// the landscape default allows one reaction a minute (the measured 0.9 /min)
		expect(planReactions(h.doc, null, { assets: { bin: 'Reactions' }, seed: 3 }).reactions).toHaveLength(1);
		expect(plan.reactions.map((r) => [r.frame, r.end - r.frame, r.trigger.kind])).toEqual([
			[cuts[0], 78, 'cta'],
			[200, 78, 'exclamation'],
		]);
		expect(plan.reactions[0]!.cut).toEqual({ trackId: h.seq.videoTracks[0]!.id, frame: 90 });
		expect(plan.reactions[1]!.cut).toBeNull();
		for (const r of plan.reactions) {
			expect(REACTION_SLOTS.landscape.some((s) => s.x === r.slot.x && s.y === r.slot.y)).toBe(true);
			expect(r.flip).toBe(r.slot.flip === true);
			expect(r.choice.scale).toBeGreaterThanOrEqual(60);
			expect(r.choice.scale).toBeLessThanOrEqual(65);
			expect(r.alternatives).toHaveLength(3);
			expect(r.alternatives.map((a) => a.asset.key)).not.toContain(r.choice.asset.key);
		}
		// a call to action prefers a picture named for it when there is one; otherwise any (seeded)
		expect(plan.triggers).toMatchObject({ cta: 1, exclamation: 1, marker: 0, hidden: 0 });
		expect(plan.reactionTrack).toMatchObject({ create: true, name: 'Reactions' });
	});

	it('is deterministic for a seed and changes with it; Reroll draws again', () => {
		const { h } = edit([120, 120, 120, 120, 600]);
		reactionBin(h, ['A', 'B', 'C', 'D', 'E']);
		words(h, [
			['wow', 50, 60],
			['increíble', 200, 210],
			['jajaja', 400, 410],
		]);
		const a = planReactions(h.doc, null, { assets: { bin: 'Reactions' }, seed: 9 });
		const b = planReactions(h.doc, null, { assets: { bin: 'Reactions' }, seed: 9 });
		expect(JSON.stringify(a.reactions)).toBe(JSON.stringify(b.reactions));
		const draws = new Set<string>();
		for (let s = 1; s < 12; s++)
			draws.add(
				planReactions(h.doc, null, { assets: { bin: 'Reactions' }, seed: s })
					.reactions.map((r) => `${r.choice.asset.key}@${r.slot.index}`)
					.join(','),
			);
		expect(draws.size).toBeGreaterThan(3);
	});

	it('markers win the rate budget; at most maxPerMinute in any minute; reactions never overlap', () => {
		const { h } = edit([900, 900, 900, 900]);
		reactionBin(h, ['Happy', 'Money']);
		const list: [string, number, number][] = [];
		for (let f = 30; f < 3500; f += 70) list.push(['wow', f, f + 5]);
		words(h, list);
		markers(h, [
			[1000, 'reaction'],
			[1500, 'Money'],
		]);
		const plan = planReactions(h.doc, null, { assets: { bin: 'Reactions' }, maxPerMinute: 2, seed: 1 });
		const starts = plan.reactions.map((r) => r.frame);
		for (let i = 0; i + 2 < starts.length; i++)
			expect(starts[i + 2]! - starts[i]!).toBeGreaterThanOrEqual(1800);
		for (let i = 1; i < plan.reactions.length; i++)
			expect(plan.reactions[i]!.frame).toBeGreaterThanOrEqual(plan.reactions[i - 1]!.end + 15);
		const kinds = plan.reactions.filter((r) => r.trigger.kind === 'marker');
		expect(kinds.map((r) => r.frame)).toEqual([1000, 1500]);
		// the marker named after a picture gets that picture
		expect(kinds[1]!.choice.asset.name).toBe('Money');
		expect(plan.skipped.some((s) => s.code === 'rate')).toBe(true);
	});

	it('property: any triggers and cap keep the rate, no overlap, the range and the frame', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 8000 }), { maxLength: 40 }),
				fc.integer({ min: 1, max: 15 }),
				fc.boolean(),
				fc.integer({ min: 0, max: 1000 }),
				(frames, cap, vertical, seed) => {
					const { h } = edit([3000, 3000, 3000], { vertical });
					reactionBin(h, ['a', 'b', 'c']);
					markers(
						h,
						frames.map((f) => [f, 'reaction'] as [number, string]),
					);
					const plan = planReactions(h.doc, null, { assets: { bin: 'Reactions' }, maxPerMinute: cap, seed });
					const s = plan.reactions.map((r) => r.frame);
					for (let i = 0; i + cap < s.length; i++) if (s[i + cap]! - s[i]! < 1800) return false;
					for (let i = 1; i < plan.reactions.length; i++)
						if (plan.reactions[i]!.frame < plan.reactions[i - 1]!.end) return false;
					return plan.reactions.every((r) => r.end <= 9000 && r.end > r.frame);
				},
			),
			{ numRuns: 40 },
		);
	});

	it('keeps clear of subtitles when subtitle groups exist (read defensively)', () => {
		const { h } = edit([600], { vertical: true });
		reactionBin(h, ['A', 'B']);
		markers(h, [[100, 'reaction']]);
		// a subtitle text clip over the bottom of the frame, member of a caption group
		const r = h.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 600,
				track: 'V2',
				content: { text: 'subtitle' },
				box: { width: 1080, height: 700 },
				transform: { position: [540, 1600] },
				ref: '$t',
			},
		]);
		const tid = (r.results[0] as { clipId: string }).clipId;
		const without = planReactions(h.doc, null, { assets: { bin: 'Reactions' } });
		expect(without.reactions).toHaveLength(1); // no group: subtitles are not known as such
		// spec 13's fields, as the subtitles work package writes them
		const seq = h.doc.sequences[h.seqId]!;
		const doc = {
			...h.doc,
			sequences: {
				...h.doc.sequences,
				[h.seqId]: {
					...seq,
					captionGroups: { grp_1: { name: 'Subtitles' } },
					clips: { ...seq.clips, [tid]: { ...seq.clips[tid]!, caption: { groupId: 'grp_1', words: [] } } },
				},
			},
		} as typeof h.doc;
		expect(subtitleRegions(doc, doc.sequences[h.seqId]!)).toHaveLength(1);
		const withSubs = planReactions(doc, null, { assets: { bin: 'Reactions' } });
		expect(withSubs.reactions).toHaveLength(0);
		expect(withSubs.skipped.map((s) => s.code)).toEqual(['subtitles']);
		// a slot above the subtitles is used instead
		const high = planReactions(doc, null, {
			assets: { bin: 'Reactions' },
			slots: [...REACTION_SLOTS.vertical, { x: 0.5, y: 0.3, name: 'Top' }],
		});
		expect(high.reactions.map((x) => x.slot.name)).toEqual(['Top']);
		// junk caption groups never throw
		const junk = {
			...doc,
			sequences: { [h.seqId]: { ...doc.sequences[h.seqId]!, captionGroups: 'x' } },
		} as never;
		expect(() => planReactions(junk, null, { assets: { bin: 'Reactions' } })).not.toThrow();
	});

	it('"speaker not visible" from face tracking; without it a warning', () => {
		const { h, ids } = edit([300]);
		reactionBin(h, ['A']);
		const none = planReactions(h.doc, null, {
			assets: { bin: 'Reactions' },
			triggers: { words: false, markers: false, speakerNotVisible: true },
		});
		expect(none.warnings.map((w) => w.code)).toContain('W_NO_FACES');
		// a faces roto at 30 fps: a face on frames 0–89 and 150–299, none on 90–149
		const present = Array.from({ length: 300 }, (_, i) => (i >= 90 && i < 150 ? 0 : 1));
		const seq = h.doc.sequences[h.seqId]!;
		const clip = seq.clips[ids[0]!]!;
		const doc = {
			...h.doc,
			sequences: {
				[h.seqId]: {
					...seq,
					clips: {
						...seq.clips,
						[clip.id]: {
							...clip,
							rotos: [
								{
									kind: 'faces',
									rate: { num: 30, den: 1 },
									result: {
										faces: [{ startFrame: 0, poses: present.flatMap(() => [960, 540, 200, 0]), present }],
									},
								},
							],
						},
					},
				},
			},
		} as never;
		const plan = planReactions(doc, null, {
			assets: { bin: 'Reactions' },
			triggers: { words: false, markers: false, speakerNotVisible: true },
		});
		expect(plan.reactions.map((r) => [r.frame, r.trigger.kind])).toEqual([[90, 'hidden']]);
	});

	it('refuses bad requests: no assets, unknown bin, unknown keys', () => {
		const { h } = edit([300]);
		expect(() => planReactions(h.doc, null, {})).toThrow(/assets/);
		expect(() => planReactions(h.doc, null, { assets: {} })).toThrow(/bin, a folder or media/);
		expect(() => planReactions(h.doc, null, { assets: { bin: 'Nope' } })).toThrow(/Bin not found/);
		expect(() => parsePassParams('reactions', { assets: { bin: 'x' }, nope: 1 })).toThrow(/nope/);
		for (const pass of ['reactions', 'slides', 'music', 'stingers'] as const)
			expect(AUTOMATION_PARAM_SCHEMAS[pass].safeParse({ junk: true }).success).toBe(false);
	});

	it('proposal: track setup + one item per reaction; accept = one transaction, invariants hold, the document before untouched', () => {
		const { h } = edit([90, 90, 90, 600]);
		reactionBin(h, ['Happy', 'Surprised', 'Thinking', 'Serious']);
		words(h, [
			['suscríbete', 95, 100],
			['wow!', 400, 410],
		]);
		const params = parsePassParams('reactions', { assets: { bin: 'Reactions' }, seed: 2 });
		const plan = planReactions(h.doc, null, params);
		const items = passItems(h.doc, plan);
		expect(items.items.map((i) => i.id)).toEqual(['reaction-track', ...plan.reactions.map((r) => r.id)]);
		expect(items.cost).toMatchObject({ class: 'hybrid', effects: ['jasper.s.shake'] });
		const draft = passDraft(plan, items, params)!;
		const p = propose(h, draft);
		expect(p.items.every((it) => it.state === 'pending')).toBe(true);
		const before = h.doc;
		const rev = h.revision;
		acceptAll(h, p);
		expect(h.revision).toBe(rev + 1);
		expect(checkInvariants(h.doc)).toEqual([]);
		const placed = reactionsOf(h);
		expect(placed.map((c) => [c.start, c.duration])).toEqual(
			plan.reactions.map((r) => [r.frame, r.end - r.frame]),
		);
		for (const [i, c] of placed.entries()) {
			const r = plan.reactions[i]!;
			const tr = (c as unknown as { transform: Record<string, { value: unknown }> }).transform;
			expect(tr.scale!.value).toBe(r.choice.scale);
			expect(tr.position!.value).toEqual(r.position);
			expect(fx(c)).toEqual([...(r.flip ? ['jasper.flip-horizontal'] : []), 'jasper.s.shake']);
			const shake = (c as { effects: EffectInstance[] }).effects.find(
				(e) => e.effectId === 'jasper.s.shake',
			)!;
			expect(shake.params.amplitude!.value).toBe(0.8);
			expect(shake.params.frequency!.value).toBe(2);
			expect(h.seq.videoTracks.find((t) => t.id === c.trackId)?.name).toBe('Reactions');
		}
		expect(Object.values(before.sequences[h.seqId]!.clips).some((c) => c.kind === 'still')).toBe(false);
	});

	it('folder assets: setup items import the files (in a bin), reused when the project has the same file', () => {
		const { h } = edit([600]);
		markers(h, [[30, 'reaction']]);
		const folder: FolderAsset[] = ['b.png', 'a.png'].map((name, i) => ({
			name,
			fingerprint: `q1:${'f'.repeat(63)}${i}`,
			register: {
				type: 'media.register',
				asset: {
					...videoAsset({ kind: 'image', width: 300, height: 200 }),
					fingerprint: `q1:${'f'.repeat(63)}${i}`,
					originalName: name,
				},
				name: name.replace('.png', ''),
			},
		}));
		const plan = planReactions(h.doc, null, { assets: { folder: '/x' }, alternatives: 1 }, { folder });
		expect(plan.assets.map((a) => [a.name, a.mediaRef])).toEqual([
			['a', '$react0'],
			['b', '$react1'],
		]);
		const items = passItems(h.doc, plan);
		expect(items.items.map((i) => i.id)).toEqual([
			'reaction-track',
			'react-bin',
			'react-asset-0',
			'react-asset-1',
			plan.reactions[0]!.id,
		]);
		const item = items.items.at(-1)!;
		expect(item.requires).toEqual(
			expect.arrayContaining(['reaction-track', 'react-asset-0', 'react-asset-1']),
		);
		const p = propose(h, passDraft(plan, items, { assets: { folder: '/x' }, alternatives: 1 })!);
		acceptAll(h, p);
		expect(Object.values(h.doc.media).filter((m) => m.kind === 'image')).toHaveLength(2);
		expect(Object.values(h.doc.items).some((it) => it.kind === 'bin' && it.name === 'Reactions')).toBe(true);
		// a second run reuses the project's files
		const again = planReactions(h.doc, null, { assets: { folder: '/x' } }, { folder });
		expect(again.setup).toEqual([]);
		expect(again.assets.every((a) => !a.mediaRef.startsWith('$'))).toBe(true);
	});

	it('Refresh re-times a reaction after its cut moved; Reroll redraws it; a gone trigger is dropped', () => {
		const { h, ids } = edit([90, 90, 600]);
		reactionBin(h, ['A', 'B', 'C', 'D']);
		markers(h, [[95, 'reaction']]);
		const params = parsePassParams('reactions', { assets: { bin: 'Reactions' } });
		const plan = planReactions(h.doc, null, params);
		expect(plan.reactions[0]!.frame).toBe(90);
		const p = propose(h, passDraft(plan, passItems(h.doc, plan), params)!);
		// trim the first clip: the cut moves to 85, still within 0.5 s of the marker
		h.ok([{ type: 'clip.trim', clipId: ids[0], edge: 'out', deltaFrames: -5, mode: 'ripple' }]);
		const id = plan.reactions[0]!.id;
		const r = refreshAutomationItems(h.doc, p, [id]);
		if (!r.ok) throw new Error(r.message);
		expect(r.items[0]!.meta).toMatchObject({ frame: 85 });
		const rr = refreshAutomationItems(h.doc, p, [id], { reroll: true });
		if (!rr.ok) throw new Error(rr.message);
		expect((rr.items[0]!.meta as { seed: number }).seed).toBe(plan.reactions[0]!.seed + 1);
		const swapped = refreshProposalItems(
			h.doc,
			p,
			[id],
			{ items: r.items, dropped: r.dropped },
			{ ...CTX, revision: h.revision },
			NOW,
		);
		expect(swapped.ok).toBe(true);
		h.ok([{ type: 'marker.remove', markerIds: h.seq.markers.map((m) => m.id) }]);
		const gone = refreshAutomationItems(h.doc, p, [id]);
		if (!gone.ok) throw new Error(gone.message);
		expect(gone.dropped.map((d) => d.itemId)).toEqual([id]);
	});
});

describe('overlay slides (EA-024)', () => {
	/** A-roll on V1 and overlays on V2: [start, length] (abutting ones share an edge). */
	function overlays(spans: [number, number][], kind: 'image' | 'video' = 'image') {
		const { h, end } = edit([3000]);
		const m = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind, seconds: 600, width: 800, height: 600 }) }])
				.results[0] as {
				mediaId: string;
			}
		).mediaId;
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const r = h.ok(
			spans.map(([at, len]) => ({
				type: 'clip.place',
				source: { mediaId: m },
				at,
				tracks: { video: 'V2' },
				video: true,
				audio: false,
				sourceRange: { in: { flicks: 0 }, out: { flicks: len * F } },
			})),
		);
		return { h, end, ids: r.results.map((x) => (x as { clipIds: string[] }).clipIds[0]!) };
	}

	it('slides only free edges, one-sided, 30 frames, with the measured directions and easings', () => {
		const { h, ids } = overlays([
			[100, 200],
			[300, 200], // abuts the first: the shared edge is not free
			[800, 40], // shorter than two slides
			[1200, 200],
		]);
		const plan = planSlides(h.doc, null, { heads: 1, tails: 1 });
		expect(plan.overlays).toBe(4);
		expect(plan.slides.map((s) => [s.clipId, s.edge, s.frame, s.frames])).toEqual([
			[ids[0], 'in', 100, 30],
			[ids[1], 'out', 470, 30],
			[ids[3], 'in', 1200, 30],
			[ids[3], 'out', 1370, 30],
		]);
		expect(plan.skipped.map((s) => s.code).sort()).toEqual(['not-free', 'not-free', 'short', 'short']);
		for (const s of plan.slides) {
			expect(['down', 'up', 'left', 'right']).toContain(s.choice.direction);
			expect(['easeInOutQuad', 'easeInOutCubic']).toContain(s.choice.easing);
			expect(s.alternatives.map((a) => a.direction)).not.toContain(s.choice.direction);
		}
	});

	it('shares, directions and easings follow their weights (2 000 edges)', () => {
		const { h } = edit([110_000]);
		// pure check of the draws: many overlays far apart on V2
		const m = (
			h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'image', width: 100, height: 100 }) }])
				.results[0] as {
				mediaId: string;
			}
		).mediaId;
		const F = flicksPerFrame(h.seq.settings.frameRate);
		h.ok(
			Array.from({ length: 1000 }, (_, i) => ({
				type: 'clip.place',
				source: { mediaId: m },
				at: 4000 + i * 100,
				tracks: { video: 'V2' },
				video: true,
				audio: false,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 70 * F } },
			})),
		);
		const plan = planSlides(h.doc, null, {});
		const heads = plan.slides.filter((s) => s.edge === 'in').length / 1000;
		const tails = plan.slides.filter((s) => s.edge === 'out').length / 1000;
		expect(heads).toBeGreaterThan(0.48);
		expect(heads).toBeLessThan(0.58);
		expect(tails).toBeGreaterThan(0.14);
		expect(tails).toBeLessThan(0.22);
		const n = plan.slides.length;
		const share = (d: string) => plan.slides.filter((s) => s.choice.direction === d).length / n;
		expect(share('down')).toBeGreaterThan(0.41);
		expect(share('down')).toBeLessThan(0.53);
		expect(share('right')).toBeLessThan(0.13);
		const quad = plan.slides.filter((s) => s.choice.easing === 'easeInOutQuad').length / n;
		expect(quad).toBeGreaterThan(0.6);
		expect(quad).toBeLessThan(0.76);
	});

	it('accept: one-sided Smooth Slide transitions at the free edges, rendered from / to transparent', () => {
		const { h, ids } = overlays([[100, 200]], 'video');
		const params = parsePassParams('slides', { heads: 1, tails: 1, seed: 4 });
		const plan = planSlides(h.doc, null, params);
		const items = passItems(h.doc, plan);
		expect(items.cost).toMatchObject({ class: 'hybrid', effects: ['jasper.smooth-slide'] });
		const p = propose(h, passDraft(plan, items, params)!);
		acceptAll(h, p);
		expect(checkInvariants(h.doc)).toEqual([]);
		const trs = Object.values(h.seq.transitions).sort(
			(a, b) => (a.incomingClipId ? -1 : 1) - (b.incomingClipId ? -1 : 1),
		);
		expect(trs.map((t) => [t.effectId, t.incomingClipId, t.outgoingClipId, t.duration, t.alignment])).toEqual(
			[
				['jasper.smooth-slide', ids[0], null, 30, 'start-at-cut'],
				['jasper.smooth-slide', null, ids[0], 30, 'end-at-cut'],
			],
		);
		expect(trs[0]!.params.direction!.value).toBe(plan.slides[0]!.choice.direction);
		expect(trs[0]!.params.motionBlur!.value).toBe('high');
		const stages = [...resolveVideoTransitions(h.doc, h.seq).stages.values()].flat();
		expect(stages.map((s) => [s.sides, s.start, s.duration])).toEqual([
			['in', 100, 30],
			['out', 270, 30],
		]);
		// a second pass finds no free edge
		expect(planSlides(h.doc, null, { heads: 1, tails: 1 }).slides).toEqual([]);
	});

	it('the other passes’ tracks (Reactions, FX, ZOOM, Stingers) hold no overlays unless named', () => {
		const { h, ids } = overlays([[100, 200]]);
		const v2 = h.seq.videoTracks[1]!.id;
		h.ok([{ type: 'track.update', trackId: v2, patch: { name: 'Reactions' } }]);
		expect(planSlides(h.doc, null, { heads: 1, tails: 1 }).overlays).toBe(0);
		const named = planSlides(h.doc, null, { heads: 1, tails: 1, overlayTracks: ['V2'] });
		expect(named.slides.map((s) => s.clipId)).toEqual([ids[0], ids[0]]);
	});
});

describe('music beds (EA-025)', () => {
	function songs(h: Harness, seconds: number[]) {
		const r = h.ok([
			{ type: 'bin.create', name: 'Music', ref: '$b' },
			...seconds.map((s, i) => ({
				type: 'media.register',
				asset: { ...videoAsset({ kind: 'audio', seconds: s }), originalName: `song${i + 1}.mp3` },
				binId: '$b',
				name: `song${i + 1}`,
			})),
		]);
		return r.results.slice(1).map((x) => (x as { mediaId: string }).mediaId);
	}

	it('switches at the first cut ≥ 52 s after each bed starts, −33 dB, the last bed to the end', () => {
		const lengths = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 170 : 130)); // ≈ 5 s clips, 30 fps
		const { h, cuts, end } = edit(lengths);
		songs(h, [600, 600, 600]);
		const plan = planMusicBed(h.doc, null, { assets: { bin: 'Music' } });
		expect(plan.beds.length).toBeGreaterThan(2);
		for (const [i, b] of plan.beds.entries()) {
			if (i < plan.beds.length - 1) {
				const want = cuts.find((c) => c >= b.frame + 52 * 30)!;
				expect(b.end).toBe(want);
				expect(b.switchAt).toBe('cut');
				expect(plan.beds[i + 1]!.frame).toBe(b.end);
			} else expect(b.end).toBe(end);
			expect(b.parts.every((p) => p.gainDb === -33 && !p.intro)).toBe(true);
			expect(b.song.key).toBe(plan.songs[i % 3]!.key);
		}
	});

	it('a short song hands over at its last cut; no cut → at bedSeconds; vertical: one bed per song + intro step', () => {
		const lengths = Array.from({ length: 30 }, () => 150);
		const { h, cuts } = edit(lengths);
		songs(h, [40, 600]);
		const plan = planMusicBed(h.doc, null, { assets: { bin: 'Music' } });
		// song 1 (1 200 frames) ends before 52 s: its last cut ≤ 1 200 within 15 s is 1 200
		expect(plan.beds[0]).toMatchObject({ frame: 0, end: 1200, switchAt: 'cut' });
		const noCuts = edit([5000]);
		songs(noCuts.h, [600]);
		const p2 = planMusicBed(noCuts.h.doc, null, { assets: { bin: 'Music' } });
		expect(p2.beds[0]).toMatchObject({ end: 52 * 30, switchAt: 'bed-seconds' });
		const v = edit([45, 60, 900], { vertical: true });
		songs(v.h, [120]);
		const p3 = planMusicBed(v.h.doc, null, { assets: { bin: 'Music' } });
		expect(p3.beds).toHaveLength(1);
		expect(p3.beds[0]!.parts.map((p) => [p.start, p.end, p.gainDb, p.intro])).toEqual([
			[0, 45, -25, true],
			[45, 1005, -33, false],
		]);
		void cuts;
	});

	it('accept: clips on a Music track, contiguous source across the intro split, gain set; ducking keys under dialogue', () => {
		const v = edit([45, 60, 900], { vertical: true });
		songs(v.h, [120]);
		words(v.h, [
			['hola', 100, 130],
			['adiós', 400, 430],
		]);
		const params = parsePassParams('music', { assets: { bin: 'Music' }, duck: { enabled: true } });
		const plan = planMusicBed(v.h.doc, null, params);
		expect(plan.beds[0]!.duckRegions.length).toBeGreaterThan(0);
		const items = passItems(v.h.doc, plan);
		expect(items.cost.class).toBe('native');
		acceptAll(v.h, propose(v.h, passDraft(plan, items, params)!));
		expect(checkInvariants(v.h.doc)).toEqual([]);
		const music = v.h.seq.audioTracks.find((t) => t.name === 'Music')!;
		const clips = Object.values(v.h.seq.clips)
			.filter((c) => c.trackId === music.id)
			.sort((a, b) => a.start - b.start) as (Clip & {
			gainDb: number;
			sourceIn: number;
			volumeDb: { keyframes: unknown[] };
		})[];
		expect(clips.map((c) => [c.start, c.duration, c.gainDb])).toEqual([
			[0, 45, -25],
			[45, 960, -33],
		]);
		expect(clips[1]!.sourceIn).toBe(clips[0]!.sourceIn + 45 * flicksPerFrame(v.h.seq.settings.frameRate));
		expect(clips.some((c) => c.volumeDb.keyframes.length > 0)).toBe(true);
	});

	it('shuffle is seeded; songs without a length are left out; Reroll changes the song', () => {
		const { h } = edit(Array.from({ length: 60 }, () => 150));
		songs(h, [300, 300, 300, 300]);
		const a = planMusicBed(h.doc, null, { assets: { bin: 'Music' }, order: 'shuffle', seed: 1 });
		const b = planMusicBed(h.doc, null, { assets: { bin: 'Music' }, order: 'shuffle', seed: 1 });
		expect(a.songs.map((s) => s.key)).toEqual(b.songs.map((s) => s.key));
		const params = parsePassParams('music', { assets: { bin: 'Music' } });
		const plan = planMusicBed(h.doc, null, params);
		const p = propose(h, passDraft(plan, passItems(h.doc, plan), params)!);
		const r = refreshAutomationItems(h.doc, p, ['bed:0'], { reroll: true });
		if (!r.ok) throw new Error(r.message);
		expect((r.items[0]!.meta as { song: { key: string } }).song.key).not.toBe(plan.beds[0]!.song.key);
	});
});

describe('stingers (EA-026)', () => {
	it('finds shouted "!" punchlines, snaps to a cut after them, 29 frames, rate and spacing', () => {
		const { h } = edit([140, 660, 400, 400, 400, 2000]);
		words(h, [
			['¡no!', 100, 130], // loud: peak near 110; the cut at 140 is within 0.5 s after it
			['¿sí?', 1000, 1010], // not "!"
			['¡ya!', 1210, 1230], // loud, cut at 1200 is before → no snap; then within 10 s of nothing
			['¡otra!', 1300, 1320], // loud but 3 s after the previous: spacing
		]);
		const fps = 30;
		const lufs: (number | null)[] = Array.from({ length: 1500 }, () => -26);
		const loud = (f0: number, f1: number) => {
			for (let k = Math.floor(f0 / 3); k < Math.ceil(f1 / 3); k++) lufs[k] = -17;
		};
		loud(100, 130);
		loud(1210, 1230);
		loud(1300, 1320);
		const curve = { startSec: 0, hopSec: 0.1, lufs };
		// the loud runs end on the 0.1 s grid of the measurement (frame 132 for the first): the later of the two ends
		const plan = planStingers(h.doc, null, { maxPerMinute: 3 }, { loudness: curve });
		expect(plan.stingers.map((s) => [s.frame, s.end - s.frame, s.trigger.source])).toEqual([
			[140, 29, 'both'],
			[1230, 29, 'both'],
		]);
		// within 0.5 s after the punchline the stinger takes the cut; the cut at 1200 is before the second one
		expect(plan.stingers.map((s) => s.cut?.frame ?? null)).toEqual([140, null]);
		expect(plan.skipped.map((s) => s.code)).toEqual(['spacing']);
		// the default rate (1 a minute) keeps the loudest, earliest one; without snapping it starts where the run ends
		expect(planStingers(h.doc, null, {}, { loudness: curve }).stingers.map((s) => s.frame)).toEqual([140]);
		expect(planStingers(h.doc, null, { snapSeconds: 0 }, { loudness: curve }).stingers[0]!.frame).toBe(132);
		// without a measurement: "!" only when asked, else a warning
		const unmeasured = planStingers(h.doc, null, {});
		expect(unmeasured.stingers).toEqual([]);
		expect(unmeasured.warnings.map((w) => w.code)).toContain('W_NO_LOUDNESS');
		expect(
			planStingers(h.doc, null, { match: 'exclamation', minGapSeconds: 0, maxPerMinute: 10 }).stingers,
		).toHaveLength(3);
		void fps;
	});

	it('proposal: a grey matte under Noise 100 % on a Stingers track + the generated noise placed through sound design', () => {
		const { h } = edit([900]);
		words(h, [['¡ja!', 100, 120]]);
		const params = parsePassParams('stingers', { match: 'exclamation' });
		const plan = planStingers(h.doc, null, params);
		const needs = sfxNeeds(h.doc, plan, params)!;
		expect(needs).toMatchObject({
			recipe: 'synth.static',
			visualKind: 'emphasis',
			sfx: { type: 'glitch', gainDb: -18 },
		});
		const items = passItems(h.doc, plan);
		expect(items.cost).toMatchObject({ class: 'hybrid', effects: ['jasper.noise'] });
		acceptAll(h, propose(h, passDraft(plan, items, params)!));
		expect(checkInvariants(h.doc)).toEqual([]);
		const top = h.seq.videoTracks.at(-1)!;
		expect(top.name).toBe('Stingers');
		const solid = Object.values(h.seq.clips).find((c) => c.trackId === top.id)!;
		expect([solid.kind, solid.start, solid.duration]).toEqual(['solid', 120, 29]);
		const noise = (solid as { effects: EffectInstance[] }).effects[0]!;
		expect([noise.effectId, noise.params.amount!.value, noise.params.colorNoise!.value]).toEqual([
			'jasper.noise',
			100,
			false,
		]);
		const syn = h.doc.synthetics[(solid as { syntheticId: string }).syntheticId]!;
		expect(syn).toMatchObject({ kind: 'color-matte', color: [0.5, 0.5, 0.5, 1] });
	});
});
