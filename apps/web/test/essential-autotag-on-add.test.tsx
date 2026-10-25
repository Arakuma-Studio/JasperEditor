// WP6.5a item 5: Premiere's Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (tag audio clips as they are
// added, through the same classify route and `essentialSound.autoTag` command as Auto Tag) and Essential Sound's "select
// all clips of a tag" (the tags in the sequence; Clip ▸ Audio Options and the clip menu: Select All <Type> Clips).
import type { AudioClassifyRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { type AudioClip, essentialAutoTag, readEssentialSound, type Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, toasts } from '@jasper/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAudioPrefs } from '../src/audio/prefs.ts';
import { addedClipsToTag, autoTaggable, watchAutoTagOnAdd } from '../src/audio-fx/auto-tag-on-add.tsx';
import { audioTypeClips } from '../src/audio-fx/ops.ts';
import { createCommandContext } from '../src/commands/context.ts';
import { runCommand } from '../src/commands/registry.ts';
import { clipMenuExtensions, type MenuItemSpec } from '../src/extensions/index.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown, status: 'connected' }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	useEngineOrNull: () => ({ client: mocks.client, status: mocks.status, subscribe: () => () => {} }),
	createEditorEngineClient: () => mocks.client,
}));

const { EssentialSoundPanel } = await import('../src/panels/essentialSound/EssentialSoundPanel.tsx');
const { registerAllCommands } = await import('../src/commands/index.ts');

beforeAll(() => registerAllCommands());
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

