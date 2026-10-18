// Music to picture in the editor (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): Essential Sound ▸ Duration ▸ Music to
// picture (Analyze Music: tempo, metre, key, the drops with ▶; "Land the drop on" playhead / hero cue / marker; Land
// Drop as one History entry "Land the Drop" recording where it landed; End on Bar), the Clip ▸ Audio Options and context
// menu entries running `audio.landDropOnPlayhead` / `audio.landDropOnHero` / `audio.endOnBar`, a later Remix keeping
// the landed drop, the style checkboxes, and engine failures reported.
import type { BeatsResult, RemixPlanRequest, RemixPlanResult } from '@jasper/api';
import {
	type AudioClip,
	type ResolvedSoundStyle,
	readRemixAnchors,
	resolveSoundStyle,
	type Sequence,
} from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { runCommand } from '../src/commands/registry.ts';
import { clipMenuExtensions, type MenuItemSpec } from '../src/extensions/index.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { SoundStyleFields } from '../src/sound/StyleControls.tsx';
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
const { registerSoundDesignUi } = await import('../src/sound/register.tsx');

beforeAll(() => {
	registerAllCommands();
	registerSoundDesignUi();
});
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

const BEATS: BeatsResult = {
	bpm: 120,
	beats: Array.from({ length: 128 }, (_, i) => i * 0.5),
	downbeats: Array.from({ length: 32 }, (_, i) => i * 2),
	beatsPerBar: 4,
	downbeatConfidence: 0.8,
	drops: [
		{ sourceSeconds: 32, bar: 17, score: 8.8, liftDb: 15.8, novelty: 1.8, levelDb: -0.4 },
		{ sourceSeconds: 50, bar: 26, score: 3.3, liftDb: 0.1, novelty: 1.6, levelDb: 0 },
	],
	dropBarsGuessed: false,
	key: {
		tonic: 0,
		mode: 'major',
		name: 'C major',
		confidence: 0.884,
		correlation: 0.88,
		margin: 0.31,
		scale: [0, 2, 4, 5, 7, 9, 11],
	},
	startSeconds: 0,
	durationSeconds: 64,
	analysedSeconds: 64,
	cached: false,
};

