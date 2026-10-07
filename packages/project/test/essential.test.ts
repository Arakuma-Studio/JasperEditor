// Essential Sound (audio-fx): settings → ordinary keyframable clip effects, gain, Volume and pan (FilmCraft's
// essential.rs design), presets, Clear Audio Type, Auto-Match, refusals; Remix and its revert.
import { describe, expect, it } from 'vitest';
import {
	AUDIO_TYPES,
	audioEffectSpec,
	builtinEssentialPresets,
	checkInvariants,
	DEFAULT_PRESET,
	EQ_PRESETS,
	type EssentialSound,
	essentialEffects,
	essentialKeys,
	newEssentialSound,
	REVERB_PRESETS,
	readEssentialSound,
	setEssentialValue,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = 705_600_000 / 30;

function setup(seconds = 20) {
	const h = new Harness();
	const m = h.registerVideo({ kind: 'audio', seconds });
	h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	const clip = () =>
		h.clips('A1')[0]! as unknown as {
			id: string;
			gainDb: number;
			volumeDb: { value: number; keyframes: { time: number; value: number }[] };
			pan: { value: number; keyframes: unknown[] };
			effects: {
				id: string;
				effectId: string;
				enabled: boolean;
				essential?: string;
				params: Record<string, { value: unknown; keyframes: { time: number; value: unknown }[] }>;
			}[];
			essential?: unknown;
		};
	return { h, m, clip };
}

describe('Essential Sound model', () => {
	it('settings: get/set with validation, presets clear on manual change, keys enumerate', () => {
		let s = newEssentialSound('dialogue');
		s = setEssentialValue(s, 'repair.noise.on', true);
		s = setEssentialValue(s, 'repair.noise.amount', 42);
		expect(s.repair.noise).toEqual({ on: true, amount: 10 });
		s = setEssentialValue(s, 'clarity.eqPreset', 'Telephone');
		expect(s.clarity.eqPreset).toBe('Telephone');
		expect(() => setEssentialValue(s, 'clarity.eqPreset', 'Nope')).toThrow();
		expect(() => setEssentialValue(s, 'repair.noise.on', 3)).toThrow();
		expect(() => setEssentialValue(s, 'nope', 3)).toThrow();
		expect(() => setEssentialValue(s, 'type', 'music')).toThrow();
		expect(s.preset).toBe('');
		s = setEssentialValue(s, 'ducking.against', ['dialogue', 'sfx', 'sfx']);
		expect(s.ducking.against).toEqual(['dialogue', 'sfx']);
		expect(essentialKeys()).toContain('repair.dehum.amount');
		expect(readEssentialSound({ type: 'music', repair: { noise: { on: 'x' } } })!.type).toBe('music');
		expect(readEssentialSound({ type: 'bogus' })).toBeNull();
	});

	it('presets are valid, unique per type, "(Default)" first, and every effect they call for exists', () => {
		const ps = builtinEssentialPresets();
		for (const t of AUDIO_TYPES) {
			const mine = ps.filter((p) => p.type === t);
			expect(mine[0]!.name).toBe(DEFAULT_PRESET);
			expect(new Set(mine.map((p) => p.name)).size).toBe(mine.length);
		}
		for (const p of ps) {
			expect(EQ_PRESETS.some((e) => e.name === p.settings.clarity.eqPreset)).toBe(true);
			expect(REVERB_PRESETS.some((e) => e.name === p.settings.creative.reverbPreset)).toBe(true);
			for (const e of essentialEffects(p.settings)) {
				const spec = audioEffectSpec(e.effectId)!;
				expect(spec, e.effectId).toBeDefined();
				for (const [k, v] of Object.entries(e.params)) {
					const ps2 = spec.params.find((x) => x.name === k);
					expect(ps2, `${e.effectId}.${k}`).toBeDefined();
					if (ps2!.type === 'number') {
						expect(v as number).toBeGreaterThanOrEqual(ps2!.range!.min!);
						expect(v as number).toBeLessThanOrEqual(ps2!.range!.max!);
					}
					if (ps2!.type === 'enum') expect(ps2!.options).toContain(v);
				}
			}
		}
	});

	it('every slot at full amount maps to in-range parameters', () => {
		const s: EssentialSound = newEssentialSound('dialogue');
		for (const k of ['noise', 'rumble', 'dehum', 'deess', 'reverb'] as const)
			s.repair[k] = { on: true, amount: 10 };
		for (const k of ['dynamics', 'eq', 'enhance'] as const) s.clarity[k] = { on: true, amount: 10 };
		s.creative.reverb = { on: true, amount: 10 };
		for (const e of essentialEffects(s)) {
			const spec = audioEffectSpec(e.effectId)!;
			for (const [k, v] of Object.entries(e.params)) {
				const ps = spec.params.find((x) => x.name === k)!;
				if (ps.type === 'number') expect(v as number).toBeLessThanOrEqual(ps.range!.max!);
			}
		}
	});
});

describe('Essential Sound commands', () => {
	it('setType / set insert, update and remove ordinary effects in order; keyframes survive unrelated changes', () => {
		const { h, clip } = setup();
		const id = clip().id;
		h.ok([{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.audio.delay' }]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'dialogue' }]);
		h.ok([
			{
				type: 'essentialSound.set',
				clipIds: [id],
				values: {
					'repair.deess.on': true,
					'creative.reverb.on': true,
					'repair.rumble.on': true,
				},
			},
		]);
		const ids = () => clip().effects.map((e) => e.essential ?? e.effectId);
		expect(ids()).toEqual(['rumble', 'deess', 'reverb', 'jasper.audio.delay']);
		// Keyframe a parameter of the DeEsser by hand, then change unrelated settings.
		const deess = clip().effects.find((e) => e.essential === 'deess')!;
		h.ok([
			{ type: 'param.set', target: ['effect', deess.id, 'reduction'], value: 3, at: { frames: 10 } },
			{
				type: 'param.setAnimated',
				target: ['effect', deess.id, 'reduction'],
				animated: true,
				at: { frames: 10 },
			},
		]);
		const kfBefore = clip().effects.find((e) => e.essential === 'deess')!.params.reduction!.keyframes.length;
		expect(kfBefore).toBeGreaterThan(0);
		h.ok([
			{
				type: 'essentialSound.set',
				clipIds: [id],
				values: { 'repair.rumble.amount': 10, 'repair.noise.on': true },
			},
		]);
		expect(ids()).toEqual(['rumble', 'noise', 'deess', 'reverb', 'jasper.audio.delay']);
		expect(clip().effects.find((e) => e.essential === 'rumble')!.params.cutoff!.value).toBe(150);
		expect(clip().effects.find((e) => e.essential === 'deess')!.params.reduction!.keyframes.length).toBe(
			kfBefore,
		);
		// Section off bypasses, slot off removes.
		h.ok([
			{
				type: 'essentialSound.set',
				clipIds: [id],
				values: { 'repair.enabled': false, 'creative.reverb.on': false },
			},
		]);
		expect(clip().effects.find((e) => e.essential === 'rumble')!.enabled).toBe(false);
		expect(clip().effects.some((e) => e.essential === 'reverb')).toBe(false);
		// A changed parameter of a keyframed effect writes a keyframe at `at`.
		h.ok([
			{ type: 'essentialSound.set', clipIds: [id], values: { 'repair.deess.amount': 8 }, at: { frames: 30 } },
		]);
		const red = clip().effects.find((e) => e.essential === 'deess')!.params.reduction!;
		expect(
			red.keyframes.some((k) => k.time === 30 * F30 && Math.abs((k.value as number) - 19.2) < 1e-9),
		).toBe(true);
		// Clear Audio Type removes every essential effect, keeps the user's.
		h.ok([{ type: 'essentialSound.clearType', clipIds: [id] }]);
		expect(ids()).toEqual(['jasper.audio.delay']);
		expect(clip().essential).toBeUndefined();
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('gain (Auto-Match), Clip Volume and pan change by deltas and are undone by Clear Audio Type', () => {
		const { h, clip } = setup();
		const id = clip().id;
		h.ok([{ type: 'audio.setGain', clipIds: [id], mode: 'set', db: 2 }]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'sfx' }]);
		h.ok([{ type: 'essentialSound.autoMatch', measuredLufs: { [id]: -30 }, targetLufs: -23 }]);
		// measured −30 (no gain) → match = −23 − (−30) − 2 = +5, total gain 7
		expect(clip().gainDb).toBeCloseTo(7, 9);
		h.ok([{ type: 'essentialSound.autoMatch', measuredLufs: { [id]: -30 }, targetLufs: -20 }]);
		expect(clip().gainDb).toBeCloseTo(10, 9);
		h.ok([
			{
				type: 'essentialSound.set',
				clipIds: [id],
				values: { volume: { on: true, levelDb: -3 }, pan: { enabled: true, value: 40 } },
			},
		]);
		expect(clip().volumeDb.value).toBe(-3);
		expect(clip().pan.value).toBe(40);
		h.ok([{ type: 'essentialSound.clearType', clipIds: [id] }]);
		expect(clip().gainDb).toBeCloseTo(2, 9);
		expect(clip().volumeDb.value).toBe(0);
		expect(clip().pan.value).toBe(0);
	});

	it('presets: built-ins by name, user settings, keeping loudness/volume/mute; mute is a Mute effect', () => {
		const { h, clip } = setup();
		const id = clip().id;
		h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'dialogue' }]);
		h.ok([{ type: 'essentialSound.autoMatch', measuredLufs: { [id]: -26 } }]);
		h.ok([{ type: 'essentialSound.applyPreset', clipIds: [id], preset: 'podcast voice' }]);
		const s = readEssentialSound(clip().essential)!;
		expect(s.preset).toBe('Podcast Voice');
		expect(s.loudness.gainDb).toBeCloseTo(3, 9);
		expect(clip().effects.map((e) => e.essential)).toEqual(['rumble', 'deess', 'dynamics', 'eq', 'enhance']);
		const user = { ...newEssentialSound('dialogue'), preset: 'Mine', mute: true };
		h.ok([{ type: 'essentialSound.applyPreset', clipIds: [id], settings: user }]);
		expect(clip().effects.map((e) => e.essential)).toEqual([]);
		expect(readEssentialSound(clip().essential)!.mute).toBe(false); // kept the clip's own mute
		h.ok([{ type: 'essentialSound.set', clipIds: [id], values: { mute: true } }]);
		expect(clip().effects.map((e) => e.effectId)).toEqual(['jasper.audio.mute']);
		const bad = h.tx([{ type: 'essentialSound.applyPreset', clipIds: [id], preset: 'Nope' }]);
		expect(bad.ok).toBe(false);
	});

	it('refuses video clips, clips without a type and unknown keys', () => {
		const h = new Harness();
		const v = h.registerVideo({ seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 0 }]);
		const video = h.clips('V1')[0]!.id;
		const audio = h.clips('A1')[0]!.id;
		expect(h.tx([{ type: 'essentialSound.setType', clipIds: [video], audioType: 'music' }]).ok).toBe(false);
		expect(
			h.tx([{ type: 'essentialSound.set', clipIds: [audio], values: { 'repair.noise.on': true } }]).ok,
		).toBe(false);
		h.ok([{ type: 'essentialSound.setType', clipIds: [audio], audioType: 'music' }]);
		const r = h.tx([{ type: 'essentialSound.set', clipIds: [audio], values: { 'repair.bogus': 1 } }]);
		expect(r.ok).toBe(false);
	});
});