/** A session with two audio media registered, and an engine that answers every clip with `category`. */
function fixture(category: 'dialogue' | 'music' | 'sfx' | 'ambience' = 'music') {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(10), ref: '$a' },
			{ type: 'media.register', asset: audioAsset(10), ref: '$b' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const media = [r.refs.$a!, r.refs.$b!];
	const requests: AudioClassifyRequest[] = [];
	let hold: Promise<void> | null = null;
	const engine = {
		classifyAudio: async (req: AudioClassifyRequest) => {
			requests.push(req);
			if (hold) await hold;
			return {
				id: 'job_1',
				kind: 'audio-classify',
				state: 'succeeded',
				result: {
					projectId: null,
					sequenceId: seqId,
					lowConfidence: 0.6,
					counts: {},
					version: 1,
					ms: 1,
					items: (req.clipIds ?? []).map((id) => ({
						clipId: id,
						name: id,
						startSeconds: 0,
						durationSeconds: 10,
						cached: false,
						result: {
							category,
							confidence: 0.9,
							scores: { dialogue: 0, music: 0, sfx: 0, ambience: 0 },
							reasons: [`heard ${category}`],
							silent: false,
							durationSec: 10,
							analysedSec: 10,
							features: {},
						},
					})),
				},
			};
		},
	} as unknown as EngineClient;
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const place = (mediaIdx: number, at: number, track = 'A1', origin: unknown = 'user') => {
		const res = session.apply({
			label: 'Place',
			origin: origin as never,
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: media[mediaIdx]! },
					at,
					tracks: { audio: track },
					ref: '$c',
				},
			] as never[],
		});
		if (!res.ok) throw new Error(JSON.stringify(res.errors));
		return res.refs.$c!;
	};
	const holdAnswers = () => {
		let release!: () => void;
		hold = new Promise<void>((r) => {
			release = r;
		});
		return () => {
			hold = null;
			release();
		};
	};
	return { session, seqId, media, engine, requests, seq, labels, place, holdAnswers };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('Preferences ▸ Audio ▸ Auto-tag audio types in the timeline', () => {
	it('is off by default and read tolerantly', () => {
		expect(parseAudioPrefs({}).autoTagInTimeline).toBe(false);
		expect(parseAudioPrefs({ autoTagInTimeline: true }).autoTagInTimeline).toBe(true);
		expect(parseAudioPrefs({ autoTagInTimeline: 'yes' }).autoTagInTimeline).toBe(false);
	});

	it('off: adding a clip asks the engine nothing', async () => {
		const f = fixture();
		const stop = watchAutoTagOnAdd(f.session, f.engine, { debounceMs: 0, enabled: () => false });
		f.place(0, 0);
		await settle();
		expect(f.requests).toHaveLength(0);
		stop();
	});

	it('on: a clip the user adds is tagged in its own "Auto Tag Audio Types" step, marked auto', async () => {
		const f = fixture('music');
		const stop = watchAutoTagOnAdd(f.session, f.engine, { debounceMs: 0, enabled: () => true });
		const id = f.place(0, 0);
		await waitFor(() =>
			expect(readEssentialSound((f.seq().clips[id] as AudioClip).essential)?.type).toBe('music'),
		);
		expect(f.requests).toHaveLength(1);
		expect(f.requests[0]!.clipIds).toEqual([id]);
		expect(f.requests[0]!.sequenceId).toBe(f.seqId);
		expect(essentialAutoTag((f.seq().clips[id] as AudioClip).essential)?.by).toBe('auto');
		expect(f.labels().slice(-2)).toEqual(['Place', 'Auto Tag Audio Types']);
		// undo takes the tag back without re-tagging; undoing the place and redoing it adds nothing new to tag
		f.session.undo();
		expect(readEssentialSound((f.seq().clips[id] as AudioClip).essential)).toBeNull();
		f.session.undo();
		f.session.redo();
		await settle();
		expect(f.requests).toHaveLength(1);
		stop();
	});

	it('skips razor parts, typed clips, agents, locked tracks and clips typed or deleted before the answer', async () => {
		const f = fixture('sfx');
		const stop = watchAutoTagOnAdd(f.session, f.engine, { debounceMs: 0, enabled: () => true });
		const id = f.place(0, 0);
		await waitFor(() => expect(f.labels().at(-1)).toBe('Auto Tag Audio Types'));
		// clear the type, then razor: the right part is not "added"
		f.session.apply({
			label: 'Clear',
			origin: 'user',
			commands: [{ type: 'essentialSound.clearType', clipIds: [id] }] as never[],
		});
		f.session.apply({
			label: 'Add Edit',
			origin: 'user',
			sequenceId: f.seqId,
			commands: [{ type: 'clip.split', at: 60, clipIds: [id] }] as never[],
		});
		await settle();
		expect(f.requests).toHaveLength(1);
		// an agent's placement is the agent's to tag (auto_tag_audio)
		f.place(1, 400, 'A1', { agent: 'test' });
		await settle();
		expect(f.requests).toHaveLength(1);
		// typed before the answer arrives: kept as the user set it, nothing else to tag → no transaction
		const release = f.holdAnswers();
		const late = f.place(1, 0, 'A2');
		await waitFor(() => expect(f.requests).toHaveLength(2));
		f.session.apply({
			label: 'Set Audio Type to Dialogue',
			origin: 'user',
			commands: [{ type: 'essentialSound.setType', clipIds: [late], audioType: 'dialogue' }] as never[],
		});
		const before = f.labels().length;
		release();
		await settle();
		expect(readEssentialSound((f.seq().clips[late] as AudioClip).essential)?.type).toBe('dialogue');
		expect(f.labels()).toHaveLength(before);
		stop();
		// a clip on a locked track is not tagged
		const other = f.place(0, 400, 'A2');
		expect(autoTaggable(f.seq(), other)).toBe(true);
		const r = f.session.apply({
			label: 'Lock',
			origin: 'user',
			sequenceId: f.seqId,
			commands: [{ type: 'track.update', trackId: 'A2', patch: { locked: true } }] as never[],
		});
		expect(r.ok).toBe(true);
		expect(autoTaggable(f.seq(), other)).toBe(false);
		expect(autoTaggable(f.seq(), 'clp_missing')).toBe(false);
	});

	it('waits for a drag in progress before it applies', async () => {
		const f = fixture('ambience');
		const stop = watchAutoTagOnAdd(f.session, f.engine, { debounceMs: 0, enabled: () => true });
		const release = f.holdAnswers();
		const id = f.place(0, 0);
		await waitFor(() => expect(f.requests).toHaveLength(1));
		const g = f.session.beginGesture('Drag');
		release();
		await settle();
		expect(readEssentialSound((f.seq().clips[id] as AudioClip).essential)).toBeNull();
		g.cancel();
		await waitFor(() =>
			expect(readEssentialSound((f.seq().clips[id] as AudioClip).essential)?.type).toBe('ambience'),
		);
		stop();
	});

	it('addedClipsToTag ignores the clips of a duplicated sequence', () => {
		const f = fixture();
		f.place(0, 0);
		const before = f.session.getCommitted();
		const r = f.session.apply({
			label: 'Duplicate',
			origin: 'user',
			commands: [{ type: 'sequence.duplicate', sequenceId: f.seqId }] as never[],
		});
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		if (!r.ok) return;
		expect(addedClipsToTag(before, f.session.getCommitted(), r.created).size).toBe(0);
	});
});

