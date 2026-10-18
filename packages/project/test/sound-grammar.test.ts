// The cue grammar and variation policy (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"): the shared pure policy module
// (`sound/grammar.ts`) and where the model applies it — the variation per type (one voice for ui / click, takes at
// rate 1 for key / tick / tap), climbing runs, one key per word for fast typing, "music carries the cuts", the
// personality (ranking, cue types, density) and palette coherence by material; the style in the sequence's settings
// (`soundDesign.setSettings {style}`, undo / redo, refusals, lenient read and repair). Deterministic, never throws.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	COMMAND_CATALOG,
	deriveCues,
	fillTypeOf,
	findRuns,
	loadProject,
	MATERIAL_BONUS,
	materialBonusOf,
	musicPlaysAt,
	offeredTakeIds,
	PERSONALITY_WEIGHT,
	paletteMaterials,
	personalityDensity,
	personalityScore,
	pickVariant,
	type RankableSound,
	rankSounds,
	rateOfSemitones,
	readSoundDesignSettings,
	repairDocument,
	resolveSoundStyle,
	runReason,
	SOUND_PERSONALITIES,
	SOUND_PERSONALITY_PROFILES,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	type SoundPersonality,
	styleCueTypes,
	takeIdOf,
	typingChoice,
	variationCycle,
	variationForFill,
	variationOf,
	voiceFor,
	wordStartUnits,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { newHarness, phase2Fixture, placeVideo } from './sound-cues-fixtures.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('variation policy per type (taxonomy `variation`)', () => {
	it('ui and click keep one voice, key / tick / tap rotate takes without varispeed, the rest vary', () => {
		for (const t of SOUND_TYPE_IDS) {
			const want = ['ui', 'click'].includes(t)
				? 'voice'
				: ['key', 'tick', 'tap'].includes(t)
					? 'takes'
					: 'vary';
			expect(SOUND_TYPES[t].variation, t).toBe(want);
		}
		// the fill type: the first cue type the sound has
		expect(fillTypeOf(['click', 'key'], ['key', 'tick', 'click'])).toBe('key');
		expect(variationForFill(['click', 'key'], ['key', 'tick', 'click'])).toBe('takes');
		expect(variationForFill(['click'], ['key', 'tick', 'click'])).toBe('voice');
		expect(variationForFill(['whoosh'], [])).toBe('vary');
		expect(variationForFill([], [])).toBe('vary');
	});

	it('variationOf: voice = rate 1 and 0 dB; takes = rate 1 with the same ±1 dB; vary = ±2 % and ±1 dB (property)', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.string(), fc.integer({ min: 0, max: 5 }), (seed, cueId, layer) => {
				const ctx = { seed, cueId, sequenceId: 'seq_x', layer };
				const vary = variationOf(ctx);
				const takes = variationOf({ ...ctx, variation: 'takes' });
				const voice = variationOf({ ...ctx, variation: 'voice' });
				expect(voice).toEqual({ rate: 1, gainDb: 0 });
				expect(takes.rate).toBe(1);
				expect(takes.gainDb).toBe(vary.gainDb);
				expect(Math.abs(vary.rate - 1)).toBeLessThanOrEqual(0.02 + 1e-12);
				expect(Math.abs(vary.gainDb)).toBeLessThanOrEqual(1);
				expect(variationOf({ ...ctx, variation: 'vary' })).toEqual(vary);
			}),
			{ numRuns: 300 },
		);
	});

	it('pickVariant with takes: every pick plays at rate 1, never the same take twice in a row (property)', () => {
		const rec = 'snd_00000000000000aa';
		const candidates = Array.from({ length: 6 }, (_, i) => takeIdOf(rec, i + 1));
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1000 }), (seed) => {
				const picks: string[] = [];
				for (let cue = 0; cue < 12; cue++) {
					const v = pickVariant(candidates, {
						seed,
						cueId: `c${cue}`,
						recentSoundIds: [...picks].reverse(),
						variation: 'takes',
					})!;
					expect(v.rate).toBe(1);
					if (picks.length) expect(v.soundId).not.toBe(picks[picks.length - 1]);
					picks.push(v.soundId);
				}
			}),
			{ numRuns: 50 },
		);
	});

	it('voiceFor: the palette sound among the candidates, else the first placed sound of the type', () => {
		const cands = [
			{ id: 'snd_000000000000000a', types: ['click'] },
			{ id: 'snd_000000000000000b', types: ['click'] },
		];
		expect(voiceFor('click', { candidates: cands, palette: [], placed: [] })).toBeNull();
		expect(voiceFor('click', { candidates: cands, palette: ['snd_000000000000000b'], placed: [] })).toEqual({
			soundId: 'snd_000000000000000b',
			from: 'palette',
		});
		const placed = [
			{ soundId: 'snd_00000000000000ff', types: ['hit'] },
			{ soundId: 'snd_00000000000000cc', types: ['click'] },
			{ soundId: 'snd_00000000000000dd', types: ['click'] },
		];
		expect(voiceFor('click', { candidates: cands, palette: [], placed })).toEqual({
			soundId: 'snd_00000000000000cc',
			from: 'placed',
		});
		// the palette wins over what is placed
		expect(voiceFor('click', { candidates: cands, palette: ['snd_000000000000000a'], placed })?.soundId).toBe(
			'snd_000000000000000a',
		);
	});
});

