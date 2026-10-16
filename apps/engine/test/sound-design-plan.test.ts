// The sound-design plan (spec 12 §2.8, P3-R3; wp-note "Phase 3 → WP3.2"): cues → rank → register → place → proposal,
// deterministic by seed. Part 1 checks the pure selection and draft on the Phase 2 fixture with a synthetic library
// (determinism, palette, sources, dialogue, stored + derived cues, alternatives, requires closure, limits); part 2 runs
// the job through the route on a real engine with an indexed kit (proposal stored, policy, accept as one transaction,
// cancellation, typed errors).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type EngineJob,
	type RegisterSoundResponse,
	type SoundDesignPlanRequest,
	type SoundDesignPlanResult,
	SoundDesignPlanResultSchema,
	type SoundEntry,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type AudioClip,
	type ClipSfx,
	createProposal,
	defaultRegistries,
	dependencyClosure,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	planAccept,
	soundCuesOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	collectPlanCues,
	composePlanDraft,
	type PlanStyle,
	resolveStyle,
	selectPlanSounds,
} from '../src/sound-design/plan.ts';
import { provenanceOf } from '../src/sounds/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, tempAppdir } from './helpers.ts';
import { asset, fixture } from './sound-design-fixture.ts';
import { PACK, writeWav } from './sound-fixtures.ts';

// ---------------------------------------------------------------------------------------------------------------
// A synthetic library (no files): a few sounds per type, real recordings and synth.

let sn = 0;
function entry(
	title: string,
	types: string[],
	o: { source?: string; license?: string; peak?: number } = {},
): SoundEntry {
	sn++;
	return {
		id: `snd_${sn.toString(16).padStart(16, '0')}`,
		fingerprint: `q1:${sn.toString(16).padStart(64, '0')}`,
		title,
		types,
		tags: [],
		source:
			o.source === 'synth'
				? { type: 'synth', recipe: types[0] ?? 'hit', seed: sn }
				: o.source === 'folder'
					? { type: 'folder', rootId: 'root_1', relPath: `${title}.wav` }
					: { type: 'starter', file: `${title}.wav` },
		license: o.license ?? 'CC0-1.0',
		author: 'Test',
		attribution: null,
		format: { durationSec: 0.6, sampleRate: 48000, channels: 2, container: 'wav' },
		descriptors: {
			durationSec: 0.6,
			peakSec: o.peak ?? 0.02,
			onsetSec: 0.01,
			riseMs: 2,
			decayMs: 120,
			decays: true,
			tailSec: 0.4,
			centroidHz: 1500,
			rolloff85Hz: 5000,
			below150Share: 0.2,
			above6kShare: 0.05,
			flatness: 0.2,
			octaveBandsDb: [-20, -18, -16, -18, -20, -24, -30],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -20,
			maxMomentaryLufs: -14,
			truePeakDb: -2,
			stereoWidth: 0.2,
			headQuietSec: 0.01,
			loopable: false,
		},
		judge: { ok: true, score: 0.9, reasons: [] },
		indexedAt: '2026-10-16T00:00:00.000Z',
		analysisVersion: 1001,
	} as SoundEntry;
}

const POOL: SoundEntry[] = [
	...['Punch hit', 'Crunch hit', 'Metal hit', 'Wood hit', 'Glass hit'].map((t) => entry(t, ['hit'])),
	...['Air whoosh', 'Fast whoosh', 'Cloth whoosh', 'Wide whoosh'].map((t) => entry(t, ['whoosh'])),
	...['Soft thump', 'Deep thump'].map((t) => entry(t, ['thump'])),
	entry('Low boom', ['boom']),
	entry('Blade swish', ['swish']),
	...['Key a', 'Key b', 'Key c'].map((t) => entry(t, ['key'])),
	entry('Bubble pop', ['pop']),
	entry('Shimmer', ['shimmer'], { license: 'CC-BY-NC-4.0' }),
	...['hit', 'whoosh', 'thump', 'boom', 'key', 'pop', 'tap', 'swish', 'reverse'].map((t) =>
		entry(`Synth ${t}`, [t], { source: 'synth' }),
	),
].sort((a, b) => (a.id < b.id ? -1 : 1));