describe('Remix', () => {
	const pieces = [
		{ srcSeconds: 0, lenSeconds: 4.1 },
		{ srcSeconds: 10.1, lenSeconds: 3.9 },
		{ srcSeconds: 16, lenSeconds: 4 },
	];

	it('replaces the clip by grouped pieces with crossfades, exact jump offsets; revert restores', () => {
		const { h, clip } = setup(20);
		const id = clip().id;
		const r = h.ok([{ type: 'clip.remix', clipId: id, targetFrames: 360, pieces, bpm: 120 }]);
		const list = h.clips('A1');
		expect(list.length).toBe(3);
		expect(list.map((c) => [c.start, c.duration])).toEqual([
			[0, 123],
			[123, 117],
			[240, 120],
		]);
		// Piece 2 starts 4.1 s into the output (frame 123 = 4.1 s exactly): source 10.1 s.
		expect(list[1]!.sourceIn).toBe(Math.round(10.1 * 705_600_000));
		// Every piece knows the remix; one group; crossfades at both joints.
		const remix = (list[0] as { remix?: { id: string; count: number } }).remix!;
		expect(remix.count).toBe(3);
		expect(Object.keys(h.seq.groups)).toContain(remix.id);
		const ts = Object.values(h.seq.transitions);
		expect(ts.length).toBe(2);
		expect(ts.every((t) => t.effectId === 'jasper.constant-power')).toBe(true);
		expect((r.results[0] as { pieces: number }).pieces).toBe(3);
		// Remix again (from the original) to another length, then revert.
		h.ok([
			{
				type: 'clip.remix',
				clipId: list[1]!.id,
				targetFrames: 300,
				pieces: [pieces[0]!, { srcSeconds: 10, lenSeconds: 6 }],
				bpm: 120,
			},
		]);
		expect(h.clips('A1').length).toBe(2);
		h.ok([{ type: 'clip.remixRevert', clipId: h.clips('A1')[1]!.id }]);
		const back = h.clips('A1');
		expect(back.length).toBe(1);
		expect([back[0]!.start, back[0]!.duration, back[0]!.sourceIn]).toEqual([0, 600, 0]);
		expect(Object.values(h.seq.transitions).length).toBe(0);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('rounding of a cut shifts the next source start by the same amount (jumps stay whole beats)', () => {
		const { h, clip } = setup(20);
		h.ok([
			{
				type: 'clip.remix',
				clipId: clip().id,
				targetFrames: 240,
				pieces: [
					{ srcSeconds: 0, lenSeconds: 4.01 },
					{ srcSeconds: 12.01, lenSeconds: 3.99 },
				],
				bpm: 120,
			},
		]);
		const [a, b] = h.clips('A1');
		// cut at round(4.01·30) = 120 frames = 4.0 s: δ = −0.01 s → second piece starts at 12.0 s.
		expect(a!.duration).toBe(120);
		expect(b!.sourceIn).toBe(Math.round(12 * 705_600_000));
	});

	it('refuses overlaps, speed changes and linked clips', () => {
		const { h, clip } = setup(20);
		const id = clip().id;
		const m2 = h.registerVideo({ kind: 'audio', seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: m2 }, at: 700, tracks: { audio: 'A1' } }]);
		expect(h.tx([{ type: 'clip.remix', clipId: id, targetFrames: 800, pieces, bpm: 120 }]).ok).toBe(false);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id], rate: 2, ripple: false }]);
		expect(h.tx([{ type: 'clip.remix', clipId: id, targetFrames: 200, pieces, bpm: 120 }]).ok).toBe(false);
		const v = h.registerVideo({ seconds: 5 });
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 1000 }]);
		const linked = h.clips('A1').find((c) => c.start === 1000)!.id;
		expect(h.tx([{ type: 'clip.remix', clipId: linked, targetFrames: 100, pieces, bpm: 120 }]).ok).toBe(
			false,
		);
	});
});