describe('runs climb', () => {
	const card = (frame: number, type: string | null = 'pop', kind = 'appear') => ({ frame, kind, type });

	it('a 4-card stagger 0.5 s apart climbs 0 / +1 / +2 / +3 st; six cards cap at +4', () => {
		const four = findRuns([0, 15, 30, 45].map((f) => card(f)), 30);
		expect(four.map((s) => s?.st)).toEqual([0, 1, 2, 3]);
		expect(four.map((s) => s?.index)).toEqual([1, 2, 3, 4]);
		expect(four.every((s) => s?.of === 4 && s.run === 1)).toBe(true);
		expect(runReason(four[2]!)).toBe('run 3 of 4: +2 st');
		const six = findRuns([0, 6, 12, 18, 24, 30].map((f) => card(f, 'ui', 'emphasis')), 30);
		expect(six.map((s) => s?.st)).toEqual([0, 1, 2, 3, 4, 4]);
		expect(rateOfSemitones(2)).toBeCloseTo(2 ** (2 / 12), 6);
		const flat = findRuns([0, 15, 30].map((f) => card(f)), 30, 'flat');
		expect(flat.map((s) => s?.st)).toEqual([0, 0, 0]);
		expect(runReason(flat[1]!, 'flat')).toBe('run 2 of 3: flat');
	});

	it('needs ≥ 3 consecutive appear / emphasis cues ≤ 0.6 s apart, filled with pop, ui, chime or tick', () => {
		expect(findRuns([card(0), card(15)], 30)).toEqual([null, null]);
		// 0.6 s at 30 fps is 18 frames: 19 breaks it
		expect(findRuns([card(0), card(18), card(36)], 30).every((s) => s !== null)).toBe(true);
		expect(findRuns([card(0), card(19), card(38)], 30)).toEqual([null, null, null]);
		// a key, a cut or an explicit pitch in between breaks the run
		expect(findRuns([card(0), card(5), card(10, 'key'), card(15), card(20)], 30)).toEqual([
			null,
			null,
			null,
			null,
			null,
		]);
		expect(findRuns([card(0), card(5), card(10, 'pop', 'cut'), card(15)], 30).every((s) => s === null)).toBe(
			true,
		);
		const fixed = findRuns([card(0), card(5), { ...card(10), fixedPitch: true }, card(15), card(20), card(25)], 30);
		expect(fixed.map((s) => s?.st ?? null)).toEqual([null, null, null, 0, 1, 2]);
		// two runs are numbered in order
		const two = findRuns([card(0), card(5), card(10), card(100, 'chime'), card(105, 'tick'), card(110, 'ui')], 30);
		expect(two.map((s) => s?.run)).toEqual([1, 1, 1, 2, 2, 2]);
	});

	it('never throws and keeps its bounds on any input (property)', () => {
		const item = fc.record({
			frame: fc.oneof(fc.integer({ min: -100, max: 10_000 }), fc.constant(Number.NaN)),
			kind: fc.constantFrom('appear', 'emphasis', 'cut', 'land', ''),
			type: fc.constantFrom('pop', 'ui', 'chime', 'tick', 'key', null),
			fixedPitch: fc.boolean(),
		});
		fc.assert(
			fc.property(fc.array(item, { maxLength: 40 }), fc.double({ noNaN: false }), (items, fps) => {
				const sorted = [...items].sort((a, b) => (a.frame || 0) - (b.frame || 0));
				const out = findRuns(sorted, fps);
				expect(out).toHaveLength(sorted.length);
				for (const s of out)
					if (s) {
						expect(s.of).toBeGreaterThanOrEqual(3);
						expect(s.st).toBeGreaterThanOrEqual(0);
						expect(s.st).toBeLessThanOrEqual(4);
						expect(s.index).toBeLessThanOrEqual(s.of);
					}
			}),
			{ numRuns: 300 },
		);
	});
});