function planOf(doc: ProjectDocument, seqId: string, req: Partial<SoundDesignPlanRequest> = {}, pool = POOL) {
	const request = { projectId: doc.projectId, sequenceId: seqId, ...req } as SoundDesignPlanRequest;
	const seq = doc.sequences[seqId]!;
	const style = resolveStyle(request, seq);
	const collected = collectPlanCues(doc, seq, request, style, { mgTemplates: mgRegistry });
	const allowed = new Set(style.sources);
	const selected = selectPlanSounds(
		doc,
		seq,
		collected.cues,
		pool.filter((e) => allowed.has(e.source.type as never)),
		style,
	);
	return { request, seq, style, collected, selected };
}

const picksOf = (r: ReturnType<typeof planOf>) =>
	r.selected.picks.map((p) => [p.cue.frame, p.cue.kind, p.sounds[0]!.entry.title, p.role]);

/** A registered response for a synthetic entry (what the engine's register would answer). */
function registered(e: SoundEntry): RegisterSoundResponse {
	return {
		mediaKey: `mk_${e.id.slice(4)}`,
		fingerprint: `q1:${e.id.slice(4).padStart(64, 'f')}`,
		originalName: `${e.title}.wav`,
		sizeBytes: 1000,
		container: 'wav',
		kind: 'audio',
		probe: {
			durationFlicks: Math.round(0.65 * 705_600_000),
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
		library: provenanceOf(e, 'snapshot-1', 0.05),
		existingMediaId: null,
	} as RegisterSoundResponse;
}

/** A plain audio file (a voice recording) of `seconds`. */
function audioAsset(seconds: number) {
	const a = asset('video', seconds) as unknown as {
		probe: { streams: unknown[] };
		kind: string;
		originalName: string;
	};
	return {
		...a,
		kind: 'audio',
		originalName: 'voice.wav',
		container: 'wav',
		probe: {
			...a.probe,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 1,
					channelLayout: 'mono',
				},
			],
		},
	};
}

/** The fixture plus an audio clip tagged Dialogue over `[from, to)` on A1 (no transcript: the clip counts). */
function withDialogue(f: ReturnType<typeof fixture>, from: number, to: number) {
	const r = f.tx([
		{ type: 'media.register', asset: audioAsset(30), ref: '$m' },
		{
			type: 'clip.place',
			source: { mediaId: '$m' },
			sourceRange: { in: { flicks: 0 }, out: { flicks: Math.round(((to - from) / 30) * 705_600_000) } },
			at: from,
			tracks: { audio: 'A1' },
			ref: '$c',
		},
	]);
	f.tx([{ type: 'essentialSound.setType', clipIds: [r.$c!], audioType: 'dialogue' }]);
}

