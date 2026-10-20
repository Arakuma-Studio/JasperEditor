// The cue grammar in the sound-design plan (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"), on a typing + UI fixture with
// a synthetic library: a fast typewriter gets one key per word, filled with distinct sibling takes at rate 1; a
// stagger of four Pop cards climbs 0 / +1 / +2 / +3 st and shares a group; the clicks share one sound and one level; a
// cut inside music is dropped under balanced with its reason; the impacts keep one material; a personality moves the
// picks; the music dips under typing on request. Deterministic; the proposal applies and places what the report says.
import { createHash } from 'node:crypto';
import {
	type RegisterSoundResponse,
	type SoundDesignPlanRequest,
	type SoundEntry,
	type SoundTake,
	withOfferedTakes,
} from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	clipPitchOf,
	createCounterIdSource,
	createEmptyProject,
	createProposal,
	defaultRegistries,
	isSetupItem,
	type ProjectDocument,
	parseTakeId,
	planAccept,
	soundCuesOf,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import {
	collectPlanCues,
	composePlanDraft,
	resolveStyle,
	selectPlanSounds,
} from '../src/sound-design/plan.ts';
import { provenanceOf } from '../src/sounds/service.ts';
import { asset, F } from './sound-design-fixture.ts';

const FAST = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';

/** An audio-only media (music) of `seconds`. */
function audioAsset(seconds: number) {
	const a = asset('video', seconds) as unknown as { probe: { streams: unknown[] } };
	return {
		...a,
		kind: 'audio',
		originalName: 'music.wav',
		container: 'wav',
		probe: {
			...a.probe,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
		},
	};
}

/**
 * The typing + UI fixture (30 fps): shots A | B | C (cuts at 90 and 180), music under the first cut (60–150) and under
 * the typing (195–300) on A1, a fast typewriter (35 characters typed in 0.6 s) at 200, four Pop cards 0.5 s apart from
 * 330, three "sfx: click" markers and two "sfx: hit" markers.
 */
export function typingFixture() {
	const ids = createCounterIdSource(91);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Grammar', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	let revision = 0;
	const tx = (commands: unknown[]) => {
		const { document, result } = applyTransaction(
			doc,
			{ label: 't', origin: 'user', sequenceId: seqId, commands: commands as never },
			{ ids, now: () => '2026-10-18T10:00:00.000Z', revision, registries: defaultRegistries(mgRegistry) },
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		doc = document;
		revision = result.revision;
		return result.refs;
	};
	for (const [at, frames] of [
		[0, 90],
		[90, 90],
		[180, 450],
	] as const)
		tx([
			{ type: 'media.register', asset: asset('video'), ref: '$m' },
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				sourceRange: { in: { flicks: 30 * F }, out: { flicks: (30 + frames) * F } },
				at,
				tracks: { video: 'V1' },
				audio: false,
			},
		]);
	for (const [at, frames] of [
		[60, 90],
		[195, 105],
	] as const) {
		const r = tx([
			{ type: 'media.register', asset: audioAsset(30), ref: '$a' },
			{
				type: 'clip.place',
				source: { mediaId: '$a' },
				sourceRange: { in: { flicks: 0 }, out: { flicks: frames * F } },
				at,
				tracks: { audio: 'A1' },
				ref: '$c',
			},
		]);
		tx([{ type: 'essentialSound.setType', clipIds: [r.$c!], audioType: 'music' }]);
	}
	tx([
		{
			type: 'clip.addText',
			at: 200,
			duration: 90,
			track: 'V3',
			content: { text: FAST },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 30 } },
		},
	]);
	for (const [i, at] of [330, 345, 360, 375].entries())
		tx([
			{
				type: 'clip.addText',
				at,
				duration: 60,
				track: `V${i + 4}`,
				content: { text: `Card ${i + 1}` },
				textAnimation: { in: { preset: 'pop', durationFrames: 10 } },
			},
		]);
	tx([
		{ type: 'marker.add', frame: 420, name: 'sfx: click' },
		{ type: 'marker.add', frame: 450, name: 'sfx: click' },
		{ type: 'marker.add', frame: 480, name: 'sfx: click' },
		{ type: 'marker.add', frame: 520, name: 'sfx: hit' },
		{ type: 'marker.add', frame: 560, name: 'sfx: hit' },
	]);
	return { get: () => doc, seqId, revision: () => revision, tx };
}