describe('typing', () => {
	it('typingChoice: auto is keys up to 25 units/s, words above; keys, words and silent force', () => {
		expect(typingChoice('auto', 25)).toBe('keys');
		expect(typingChoice('auto', 25.1)).toBe('words');
		expect(typingChoice('auto', Number.NaN)).toBe('keys');
		expect(typingChoice('keys', 80)).toBe('keys');
		expect(typingChoice('words', 3)).toBe('words');
		expect(typingChoice('silent', 10)).toBe('silent');
	});

	it('wordStartUnits counts like the typewriter (non-space graphemes) or the selector (with spaces)', () => {
		expect(wordStartUnits('THE QUICK BROWN FOX')).toEqual([0, 3, 8, 13]);
		expect(wordStartUnits('THE QUICK BROWN FOX', 'charWithSpaces')).toEqual([0, 4, 10, 16]);
		expect(wordStartUnits('  two\nlines ')).toEqual([0, 3]);
		expect(wordStartUnits('')).toEqual([]);
		expect(wordStartUnits('é😀 ab')).toEqual([0, 2]);
	});

	const typewriter = (text: string, frames: number) => {
		const h = newHarness();
		h.ok([
			{
				type: 'clip.addText',
				at: 0,
				duration: 90,
				track: 'V2',
				content: { text },
				textAnimation: { in: { preset: 'typewriter', durationFrames: frames } },
			},
		]);
		return h;
	};
	const FAST = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';

	it('a typewriter faster than 25 units/s gets one key per word start; keys / silent force it', () => {
		const h = typewriter(FAST, 30); // 35 characters in 1 s
		const auto = deriveCues(h.doc, h.seqId, { sources: ['text'] });
		expect(auto.cues.map((c) => (c.anchor as { unit?: number }).unit)).toEqual([0, 3, 8, 13, 16, 21, 25, 28, 32]);
		// typewriter@2 types over 60 % of its window: 35 units in 0.6 s
		expect(auto.cues[0]!.reason).toMatch(/one key per word: 58 typed\/s/);
		expect(new Set(auto.cues.map((c) => c.group)).size).toBe(1);
		const keys = deriveCues(h.doc, h.seqId, { sources: ['text'], typing: 'keys' });
		// keys: thinned to ≤ 12 per second (7 over the 0.6 s of typing), wherever they fall in the words
		expect(keys.cues).toHaveLength(7);
		expect(keys.cues.map((c) => (c.anchor as { unit?: number }).unit)).not.toEqual(
			auto.cues.slice(0, 7).map((c) => (c.anchor as { unit?: number }).unit),
		);
		expect(deriveCues(h.doc, h.seqId, { sources: ['text'], typing: 'silent' }).cues).toEqual([]);
		// the sequence's style is the default
		h.ok([{ type: 'soundDesign.setSettings', style: { typing: 'keys' } }]);
		expect(deriveCues(h.doc, h.seqId, { sources: ['text'] }).cues).toHaveLength(keys.cues.length);
	});

	it('a slow typewriter keeps one key per unit (auto); words gives the word starts', () => {
		const h = typewriter('HELLO WORLD', 45); // 10 units in 0.9 s: 11 per second
		const auto = deriveCues(h.doc, h.seqId, { sources: ['text'] });
		expect(auto.cues).toEqual(deriveCues(h.doc, h.seqId, { sources: ['text'], typing: 'keys' }).cues);
		// thinned to ≤ 12 per second as before (two of the ten fall within 2.5 frames of the previous key)
		expect(auto.cues).toHaveLength(8);
		expect(auto.cues[0]!.reason).toMatch(/\(8 keys over 1\.5 s\)$/);
		const words = deriveCues(h.doc, h.seqId, { sources: ['text'], typing: 'words' });
		expect(words.cues.map((c) => (c.anchor as { unit?: number }).unit)).toEqual([0, 5]);
	});
});

