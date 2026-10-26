// Editing-automation planners (spec 15 EA-020…EA-022, EA-030, EA-032, EA-050): Decorate Cuts (kits centred on the cut
// exactly to the frame, never overlapping, shorter families near close cuts, coverage, determinism, measured shares and
// repeat probability), punch-ins (midpoint, 7-frame linear ramp, hold, density, zoom about a point keeps the frame
// covered), Ken Burns (share, keys on first and last frame, in : out 2 : 1), proposals (one item per decoration, accept
// = one transaction = one undo step, invariants), refresh and reroll.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AdjustmentClip,
	type Animatable,
	AutomationInputError,
	automationReportOf,
	batchKeysOf,
	type Clip,
	chainWeights,
	checkInvariants,
	createProposal,
	defaultRegistries,
	EDIT_AUTOMATION_FEATURE,
	type EffectInstance,
	evaluate,
	flicksPerFrame,
	KIT_MODEL_STRINGS,
	kitPackIssues,
	LONG_PACK,
	type Proposal,
	type ProposalContext,
	parsePassParams,
	passDraft,
	passItems,
	planAccept,
	planDecorateCuts,
	planKenBurns,
	planPunchIns,
	refreshAutomationItems,
	refreshProposalItems,
	repeatProbability,
	resolveKitEase,
	revalidate,
	SHORTS_SHAKE_PACK,
	zoomMotion,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-26T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

/** An A-roll on `track`: clips of `lengths` frames, alternating two sources (every boundary is a cut). */
function aroll(lengths: number[], opts: { preset?: string; track?: string } = {}) {
	const h = new Harness(opts.preset ? { preset: opts.preset } : {});
	const vertical = (opts.preset ?? '').startsWith('vertical');
	const size = vertical ? { width: 1080, height: 1920 } : {};
	const a = h.registerVideo({ seconds: 36_000, audio: false, ...size });
	const b = h.registerVideo({ seconds: 36_000, audio: false, ...size });
	const F = flicksPerFrame(h.seq.settings.frameRate);
	let at = 0;
	const ids: string[] = [];
	const cmds = lengths.map((len, i) => {
		const c = {
			type: 'clip.place',
			source: { mediaId: i % 2 ? b : a },
			at,
			tracks: { video: opts.track ?? 'V1' },
			sourceRange: { in: { flicks: at * F }, out: { flicks: (at + len) * F } },
		};
		at += len;
		return c;
	});
	const r = h.ok(cmds);
	for (const x of r.results) ids.push((x as { clipIds: string[] }).clipIds[0]!);
	return {
		h,
		ids,
		cuts: cutsOf(lengths),
	};
}

/** The cut frames of clips of `lengths` placed end to end. */
function cutsOf(lengths: number[]): number[] {
	const out: number[] = [];
	let at = 0;
	for (const l of lengths.slice(0, -1)) out.push((at += l));
	return out;
}

const fxOf = (c: Clip) => (c as { effects: EffectInstance[] }).effects;

function propose(h: Harness, draft: unknown): Proposal {
	const r = createProposal(
		h.doc,
		draft,
		{ id: nextId(), projectId: h.doc.projectId, author: { agent: 'test' }, now: NOW, revision: h.revision },
		{ ...CTX, revision: h.revision },
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors).slice(0, 2000));
	return r.proposal;
}

function acceptAll(h: Harness, p: Proposal) {
	const plan = planAccept(h.doc, p, 'all', { agent: 'test' }, { ...CTX, revision: h.revision });
	if (!plan.ok || !plan.composed) throw new Error(JSON.stringify(plan.ok ? 'nothing' : plan.errors));
	return h.ok(plan.composed.tx.commands, { label: plan.composed.tx.label });
}