let sn = 0xe600;
function entry(title: string, types: string[], over: Partial<SoundEntry> = {}): SoundEntry {
	sn++;
	return {
		id: `snd_${sn.toString(16).padStart(16, '0')}`,
		fingerprint: `q1:${sn.toString(16).padStart(64, '0')}`,
		title,
		types,
		tags: [],
		source: { type: 'starter', file: `${title}.wav` },
		license: 'CC0-1.0',
		author: 'Test',
		attribution: null,
		format: { durationSec: 0.3, sampleRate: 48000, channels: 2, container: 'wav' },
		descriptors: {
			durationSec: 0.3,
			peakSec: 0.02,
			onsetSec: 0.01,
			riseMs: 2,
			decayMs: 80,
			decays: true,
			tailSec: 0.2,
			centroidHz: 2500,
			rolloff85Hz: 6000,
			below150Share: 0.05,
			above6kShare: 0.1,
			flatness: 0.15,
			octaveBandsDb: [-24, -22, -18, -16, -18, -22, -28],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -22,
			maxMomentaryLufs: -16,
			truePeakDb: -3,
			stereoWidth: 0.1,
			headQuietSec: 0.01,
			loopable: false,
		},
		judge: { ok: true, score: 0.9, reasons: [], type: types[0] ?? 'hit' },
		indexedAt: '2026-10-18T00:00:00.000Z',
		analysisVersion: 2002,
		...over,
	} as SoundEntry;
}
const judged = (score: number, type: string) => ({ judge: { ok: true, score, reasons: [], type } });

/** A typing recording (multi-hit) with `n` clean takes. */
function typingRun(n: number): SoundEntry {
	const rec = entry('Keyboard typing run', ['key'], {
		format: { durationSec: 12, sampleRate: 48000, channels: 2, container: 'flac' },
		judge: { ok: false, score: 0.2, reasons: ['too-long', 'multi-hit'], type: 'key' },
		materials: ['plastic'],
	});
	rec.takes = Array.from(
		{ length: n },
		(_, i): SoundTake => ({
			index: i + 1,
			startSec: i * 0.4,
			endSec: i * 0.4 + 0.15,
			headDb: -40,
			tailDb: -42,
			flags: [],
			strokes: 2,
			descriptors: {
				...rec.descriptors,
				durationSec: 0.15,
				peakSec: 0.006,
				tailSec: 0.12,
				headQuietSec: 0.004,
			},
			judge: { ok: true, score: 1, reasons: [], type: 'key' },
		}),
	);
	return rec;
}

const REC = typingRun(8);
const BASE: SoundEntry[] = [
	REC,
	entry('Key a', ['key'], judged(0.8, 'key')),
	entry('Key b', ['key'], judged(0.8, 'key')),
	entry('Mouse click a', ['click'], judged(0.95, 'click')),
	entry('Mouse click b', ['click'], judged(0.9, 'click')),
	entry('Switch click', ['click'], judged(0.85, 'click')),
	entry('Bubble pop a', ['pop'], judged(0.95, 'pop')),
	entry('Bubble pop b', ['pop'], judged(0.9, 'pop')),
	entry('Bubble pop c', ['pop'], judged(0.85, 'pop')),
	entry('Metal hit', ['hit'], { ...judged(1, 'hit'), materials: ['metal'] }),
	entry('Wood hit', ['hit'], { ...judged(0.97, 'hit'), materials: ['wood'] }),
	entry('Steel hit', ['hit'], { ...judged(0.94, 'hit'), materials: ['metal'] }),
	entry('Iron hit', ['hit'], { ...judged(0.92, 'hit'), materials: ['metal'] }),
	entry('Soft thump', ['thump'], { ...judged(0.9, 'thump'), materials: ['cloth'] }),
	entry('Paper swish', ['swish'], { ...judged(0.9, 'swish'), materials: ['paper'] }),
].sort((a, b) => (a.id < b.id ? -1 : 1));
const POOL = withOfferedTakes(BASE);
/** The same library before the materials index field (P6-E9 not run): the palette bonus does not apply. */
const NO_MATERIALS = withOfferedTakes(BASE.map(({ materials: _m, ...e }) => e as SoundEntry));

const CUE_SOURCES = ['edits', 'text', 'markers'] as const;