describe('plan selection (pure)', () => {
	it('derives the fixture’s cues and gives each a ranked, rotated sound with alternatives; deterministic by seed', () => {
		const f = fixture();
		const a = planOf(f.get(), f.seqId, { style: { seed: 7 } });
		const again = planOf(f.get(), f.seqId, { style: { seed: 7 } });
		expect(picksOf(again)).toEqual(picksOf(a));
		expect(again.selected.picks.map((p) => [p.rate, p.gainOffsetDb])).toEqual(
			a.selected.picks.map((p) => [p.rate, p.gainOffsetDb]),
		);
		const frames = a.selected.picks.map((p) => p.cue.frame);
		expect(frames).toEqual(expect.arrayContaining([46, 52, 90, 180, 200, 250, 330, 360, 405]));
		const push = a.selected.picks.find((p) => p.cue.frame === 180)!;
		expect(push.sounds[0]!.entry.types).toContain('whoosh');
		expect(push.sounds.length).toBe(4);
		expect(new Set(push.sounds.map((s) => s.entry.id)).size).toBe(4);
		// Real recordings rank before synth; the NC-licensed sound is never offered.
		expect(push.sounds.every((s) => s.entry.source.type !== 'synth')).toBe(true);
		for (const p of a.selected.picks) expect(p.sounds.some((s) => s.entry.title === 'Shimmer')).toBe(false);
		// Neighbouring cues of one type rotate (the typewriter keys never repeat the previous key).
		const keys = a.selected.picks.filter((p) => p.cue.types[0] === 'key').map((p) => p.sounds[0]!.entry.id);
		expect(keys.length).toBeGreaterThan(3);
		for (let i = 1; i < keys.length; i++) expect(keys[i]).not.toBe(keys[i - 1]);
		// Rates within ±2 %, gain offsets within ±1 dB.
		for (const p of a.selected.picks) {
			expect(Math.abs(p.rate - 1)).toBeLessThanOrEqual(0.02);
			expect(Math.abs(p.gainOffsetDb)).toBeLessThanOrEqual(1);
		}
		// Another seed changes the rotation or the variation somewhere.
		const other = planOf(f.get(), f.seqId, { style: { seed: 8 } });
		expect(
			JSON.stringify(other.selected.picks.map((p) => [p.sounds[0]!.entry.id, p.rate])) !==
				JSON.stringify(a.selected.picks.map((p) => [p.sounds[0]!.entry.id, p.rate])),
		).toBe(true);
	});

	it('puts palette sounds first', () => {
		const f = fixture();
		const base = planOf(f.get(), f.seqId);
		const push = base.selected.picks.find((p) => p.cue.frame === 180)!;
		// The palette names the whoosh the plan would rank last of the four.
		const last = push.sounds[3]!.entry;
		const pal = planOf(f.get(), f.seqId, { style: { palette: [last.id] } });
		const first = pal.selected.picks.find((p) => p.sounds.some((s) => s.entry.id === last.id))!;
		expect(first.sounds[0]!.entry.id).toBe(last.id);
		// "project" reads the sequence palette (soundDesign.setPalette).
		f.tx([{ type: 'soundDesign.setPalette', soundIds: [last.id] }]);
		const proj = planOf(f.get(), f.seqId);
		expect(proj.style.palette).toEqual([last.id]);
		expect(proj.selected.picks.find((p) => p.cue.frame === first.cue.frame)!.sounds[0]!.entry.id).toBe(
			last.id,
		);
	});

	it('honours the sources: synth only, or recordings only (cues no recording fits are skipped NO_SOUND)', () => {
		const f = fixture();
		const synth = planOf(f.get(), f.seqId, { style: { sources: ['synth'] } });
		expect(synth.selected.picks.length).toBeGreaterThan(0);
		for (const p of synth.selected.picks) {
			expect(p.sounds.every((s) => s.entry.source.type === 'synth')).toBe(true);
			expect(p.notes.join(' ')).toMatch(/Jasper Synth/);
		}
		const kit = planOf(f.get(), f.seqId, { style: { sources: ['starter'] } });
		for (const p of kit.selected.picks)
			expect(p.sounds.every((s) => s.entry.source.type === 'starter')).toBe(true);
		// The marker asks for boom + whoosh: two layers, the one starter boom and a whoosh.
		const marker = kit.selected.picks.find((p) => p.cue.frame === 250)!;
		expect(marker.sounds[0]!.entry.title).toBe('Low boom');
		expect(marker.extraLayers.map((l) => l.sound.entry.types)).toEqual([['whoosh']]);
		// A pool without whooshes or swishes: the push gets no sound, with the reason.
		const noMove = planOf(
			f.get(),
			f.seqId,
			{ style: { sources: ['starter'] } },
			POOL.filter(
				(e) => !e.types.some((t) => ['whoosh', 'swish', 'transition', 'reverse', 'riser'].includes(t)),
			),
		);
		const skipped = noMove.selected.skipped.find((s) => s.frame === 180)!;
		expect(skipped).toMatchObject({ code: 'NO_SOUND', kind: 'transition' });
		expect(skipped.reason).toMatch(/no commercial-safe sound of type whoosh/);
	});

	it('respects dialogue: no cut cue under words, a hero under words becomes support', () => {
		const f = fixture();
		withDialogue(f, 80, 100);
		withDialogue(f, 240, 262);
		f.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 95, kind: 'cut', weight: 'support', source: 'user', types: ['hit'] }],
			},
		]);
		const on = planOf(f.get(), f.seqId);
		expect(on.selected.picks.find((p) => p.cue.frame === 90)).toBeUndefined();
		expect(on.collected.skipped.find((s) => s.frame === 95)).toMatchObject({ code: 'DIALOGUE' });
		const hero = on.selected.picks.find((p) => p.cue.frame === 250)!;
		expect(hero.cue.weight).toBe('hero');
		expect(hero.role).toBe('support');
		expect(hero.notes[0]).toMatch(/under spoken words/);
		const off = planOf(f.get(), f.seqId, { style: { respectDialogue: false } });
		expect(off.selected.picks.find((p) => p.cue.frame === 90)).toBeDefined();
		expect(off.selected.picks.find((p) => p.cue.frame === 95)).toBeDefined();
		expect(off.selected.picks.find((p) => p.cue.frame === 250)!.role).toBe('hero');
	});

	it('plans stored unfilled cues and derived ones once; skips filled, muted, silence and near-duplicates; explicit ids', () => {
		const f = fixture();
		const stored = f.tx([
			{
				type: 'soundCue.add',
				cues: [
					// the derived cut at 90, stored (same frame and kind): planned once, as the stored cue
					{ frame: 90, kind: 'cut', weight: 'support', source: 'user', types: ['thump'], ref: '$cut' },
					// two frames from the derived marker cue (250): the stored one wins
					{ frame: 252, kind: 'manual', weight: 'support', source: 'user', types: ['pop'], ref: '$near' },
					{
						frame: 500,
						kind: 'manual',
						weight: 'support',
						source: 'user',
						types: ['hit'],
						muted: true,
						ref: '$mute',
					},
					{ frame: 520, kind: 'silence', weight: 'ambient', source: 'user', ref: '$sil' },
					{ frame: 540, kind: 'manual', weight: 'support', source: 'user', ref: '$none' },
				],
			},
		]);
		const r = planOf(f.get(), f.seqId);
		const at90 = r.selected.picks.filter((p) => p.cue.frame === 90);
		expect(at90).toHaveLength(1);
		expect(at90[0]!.cue.stored?.id).toBe(stored.$cut);
		expect(at90[0]!.sounds[0]!.entry.types).toContain('thump');
		expect(r.collected.skipped.find((s) => s.frame === 250)).toMatchObject({ code: 'NEAR_STORED' });
		expect(r.selected.picks.find((p) => p.cue.frame === 252)!.cue.stored?.id).toBe(stored.$near);
		expect(r.collected.skipped.find((s) => s.cueId === stored.$mute)).toMatchObject({ code: 'MUTED' });
		expect(r.collected.skipped.find((s) => s.cueId === stored.$sil)).toMatchObject({ code: 'SILENCE' });
		expect(r.selected.skipped.find((s) => s.cueId === stored.$none)).toMatchObject({ code: 'NO_TYPES' });
		// explicit ids: only those, nothing derived
		const ids = planOf(f.get(), f.seqId, { cues: [stored.$cut!, stored.$near!] });
		expect(ids.selected.picks.map((p) => p.cue.stored?.id)).toEqual([stored.$cut, stored.$near]);
		// a range keeps cues inside it
		const ranged = planOf(f.get(), f.seqId, { range: { start: 170, end: 260 } });
		expect(ranged.selected.picks.every((p) => p.cue.frame >= 170 && p.cue.frame < 260)).toBe(true);
		expect(ranged.selected.picks.length).toBeGreaterThan(2);
	});

	it('caps the cues (LIMIT) and the alternatives', () => {
		const f = fixture();
		const r = planOf(f.get(), f.seqId, { maxCues: 3, style: { alternatives: 1 } });
		expect(r.selected.picks).toHaveLength(3);
		expect(r.selected.picks.every((p) => p.sounds.length <= 2)).toBe(true);
		const limited = r.selected.skipped.filter((s) => s.code === 'LIMIT');
		expect(limited.length).toBeGreaterThan(3);
		expect(Math.min(...limited.map((s) => s.frame))).toBeGreaterThan(
			Math.max(...r.selected.picks.map((p) => p.cue.frame)),
		);
	});
});