describe('runs in cue derivation: a stagger is one budget unit', () => {
	it('four Pop cards 0.3 s apart are all kept under balanced (≤ 2 per second otherwise)', () => {
		const h = newHarness();
		for (const [i, at] of [0, 9, 18, 27].entries())
			h.ok([
				{
					type: 'clip.addText',
					at: at + 30,
					duration: 60,
					track: `V${i + 2}`,
					content: { text: `Card ${i + 1}` },
					textAnimation: { in: { preset: 'pop', durationFrames: 10 } },
				},
			]);
		const r = deriveCues(h.doc, h.seqId, { sources: ['text'], density: 'balanced' });
		expect(r.cues.map((c) => c.frame)).toEqual([30, 39, 48, 57]);
		expect(r.cues.every((c) => c.kind === 'appear' && c.types[0] === 'pop')).toBe(true);
		expect(new Set(r.cues.map((c) => c.group)).size).toBe(1);
		expect(r.cues[0]!.group).toMatch(/^run:/);
		expect(r.stats.runs).toBe(1);
	});
});

describe('music carries the cuts', () => {
	function edit(opts: { mute?: boolean } = {}) {
		const h = newHarness();
		placeVideo(h, 0, 90, 'V1', 'Shot A');
		placeVideo(h, 90, 90, 'V1', 'Shot B');
		placeVideo(h, 180, 90, 'V1', 'Shot C');
		const media = h.registerVideo({ kind: 'audio', seconds: 30 });
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: media },
				sourceRange: { in: { flicks: 0 }, out: { flicks: 90 * (705_600_000 / 30) } },
				at: 60,
				tracks: { audio: 'A1' },
				ref: '$m',
			},
		]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [r.refs.$m!], audioType: 'music' }]);
		if (opts.mute) {
			const doc = clone(h.doc);
			doc.sequences[h.seqId]!.audioTracks[0]!.mute = true;
			h.doc = doc;
		}
		return h;
	}

	it('a cut inside music is dropped under balanced, with its reason; rich keeps it at half confidence', () => {
		const h = edit();
		expect(musicPlaysAt(h.seq, 90)).toBe(true);
		expect(musicPlaysAt(h.seq, 180)).toBe(false);
		const balanced = deriveCues(h.doc, h.seqId, { sources: ['edits'], density: 'balanced' });
		expect(balanced.cues.map((c) => c.frame)).toEqual([180]);
		expect(balanced.stats.musicCarriesCuts).toBe(1);
		expect(balanced.carried).toHaveLength(1);
		expect(balanced.carried![0]).toMatchObject({ frame: 90, confidence: 0.25, minConfidence: 0.3 });
		expect(balanced.carried![0]!.reason).toMatch(/music carries the cut/);
		const rich = deriveCues(h.doc, h.seqId, { sources: ['edits'], density: 'rich' });
		const cut = rich.cues.find((c) => c.frame === 90)!;
		expect(cut.confidence).toBe(0.25);
		expect(cut.reason).toMatch(/; music carries the cut$/);
		expect(rich.carried).toBeUndefined();
	});

	it('off (option or the sequence style), on a muted track, or under dialogue: the cut keeps its confidence', () => {
		const h = edit();
		const off = deriveCues(h.doc, h.seqId, { sources: ['edits'], musicCarriesCuts: false });
		expect(off.cues.find((c) => c.frame === 90)?.confidence).toBe(0.5);
		h.ok([{ type: 'soundDesign.setSettings', style: { musicCarriesCuts: false } }]);
		expect(deriveCues(h.doc, h.seqId, { sources: ['edits'] }).cues.map((c) => c.frame)).toEqual([90, 180]);
		const muted = edit({ mute: true });
		expect(musicPlaysAt(muted.seq, 90)).toBe(false);
		expect(deriveCues(muted.doc, muted.seqId, { sources: ['edits'] }).cues.map((c) => c.frame)).toEqual([90, 180]);
	});
});

