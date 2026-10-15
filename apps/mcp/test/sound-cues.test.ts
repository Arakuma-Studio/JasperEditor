// Sound design cue tools end to end (spec 12 §2.10, P2-R6; wp-note "WP2.3 cue route & MCP tools"): a real engine in
// a temp appdir indexes a few starter-kit recordings plus Jasper Synth, jasper-mcp (stdio) drives it on the Phase 2
// fixture built from solids, a shape, a typewriter title, a lower third and an `sfx:` marker: find_sound_cues,
// set_sound_cues (one transaction), place_sound (peak-exact layers, picks by type, alternates), swap_sound (keeps
// the aligned frame, role, pan, gain; cycles alternates), align_peak (exact, layers together), strict arguments.
// No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type AudioClip,
	type ClipSfx,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type ProjectDocument,
	type Sequence,
	type SoundDesign,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, waitFor } from './helpers.ts';
import { FIXTURE_COMMANDS } from './sound-cues-fixture.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
const PORT = Number(process.env.MCP_SOUND_CUES_TEST_PORT ?? 49511);
const KIT_FILES = [
	'hit-punch-01.ogg',
	'hit-crunch-01.ogg',
	'hit-metal-light-01.ogg',
	'thump-punch-01.ogg',
	'boom-low-01.ogg',
	'riser-engine-01.ogg',
	'whoosh-air-01.ogg',
	'whoosh-air-03.ogg',
	'ui-confirm-01.ogg',
];

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('').slice(-2000)}`);
	return JSON.parse(textOf(r)) as T;
}
async function fails(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string } }).error;
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}
async function revisionOf(projectId: string): Promise<number> {
	return (await ok<{ revision: number }>('get_project', { projectId })).revision;
}

type SfxClip = AudioClip & { sfx?: ClipSfx };
/** Sequence flicks at which a placed clip's aligned point plays (what the export plays: no error term). */
function playsAt(c: SfxClip, F: number): number {
	return c.start * F + (c.sfx!.placement.peakFlicks - c.sourceIn) / c.speed.rate;
}
const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0]!;
const cuesOf = (seq: Sequence) => Object.values((seq.soundDesign as SoundDesign | undefined)?.cues ?? {});

function makeKit(dir: string) {
	const manifest = JSON.parse(readFileSync(join(KIT, 'manifest.json'), 'utf8')) as {
		packs: { id: string }[];
		sounds: { file: string; packId?: string }[];
	};
	const sounds = manifest.sounds.filter((s) => KIT_FILES.includes(s.file));
	expect(sounds).toHaveLength(KIT_FILES.length);
	const packs = manifest.packs.filter((p) => sounds.some((s) => s.packId === p.id));
	mkdirSync(dir, { recursive: true });
	for (const s of sounds) copyFileSync(join(KIT, s.file), join(dir, s.file));
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, packs, sounds }));
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-cues-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	makeKit(join(work, 'kit'));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_EDITOR_KEY: editorKey,
				JASPER_SOUND_STARTER_DIR: join(work, 'kit'),
				JASPER_SOUND_SYNTH_VARIANTS: '1',
				JASPER_SOUND_AUTO_INDEX: '0',
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		120_000,
		`the engine on ${PORT}: ${engineLog.join('')}`,
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-cues', version: '1.0.0' });
	await client.connect(transport);
	await ok('rescan_sound_library', { wait: true });
}, 600_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (work) rmSync(work, { recursive: true, force: true });
}, 30_000);

type Cue = {
	key: string;
	frame: number;
	timecode: string;
	kind: string;
	weight: string;
	types: string[];
	from: string;
	reason: string;
	anchorText: string;
	panSweep?: { from: number; to: number };
	storedCueId: string | null;
};
type Found = {
	sequenceId: string;
	revision: number;
	count: number;
	cues: Cue[];
	stats: { bySource: Record<string, { found: number; kept: number }> };
	dialogue: unknown[];
	storedCues: number;
};
type Placed = {
	revision: number;
	cueId: string | null;
	frame: { frame: number };
	groupId: string | null;
	clips: {
		clipId: string;
		soundId: string | null;
		track: string;
		role: string;
		align: string;
		errorFlicks: number;
		peakFrame: number | null;
		rate: number;
		picked?: { from: string[]; variationRate: number; variationGainDb: number };
	}[];
	placementWarnings?: { code: string }[];
};

let projectId = '';
const sounds: Record<string, string> = {};

describe('sound cue MCP tools', { timeout: 900_000 }, () => {
	it('builds the fixture and finds every event with frames, timecodes, reasons and anchors', async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Cues', preset: 'hd-1080p-30' }))
			.projectId;
		await ok('apply_commands', { projectId, label: 'Fixture', commands: FIXTURE_COMMANDS });
		const found = await ok<Found>('find_sound_cues', { projectId });
		const of = (from: string) => found.cues.filter((c) => c.from === from);
		expect(of('edits').map((c) => c.frame)).toEqual([90, 330]);
		expect(of('edits')[0]!.reason).toBe("Cut on V1: 'Shot A' → 'Shot B'");
		expect(of('edits')[0]!.anchorText).toBe("cut on V1: V1 'Shot A' → V1 'Shot B'");
		expect(of('edits')[0]!.timecode).toBe('00:00:03:00');
		const push = of('transitions')[0]!;
		expect(push).toMatchObject({ frame: 180, kind: 'transition', panSweep: { from: -60, to: 60 } });
		expect(push.types[0]).toBe('whoosh');
		expect(of('keyframes').map((c) => c.kind)).toEqual(expect.arrayContaining(['move', 'land']));
		expect(of('keyframes').find((c) => c.kind === 'move')!.anchorText).toContain('transform.position');
		expect(of('text').length).toBeGreaterThanOrEqual(5);
		expect(of('mg').map((c) => [c.kind, c.frame])).toEqual([
			['land', 360],
			['exit', 405],
		]);
		expect(of('markers')[0]).toMatchObject({
			frame: 250,
			kind: 'manual',
			weight: 'hero',
			types: ['boom', 'whoosh'],
		});
		expect(found.count).toBe(found.cues.length);
		expect(found.storedCues).toBe(0);
		expect(found.cues.every((c) => c.storedCueId === null)).toBe(true);
		// fewer in sparse; one source only; a range in seconds
		const sparse = await ok<Found>('find_sound_cues', { projectId, density: 'sparse' });
		expect(sparse.count).toBeLessThan(found.count);
		const only = await ok<Found>('find_sound_cues', { projectId, sources: ['edits'] });
		expect(only.cues.every((c) => c.from === 'edits')).toBe(true);
		const ranged = await ok<Found>('find_sound_cues', {
			projectId,
			range: { start: { seconds: 5 }, end: '00:00:09:00' },
		});
		expect(ranged.cues.every((c) => c.frame >= 150 && c.frame < 270)).toBe(true);
		expect((await fails('find_sound_cues', { projectId, densty: 'rich' })).code).toBe('E_UNKNOWN_ARGUMENT');
		// a range past the last frame a sequence can have is refused by the tool with a time hint (it was the route's
		// raw zod dump, VALIDATION_FAILED)
		const far = await fails('find_sound_cues', { projectId, range: { start: 0, end: '99:59:59:29' } });
		expect([far.code, far.message]).toEqual([
			'E_INVALID_PARAM',
			expect.stringMatching(/^range must lie within/),
		]);
		expect(far.hint).toContain('timecode');
		expect((await fails('find_sound_cues', { projectId, sequenceId: 'seq_nope' })).code).toBe('E_NOT_FOUND');
	});

	it('set_sound_cues stores suggestions verbatim in one transaction, skips stored ones, edits, removes and resyncs', async () => {
		const found = await ok<Found>('find_sound_cues', { projectId });
		const rev = await revisionOf(projectId);
		const added = await ok<{
			revision: number;
			added: { index: number; cueId: string }[];
			historyLabel: string;
		}>('set_sound_cues', { projectId, add: found.cues, expectedRevision: found.revision });
		expect(added.revision).toBe(rev + 1);
		expect(added.added).toHaveLength(found.cues.length);
		expect(added.historyLabel).toBe(`Sound Cues (add ${found.cues.length})`);
		const again = await ok<Found>('find_sound_cues', { projectId });
		expect(again.storedCues).toBe(found.cues.length);
		expect(again.cues.every((c) => c.storedCueId)).toBe(true);
		// the same suggestions again: all stored, nothing to do
		expect((await fails('set_sound_cues', { projectId, add: again.cues })).code).toBe('E_INVALID_PARAM');
		// a stale expectedRevision is refused
		expect(
			(await fails('set_sound_cues', { projectId, add: [{ at: 12 }], expectedRevision: rev })).code,
		).toBe('E_REVISION_MISMATCH');
		// add a manual cue, edit one, remove one and resync in ONE transaction
		const doc = await documentOf(projectId);
		const stored = cuesOf(seqOf(doc));
		const cut = stored.find((c) => c.kind === 'cut' && c.frame === 90)!;
		const exit = stored.find((c) => c.kind === 'exit' && c.frame === 405)!;
		const r2 = await revisionOf(projectId);
		const multi = await ok<{
			revision: number;
			added: { cueId: string }[];
			removed: unknown;
			resynced: { moved: unknown[] };
		}>('set_sound_cues', {
			projectId,
			add: [
				{
					at: { seconds: 14 },
					kind: 'emphasis',
					weight: 'support',
					types: ['swoosh', 'pop'],
					reason: 'Title pulse',
				},
			],
			update: [{ cueId: cut.id, weight: 'hero', label: 'Big cut' }],
			remove: { cueIds: [exit.id] },
			resync: true,
		});
		expect(multi.revision).toBe(r2 + 1);
		const after = cuesOf(seqOf(await documentOf(projectId)));
		const manual = after.find((c) => c.id === multi.added[0]!.cueId)!;
		expect(manual).toMatchObject({
			frame: 420,
			kind: 'emphasis',
			source: 'agent',
			types: ['whoosh', 'pop'],
			reason: 'Title pulse',
		});
		expect(after.find((c) => c.id === cut.id)).toMatchObject({ weight: 'hero', label: 'Big cut' });
		expect(after.some((c) => c.id === exit.id)).toBe(false);
		expect(multi.resynced.moved).toEqual([]);
		// strict and typed refusals
		expect((await fails('set_sound_cues', { projectId })).code).toBe('E_INVALID_PARAM');
		expect((await fails('set_sound_cues', { projectId, add: [{ at: 3, types: ['kazoo'] }] })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await fails('set_sound_cues', { projectId, add: [{ at: 3, colour: 'red' }] })).code).toBe(
			'E_UNKNOWN_ARGUMENT',
		);
		// an inverted window is refused (it was silently dropped while update refused it); storedCueId is bounded
		const inverted = await fails('set_sound_cues', {
			projectId,
			add: [{ at: 3, window: { start: 50, end: 10 } }],
		});
		expect([inverted.code, inverted.message]).toEqual([
			'E_INVALID_PARAM',
			expect.stringContaining('add[0].window'),
		]);
		expect(
			(await fails('set_sound_cues', { projectId, add: [{ at: 3, storedCueId: 'x'.repeat(10_000) }] })).code,
		).toBe('E_INVALID_ARGUMENT');
		expect(
			(await fails('set_sound_cues', { projectId, remove: { cueIds: ['cue_0000000000000999'] } })).code,
		).toBe('E_NOT_FOUND');
	});

	it('place_sound lands peaks exactly on cues: a sound with alternates, three layers, a pick by type', async () => {
		const search = await ok<{
			results: { soundId: string; title: string; types: string[]; source: { type: string } }[];
		}>('search_sounds', { license: 'any', limit: 24, sources: ['starter'] });
		for (const s of search.results) sounds[s.title] = s.soundId;
		const hits = search.results.filter((s) => s.types.includes('hit')).map((s) => s.soundId);
		expect(hits.length).toBeGreaterThanOrEqual(3);
		const doc = await documentOf(projectId);
		const seq = seqOf(doc);
		const F = flicksPerFrame(seq.settings.frameRate);
		const cut = cuesOf(seq).find((c) => c.kind === 'cut' && c.frame === 90)!;
		const rev = await revisionOf(projectId);
		const one = await ok<Placed>('place_sound', {
			projectId,
			cueId: cut.id,
			layers: [{ soundId: hits[0], pan: -20, gainDb: -3 }],
			alternatives: [hits[1], hits[2]],
			reason: 'Hard cut to Shot B',
		});
		expect(one.revision).toBe(rev + 1);
		expect(one.cueId).toBe(cut.id);
		expect(one.clips[0]).toMatchObject({ role: 'hero', align: 'peak', errorFlicks: 0, soundId: hits[0] });
		expect(Math.abs(one.clips[0]!.peakFrame! - 90)).toBeLessThan(0.001);
		let d = await documentOf(projectId);
		let s = seqOf(d);
		const c1 = s.clips[one.clips[0]!.clipId] as SfxClip;
		expect(Math.abs(playsAt(c1, F) - 90 * F)).toBeLessThanOrEqual(1);
		expect(c1.sfx).toMatchObject({ cueId: cut.id, role: 'hero', alternatives: [hits[0], hits[1], hits[2]] });
		expect(c1.pan.value).toBe(-20);
		expect(c1.gainDb).toBe(-3);
		const cueAfter = cuesOf(s).find((c) => c.id === cut.id)!;
		expect(cueAfter.placedClipIds).toEqual([c1.id]);
		expect(cueAfter.reason).toContain('Sound: Hard cut to Shot B');
		// three layers on the sfx marker cue (hero): separate tracks, grouped, all aligned on the cue frame
		const marker = cuesOf(s).find((c) => c.source === 'marker')!;
		const three = await ok<Placed>('place_sound', {
			projectId,
			cueId: marker.id,
			layers: [
				{ soundId: sounds['Low boom'] ?? hits[0] },
				{ sound: { type: 'whoosh' } },
				{ soundId: hits[1], gainDb: -6 },
			],
		});
		expect(three.clips).toHaveLength(3);
		expect(new Set(three.clips.map((c) => c.track)).size).toBe(3);
		expect(three.groupId).toBeTruthy();
		expect(three.clips.map((c) => c.role)).toEqual(['hero', 'layer', 'layer']);
		const picked = three.clips[1]!.picked!;
		expect(picked.variationRate).toBeGreaterThanOrEqual(0.98);
		expect(picked.variationRate).toBeLessThanOrEqual(1.02);
		d = await documentOf(projectId);
		s = seqOf(d);
		for (const c of three.clips) {
			const clip = s.clips[c.clipId] as SfxClip;
			expect(clip.groupId).toBe(three.groupId);
			expect(Math.abs(playsAt(clip, F) - 250 * F), c.clipId).toBeLessThanOrEqual(1);
			expect(c.errorFlicks).toBe(0);
		}
		// a pick by type on the push cue: its 20-frame window (0.666… s) is passed to the search (regression: the
		// window was serialised with 16 decimals and refused by the search route)
		const push = cuesOf(s).find((c) => c.kind === 'transition')!;
		const whoosh = await ok<Placed>('place_sound', {
			projectId,
			cueId: push.id,
			layers: [{ sound: { type: 'whoosh' } }],
		});
		expect(whoosh.clips[0]!.errorFlicks).toBe(0);
		const wclip = seqOf(await documentOf(projectId)).clips[whoosh.clips[0]!.clipId] as SfxClip;
		expect(Math.abs(playsAt(wclip, F) - 180 * F)).toBeLessThanOrEqual(1);
		// the cue's pan sweep (−60 → 60) becomes pan keyframes
		expect(wclip.pan.keyframes.map((k) => k.value)).toEqual([-60, 60]);
		// a riser at a time: its END lands on the frame; a cue is created with the reason
		const riser = await ok<Placed>('place_sound', {
			projectId,
			at: '00:00:12:00',
			layers: [{ sound: { type: 'riser' } }],
			kind: 'reveal',
			reason: 'Build into the lower third',
		});
		expect(riser.clips[0]!.align).toBe('end');
		const created = cuesOf(seqOf(await documentOf(projectId))).find((c) => c.id === riser.cueId)!;
		expect(created).toMatchObject({
			frame: 360,
			kind: 'reveal',
			source: 'agent',
			reason: 'Build into the lower third',
		});
		// a second hero within 0.5 s of the marker's hero is flagged
		const near = await ok<Placed>('place_sound', {
			projectId,
			at: 255,
			layers: [{ soundId: hits[2], role: 'hero' }],
			weight: 'hero',
		});
		expect(near.placementWarnings?.map((w) => w.code)).toContain('W_HERO_TOO_CLOSE');
		// refusals
		expect(
			(
				await fails('place_sound', {
					projectId,
					at: 30,
					layers: [{ soundId: hits[0], sound: { type: 'hit' } }],
				})
			).code,
		).toBe('E_INVALID_PARAM');
		expect(
			(await fails('place_sound', { projectId, cueId: cut.id, at: 30, layers: [{ soundId: hits[0] }] })).code,
		).toBe('E_INVALID_PARAM');
		expect(
			(await fails('place_sound', { projectId, at: 30, layers: [{ sound: { type: 'kazoo' } }] })).code,
		).toBe('E_INVALID_PARAM');
		expect(
			(await fails('place_sound', { projectId, at: 0, layers: [{ soundId: sounds['Low boom'] ?? hits[0] }] }))
				.code,
		).toBe('E_INVALID_PARAM');
		expect(
			(
				await fails('place_sound', {
					projectId,
					cueId: 'cue_0000000000000999',
					layers: [{ soundId: hits[0] }],
				})
			).code,
		).toBe('E_NOT_FOUND');
		expect(
			(await fails('place_sound', { projectId, at: 30, layers: [{ soundId: hits[0], volume: 3 }] })).code,
		).toBe('E_UNKNOWN_ARGUMENT');
	});

	it('swap_sound keeps the peak frame, track, role, pan and gain; next / previous cycle the alternates', async () => {
		const doc = await documentOf(projectId);
		const seq = seqOf(doc);
		const F = flicksPerFrame(seq.settings.frameRate);
		const clip = Object.values(seq.clips).find(
			(c) => c.kind === 'audio' && (c as SfxClip).sfx?.alternatives?.length,
		) as SfxClip;
		const alts = clip.sfx!.alternatives!;
		const rev = await revisionOf(projectId);
		const n1 = await ok<{
			revision: number;
			to: { soundId: string };
			cycle: { index: number; of: number; from: string };
			alignedFrame: { frame: number };
		}>('swap_sound', { projectId, clipId: clip.id, to: 'next' });
		expect(n1.revision).toBe(rev + 1);
		expect(n1.to.soundId).toBe(alts[1]);
		expect(n1.cycle).toMatchObject({ index: 2, from: 'alternatives' });
		expect(n1.alignedFrame.frame).toBe(90);
		const n2 = await ok<{ to: { soundId: string } }>('swap_sound', {
			projectId,
			clipId: clip.id,
			to: 'next',
		});
		expect(n2.to.soundId).toBe(alts[2]);
		const p1 = await ok<{ to: { soundId: string } }>('swap_sound', {
			projectId,
			clipId: clip.id,
			to: 'previous',
		});
		expect(p1.to.soundId).toBe(alts[1]);
		const p2 = await ok<{ to: { soundId: string } }>('swap_sound', {
			projectId,
			clipId: clip.id,
			to: 'previous',
		});
		expect(p2.to.soundId).toBe(alts[0]);
		// beyond the alternates: the family / similar sounds (wraps around the whole cycle)
		const back = await ok<{ to: { soundId: string }; cycle: { of: number } }>('swap_sound', {
			projectId,
			clipId: clip.id,
			to: 'previous',
		});
		expect(alts).not.toContain(back.to.soundId);
		expect(back.cycle.of).toBeGreaterThan(3);
		const explicit = await ok<{ to: { soundId: string } }>('swap_sound', {
			projectId,
			clipId: clip.id,
			to: alts[1],
		});
		expect(explicit.to.soundId).toBe(alts[1]);
		const after = seqOf(await documentOf(projectId)).clips[clip.id] as SfxClip;
		expect(Math.abs(playsAt(after, F) - 90 * F)).toBeLessThanOrEqual(1);
		expect(after.sfx!.placement.errorFlicks).toBe(0);
		expect(after.trackId).toBe(clip.trackId);
		expect(after.sfx!.role).toBe('hero');
		expect(after.sfx!.cueId).toBe(clip.sfx!.cueId);
		expect(after.pan.value).toBe(-20);
		expect(after.gainDb).toBe(-3);
		expect(after.sfx!.alternatives).toEqual(alts);
		expect((await fails('swap_sound', { projectId, clipId: clip.id, to: alts[1] })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await fails('swap_sound', { projectId, clipId: 'clp_0000000000000999', to: 'next' })).code).toBe(
			'E_NOT_FOUND',
		);
		expect((await fails('swap_sound', { projectId, clipId: clip.id, to: 'snd_zz' })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
	});

	it('swap_sound cycles a sound placed without alternates: next ×3 progresses, previous ×3 returns to it', async () => {
		// Regression (lead's real run): without a stored ring the cycle was anchored on the CURRENT sound, so it was
		// rebuilt around each new sound and "next" alternated between two sounds forever.
		const seq = seqOf(await documentOf(projectId));
		const F = flicksPerFrame(seq.settings.frameRate);
		const push = cuesOf(seq).find((c) => c.kind === 'transition')!;
		const clip = Object.values(seq.clips).find(
			(c) => c.kind === 'audio' && (c as SfxClip).sfx?.cueId === push.id,
		) as SfxClip;
		expect(clip.sfx!.alternatives ?? []).toEqual([]);
		const original = clip.sfx!.soundId!;
		const seen = [original];
		for (let i = 0; i < 3; i++)
			seen.push(
				(await ok<{ to: { soundId: string } }>('swap_sound', { projectId, clipId: clip.id, to: 'next' })).to
					.soundId,
			);
		expect(new Set(seen).size, seen.join(' ')).toBe(4);
		const back: string[] = [];
		for (let i = 0; i < 3; i++)
			back.push(
				(await ok<{ to: { soundId: string } }>('swap_sound', { projectId, clipId: clip.id, to: 'previous' }))
					.to.soundId,
			);
		expect(back).toEqual([seen[2], seen[1], original]);
		const after = seqOf(await documentOf(projectId)).clips[clip.id] as SfxClip;
		expect(after.sfx!.alternatives).toEqual([original]);
		expect(after.sfx!.soundId).toBe(original);
		expect(Math.abs(playsAt(after, F) - 180 * F)).toBeLessThanOrEqual(1);
	});

	it('align_peak moves a clip (and its layers) so the peak lands exactly; back to its cue; refusals', async () => {
		const doc = await documentOf(projectId);
		const seq = seqOf(doc);
		const F = flicksPerFrame(seq.settings.frameRate);
		const marker = cuesOf(seq).find((c) => c.source === 'marker')!;
		const layers = marker.placedClipIds!;
		const rev = await revisionOf(projectId);
		const moved = await ok<{
			revision: number;
			clips: { clipId: string; alignedFrame: { frame: number }; errorFlicks: number; movedFrames: number }[];
			note?: string;
		}>('align_peak', { projectId, clipId: layers[0], to: { seconds: 7 } });
		expect(moved.revision).toBe(rev + 1);
		expect(moved.clips.map((c) => c.clipId).sort()).toEqual([...layers].sort());
		expect(moved.note).toContain(marker.id);
		let s = seqOf(await documentOf(projectId));
		for (const id of layers) {
			const c = s.clips[id] as SfxClip;
			expect(Math.abs(playsAt(c, F) - 210 * F), id).toBeLessThanOrEqual(1);
			expect(c.sfx!.placement.errorFlicks).toBe(0);
		}
		// back to the cue: exact again
		await ok('align_peak', { projectId, clipId: layers[1], to: 'cue' });
		s = seqOf(await documentOf(projectId));
		for (const id of layers)
			expect(Math.abs(playsAt(s.clips[id] as SfxClip, F) - 250 * F)).toBeLessThanOrEqual(1);
		// one layer alone, by timecode
		await ok('align_peak', { projectId, clipId: layers[2], to: '00:00:08:10', withLayers: false });
		s = seqOf(await documentOf(projectId));
		expect(Math.abs(playsAt(s.clips[layers[2]!] as SfxClip, F) - 250 * F)).toBeLessThanOrEqual(1);
		expect(Math.abs(playsAt(s.clips[layers[0]!] as SfxClip, F) - 250 * F)).toBeLessThanOrEqual(1);
		// refusals: before the sequence start, no session for the playhead, a video clip
		expect((await fails('align_peak', { projectId, clipId: layers[0], to: 0 })).code).toBe('E_INVALID_PARAM');
		expect((await fails('align_peak', { projectId, clipId: layers[0], to: 'playhead' })).code).toBe(
			'E_NO_SESSION',
		);
		const video = Object.values(s.clips).find((c) => c.kind !== 'audio')!;
		expect((await fails('align_peak', { projectId, clipId: video.id, to: 100 })).code).toBe(
			'E_INVALID_PARAM',
		);
		// a duplicated layer carries sfx.cueId but fills nothing (the cue's placedClipIds does not list it): "cue" is
		// the cue nearest to the copy, and the original layers are not dragged along (regression: they were)
		const dup = await ok<{ results: { clipIds?: string[]; created?: string[] }[]; created: string[] }>(
			'apply_commands',
			{
				projectId,
				label: 'Duplicate',
				commands: [{ type: 'clip.duplicate', clipIds: [layers[0]], at: 600 }],
			},
		);
		const copy = dup.created.find((id) => !layers.includes(id) && id.startsWith('clp_'))!;
		expect((seqOf(await documentOf(projectId)).clips[copy] as SfxClip).sfx?.cueId).toBe(marker.id);
		const alone = await ok<{ clips: { clipId: string }[]; cueId?: string }>('align_peak', {
			projectId,
			clipId: copy,
			to: 'cue',
		});
		expect(alone.clips.map((c) => c.clipId)).toEqual([copy]);
		expect(alone.cueId).not.toBe(marker.id);
		s = seqOf(await documentOf(projectId));
		for (const id of layers)
			expect(Math.abs(playsAt(s.clips[id] as SfxClip, F) - 250 * F)).toBeLessThanOrEqual(1);
		expect(FLICKS_PER_SECOND).toBe(705_600_000);
	});
});
