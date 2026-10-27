// Proposal tools end to end (spec 12 §2.10, P3-R5; wp-note "Phase 3 → WP3.2"): a real engine (token + editor key) in a
// temp appdir with a few starter-kit recordings plus Jasper Synth; jasper-mcp (stdio) plans a sound-design pass on the
// Phase 2 fixture (a proposal, nothing applied), reads it with its ghost table, is refused accept by the policy gate,
// rejects items; the "user" (HTTP with the editor key) notes, swaps an alternative and accepts; wait_for_proposal
// returns those decisions and notes; an allowed agent accepts the rest; place_sound proposes by default. No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type AudioClip,
	type ClipSfx,
	flicksPerFrame,
	makeEnvelope,
	type ProjectDocument,
	type Sequence,
	type SoundDesign,
	soundDesignSettingsOf,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, testPort, waitFor } from './helpers.ts';
import { FIXTURE_COMMANDS } from './sound-cues-fixture.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
const PORT = await testPort(process.env.MCP_PROPOSALS_TEST_PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const KIT_FILES = [
	'hit-punch-01.ogg',
	'hit-crunch-01.ogg',
	'hit-metal-light-01.ogg',
	'thump-punch-01.ogg',
	'boom-low-01.ogg',
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
const EDITOR = {
	cookie: `jasper_session=${token}; jasper_editor=${editorKey}`,
	'content-type': 'application/json',
};

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
/** The user in the editor (the editor key): proposal decisions over HTTP. */
async function editor(path: string, body: unknown) {
	const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: EDITOR, body: JSON.stringify(body) });
	const json = (await r.json()) as Record<string, unknown>;
	if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(json)}`);
	return json;
}
const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0]!;
const cuesOf = (seq: Sequence) => Object.values((seq.soundDesign as SoundDesign | undefined)?.cues ?? {});
type SfxClip = AudioClip & { sfx?: ClipSfx };

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
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-proposals-'));
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
		async () => (await fetch(`${BASE}/health`)).ok,
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
	client = new Client({ name: 'vitest-mcp-proposals', version: '1.0.0' });
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

type Planned = {
	proposalId: string;
	items: number;
	counts: Record<string, number>;
	placed: number;
	table: string;
	events: {
		itemId: string;
		timecode: string;
		frame: number;
		kind: string;
		soundId: string;
		title: string;
		role: string;
		why: string;
		alternatives: { soundId: string; title: string }[];
		layers?: { soundId: string }[];
	}[];
	skipped: { code: string }[];
	next: string;
};
type Item = {
	itemId: string;
	label: string;
	state: string;
	setup: boolean;
	note?: string;
	swapped?: { alternative: number; label: string };
	alternatives?: { index: number; label: string }[];
};
type Got = {
	updatedAt: string;
	items: Item[];
	ghosts: string;
	counts: Record<string, number>;
	decided: boolean;
};
type Waited = {
	status: string;
	updatedAt: string;
	items: Item[];
	notes?: { itemId: string; note: string }[];
	counts: Record<string, number>;
};

let projectId = '';
let plan: Planned;

describe('proposal MCP tools', { timeout: 900_000 }, () => {
	it('plan_sound_design stores a proposal (nothing applied) with a table, why-lines and alternates', async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Plan', preset: 'hd-1080p-30' }))
			.projectId;
		await ok('apply_commands', { projectId, label: 'Fixture', commands: FIXTURE_COMMANDS });
		const rev = await revisionOf(projectId);
		plan = await ok<Planned>('plan_sound_design', { projectId, style: { seed: 5 } });
		expect(plan.proposalId).toMatch(/^prp_/);
		expect(plan.placed).toBeGreaterThan(6);
		expect(plan.counts.pending).toBe(plan.items);
		// Phase 4: every row ends with its solved level ("−3 dB, …") or says the default level applies
		for (const row of plan.table.split('\n').slice(1))
			expect(row).toMatch(/\| (?:[−+]?[\d.]+ dB|default level)/);
		expect(plan.next).toMatch(/Review panel/);
		expect(plan.next).toMatch(/wait_for_proposal/);
		const push = plan.events.find((e) => e.frame === 180)!;
		expect(push.why).toContain('00:00:06:00');
		expect(push.alternatives.length).toBeGreaterThanOrEqual(1);
		// the marker "sfx: boom+swoosh" asks for two layers
		expect(plan.events.find((e) => e.frame === 250)!.layers).toHaveLength(1);
		expect(await revisionOf(projectId)).toBe(rev);
		// the same seed plans the same sounds
		const again = await ok<Planned>('plan_sound_design', { projectId, style: { seed: 5 } });
		expect(again.events.map((e) => [e.frame, e.soundId])).toEqual(
			plan.events.map((e) => [e.frame, e.soundId]),
		);
		await ok('reject_proposal', { projectId, proposalId: again.proposalId, itemIds: 'all' });
		const listed = await ok<{ proposals: { proposalId: string; decided: boolean }[] }>('list_proposals', {
			projectId,
			undecided: true,
		});
		expect(listed.proposals.map((p) => p.proposalId)).toEqual([plan.proposalId]);
		expect((await fails('plan_sound_design', { projectId, style: { densty: 'rich' } })).code).toBe(
			'E_UNKNOWN_ARGUMENT',
		);
		// style.cueSources: only the chosen sources derive cues (here the "sfx: boom+swoosh" marker alone)
		// check: true (spec 12 §4 P6-E5) also runs Sound Check on the new proposal (nothing applied)
		const markersOnly = await ok<Planned & { soundCheck: { summary: string; checkedItems: string[] } }>(
			'plan_sound_design',
			{ projectId, style: { seed: 5, cueSources: ['markers'] }, check: true },
		);
		expect(markersOnly.events.map((e) => e.frame)).toEqual([250]);
		expect(markersOnly.events[0]!.soundId).toBe(plan.events.find((e) => e.frame === 250)!.soundId);
		expect(markersOnly.soundCheck.summary).toMatch(
			/^Sound Check of this proposal: fixes \d+ · introduces \d+/,
		);
		expect(markersOnly.soundCheck.checkedItems).toContain(markersOnly.events[0]!.itemId);
		expect(await revisionOf(projectId)).toBe(rev);
		const checked = await ok<{ soundCheck: { summary: string } | null }>('get_proposal', {
			projectId,
			proposalId: markersOnly.proposalId,
			ghosts: false,
		});
		expect(checked.soundCheck?.summary).toBe(markersOnly.soundCheck.summary);
		await ok('reject_proposal', { projectId, proposalId: markersOnly.proposalId, itemIds: 'all' });
		expect(
			(await fails('plan_sound_design', { projectId, style: { cueSources: ['nonsense'] } })).code,
		).toMatch(/^E_/);
		expect((await fails('plan_sound_design', { projectId, style: { cueSources: [] } })).code).toMatch(/^E_/);
	});

	it('get_proposal lists items and a ghost table; an agent may not accept; reject works', async () => {
		const got = await ok<Got>('get_proposal', { projectId, proposalId: plan.proposalId });
		expect(got.items.every((i) => i.state === 'pending')).toBe(true);
		expect(got.items.some((i) => i.setup)).toBe(true);
		const lines = got.ghosts.split('\n');
		const placeRow = lines.find(
			(l) => l.startsWith(`${plan.events[0]!.itemId} |`) && l.includes('create clip'),
		)!;
		expect(placeRow).toMatch(/SFX|A\d/);
		// setup items in one line each (the new cue, the imported sounds); the place item fills its cue
		expect(lines.some((l) => l.startsWith(`cue:${plan.events[0]!.itemId} | pending | setup |`))).toBe(true);
		expect(lines.some((l) => l.startsWith(`${plan.events[0]!.itemId} |`) && l.includes('change cue'))).toBe(
			true,
		);
		const rev = await revisionOf(projectId);
		const refused = await fails('accept_proposal', {
			projectId,
			proposalId: plan.proposalId,
			itemIds: 'all',
		});
		expect(refused.code).toBe('E_APPROVAL_REQUIRED');
		expect(refused.hint).toMatch(/Review panel/);
		expect(refused.hint).toMatch(/Allow agents to apply sound proposals/);
		expect(await revisionOf(projectId)).toBe(rev);
		const rej = await ok<{ changed: string[] }>('reject_proposal', {
			projectId,
			proposalId: plan.proposalId,
			itemIds: [plan.events[0]!.itemId, plan.events[1]!.itemId],
		});
		expect(rej.changed.slice(0, 2)).toEqual([plan.events[0]!.itemId, plan.events[1]!.itemId]);
		// their own new cues (setup items nothing else needs) are settled with them
		const after = await ok<Got>('get_proposal', { projectId, proposalId: plan.proposalId, ghosts: false });
		for (const id of rej.changed.slice(2))
			expect(after.items.find((i) => i.itemId === id)).toMatchObject({ setup: true, state: 'rejected' });
		expect(rej.changed.slice(2)).toContain(`cue:${plan.events[0]!.itemId}`);
	});

	it('wait_for_proposal returns the user’s decisions: accepted, rejected, swapped, notes', async () => {
		const before = await ok<Got>('get_proposal', { projectId, proposalId: plan.proposalId, ghosts: false });
		// A wait that is answered by a note the user writes while it waits.
		const noteItem = plan.events[2]!.itemId;
		const waiting = ok<Waited>('wait_for_proposal', {
			projectId,
			proposalId: plan.proposalId,
			since: before.updatedAt,
			timeoutSeconds: 60,
		});
		// `since` identifies the prior version even if the note arrives before the wait starts.
		await editor(`/api/projects/${projectId}/proposals/${plan.proposalId}/note`, {
			itemId: noteItem,
			note: 'Too loud for this moment, try something softer',
		});
		const w1 = await waiting;
		expect(w1.status).toBe('changed');
		expect(w1.notes).toEqual([
			{ itemId: noteItem, label: expect.any(String), note: 'Too loud for this moment, try something softer' },
		]);
		// The user swaps the push to its first alternate and applies three items in the editor.
		const push = plan.events.find((e) => e.frame === 180)!;
		await editor(`/api/projects/${projectId}/proposals/${plan.proposalId}/select`, {
			itemId: push.itemId,
			alternative: 1,
		});
		const accepted = [push.itemId, plan.events[3]!.itemId, plan.events[4]!.itemId];
		const rev = await revisionOf(projectId);
		const acc = await editor(`/api/projects/${projectId}/proposals/${plan.proposalId}/accept`, {
			itemIds: accepted,
		});
		expect(acc.appliedBy).toBe('headless');
		expect(await revisionOf(projectId)).toBe(rev + 1);
		const w2 = await ok<Waited>('wait_for_proposal', {
			projectId,
			proposalId: plan.proposalId,
			since: w1.updatedAt,
			timeoutSeconds: 10,
		});
		expect(w2.status).toBe('changed');
		const state = (id: string) => w2.items.find((i) => i.itemId === id)!;
		expect(state(plan.events[0]!.itemId).state).toBe('rejected');
		expect(state(push.itemId)).toMatchObject({
			state: 'accepted',
			swapped: { alternative: 1, label: push.alternatives[0]!.title },
		});
		expect(state(plan.events[3]!.itemId).state).toBe('accepted');
		expect(state(noteItem)).toMatchObject({ state: 'pending', note: expect.stringContaining('softer') });
		expect(w2.items.every((i) => !i.setup)).toBe(true);
		// The swapped item placed the alternative, peak on the cue.
		const seq = seqOf(await documentOf(projectId));
		const F = flicksPerFrame(seq.settings.frameRate);
		const cue = cuesOf(seq).find((c) => c.frame === 180)!;
		const clip = seq.clips[cue.placedClipIds![0]!] as SfxClip;
		expect(clip.sfx!.soundId).toBe(push.alternatives[0]!.soundId);
		expect(
			Math.abs(clip.start * F + (clip.sfx!.placement.peakFlicks - clip.sourceIn) / clip.speed.rate - 180 * F),
		).toBeLessThanOrEqual(1);
		// No change since: a short wait times out.
		const w3 = await ok<Waited>('wait_for_proposal', {
			projectId,
			proposalId: plan.proposalId,
			since: w2.updatedAt,
			timeoutSeconds: 2,
		});
		expect(w3.status).toBe('timeout');
	});

	it('an allowed agent accepts the rest ("all" = the remaining place items with their setup); decided', async () => {
		// The user turns on "Allow agents to apply sound proposals" (an agent cannot grant it to itself).
		// (Saved from the editor window: the setting's command needs the user's approval card, which a headless
		// test cannot answer.)
		const doc = await documentOf(projectId);
		const seq = seqOf(doc);
		const sd = (seq.soundDesign ?? { cues: {} }) as SoundDesign;
		(seq as { soundDesign?: unknown }).soundDesign = {
			...sd,
			settings: { ...soundDesignSettingsOf(seq), agentsMayApply: true },
		};
		const rev0 = await revisionOf(projectId);
		const put = await fetch(`${BASE}/api/projects/${projectId}`, {
			method: 'PUT',
			headers: { ...EDITOR, 'if-match': String(rev0) },
			body: JSON.stringify(
				makeEnvelope(doc, { revision: rev0 + 1, savedAt: new Date().toISOString(), platform: 'test' }),
			),
		});
		expect(put.status, await put.clone().text()).toBeLessThan(300);
		const rev = await revisionOf(projectId);
		const r = await ok<{ applied: string[]; counts: Record<string, number> }>('accept_proposal', {
			projectId,
			proposalId: plan.proposalId,
			itemIds: 'all',
		});
		expect(r.applied.length).toBeGreaterThan(3);
		expect(r.counts.pending).toBe(0);
		expect(r.counts.stale).toBe(0);
		expect(await revisionOf(projectId)).toBe(rev + 1);
		const w = await ok<Waited>('wait_for_proposal', {
			projectId,
			proposalId: plan.proposalId,
			until: 'decided',
			timeoutSeconds: 5,
		});
		expect(w.status).toBe('applied');
		// rejected items stay unplaced: their cues (new ones) were never added
		const final = seqOf(await documentOf(projectId));
		expect(
			cuesOf(final).some((c) => c.frame === plan.events[0]!.frame && c.kind === plan.events[0]!.kind),
		).toBe(false);
	});

	it('place_sound proposes by default; a placement that cannot apply is refused and leaves no proposal', async () => {
		const rev = await revisionOf(projectId);
		const before = (await ok<{ proposals: unknown[] }>('list_proposals', { projectId })).proposals.length;
		const search = await ok<{ results: { soundId: string; types: string[] }[] }>('search_sounds', {
			types: ['hit'],
			sources: ['starter'],
			limit: 3,
		});
		const [h0, h1] = search.results.map((s) => s.soundId);
		const p = await ok<{
			mode: string;
			proposalId: string;
			items: { itemId: string; state: string; alternatives?: string[] }[];
			next: string;
		}>('place_sound', {
			projectId,
			at: '00:00:15:00',
			layers: [{ soundId: h0 }],
			alternatives: [h1],
			reason: 'Button press',
		});
		expect(p.mode).toBe('propose');
		expect(p.items.find((i) => i.itemId === 'place')).toMatchObject({
			state: 'pending',
			alternatives: [expect.any(String)],
		});
		expect(p.next).toMatch(/Review panel/);
		expect(await revisionOf(projectId)).toBe(rev);
		const bad = await fails('place_sound', { projectId, at: 30, layers: [{ soundId: h0, track: 'V1' }] });
		expect(bad.code).toBe('E_TRACK_KIND');
		const after = (await ok<{ proposals: unknown[] }>('list_proposals', { projectId })).proposals.length;
		expect(after).toBe(before + 1);
	});
});