describe('personality', () => {
	it('every personality has a description, density and disjoint boosts / exclusions of known types', () => {
		for (const p of SOUND_PERSONALITIES) {
			const prof = SOUND_PERSONALITY_PROFILES[p];
			expect(prof.description.length).toBeGreaterThan(10);
			for (const t of [...prof.boost, ...prof.exclude]) expect(SOUND_TYPE_IDS).toContain(t);
			expect(prof.boost.some((t) => prof.exclude.includes(t))).toBe(false);
			expect(personalityDensity(p, 'balanced')).toBe(prof.density);
		}
		expect(personalityDensity(null, 'rich')).toBe('rich');
		expect(SOUND_PERSONALITY_PROFILES.calm.density).toBe('sparse');
		expect(SOUND_PERSONALITY_PROFILES.calm.exclude).toEqual(expect.arrayContaining(['boom', 'hit']));
	});

	/** A sound on the personality's side of every preference, and one on the other side. */
	function pair(p: SoundPersonality): [RankableSound, RankableSound] {
		const prof = SOUND_PERSONALITY_PROFILES[p];
		const side = (want: boolean, type: (typeof SOUND_TYPE_IDS)[number]) => ({
			// each at its type's ideal length: only the personality tells them apart, the judge favours the opposite
			durationSec: SOUND_TYPES[type].durationFit.idealSec,
			centroidHz: (prof.tone === 'dark') === want ? 600 : 5000,
			riseMs: (prof.attack === 'punchy') === want ? 2 : 90,
			below150Share: (prof.weight === 'light') === want ? 0.01 : 0.5,
			flatness: (prof.texture === 'noisy') === want ? 0.4 : 0.02,
		});
		const other = SOUND_TYPE_IDS.find(
			(t) => !prof.boost.includes(t) && (prof.exclude.length ? prof.exclude.includes(t) : true) && t !== 'ambience',
		)!;
		const otherMat = (['stone', 'water', 'rubber'] as const).find((m) => !prof.materials.includes(m))!;
		const fits: RankableSound = {
			id: 'snd_000000000000000a',
			title: 'Fits',
			types: [prof.boost[0]!],
			source: { type: 'starter' },
			license: 'CC0-1.0',
			descriptors: side(true, prof.boost[0]!),
			judge: { ok: true, score: 0.6 },
			materials: [prof.materials[0]!],
		};
		const opposite: RankableSound = {
			id: 'snd_000000000000000b',
			title: 'Opposite',
			types: [other],
			source: { type: 'starter' },
			license: 'CC0-1.0',
			descriptors: side(false, other),
			judge: { ok: true, score: 1 },
			materials: [otherMat],
		};
		return [fits, opposite];
	}

	it('each personality moves the ranking in its documented direction', () => {
		for (const p of SOUND_PERSONALITIES) {
			const [fits, opposite] = pair(p);
			const plain = rankSounds([fits, opposite]);
			expect(plain[0]!.entry.id, `${p} without a personality`).toBe(opposite.id);
			const styled = rankSounds([fits, opposite], { personality: p });
			expect(styled[0]!.entry.id, p).toBe(fits.id);
			expect(styled[0]!.parts.style).toBeGreaterThan(0);
			expect(styled[1]!.parts.style).toBeLessThan(0);
			expect(Math.abs(styled[0]!.parts.style!)).toBeLessThanOrEqual(PERSONALITY_WEIGHT);
			expect(personalityScore(fits, p)).toBeGreaterThan(0.5);
			expect(personalityScore(opposite, p)).toBeLessThan(0);
			expect(plain[0]!.parts.style ?? null).toBeNull();
		}
	});

	it('a sound of excluded types only scores −1; descriptors it lacks are not counted', () => {
		expect(personalityScore({ types: ['boom'], descriptors: {} }, 'calm')).toBe(-1);
		expect(personalityScore({ types: ['boom', 'swish'], descriptors: {} }, 'calm')).toBe(1);
		expect(personalityScore({ types: ['click'], descriptors: {} }, 'calm')).toBe(0);
		expect(personalityScore({ types: ['click'] }, null)).toBeNull();
	});

	it('styleCueTypes: exclusions out (never all), boosts first; deriveCues applies it to derived cues, not markers', () => {
		expect(styleCueTypes(['hit', 'thump', 'transition', 'glitch', 'click'], 'calm')).toEqual([
			'thump',
			'transition',
			'click',
		]);
		expect(styleCueTypes(['thump', 'hit', 'transition'], 'energetic')).toEqual(['hit', 'transition', 'thump']);
		expect(styleCueTypes(['boom', 'hit'], 'calm')).toEqual(['boom', 'hit']);
		expect(styleCueTypes(['boom', 'hit'], null)).toEqual(['boom', 'hit']);
		const { h } = phase2Fixture();
		const calm = deriveCues(h.doc, h.seqId, { personality: 'calm' });
		const cut = calm.cues.find((c) => c.kind === 'cut')!;
		expect(cut.types).not.toContain('hit');
		const marker = calm.cues.find((c) => c.source === 'marker')!;
		expect(marker.types).toEqual(['boom', 'whoosh']);
		// the sequence's personality is the default; null asks for none
		h.ok([{ type: 'soundDesign.setSettings', style: { personality: 'calm' } }]);
		expect(deriveCues(h.doc, h.seqId).cues.find((c) => c.kind === 'cut')!.types).not.toContain('hit');
		expect(deriveCues(h.doc, h.seqId, { personality: null }).cues.find((c) => c.kind === 'cut')!.types[0]).toBe(
			'hit',
		);
	});
});