describe('Essential Sound: select all clips of a tag', () => {
	function typed() {
		const f = fixture();
		const a = f.place(0, 0, 'A1');
		const b = f.place(1, 0, 'A2');
		const c = f.place(0, 400, 'A1');
		const r = f.session.apply({
			label: 'types',
			origin: 'user',
			commands: [
				{ type: 'essentialSound.setType', clipIds: [a, c], audioType: 'dialogue' },
				{ type: 'essentialSound.setType', clipIds: [b], audioType: 'music' },
			] as never[],
		});
		expect(r.ok).toBe(true);
		return { ...f, a, b, c };
	}

	it('audioTypeClips lists each type in timeline order', () => {
		const f = typed();
		expect(audioTypeClips(f.seq())).toEqual({ dialogue: [f.a, f.c], music: [f.b], sfx: [], ambience: [] });
	});

	it('the panel shows the tags in the sequence; a click selects only those audio clips', async () => {
		const f = typed();
		mocks.client = f.engine;
		const view = () => (
			<SessionProvider session={f.session}>
				<EssentialSoundPanel {...({} as Parameters<typeof EssentialSoundPanel>[0])} />
			</SessionProvider>
		);
		const r = render(view());
		const off = f.session.store.subscribe(() => r.rerender(view()));
		const strip = await screen.findByTestId('essential-tags');
		expect(strip.textContent).toContain('Dialogue 2');
		expect(strip.textContent).toContain('Music 1');
		expect(screen.queryByTestId('essential-tag-sfx')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Select all Dialogue clips (2)' }));
		expect(f.session.getState().selection.timeline.clips).toEqual([f.a, f.c]);
		// the panel now edits them (the strip stays)
		await waitFor(() => expect(screen.getByTestId('essential-current-type').textContent).toBe('Dialogue'));
		fireEvent.click(screen.getByTestId('essential-tag-music'));
		expect(f.session.getState().selection.timeline.clips).toEqual([f.b]);
		off();
	});

	it('the command (args or the selection) and the clip menu entry', async () => {
		const f = typed();
		const shown: string[] = [];
		const ctx = createCommandContext({
			engine: f.engine,
			session: f.session,
			toast: (r) => shown.push(r.message ?? ''),
		});
		await runCommand('audio.selectAudioType', ctx, { type: 'music' });
		expect(f.session.getState().selection.timeline.clips).toEqual([f.b]);
		f.session.select('timeline', [f.a], 'replace', { linked: false });
		await runCommand('audio.selectAudioType', ctx);
		expect(f.session.getState().selection.timeline.clips).toEqual([f.a, f.c]);
		await runCommand('audio.selectAudioType', ctx, { type: 'sfx' });
		expect(f.session.getState().selection.timeline.clips).toEqual([]);
		expect(shown).toEqual(['No SFX clips in this sequence']);
		const ran: [string, unknown][] = [];
		const items = clipMenuExtensions
			.list()
			.filter((x) => x.id === 'audio-fx')
			.flatMap((x) =>
				x.items({
					session: f.session,
					clip: f.seq().clips[f.b]!,
					runCommand: (id: string, args?: unknown) => ran.push([id, args]),
				} as never),
			) as MenuItemSpec[];
		const entry = items.find((i) => i.kind === 'item' && i.label === 'Select All Music Clips');
		expect(entry).toBeDefined();
		if (entry?.kind === 'item') entry.run();
		expect(ran).toContainEqual(['audio.selectAudioType', { type: 'music' }]);
	});
});