describe('Essential Sound invariants and repair', () => {
	it('flags and repairs unreadable settings, stray essential markers and remix counts', async () => {
		const { repairDocument, createCounterIdSource } = await import('../src/index.ts');
		const { h, clip } = setup();
		const id = clip().id;
		h.ok([{ type: 'essentialSound.setType', clipIds: [id], audioType: 'dialogue' }]);
		h.ok([{ type: 'essentialSound.set', clipIds: [id], values: { 'repair.noise.on': true } }]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		const c = doc.sequences[h.seqId].clips[id];
		c.essential = { type: 'dialogue', repair: { noise: { on: 'yes' } } };
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-ESSENTIAL')).toBe(true);
		const r1 = repairDocument(doc, createCounterIdSource(99));
		expect(r1.report.some((e) => e.action === 'normalize-essential')).toBe(true);
		expect(checkInvariants(r1.document).some((i) => i.invariant === 'INV-ESSENTIAL')).toBe(false);
		c.essential = 'garbage';
		const r2 = repairDocument(doc, createCounterIdSource(99));
		const fixed = r2.document.sequences[h.seqId]!.clips[id] as {
			essential?: unknown;
			effects: { essential?: string }[];
		};
		expect(fixed.essential).toBeUndefined();
		expect(fixed.effects.every((e) => e.essential === undefined)).toBe(true);
		expect(checkInvariants(r2.document)).toEqual([]);
	});
});