describe('palette coherence (materials)', () => {
	it('paletteMaterials: the dominant material per family; ties go to the first named', () => {
		expect(
			paletteMaterials([
				{ soundId: 'a', types: ['hit'], materials: ['wood'] },
				{ soundId: 'b', types: ['thump'], materials: ['metal'] },
				{ soundId: 'c', types: ['hit'], materials: ['metal', 'wood'] },
				{ soundId: 'd', types: ['click'], materials: ['plastic'] },
				{ soundId: 'e', types: ['whoosh'], materials: [] },
				{ soundId: 'f', types: ['whoosh'] },
			]),
		).toEqual({ impacts: 'wood', digital: 'plastic' });
		expect(
			paletteMaterials([
				{ soundId: 'a', types: ['hit'], materials: ['metal'] },
				{ soundId: 'b', types: ['hit'], materials: ['wood'] },
			]),
		).toEqual({ impacts: 'metal' });
		expect(paletteMaterials([])).toEqual({});
	});

	it('the bonus applies only when the field is present, for the sound’s own family', () => {
		const pal = { impacts: 'wood' as const };
		expect(materialBonusOf({ types: ['hit'], materials: ['wood'] }, pal)).toBe(MATERIAL_BONUS);
		expect(materialBonusOf({ types: ['hit'], materials: ['metal'] }, pal)).toBe(0);
		expect(materialBonusOf({ types: ['hit'], materials: [] }, pal)).toBe(0);
		expect(materialBonusOf({ types: ['hit'] }, pal)).toBeNull();
		expect(materialBonusOf({ types: ['whoosh'], materials: ['wood'] }, pal)).toBeNull();
		expect(materialBonusOf({ types: ['hit'], materials: ['wood'] }, null)).toBeNull();
	});

	it('ranking: a wood hit outranks a slightly better metal one when the impacts are wood', () => {
		const hit = (id: string, mat: string, judge: number): RankableSound => ({
			id,
			title: `${mat} hit`,
			types: ['hit'],
			source: { type: 'starter' },
			license: 'CC0-1.0',
			descriptors: { durationSec: 1.2 },
			judge: { ok: true, score: judge },
			materials: [mat],
		});
		const metal = hit('snd_000000000000000a', 'metal', 1);
		const wood = hit('snd_000000000000000b', 'wood', 0.9);
		expect(rankSounds([metal, wood], { types: ['hit'] })[0]!.entry.id).toBe(metal.id);
		const r = rankSounds([metal, wood], { types: ['hit'], paletteMaterials: { impacts: 'wood' } });
		expect(r[0]!.entry.id).toBe(wood.id);
		expect(r[0]!.parts.material).toBe(MATERIAL_BONUS);
		expect(r[1]!.parts.material).toBe(0);
	});
});