function planOf(
	doc: ProjectDocument,
	seqId: string,
	style: SoundDesignPlanRequest['style'] = {},
	pool = POOL,
) {
	const request = {
		projectId: doc.projectId,
		sequenceId: seqId,
		style: { seed: 5, cueSources: [...CUE_SOURCES], ...style },
	} as SoundDesignPlanRequest;
	const seq = doc.sequences[seqId]!;
	const st = resolveStyle(request, seq);
	const collected = collectPlanCues(doc, seq, request, st, { mgTemplates: mgRegistry });
	const selected = selectPlanSounds(doc, seq, collected.cues, pool, st);
	return { request, seq, style: st, collected, selected };
}

function registered(e: SoundEntry): RegisterSoundResponse {
	const hex = createHash('sha256').update(e.id).digest('hex');
	return {
		mediaKey: `mk_${hex.slice(0, 24)}`,
		fingerprint: `q1:${hex}`,
		originalName: `${e.title}.wav`,
		sizeBytes: 1000,
		container: 'wav',
		kind: 'audio',
		probe: {
			durationFlicks: Math.round(0.4 * 705_600_000),
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [],
		browserPlayable: 'yes',
		library: provenanceOf(e, 'snapshot-g', 0.05),
		existingMediaId: null,
	} as RegisterSoundResponse;
}

const at = (r: ReturnType<typeof planOf>, frame: number) =>
	r.selected.picks.find((p) => p.cue.frame === frame);

describe('the cue grammar in the plan (typing + UI fixture)', () => {
	const f = typingFixture();
	const r = planOf(f.get(), f.seqId);

	it('fast typing: one key per word start, each a distinct sibling take, at rate 1 (no varispeed)', () => {
		const keys = r.selected.picks.filter((p) => p.cue.derived?.group?.includes('typewriter'));
		// 35 characters in 0.6 s (58 typed/s): the nine word starts
		expect(keys.map((p) => (p.cue.derived!.anchor as { unit?: number }).unit)).toEqual([
			0, 3, 8, 13, 16, 21, 25, 28, 32,
		]);
		for (const k of keys) {
			expect(parseTakeId(k.sounds[0]!.entry.id)?.parentId).toBe(REC.id);
			expect(k.rate).toBe(1);
			expect(k.variation).toBe('takes');
			expect(Math.abs(k.gainOffsetDb)).toBeLessThanOrEqual(1);
			expect(k.notes).toContain('no varispeed: keys, ticks and taps vary the take, not the pitch');
		}
		const ids = keys.map((k) => k.sounds[0]!.entry.id);
		for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
		expect(new Set(ids.slice(0, 8)).size).toBe(8);
	});

	it('a 4-card stagger climbs 0 / +1 / +2 / +3 st by varispeed and the cards share a group', () => {
		const cards = [330, 345, 360, 375].map((fr) => at(r, fr)!);
		expect(cards.every((c) => c.sounds[0]!.entry.types.includes('pop'))).toBe(true);
		expect(cards.map((c) => c.pitchSt ?? 0)).toEqual([0, 1, 2, 3]);
		expect(cards.map((c) => c.rate)).toEqual([1, 1, 1, 1]);
		expect(cards.map((c) => c.run)).toEqual([
			{ group: 'run:1', index: 1, of: 4, st: 0 },
			{ group: 'run:1', index: 2, of: 4, st: 1 },
			{ group: 'run:1', index: 3, of: 4, st: 2 },
			{ group: 'run:1', index: 4, of: 4, st: 3 },
		]);
		expect(cards[2]!.notes).toContain('run 3 of 4: +2 st');
		// flat: the run is found, nothing is pitched
		const flat = planOf(f.get(), f.seqId, { runs: 'flat' });
		expect([330, 345, 360, 375].map((fr) => at(flat, fr)!.pitchSt ?? 0)).toEqual([0, 0, 0, 0]);
		expect(at(flat, 345)!.notes).toContain('run 2 of 4: flat');
	});

	it('the clicks share one sound and one level: no varispeed, no gain jitter', () => {
		const clicks = [420, 450, 480].map((fr) => at(r, fr)!);
		expect(new Set(clicks.map((c) => c.sounds[0]!.entry.id)).size).toBe(1);
		expect(clicks[0]!.sounds[0]!.entry.title).toBe('Mouse click a');
		for (const c of clicks) {
			expect(c.rate).toBe(1);
			expect(c.gainOffsetDb).toBe(0);
			expect(c.variation).toBe('voice');
			expect(c.voice).toEqual({ type: 'click', soundId: clicks[0]!.sounds[0]!.entry.id });
		}
		expect(r.selected.grammar.voices).toEqual({ click: clicks[0]!.sounds[0]!.entry.id });
		// the palette sound is the voice when the sequence has one
		const pal = BASE.find((e) => e.title === 'Switch click')!.id;
		const withPalette = planOf(f.get(), f.seqId, { palette: [pal] });
		expect([420, 450, 480].map((fr) => at(withPalette, fr)!.sounds[0]!.entry.id)).toEqual([pal, pal, pal]);
	});

	it('a cut inside music is dropped under balanced with its reason; the cut outside music is kept', () => {
		expect(at(r, 90)).toBeUndefined();
		const skip = r.collected.skipped.find((s) => s.frame === 90)!;
		expect(skip).toMatchObject({ code: 'MUSIC_CARRIES_CUT', kind: 'cut' });
		expect(skip.reason).toMatch(
			/^music carries the cut: its confidence is halved to 0\.25, under the balanced minimum 0\.3/,
		);
		expect(at(r, 180)?.cue.kind).toBe('cut');
		// rich keeps it (half confidence), with the reason; off brings it back
		expect(at(planOf(f.get(), f.seqId, { density: 'rich' }), 90)?.cue.reason).toMatch(
			/music carries the cut/,
		);
		expect(at(planOf(f.get(), f.seqId, { musicCarriesCuts: false }), 90)?.cue.kind).toBe('cut');
	});

	it('palette coherence: the impacts keep the material of the first one (metal); without materials rotation wins', () => {
		const hits = [180, 520, 560].map((fr) => at(r, fr)!.sounds[0]!.entry);
		expect(hits.map((h) => h.title)).toEqual(['Metal hit', 'Steel hit', 'Iron hit']);
		expect(hits.every((h) => h.materials?.includes('metal'))).toBe(true);
		expect(at(r, 520)!.sounds[0]!.parts.material).toBeGreaterThan(0);
		expect(r.selected.grammar.materials.impacts).toBe('metal');
		const plain = planOf(f.get(), f.seqId, {}, NO_MATERIALS);
		expect([180, 520].map((fr) => at(plain, fr)!.sounds[0]!.entry.title)).toEqual(['Metal hit', 'Wood hit']);
	});

	it('a personality moves the picks: calm leaves the hits out of cut cues and is sparse by default', () => {
		const calm = planOf(f.get(), f.seqId, { personality: 'calm' });
		expect(calm.style.density).toBe('sparse');
		expect(calm.selected.grammar.personality).toBe('calm');
		const cut = at(calm, 180)!;
		expect(cut.cue.types).not.toContain('hit');
		expect(cut.sounds[0]!.entry.types).not.toContain('hit');
		// a density given with it wins
		expect(planOf(f.get(), f.seqId, { personality: 'calm', density: 'rich' }).style.density).toBe('rich');
		// the sequence's personality is the default
		f.tx([{ type: 'soundDesign.setSettings', style: { personality: 'calm' } }]);
		expect(planOf(f.get(), f.seqId).style.grammar.personality).toBe('calm');
		expect(at(planOf(f.get(), f.seqId), 180)!.cue.types).not.toContain('hit');
		f.tx([{ type: 'soundDesign.setSettings', style: { personality: null } }]);
	});

	it('a typewriter filled with ticks (no key recording) is typing, not a climbing run: speed 1, one type', () => {
		const ticksOnly = withOfferedTakes([
			...BASE.filter((e) => !e.types.includes('key')),
			entry('Tick a', ['tick'], judged(0.9, 'tick')),
			entry('Tick b', ['tick'], judged(0.85, 'tick')),
		]);
		const t = planOf(f.get(), f.seqId, {}, ticksOnly);
		const keys = t.selected.picks.filter((p) => p.cue.derived?.group?.includes('typewriter'));
		expect(keys.length).toBe(9);
		for (const k of keys) {
			expect(k.sounds[0]!.entry.types).toContain('tick');
			expect(k.rate).toBe(1);
			expect(k.pitchSt ?? 0).toBe(0);
			expect(k.run).toBeUndefined();
			expect(k.variation).toBe('takes');
		}
	});

	it('is deterministic', () => {
		const again = planOf(f.get(), f.seqId);
		const sig = (x: typeof r) =>
			x.selected.picks.map((p) => [
				p.cue.frame,
				p.sounds[0]!.entry.id,
				p.rate,
				p.pitchSt ?? 0,
				p.gainOffsetDb,
			]);
		expect(sig(again)).toEqual(sig(r));
	});
});

describe('the proposal places what the grammar decided', () => {
	it('keys at rate 1, the run pitched by varispeed, one click level, the duck under typing; one transaction', () => {
		const f = typingFixture();
		const r = planOf(f.get(), f.seqId, { duckUnderTyping: true });
		const typing = r.selected.picks.find((p) => p.cue.frame === 200)!;
		expect(typing.duck?.clipIds).toHaveLength(1);
		expect(r.selected.grammar.typingDucks).toBe(1);
		const reg = new Map<string, RegisterSoundResponse>();
		for (const p of r.selected.picks) for (const s of p.sounds) reg.set(s.entry.id, registered(s.entry));
		const composed = composePlanDraft(f.get(), r.seq, r.request, r.style, r.selected.picks, reg, {
			skipped: [...r.collected.skipped, ...r.selected.skipped],
			warnings: [],
			considered: r.collected.cues.length,
			snapshotHash: 'snapshot-g',
			librarySize: POOL.length,
			grammar: r.selected.grammar,
		});
		const { draft, report } = composed;
		expect(report.grammar).toMatchObject({ runCount: 1, carriedCuts: 1, typingDucks: 1, runs: 'climb' });
		expect(composed.voiceGroups).toHaveLength(1);
		expect(composed.voiceGroups[0]).toHaveLength(3);
		const card = report.events.find((e) => e.frame === 360)!;
		expect(card.run).toEqual({ group: 'run:1', index: 3, of: 4, st: 2 });
		expect(card.rate).toBeCloseTo(2 ** (2 / 12), 6);
		const duckItem = draft!.items.find((i) => i.id.startsWith('duck:'))!;
		expect(duckItem.commands[0]).toMatchObject({
			type: 'audio.volumeDip',
			dips: [{ depthDb: -6, fadeMs: 80 }],
		});
		const c = createProposal(
			f.get(),
			draft!,
			{
				id: 'prp_00000000000000E6',
				projectId: f.get().projectId,
				author: { agent: 't' },
				now: '2026-10-18T00:00:00.000Z',
				revision: f.revision(),
			},
			{ registries: defaultRegistries(mgRegistry) },
		);
		if (!c.ok) throw new Error(JSON.stringify(c.errors));
		expect(c.proposal.items.filter((i) => i.state !== 'pending')).toEqual([]);
		const placeIds = c.proposal.items.filter((i) => !isSetupItem(i)).map((i) => i.id);
		const plan = planAccept(f.get(), c.proposal, placeIds, 'user', {
			registries: defaultRegistries(mgRegistry),
		});
		if (!plan.ok || !plan.composed) throw new Error(JSON.stringify(plan));
		const { document, result } = applyTransaction(f.get(), plan.composed.tx as never, {
			ids: createCounterIdSource(500),
			now: () => '2026-10-18T00:00:00.000Z',
			revision: f.revision(),
			registries: defaultRegistries(mgRegistry),
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
		const seq = document.sequences[f.seqId]!;
		const cues = soundCuesOf(seq);
		const clipAt = (frame: number) => {
			const cue = cues.find((x) => x.frame === frame)!;
			return seq.clips[cue.placedClipIds![0]!] as AudioClip & { sfx: ClipSfx };
		};
		// keys play at speed 1
		for (const fr of r.selected.picks.filter((p) => p.variation === 'takes').map((p) => p.cue.frame))
			expect(clipAt(fr).speed.rate).toBe(1);
		// the cards climb by varispeed: speed 2^(st/12), maintain pitch off, read back as +st semitones
		for (const [i, fr] of [330, 345, 360, 375].entries()) {
			const clip = clipAt(fr);
			expect(clip.speed.rate).toBeCloseTo(2 ** (i / 12), 6);
			if (i) expect(clip.speed.maintainPitch).toBe(false);
			expect(clipPitchOf(clip).st).toBe(i);
		}
		// the clicks: one sound at one gain, speed 1
		const clicks = [420, 450, 480].map(clipAt);
		expect(new Set(clicks.map((x) => x.sfx.soundId)).size).toBe(1);
		expect(new Set(clicks.map((x) => x.gainDb)).size).toBe(1);
		expect(clicks.every((x) => x.speed.rate === 1)).toBe(true);
		// the music under the typing dips 6 dB
		const music = Object.values(seq.clips).find((x) => x.kind === 'audio' && x.start === 195) as AudioClip;
		expect(music.volumeDb.keyframes.length).toBeGreaterThan(0);
		expect(Math.min(...music.volumeDb.keyframes.map((k) => k.value as number))).toBeCloseTo(
			music.volumeDb.value - 6,
			6,
		);
	});
});