describe('kit packs (data)', () => {
	it('built-in packs are valid, their eases resolve and their labels are model strings', () => {
		for (const p of [SHORTS_SHAKE_PACK, LONG_PACK]) expect(kitPackIssues(p)).toEqual([]);
		for (const id of ['penner.quart-in', 'penner.quart-out', 'penner.cubic-in', 'penner.circ-out'])
			expect(resolveKitEase(id)).toMatchObject({ easeOut: expect.any(Object), easeIn: expect.any(Object) });
		expect(resolveKitEase('penner.nope-in')).toBeNull();
		expect(KIT_MODEL_STRINGS).toEqual(
			expect.arrayContaining(['Jolt', 'Whip left', 'Zoom through in', 'Shake']),
		);
	});

	it('the repeat penalty keeps the shares and gives P(same family) = 0.23 for the long-form pack', () => {
		const shares = LONG_PACK.families.map((f) => f.weight);
		const p = repeatProbability(shares, LONG_PACK.repeatPenalty);
		expect(p).toBeGreaterThan(0.22);
		expect(p).toBeLessThan(0.24);
		expect(repeatProbability(shares, 1)).toBeCloseTo(0.3124, 3);
		const w = chainWeights(shares, 1);
		expect(w[0]).toBeCloseTo(699 / 1429, 6);
	});

	it('kit keys become per-side eased batch keys (2-key curves, linear, hold)', () => {
		const keys = batchKeysOf(
			[
				{ at: -12, value: 0 },
				{ at: 0, value: 270, ease: 'penner.quart-in' },
				{ at: 5, value: 270, ease: 'linear' },
				{ at: 9, value: 0, ease: 'hold' },
			],
			20,
		);
		expect(keys.map((k) => k.frame)).toEqual([8, 20, 25, 29]);
		expect(keys[0]).toMatchObject({ interpolation: 'bezier', easeOut: expect.any(Object) });
		expect(keys[1]).toMatchObject({ inInterpolation: 'bezier', interpolation: 'linear' });
		expect(keys[2]).toMatchObject({ inInterpolation: 'linear', interpolation: 'hold' });
		expect(keys[1]!.easeIn!.slope).toBeGreaterThan(1); // arriving fast: an ease-in into the cut
	});
});