describe('variation cycling: vary the take', () => {
	it('offeredTakeIds lists the clean takes; the cycle puts sibling takes after the ring', () => {
		const rec = 'snd_00000000000000aa';
		expect(
			offeredTakeIds({
				id: rec,
				takes: [{ index: 1 }, { index: 2, flags: ['tail-cut'] }, { index: 3, flags: [] }],
			}),
		).toEqual([takeIdOf(rec, 1), takeIdOf(rec, 3)]);
		expect(offeredTakeIds({ id: takeIdOf(rec, 1), takes: [{ index: 1 }] })).toEqual([]);
		expect(
			variationCycle({
				anchor: takeIdOf(rec, 1),
				ring: [takeIdOf(rec, 1), 'snd_00000000000000bb'],
				siblings: [takeIdOf(rec, 1), takeIdOf(rec, 3)],
				family: ['snd_00000000000000cc', 'bad id'],
				similar: ['snd_00000000000000bb', 'snd_00000000000000dd'],
			}),
		).toEqual([takeIdOf(rec, 1), 'snd_00000000000000bb', takeIdOf(rec, 3), 'snd_00000000000000cc', 'snd_00000000000000dd']);
	});
});

describe('the style in the sequence settings (soundDesign.setSettings {style})', () => {
	it('merges fields, null resets one, undo / redo, invariants hold, the save round-trips', () => {
		const h = new Harness();
		const before = h.doc;
		h.ok([{ type: 'soundDesign.setSettings', style: { personality: 'warm', runs: 'flat' } }]);
		const one = h.doc;
		expect(h.seq.soundDesign?.settings?.style).toEqual({ personality: 'warm', runs: 'flat' });
		h.ok([{ type: 'soundDesign.setSettings', style: { runs: null, typing: 'words', duckUnderTyping: true } }]);
		expect(h.seq.soundDesign?.settings?.style).toEqual({ personality: 'warm', typing: 'words', duckUnderTyping: true });
		expect(resolveSoundStyle(h.seq.soundDesign?.settings?.style)).toEqual({
			personality: 'warm',
			runs: 'climb',
			typing: 'words',
			musicCarriesCuts: true,
			duckUnderTyping: true,
		});
		expect(checkInvariants(h.doc)).toEqual([]);
		// undo: the earlier documents are untouched; redo repeats the same result
		expect(Object.values(before.sequences)[0]!.soundDesign).toBeUndefined();
		const after = h.doc;
		h.doc = one;
		h.ok([{ type: 'soundDesign.setSettings', style: { runs: null, typing: 'words', duckUnderTyping: true } }]);
		expect(h.doc.sequences[h.seqId]!.soundDesign).toEqual(after.sequences[h.seqId]!.soundDesign);
		// clearing every field removes the style
		h.ok([
			{
				type: 'soundDesign.setSettings',
				style: { personality: null, typing: null, duckUnderTyping: null },
			},
		]);
		expect(h.seq.soundDesign?.settings?.style).toBeUndefined();
		const loaded = loadProject(clone(after));
		expect(loaded.repairs).toEqual([]);
		expect(loaded.document.sequences[h.seqId]!.soundDesign?.settings?.style).toEqual(
			after.sequences[h.seqId]!.soundDesign!.settings!.style,
		);
	});

	it('refuses unknown values and keys; the schema is in the catalogue', () => {
		const schema = COMMAND_CATALOG['soundDesign.setSettings'].schema;
		expect(schema.safeParse({ type: 'soundDesign.setSettings', style: { personality: 'calm' } }).success).toBe(true);
		const h = new Harness();
		for (const style of [{ personality: 'grumpy' }, { runs: 'down' }, { typing: 'fast' }, { volume: 3 }, { musicCarriesCuts: 'yes' }]) {
			const r = h.tx([{ type: 'soundDesign.setSettings', style }]);
			expect(r.ok, JSON.stringify(style)).toBe(false);
		}
		expect(h.seq.soundDesign).toBeUndefined();
	});

	it('reads a damaged style leniently (bad fields dropped, newer ones kept) and repair fixes it', () => {
		const s = readSoundDesignSettings({
			delivery: 'web',
			density: 'balanced',
			sfxTrackIds: [],
			roomBus: null,
			seed: 0,
			style: { personality: 'grumpy', runs: 'flat', future: 1 },
		});
		expect(s.style).toEqual({ runs: 'flat', future: 1 });
		expect(readSoundDesignSettings({ style: 7 }).style).toBeUndefined();
		const h = new Harness();
		h.ok([{ type: 'soundDesign.setSettings', style: { personality: 'calm' } }]);
		const doc = clone(h.doc);
		(doc.sequences[h.seqId]!.soundDesign!.settings as Record<string, unknown>).style = { personality: 5, typing: 'words' };
		expect(checkInvariants(doc).length).toBeGreaterThan(0);
		const { document } = repairDocument(doc, h.ids);
		expect(document.sequences[h.seqId]!.soundDesign!.settings!.style).toEqual({ typing: 'words' });
		expect(checkInvariants(document)).toEqual([]);
	});

	it('resolveSoundStyle: the first layer that sets a field wins, then the defaults', () => {
		expect(resolveSoundStyle()).toEqual({
			personality: null,
			runs: 'climb',
			typing: 'auto',
			musicCarriesCuts: true,
			duckUnderTyping: false,
		});
		expect(
			resolveSoundStyle({ personality: null, typing: 'keys' }, { personality: 'calm', typing: 'words', runs: 'flat' }),
		).toMatchObject({ personality: null, typing: 'keys', runs: 'flat' });
		expect(resolveSoundStyle({ runs: 'bad' as never }, null).runs).toBe('climb');
	});
});