describe('plan draft (pure)', () => {
	it('is a valid proposal: setup first, place items requiring their setup, alternatives, why-lines; accepting one places it', () => {
		const f = fixture();
		const r = planOf(f.get(), f.seqId, { style: { seed: 3 } });
		const reg = new Map<string, RegisterSoundResponse>();
		for (const p of r.selected.picks) for (const s of p.sounds) reg.set(s.entry.id, registered(s.entry));
		const { draft, report } = composePlanDraft(f.get(), r.seq, r.request, r.style, r.selected.picks, reg, {
			skipped: [...r.collected.skipped, ...r.selected.skipped],
			warnings: [],
			considered: r.collected.cues.length,
			snapshotHash: 'snapshot-1',
			librarySize: POOL.length,
		});
		expect(draft).not.toBeNull();
		expect(draft!.feature).toBe('sound-design');
		expect(report.events).toHaveLength(r.selected.picks.length);
		expect(report.counts).toMatchObject({ placed: r.selected.picks.length, items: draft!.items.length });
		expect(draft!.items.length).toBeLessThan(400);
		const push = report.events.find((e) => e.frame === 180)!;
		expect(push.why).toBe(`${push.sound.title} on ${push.cueReason} at 00:00:06:00 · support · peak`);
		expect(push.alternatives).toHaveLength(3);
		const ids = draft!.items.map((i) => i.id);
		// every requires names an earlier item; setup items come before every place item
		draft!.items.forEach((it, i) => {
			for (const q of it.requires ?? []) expect(ids.indexOf(q)).toBeLessThan(i);
		});
		const firstPlace = draft!.items.findIndex((i) => !isSetupItem(i));
		expect(draft!.items.slice(firstPlace).every((i) => !isSetupItem(i))).toBe(true);
		const p: Proposal = (() => {
			const c = createProposal(
				f.get(),
				draft!,
				{
					id: 'prp_0000000000000001',
					projectId: f.get().projectId,
					author: { agent: 't' },
					now: '2026-10-16T00:00:00.000Z',
					revision: f.revision,
				},
				{ registries: defaultRegistries(mgRegistry) },
			);
			if (!c.ok) throw new Error(JSON.stringify(c.errors));
			return c.proposal;
		})();
		expect(p.items.filter((i) => i.state !== 'pending')).toEqual([]);
		// The push's closure: its new cue, the bin, its four sounds; accepting it places the whoosh on the cue.
		const item = p.items.find((i) => !isSetupItem(i) && (i.meta as { frame?: number }).frame === 180)!;
		const closure = dependencyClosure(p, [item.id]).map((i) => i.id);
		expect(closure).toEqual(expect.arrayContaining(['bin', `cue:${item.id}`, item.id]));
		expect(closure.filter((id) => id.startsWith('sound:'))).toHaveLength(4);
		const plan = planAccept(f.get(), p, [item.id], 'user', { registries: defaultRegistries(mgRegistry) });
		expect(plan.ok && plan.composed?.itemIds.length).toBe(closure.length);
		// "all" minus the setup items composes the whole plan (what accept_proposal "all" sends)
		const placeIds = p.items.filter((i) => !isSetupItem(i)).map((i) => i.id);
		const all = planAccept(f.get(), p, placeIds, 'user', { registries: defaultRegistries(mgRegistry) });
		expect(all.ok && all.composed?.itemIds.length).toBe(p.items.length);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// The job on a real engine (an indexed kit of generated recordings plus Jasper Synth).

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_plan_0123456789abcdef0123';
const KEY = 'key_plan_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'plan-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

function makeKit(dir: string): string {
	const files: [string, 'hit' | 'whoosh' | 'click', number, string, string[]][] = [
		['hit_a.wav', 'hit', 0.5, 'Punch hit', ['hit']],
		['hit_b.wav', 'hit', 0.4, 'Crunch hit', ['hit']],
		['hit_c.wav', 'hit', 0.6, 'Metal hit', ['hit']],
		['thump_a.wav', 'hit', 0.45, 'Soft thump', ['thump']],
		['boom_a.wav', 'hit', 0.9, 'Low boom', ['boom']],
		['whoosh_a.wav', 'whoosh', 0.7, 'Air whoosh', ['whoosh']],
		['whoosh_b.wav', 'whoosh', 0.9, 'Fast whoosh', ['whoosh']],
		['key_a.wav', 'click', 0.08, 'Key a', ['key']],
		['key_b.wav', 'click', 0.09, 'Key b', ['key']],
	];
	files.forEach(([file, shape, sec], i) => {
		writeWav(join(dir, file), shape, sec, i + 1);
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [PACK],
			sounds: files.map(([file, , , title, types]) => ({
				file,
				title,
				types,
				tags: ['test'],
				author: 'Test Author',
				license: 'CC0-1.0',
				sourceUrl: 'https://example.invalid/sounds',
				packId: PACK.id,
			})),
		}),
	);
	return dir;
}

type App = Awaited<ReturnType<typeof makeApp>>;
let app: App;

/** Writes the fixture as a saved project (revision 3) and returns its ids. */
let projects = 0;
function seedProject(a: App, f: ReturnType<typeof fixture>) {
	// Every test gets its own project (the fixture's ids are deterministic).
	const doc = { ...f.get(), projectId: `prj_${(++projects).toString().padStart(16, '0')}` };
	const file = appdirPaths(a.appdir).projectFile(doc.projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' })),
	);
	return { projectId: doc.projectId, seqId: f.seqId };
}

async function startPlan(body: unknown, headers = AGENT_H) {
	return app.inject({
		method: 'POST',
		url: '/api/sound-design/plan',
		headers: json(headers),
		payload: JSON.stringify(body),
	});
}
async function runPlan(
	body: unknown,
	headers = AGENT_H,
): Promise<{ job: EngineJob; result: SoundDesignPlanResult }> {
	const r = await startPlan(body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return { job, result: SoundDesignPlanResultSchema.parse(job.result) };
}
async function getProposal(projectId: string, id: string, headers = AGENT_H): Promise<Proposal> {
	const r = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/proposals/${id}`, headers });
	expect(r.statusCode, r.body).toBe(200);
	return (r.json() as { proposal: Proposal }).proposal;
}
async function savedDoc(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: json(EDITOR_H),
		payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
	});
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}

describe('POST /api/sound-design/plan (real engine)', { timeout: 600_000 }, () => {
	beforeAll(async () => {
		process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-plan-kit-'));
		process.env.JASPER_SOUND_SYNTH_VARIANTS = '1';
		process.env.JASPER_SOUND_AUTO_INDEX = '0';
		app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const r = await app.inject({
			method: 'POST',
			url: '/api/sounds/index',
			headers: json(EDITOR_H),
			payload: '{}',
		});
		expect(r.statusCode, r.body).toBe(202);
		const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	}, 600_000);
	afterAll(async () => {
		await closeApps();
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it('stores a proposal (nothing applied), same picks for the same seed; agents are refused accept; the editor applies one transaction', async () => {
		const f = fixture();
		const { projectId, seqId } = seedProject(app, f);
		const before = await savedDoc(projectId);
		const { job, result } = await runPlan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		expect(job.kind).toBe('sound-design');
		expect(job.origin).toEqual({ type: 'agent', agentRunId: 'plan-agent' });
		expect(result.proposalId).toMatch(/^prp_/);
		expect(result.invalid).toEqual([]);
		expect(result.counts!.pending).toBe(result.itemCount);
		expect(result.report.events.length).toBeGreaterThan(6);
		expect(result.report.counts.sounds).toBeGreaterThan(3);
		// Nothing was applied: same revision, no clips added.
		const after = await savedDoc(projectId);
		expect(after.revision).toBe(before.revision);
		const p = await getProposal(projectId, result.proposalId!);
		expect(p.author).toEqual({ agent: 'plan-agent' });
		expect(p.feature).toBe('sound-design');
		// Real recordings first: the push's whoosh is a kit sound; the cut's hit too.
		const push = result.report.events.find((e) => e.frame === 180)!;
		expect(push.sound.source).toBe('starter');
		// Same seed, same picks (and same registered media reused: no second copy needed).
		const again = await runPlan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		expect(again.result.report.events.map((e) => [e.frame, e.sound.soundId, e.rate])).toEqual(
			result.report.events.map((e) => [e.frame, e.sound.soundId, e.rate]),
		);
		// An agent may not apply it (agentsMayApply is off).
		const refused = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(AGENT_H),
			payload: JSON.stringify({ itemIds: [push.itemId] }),
		});
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({
			code: 'APPROVAL_REQUIRED',
			detail: { code: 'E_APPROVAL_REQUIRED' },
		});
		// The editor applies every place item: ONE transaction (revision + 1), every sound on its cue.
		const placeIds = p.items.filter((i) => !isSetupItem(i)).map((i) => i.id);
		const ok = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${p.id}/accept`,
			headers: json(EDITOR_H),
			payload: JSON.stringify({ itemIds: placeIds }),
		});
		expect(ok.statusCode, ok.body).toBe(200);
		const applied = await savedDoc(projectId);
		expect(applied.revision).toBe(before.revision + 1);
		const seq = applied.doc.sequences[seqId]!;
		const cues = soundCuesOf(seq);
		const F = 705_600_000 / 30;
		for (const e of result.report.events) {
			const cue = cues.find((c) => c.frame === e.frame && c.kind === e.kind)!;
			expect(cue, `cue at ${e.frame}`).toBeDefined();
			const clip = seq.clips[cue.placedClipIds![0]!] as AudioClip & { sfx: ClipSfx };
			expect(clip.sfx.soundId).toBe(e.sound.soundId);
			expect(clip.sfx.role).toBe(e.role);
			const at = clip.start * F + (clip.sfx.placement.peakFlicks - clip.sourceIn) / clip.speed.rate;
			expect(Math.abs(at - e.frame * F)).toBeLessThanOrEqual(1);
		}
		// Planning again: every cue is filled now — nothing to propose.
		const none = await runPlan({ projectId, sequenceId: seqId, style: { seed: 11 } });
		expect(none.result.proposalId).toBeNull();
		expect(none.result.report.events).toEqual([]);
	});

	it('an allowed agent may accept; sources and explicit cue ids are honoured', async () => {
		const f = fixture();
		const ids = f.tx([
			{ type: 'soundDesign.setSettings', agentsMayApply: true },
			{
				type: 'soundCue.add',
				cues: [{ frame: 120, kind: 'land', weight: 'support', source: 'user', types: ['tap'], ref: '$c' }],
			},
		]);
		const { projectId, seqId } = seedProject(app, f);
		const { result } = await runPlan({
			projectId,
			sequenceId: seqId,
			cues: [ids.$c!],
			style: { sources: ['synth'] },
		});
		expect(result.report.events).toHaveLength(1);
		expect(result.report.events[0]).toMatchObject({ cueId: ids.$c, sound: { source: 'synth' } });
		const ok = await app.inject({
			method: 'POST',
			url: `/api/projects/${projectId}/proposals/${result.proposalId}/accept`,
			headers: json(AGENT_H),
			payload: JSON.stringify({ itemIds: [result.report.events[0]!.itemId] }),
		});
		expect(ok.statusCode, ok.body).toBe(200);
	});

	it('cancels: a cancelled plan leaves no proposal', async () => {
		const f = fixture();
		const { projectId, seqId } = seedProject(app, f);
		const sounds = app.jasper.services.sounds as { register: (id: string, pid: string) => Promise<unknown> };
		const real = sounds.register.bind(sounds);
		let calls = 0;
		sounds.register = async (id, pid) => {
			calls++;
			await new Promise((r) => setTimeout(r, 150));
			return real(id, pid);
		};
		try {
			const r = await startPlan({ projectId, sequenceId: seqId });
			expect(r.statusCode).toBe(202);
			const id = (r.json() as EngineJob).id;
			const q = coreServices(app).queue;
			const end = Date.now() + 30_000;
			while (calls < 1 && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
			q.cancel(id);
			const job = await q.wait(id);
			expect(job.state).toBe('cancelled');
			const list = await app.inject({
				method: 'GET',
				url: `/api/projects/${projectId}/proposals`,
				headers: AGENT_H,
			});
			expect((list.json() as { proposals: unknown[] }).proposals).toEqual([]);
		} finally {
			sounds.register = real;
		}
	});

	it('refuses bad requests with typed errors before a job starts', async () => {
		const f = fixture();
		const { projectId } = seedProject(app, f);
		const cases: [unknown, number, string][] = [
			[{}, 400, 'VALIDATION_FAILED'],
			[{ projectId, densty: 'rich' }, 400, 'VALIDATION_FAILED'],
			[{ projectId, style: { alternatives: 9 } }, 400, 'VALIDATION_FAILED'],
			[{ projectId, range: { start: 50, end: 10 } }, 400, 'VALIDATION_FAILED'],
			[{ projectId, style: { palette: ['nope'] } }, 400, 'VALIDATION_FAILED'],
			[{ projectId: 'prj_00000000000000ZZ' }, 404, 'PROJECT_NOT_FOUND'],
			[{ projectId: '../etc' }, 400, 'VALIDATION_FAILED'],
			[{ projectId, sequenceId: 'seq_nope' }, 404, 'SEQUENCE_NOT_FOUND'],
			[{ projectId, cues: ['cue_00000000000000ZZ'] }, 404, 'CUE_NOT_FOUND'],
		];
		for (const [body, status, code] of cases) {
			const r = await startPlan(body);
			expect([r.statusCode, (r.json() as { code: string }).code], JSON.stringify(body)).toEqual([
				status,
				code,
			]);
		}
		expect(coreServices(app).queue.list({ kind: 'sound-design', projectId })).toEqual([]);
	});
});