describe('Decorate Cuts planner', () => {
	const lengths = Array.from({ length: 60 }, (_, i) => 60 + ((i * 37) % 90));

	it('centres every kit on its cut exactly to the frame and never overlaps two kits', () => {
		const { h, cuts } = aroll(lengths);
		const plan = planDecorateCuts(h.doc, h.seqId, {});
		expect(plan.pack.id).toBe('long-pack');
		expect(plan.kits.length).toBeGreaterThan(50);
		let prevEnd = 0;
		for (const k of plan.kits) {
			expect(cuts).toContain(k.frame);
			expect(k.start).toBe(k.frame - k.before);
			expect(k.end).toBe(k.frame + k.after);
			expect(k.start).toBeGreaterThanOrEqual(prevEnd);
			prevEnd = k.end;
			// clips: one over the kit, or one ending on the frame before the cut and one starting on it
			if (k.clips.length === 1)
				expect(k.clips[0]).toMatchObject({ start: k.start, length: k.before + k.after });
			else {
				expect(k.clips[0]!.start + k.clips[0]!.length).toBe(k.frame);
				expect(k.clips[1]!.start).toBe(k.frame);
			}
			for (const a of k.alternatives) {
				expect(a.start).toBe(k.frame - a.before);
				expect(a.family).not.toBe(k.family);
			}
		}
		// alternatives stay between the neighbouring kits
		for (let i = 0; i < plan.kits.length; i++) {
			const lo = i ? plan.kits[i - 1]!.end : 0;
			const hi = plan.kits[i + 1]?.start ?? Number.POSITIVE_INFINITY;
			for (const a of plan.kits[i]!.alternatives) {
				expect(a.start).toBeGreaterThanOrEqual(lo);
				expect(a.end).toBeLessThanOrEqual(hi);
			}
		}
	});

	it('is deterministic for a seed; another seed gives another draw', () => {
		const { h } = aroll(lengths);
		const a = planDecorateCuts(h.doc, h.seqId, { seed: 7 });
		const b = planDecorateCuts(h.doc, h.seqId, { seed: 7 });
		expect(b).toEqual(a);
		const c = planDecorateCuts(h.doc, h.seqId, { seed: 8 });
		expect(c.kits.map((k) => k.family)).not.toEqual(a.kits.map((k) => k.family));
	});

	it('vertical sequences get the shorts shake kit (S_Shake 10 + 10, Amplitude 0.5, Frequency 6, Motion Blur)', () => {
		const { h } = aroll([90, 90, 90], { preset: 'vertical-1080x1920-30' });
		const plan = planDecorateCuts(h.doc, h.seqId, {});
		expect(plan.pack.id).toBe('shorts-shake');
		expect(plan.kits.map((k) => [k.frame, k.start, k.end])).toEqual([
			[90, 80, 100],
			[180, 170, 190],
		]);
		expect(plan.kits[0]!.clips[0]!.effects).toEqual([
			{ effectId: 'jasper.s.shake', params: { amplitude: 0.5, frequency: 6, motionBlur: true, seed: 0 } },
		]);
	});

	it('close cuts take a family short enough to fit, else are skipped and reported', () => {
		// cuts 30 apart: after a kit, a 20 + 20 kit no longer fits before the next cut; Jolt (10 + 10) does
		const { h } = aroll([60, 30, 30, 30, 30, 30, 60]);
		for (const seed of [1, 2, 3, 4, 5]) {
			const plan = planDecorateCuts(h.doc, h.seqId, { seed });
			for (let i = 1; i < plan.kits.length; i++) {
				const k = plan.kits[i]!;
				expect(k.start).toBeGreaterThanOrEqual(plan.kits[i - 1]!.end);
				if (k.frame - plan.kits[i - 1]!.end < 18) expect(k.family).toBe('jolt');
			}
		}
		const only = planDecorateCuts(h.doc, h.seqId, { families: { jolt: 0 } });
		// without Jolt, 20 + 20 kits need 40 frames between cuts: some are skipped as too close
		expect(only.skipped.some((s) => s.code === 'too-close')).toBe(true);
		let prev = 0;
		for (const k of only.kits) {
			expect(k.start).toBeGreaterThanOrEqual(prev);
			prev = k.end;
		}
	});

	it('skips cuts near the sequence edges, under transitions and already decorated', () => {
		const { h, ids } = aroll([8, 120, 120, 120]);
		h.ok([
			{
				type: 'transition.add',
				clipId: ids[2]!,
				edge: 'out',
				effectId: 'jasper.cross-dissolve',
				duration: 10,
			},
		]);
		h.ok([{ type: 'clip.addAdjustment', at: 120, duration: 20, track: 'V2' }]);
		const plan = planDecorateCuts(h.doc, h.seqId, {});
		const codes = Object.fromEntries(plan.skipped.map((s) => [s.frame, s.code]));
		expect(codes[8]).toBe('edge');
		expect(codes[128]).toBe('decorated');
		expect(codes[248]).toBe('transition');
		expect(plan.kits).toEqual([]);
		expect(planDecorateCuts(h.doc, h.seqId, { skipDecorated: false }).kits.map((k) => k.frame)).toEqual([
			128,
		]);
	});

	it('coverage, minimum spacing, range and track options', () => {
		const { h, cuts } = aroll(lengths);
		const all = planDecorateCuts(h.doc, h.seqId, {}).kits.length;
		const half = planDecorateCuts(h.doc, h.seqId, { coverage: 0.5 }).kits.length;
		expect(half).toBeGreaterThan(all * 0.3);
		expect(half).toBeLessThan(all * 0.7);
		const spaced = planDecorateCuts(h.doc, h.seqId, { minSpacingFrames: 400 }).kits;
		for (let i = 1; i < spaced.length; i++)
			expect(spaced[i]!.frame - spaced[i - 1]!.frame).toBeGreaterThanOrEqual(400);
		const range = { start: cuts[10]!, end: cuts[20]! };
		const ranged = planDecorateCuts(h.doc, h.seqId, { range }).kits;
		for (const k of ranged) expect(k.frame >= range.start && k.frame < range.end).toBe(true);
		expect(planDecorateCuts(h.doc, h.seqId, { track: 'V1' }).kits.length).toBe(all);
		expect(() => planDecorateCuts(h.doc, h.seqId, { track: 'V9' })).toThrow(AutomationInputError);
		expect(() => planDecorateCuts(h.doc, h.seqId, { families: { nope: 1 } })).toThrow(/no family "nope"/);
		expect(() => parsePassParams('decorate-cuts', { covrage: 1 })).toThrow(AutomationInputError);
	});

	it('draws families with the measured shares and few repeats over a long sequence', () => {
		const many = Array.from({ length: 2400 }, (_, i) => 60 + ((i * 53) % 120));
		const { h } = aroll(many);
		const plan = planDecorateCuts(h.doc, h.seqId, { seed: 11 });
		const n = plan.kits.length;
		expect(n).toBeGreaterThan(2000);
		const share = (id: string) => (plan.families[id] ?? 0) / n;
		expect(share('jolt')).toBeGreaterThan(0.44);
		expect(share('jolt')).toBeLessThan(0.54);
		expect(share('whip')).toBeGreaterThan(0.13);
		expect(share('spin')).toBeGreaterThan(0.05);
		let same = 0;
		for (let i = 1; i < n; i++) if (plan.kits[i]!.family === plan.kits[i - 1]!.family) same++;
		expect(same / (n - 1)).toBeGreaterThan(0.19);
		expect(same / (n - 1)).toBeLessThan(0.28);
	});

	it('property: kits sit on cuts, are ordered, disjoint and inside the sequence for any lengths and seed', () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 120 }), { minLength: 2, maxLength: 25 }),
				fc.integer({ min: 0, max: 2 ** 31 }),
				fc.constantFrom('hd-1080p-30', 'vertical-1080x1920-30'),
				(ls, seed, preset) => {
					const { h, cuts } = aroll(ls, { preset });
					const total = ls.reduce((a, b) => a + b, 0);
					const plan = planDecorateCuts(h.doc, h.seqId, { seed });
					let prev = 0;
					for (const k of plan.kits) {
						expect(cuts).toContain(k.frame);
						expect(k.start).toBeGreaterThanOrEqual(prev);
						expect(k.end).toBeLessThanOrEqual(total);
						expect(k.frame - k.start).toBe(k.before);
						prev = k.end;
					}
					expect(plan.kits.length + plan.skipped.length).toBe(plan.considered);
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('Decorate Cuts proposal', () => {
	it('one item per kit plus the FX track; accept = one transaction (undo = the document before)', () => {
		const { h, cuts } = aroll([90, 90, 90, 90]);
		const plan = planDecorateCuts(h.doc, h.seqId, { seed: 2 });
		const items = passItems(h.doc, plan);
		const draft = passDraft(plan, items, parsePassParams('decorate-cuts', { seed: 2 }));
		expect(draft).not.toBeNull();
		const p = propose(h, draft);
		expect(p.feature).toBe(EDIT_AUTOMATION_FEATURE);
		expect(p.items.map((it) => it.id)).toEqual(['fx-track', ...cuts.map((c) => `kit:${c}`)]);
		expect(p.items.every((it) => it.state === 'pending')).toBe(true);
		expect(automationReportOf(p)?.pass).toBe('decorate-cuts');
		const before = h.doc;
		const tracksBefore = h.seq.videoTracks.length;
		const rev = h.revision;
		const r = acceptAll(h, p);
		expect(r.ok).toBe(true);
		// one transaction: one revision (one History entry in the editor)
		expect(h.revision).toBe(rev + 1);
		expect(checkInvariants(h.doc)).toEqual([]);
		const fx = h.seq.videoTracks.find((t) => t.name === 'FX')!;
		expect(h.seq.videoTracks.indexOf(fx)).toBe(h.seq.videoTracks.length - 1);
		const kits = Object.values(h.seq.clips).filter((c): c is AdjustmentClip => c.trackId === fx.id);
		const covered = plan.kits.flatMap((k) => k.clips.map((c) => [c.start, c.start + c.length]));
		expect(kits.map((c) => [c.start, c.start + c.duration]).sort((x, y) => x[0]! - y[0]!)).toEqual(covered);
		for (const c of kits) expect(fxOf(c).length).toBeGreaterThan(0);
		// undo = the document before (untouched by the accept)
		expect(Object.values(before.sequences[h.seqId]!.clips).some((c) => c.kind === 'adjustment')).toBe(false);
		expect(before.sequences[h.seqId]!.videoTracks).toHaveLength(tracksBefore);
		expect(h.seq.videoTracks).toHaveLength(tracksBefore + 1);
	});

	it('the whip kit evaluates its curves relative to the cut (eased into the cut, out after it)', () => {
		const { h } = aroll([120, 120]);
		const plan = planDecorateCuts(h.doc, h.seqId, {
			families: { jolt: 0, 'zoom-blur': 0, 'zoom-through': 0, spin: 0 },
		});
		expect(plan.kits[0]!.family).toBe('whip');
		acceptAll(h, propose(h, passDraft(plan, passItems(h.doc, plan), {})));
		const clip = Object.values(h.seq.clips).find((c) => c.kind === 'adjustment')!;
		const blur = fxOf(clip).find((e) => e.effectId === 'jasper.directional-blur')!;
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const at = (frame: number) =>
			evaluate(blur.params.blurLength as Animatable<number>, (frame - clip.start) * F);
		expect(at(120 - 12)).toBeCloseTo(0, 6);
		expect(at(120 - 3)).toBeCloseTo(270, 3);
		expect(at(120)).toBeCloseTo(270, 3);
		expect(at(120 + 13)).toBeCloseTo(0, 3);
		// an ease-in: slow at first
		expect(at(120 - 8)).toBeLessThan(270 * 0.15);
	});

	it('refresh re-plans a kit whose cut moved (same id and refs); reroll draws with the next seed', () => {
		const { h, ids } = aroll([120, 120, 120]);
		const params = parsePassParams('decorate-cuts', { seed: 5 });
		const plan = planDecorateCuts(h.doc, h.seqId, params);
		const p0 = propose(h, passDraft(plan, passItems(h.doc, plan), params));
		h.ok([
			{ type: 'clip.trim', clipId: ids[0]!, edge: 'out', deltaFrames: -10 },
			{ type: 'clip.move', clipIds: [ids[1]!, ids[2]!], deltaFrames: -10 },
		]);
		const stale = revalidate(h.doc, p0, { ...CTX, revision: h.revision }).proposal;
		expect(stale.items.find((it) => it.id === 'kit:120')!.state).toBe('stale');
		const r = refreshAutomationItems(h.doc, stale, ['kit:120']);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.items).toHaveLength(1);
		expect((r.items[0]!.meta as { frame: number }).frame).toBe(110);
		const swapped = refreshProposalItems(
			h.doc,
			stale,
			['kit:120'],
			{ items: r.items, dropped: r.dropped },
			{ ...CTX, revision: h.revision },
			NOW,
		);
		expect(swapped.ok).toBe(true);
		if (!swapped.ok) return;
		expect(swapped.proposal.items.find((it) => it.id === 'kit:120')!.state).toBe('pending');
		const seed0 = (stale.items.find((it) => it.id === 'kit:120')!.meta as { seed: number }).seed;
		const rr = refreshAutomationItems(h.doc, swapped.proposal, ['kit:120'], { reroll: true });
		expect(rr.ok && (rr.items[0]!.meta as { seed: number }).seed).toBe(seed0 + 1);
		// a cut that is gone is dropped
		h.ok([{ type: 'clip.move', clipIds: [ids[2]!], deltaFrames: 50 }]);
		const gone = refreshAutomationItems(h.doc, swapped.proposal, ['kit:240']);
		expect(gone.ok && gone.dropped.map((d) => d.itemId)).toEqual(['kit:240']);
	});
});