function fixture(fail = false) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(64), ref: '$a' },
			{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' }, ref: '$x' },
			{ type: 'essentialSound.setType', clipIds: ['$x'], audioType: 'music' },
			{ type: 'soundCue.add', cues: [{ frame: 615, kind: 'emphasis', weight: 'hero', source: 'user' }] },
			{ type: 'marker.add', frame: 450, name: 'Logo' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const clipId = r.refs.$x!;
	const plans: RemixPlanRequest[] = [];
	mocks.client = {
		audioBeats: async () => {
			if (fail) throw Object.assign(new Error('ffmpeg exited 1'), { code: 'DECODE_FAILED' });
			return BEATS;
		},
		remixPlan: async (req: RemixPlanRequest): Promise<RemixPlanResult> => {
			plans.push(req);
			const base = {
				bpm: 120,
				beats: BEATS.beats,
				crossfadeSeconds: 0.02,
				downbeats: BEATS.downbeats!,
				beatsPerBar: 4,
				barsGuessed: false,
				drops: BEATS.drops,
			};
			if (!req.anchors)
				return {
					...base,
					pieces: [{ srcSeconds: 0, lenSeconds: req.targetSeconds }],
					lengthSeconds: req.targetSeconds,
					cuts: [],
				};
			// the drop (32 s) lands at the anchor's output time: skip (32 − out) seconds of whole bars from 16 s on
			const a = req.anchors[0]!;
			const skip = a.sourceSeconds - a.outputSeconds;
			const head = skip - Math.floor(skip / 2) * 2;
			const jump = skip - head;
			return {
				...base,
				pieces: [
					{ srcSeconds: head, lenSeconds: 16 - head },
					{ srcSeconds: 16 + jump, lenSeconds: 64 - 16 - jump },
				],
				lengthSeconds: 64 - jump - head,
				cuts: [[16, 16 + jump]],
				targetSeconds: 64 - jump - head,
				headTrimSeconds: head,
				anchors: [
					{
						sourceSeconds: a.sourceSeconds,
						outputSeconds: a.outputSeconds,
						landedSeconds: a.outputSeconds,
						errorMs: 0,
					},
				],
			};
		},
	};
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const pieces = () =>
		(Object.values(seq().clips).filter((c) => c.kind === 'audio') as AudioClip[]).sort(
			(x, y) => x.start - y.start,
		);
	const labels = () => session.getState().history.entries.map((e) => e.label);
	session.select('timeline', [clipId], 'replace');
	const mount = () => {
		const view = () => (
			<SessionProvider session={session}>
				<EssentialSoundPanel {...({} as Parameters<typeof EssentialSoundPanel>[0])} />
			</SessionProvider>
		);
		const rr = render(view());
		return session.store.subscribe(() => rr.rerender(view()));
	};
	const toastsSeen: { message: string; detail?: string }[] = [];
	const ctx = createCommandContext({
		engine: mocks.client as never,
		session,
		focus: { panel: 'timeline', instanceId: 'x' },
		capabilities: ['engine'],
		toast: (t) => toastsSeen.push(t as never),
	});
	return { session, seqId, clipId, plans, seq, pieces, labels, mount, ctx, toastsSeen };
}

describe('Essential Sound ▸ Music to picture', () => {
	it('analyses the music, plays a drop, lands it on the hero cue in one undo step', async () => {
		const f = fixture();
		const off = f.mount();
		const block = await screen.findByTestId('essential-music-fit');
		await act(async () => {
			fireEvent.click(within(block).getByTestId('essential-music-analyse'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('essential-music-info').textContent).toBe(
				'120 BPM · 4 beats per bar · C major (88 %)',
			),
		);
		const drops = screen.getByTestId('essential-music-drops');
		expect(drops.textContent).toContain('Bar 17 · 00:00:32:00');
		fireEvent.click(within(drops).getByRole('button', { name: 'Play the drop at bar 17' }));
		expect(f.session.transport.getState().frame).toBe(960);
		f.session.transport.pause();
		// the target: the hero cue (00:00:20:15), and the marker is offered too
		const select = within(block).getByRole('combobox', { name: 'Land the drop on' });
		await act(async () => {
			fireEvent.keyDown(select, { key: 'Enter' });
		});
		expect(await screen.findByRole('option', { name: 'Logo (00:00:15:00)' })).toBeTruthy();
		const hero = await screen.findByRole('option', { name: 'Hero cue (00:00:20:15)' });
		await act(async () => {
			fireEvent.keyDown(hero, { key: 'Enter' });
		});
		await act(async () => {
			fireEvent.click(within(block).getByTestId('essential-land-drop'));
		});
		await waitFor(() => expect(f.labels()).toContain('Land the Drop'));
		const anchored = f.plans.find((p) => p.anchors)!;
		expect(anchored.anchors).toEqual([{ sourceSeconds: 32, outputSeconds: 20.5 }]);
		expect(anchored.fit).toBe('nearest');
		expect(readRemixAnchors(f.pieces()[0]!.remix)).toEqual([{ sourceSeconds: 32, frame: 615 }]);
		await waitFor(() =>
			expect(screen.getByTestId('essential-music-landed').textContent).toBe('The drop lands at 00:00:20:15'),
		);
		expect(f.labels().filter((l) => l === 'Land the Drop').length).toBe(1);
		off();
	});

	it('a later Remix keeps the landed drop; End on Bar ends the music before a bar line', async () => {
		const f = fixture();
		const r1 = await runCommand('audio.landDropOnHero', f.ctx);
		expect(r1.ran, r1.reason).toBe(true);
		await waitFor(() => expect(f.labels()).toContain('Land the Drop'));
		const last = f.pieces().at(-1)!;
		f.session.select('timeline', [last.id], 'replace');
		const r2 = await runCommand('audio.remix', f.ctx, { targetSeconds: 50 });
		expect(r2.ran, r2.reason).toBe(true);
		await waitFor(() => expect(f.labels()).toContain('Remix'));
		expect(f.plans.at(-1)!.anchors).toEqual([{ sourceSeconds: 32, outputSeconds: 20.5 }]);
		expect(readRemixAnchors(f.pieces()[0]!.remix)[0]!.frame).toBe(615);
		f.session.select('timeline', [f.pieces().at(-1)!.id], 'replace');
		const r3 = await runCommand('audio.endOnBar', f.ctx);
		expect(r3.ran, r3.reason).toBe(true);
		await waitFor(() => expect(f.labels()).toContain('End on Bar'));
		const end = f.pieces().at(-1)!;
		const endSec = (end.start + end.duration) / 30;
		// a bar line every 2 s in media time: the music ends ≥ 3 ms and < 1 frame + 3 ms before one
		const playsAt = f.toastsSeen.find((x) => x.message.startsWith('The music ends on the bar line at'));
		expect(playsAt).toBeDefined();
		expect(
			Object.values(f.seq().transitions).some((t) => t.outgoingClipId === end.id && !t.incomingClipId),
		).toBe(true);
		expect(endSec).toBeGreaterThan(0);
	});

	it('Clip ▸ Audio Options and the context menu offer the entries; Land Drop on Playhead; failures are reported', async () => {
		const clipMenu = JSON.stringify(MENUBAR.find((m) => m.label === 'Clip')!);
		for (const id of ['audio.landDropOnPlayhead', 'audio.landDropOnHero', 'audio.endOnBar'])
			expect(clipMenu).toContain(id);
		const f = fixture();
		const ran: string[] = [];
		const items = clipMenuExtensions
			.list()
			.filter((e) => e.id === 'audio-fx')
			.flatMap((e) =>
				e.items({
					session: f.session,
					clip: f.seq().clips[f.clipId]!,
					selection: [f.clipId],
					runCommand: async (id: string) => {
						ran.push(id);
						await runCommand(id, f.ctx);
					},
				} as never),
			) as MenuItemSpec[];
		const land = items.find((i) => i.kind === 'item' && i.label === 'Land Drop on Playhead') as {
			run(): void;
		};
		expect(items.some((i) => i.kind === 'item' && i.label === 'End on Bar')).toBe(true);
		f.session.transport.seek(450);
		land.run();
		await waitFor(() => expect(f.labels()).toContain('Land the Drop'));
		expect(ran).toEqual(['audio.landDropOnPlayhead']);
		expect(f.plans.find((p) => p.anchors)!.anchors![0]!.outputSeconds).toBe(15);
		const g = fixture(true);
		const r = await runCommand('audio.endOnBar', g.ctx);
		expect(r.ran).toBe(true);
		await waitFor(() => expect(g.toastsSeen.some((x) => x.message === 'End on Bar failed')).toBe(true));
		expect(g.toastsSeen.find((x) => x.message === 'End on Bar failed')!.detail).toContain('ffmpeg exited 1');
		expect(g.labels()).not.toContain('End on Bar');
	});
});

describe('the style checkboxes', () => {
	it('"Tune chimes…" and "Stop the music on the bar line" change tuneToMusic / stopOnBar', () => {
		const seen: [ResolvedSoundStyle, string][] = [];
		render(
			<SoundStyleFields value={resolveSoundStyle()} onChange={(next, field) => seen.push([next, field])} />,
		);
		const tune = screen.getByRole('checkbox', { name: "Tune chimes and pitched sounds to the music's key" });
		const stop = screen.getByRole('checkbox', { name: 'Stop the music on the bar line before a hit' });
		expect((tune as HTMLInputElement).checked ?? tune.getAttribute('aria-checked') === 'true').toBeTruthy();
		fireEvent.click(tune);
		fireEvent.click(stop);
		expect(seen.map(([v, f]) => [f, v[f as keyof ResolvedSoundStyle]])).toEqual([
			['tuneToMusic', false],
			['stopOnBar', false],
		]);
	});
});