describe('punch-ins planner', () => {
	it('density of the clips ≥ 1.5 s get a 7-frame linear ramp to 180 % from the midpoint, held to the cut', () => {
		const { h, ids } = aroll([30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
		const plan = planPunchIns(h.doc, h.seqId, {});
		// candidates: ≥ 45 frames at 30 fps (1.5 s) → 9 clips, 70 % → 6
		expect(plan.candidates).toBe(9);
		expect(plan.punches).toHaveLength(6);
		expect(plan.skipped.find((s) => s.clipId === ids[0])?.code).toBe('short');
		for (const p of plan.punches) {
			const c = h.seq.clips[p.clipId]!;
			expect(p.frame).toBe(c.start + Math.floor(c.duration / 2));
			expect(p.rampFrames).toBe(7);
			expect(p.motion.scale).toEqual({ from: 100, to: 180 });
			expect(p.motion.keys).toEqual([p.frame - c.start, p.frame - c.start + 7]);
			expect(p.motion.position).toBeUndefined(); // centred clip, centre target: no move
		}
		acceptAll(h, propose(h, passDraft(plan, passItems(h.doc, plan), {})));
		expect(checkInvariants(h.doc)).toEqual([]);
		const p = plan.punches[0]!;
		const c = h.seq.clips[p.clipId] as Clip & { transform: { scale: Animatable<number> } };
		const F = flicksPerFrame(h.seq.settings.frameRate);
		const t = (f: number) => c.sourceIn + (f - c.start) * F;
		expect(evaluate(c.transform.scale, t(p.frame))).toBeCloseTo(100, 6);
		expect(evaluate(c.transform.scale, t(p.frame + 3))).toBeCloseTo(100 + (80 * 3) / 7, 3);
		expect(evaluate(c.transform.scale, t(p.frame + 7))).toBeCloseTo(180, 6);
		expect(evaluate(c.transform.scale, t(c.start + c.duration - 1))).toBeCloseTo(180, 6);
		// a second pass leaves keyed clips alone
		expect(planPunchIns(h.doc, h.seqId, {}).punches.map((x) => x.clipId)).not.toContain(p.clipId);
	});

	it('leaves reframed clips (their own static scale or position) alone unless asked', () => {
		const { h, ids } = aroll([90, 90, 90]);
		h.ok([
			{ type: 'param.set', target: ['clip', ids[0]!, 'transform', 'scale'], value: 150 },
			{ type: 'param.set', target: ['clip', ids[1]!, 'transform', 'position'], value: [700, 540] },
		]);
		const plan = planPunchIns(h.doc, h.seqId, { density: 1 });
		expect(plan.punches.map((p) => p.clipId)).toEqual([ids[2]]);
		expect(plan.skipped.filter((s) => s.code === 'reframed').map((s) => s.clipId)).toEqual([ids[0], ids[1]]);
		const all = planPunchIns(h.doc, h.seqId, { density: 1, skipReframed: false });
		expect(all.punches).toHaveLength(3);
		// a reframed clip zooms from its own scale and about the frame centre (its position moves with the zoom)
		const p0 = all.punches.find((p) => p.clipId === ids[0])!;
		expect(p0.motion.scale).toEqual({ from: 150, to: 270 });
		const p1 = all.punches.find((p) => p.clipId === ids[1])!;
		expect(p1.motion.position).toEqual({ from: [700, 540], to: [960 + 1.8 * (700 - 960), 540] });
	});

	it('zooming in about any point of the frame keeps a covering picture covering the frame', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1920, noNaN: true }),
				fc.double({ min: 0, max: 1080, noNaN: true }),
				fc.double({ min: 1.01, max: 5, noNaN: true }),
				fc.double({ min: 100, max: 250, noNaN: true }),
				(x, y, k, base) => {
					const m = {
						position: [960, 540] as [number, number],
						anchor: [960, 540] as [number, number],
						scale: base,
						scaleWidth: base,
						uniformScale: true,
						rotation: 0,
						flipH: false,
						flipV: false,
					};
					const z = zoomMotion(m, k, [x, y], 0, 7);
					const pos = z.position?.to ?? m.position;
					const s = z.scale.to / 100;
					// the 1920 × 1080 picture around its anchor, scaled, at the new position
					const left = pos[0] - 960 * s;
					const right = pos[0] + 960 * s;
					const top = pos[1] - 540 * s;
					const bottom = pos[1] + 540 * s;
					// (values are rounded to 0.001 px)
					expect(left).toBeLessThanOrEqual(0.01);
					expect(top).toBeLessThanOrEqual(0.01);
					expect(right).toBeGreaterThanOrEqual(1920 - 0.01);
					expect(bottom).toBeGreaterThanOrEqual(1080 - 0.01);
				},
			),
			{ numRuns: 300 },
		);
	});

	it('adjustment method: a Transform clip on a ZOOM track right above the A-roll; point target', () => {
		const { h } = aroll([120, 120, 120]);
		h.ok([{ type: 'track.add', kind: 'video', name: 'Titles' }]);
		const names = h.seq.videoTracks.map((t) => t.name);
		const plan = planPunchIns(h.doc, h.seqId, {
			method: 'adjustment',
			density: 1,
			target: { x: 0.25, y: 0.25 },
		});
		expect(plan.zoomTrack).toMatchObject({ create: true, name: 'ZOOM', index: 1 });
		acceptAll(h, propose(h, passDraft(plan, passItems(h.doc, plan), {})));
		expect(h.seq.videoTracks.map((t) => t.name)).toEqual([names[0], 'ZOOM', ...names.slice(1)]);
		const adj = Object.values(h.seq.clips).filter((c) => c.kind === 'adjustment');
		expect(adj).toHaveLength(3);
		const tf = fxOf(adj[0]!)[0]!;
		expect(tf.effectId).toBe('jasper.transform');
		expect((tf.params.anchorPoint as Animatable<number[]>).value).toEqual([0.25, 0.25]);
	});
});

describe('Ken Burns planner', () => {
	it('share of the clips, keys on first and last frame, in : out ≈ 2 : 1, value per aspect', () => {
		const many = Array.from({ length: 600 }, (_, i) => 40 + ((i * 29) % 100));
		const { h } = aroll(many);
		const plan = planKenBurns(h.doc, h.seqId, {});
		expect(plan.moves.length).toBe(Math.round(0.15 * plan.candidates));
		const ins = plan.moves.filter((m) => m.direction === 'in').length;
		expect(ins / plan.moves.length).toBeGreaterThan(0.58);
		expect(ins / plan.moves.length).toBeLessThan(0.75);
		for (const m of plan.moves) {
			const c = h.seq.clips[m.clipId]!;
			expect(m.motion.keys).toEqual([0, c.duration - 1]);
			expect(m.motion.scale).toEqual(m.direction === 'in' ? { from: 100, to: 130 } : { from: 130, to: 100 });
		}
		const v = aroll([90, 90, 90, 90, 90, 90, 90], { preset: 'vertical-1080x1920-30' });
		const vp = planKenBurns(v.h.doc, v.h.seqId, { share: 1 });
		expect(vp.moves[0]!.scale).toBe(118);
		expect(planKenBurns(h.doc, h.seqId, {})).toEqual(plan);
	});

	it('excluded clips and clips already zoomed are left alone; accept writes native Motion keys', () => {
		const { h, ids } = aroll([90, 90, 90]);
		const plan = planKenBurns(h.doc, h.seqId, { share: 1, excludeClipIds: [ids[0]!] });
		expect(plan.moves.map((m) => m.clipId)).toEqual([ids[1], ids[2]]);
		acceptAll(h, propose(h, passDraft(plan, passItems(h.doc, plan), {})));
		expect(checkInvariants(h.doc)).toEqual([]);
		expect(planKenBurns(h.doc, h.seqId, { share: 1 }).moves.map((m) => m.clipId)).toEqual([ids[0]]);
	});
});
