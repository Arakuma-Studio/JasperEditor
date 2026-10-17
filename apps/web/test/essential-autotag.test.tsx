// Essential Sound ▸ Auto Tag in the editor (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): the panel's Auto Tag button on
// untyped clips (multi-select, one History entry "Auto Tag Audio Types", the engine asked with the editor's envelope),
// the "auto" banner with Confirm / Change…, low confidence, the dotted clip badge (aria-label, data-auto-tag), the
// Clip ▸ Audio Options and context-menu entries running `audio.autoTag`, and engine failures reported.
import type { AudioClassifyRequest } from '@jasper/api';
import { type AudioClip, essentialAutoTag, readEssentialSound, type Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { runCommand } from '../src/commands/registry.ts';
import {
	type ClipDecorationProps,
	clipDecorations,
	clipMenuExtensions,
	type MenuItemSpec,
} from '../src/extensions/index.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { clipBadges } from '../src/sound/register.tsx';
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

type Answer = {
	category: 'dialogue' | 'music' | 'sfx' | 'ambience' | null;
	confidence: number;
	silent?: boolean;
};

function fixture(answers: Answer[], fail = false) {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(10), ref: '$a' },
			{ type: 'media.register', asset: audioAsset(10), ref: '$b' },
			{ type: 'clip.place', source: { mediaId: '$a' }, at: 0, tracks: { audio: 'A1' }, ref: '$x' },
			{ type: 'clip.place', source: { mediaId: '$b' }, at: 0, tracks: { audio: 'A2' }, ref: '$y' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const ids = [r.refs.$x!, r.refs.$y!];
	const requests: AudioClassifyRequest[] = [];
	mocks.client = {
		classifyAudio: async (req: AudioClassifyRequest, opts: { wait?: boolean }) => {
			requests.push(req);
			expect(opts.wait).toBe(true);
			if (fail)
				return {
					id: 'job_1',
					kind: 'audio-classify',
					state: 'failed',
					error: { code: 'DECODE_FAILED', message: 'ffmpeg exited 1' },
				};
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
					items: (req.clipIds ?? []).map((id) => {
						const a = answers[ids.indexOf(id)]!;
						return {
							clipId: id,
							name: id,
							startSeconds: 0,
							durationSeconds: 10,
							cached: false,
							result: {
								category: a.category,
								confidence: a.confidence,
								scores: { dialogue: 0, music: 0, sfx: 0, ambience: 0 },
								reasons: a.silent ? ['silent'] : [`heard ${a.category}`],
								silent: !!a.silent,
								durationSec: 10,
								analysedSec: 10,
								features: {},
							},
						};
					}),
				},
			};
		},
	};
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const clip = (i: number) => seq().clips[ids[i]!] as AudioClip;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const select = (which: number[]) =>
		session.select(
			'timeline',
			which.map((i) => ids[i]!),
			'replace',
		);
	const mount = () => {
		const view = () => (
			<SessionProvider session={session}>
				<EssentialSoundPanel {...({} as Parameters<typeof EssentialSoundPanel>[0])} />
			</SessionProvider>
		);
		const rr = render(view());
		const off = session.store.subscribe(() => rr.rerender(view()));
		return off;
	};
	return { session, seqId, ids, requests, seq, clip, labels, select, mount };
}

describe('Essential Sound ▸ Auto Tag', () => {
	it('tags the selected untyped clips in one undo step; banner, Confirm, Change…', async () => {
		const f = fixture([
			{ category: 'dialogue', confidence: 0.92 },
			{ category: 'music', confidence: 0.81 },
		]);
		f.select([0, 1]);
		const off = f.mount();
		fireEvent.click(screen.getByTestId('essential-auto-tag'));
		await waitFor(() => expect(readEssentialSound(f.clip(1).essential)?.type).toBe('music'));
		expect(f.requests[0]!.clipIds).toEqual(f.ids);
		expect(f.requests[0]!.envelope).toBeDefined();
		expect(readEssentialSound(f.clip(0).essential)?.type).toBe('dialogue');
		expect(f.labels().filter((l) => l === 'Auto Tag Audio Types')).toHaveLength(1);
		expect(
			toasts
				.getState()
				.toasts.map((t) => t.title)
				.join(),
		).toContain('Tagged 1 Dialogue, 1 Music');
		// two types: the mixed view still offers the banner
		await waitFor(() =>
			expect(screen.getByTestId('essential-auto-tag-banner').textContent).toContain('2 clips auto-tagged'),
		);
		// one clip: "Auto-tagged as Music · 81 % confident", Confirm keeps the type and drops the mark
		act(() => f.select([1]));
		await waitFor(() =>
			expect(screen.getByTestId('essential-auto-tag-banner').textContent).toContain(
				'Auto-tagged as Music · 81 % confident',
			),
		);
		expect(screen.getByTestId('essential-auto-tag-banner').textContent).toContain('heard music');
		expect(screen.queryByTestId('essential-auto-tag-low')).toBeNull();
		fireEvent.click(screen.getByTestId('essential-auto-tag-confirm'));
		await waitFor(() => expect(screen.queryByTestId('essential-auto-tag-banner')).toBeNull());
		expect(readEssentialSound(f.clip(1).essential)?.type).toBe('music');
		expect(essentialAutoTag(f.clip(1).essential)).toBeNull();
		expect(f.labels().at(-1)).toBe('Confirm Audio Type');
		// Change… on the other clip
		act(() => f.select([0]));
		await waitFor(() => screen.getByTestId('essential-auto-tag-change'));
		fireEvent.click(screen.getByTestId('essential-auto-tag-change'));
		fireEvent.click(screen.getByTestId('essential-auto-tag-change-ambience'));
		await waitFor(() => expect(readEssentialSound(f.clip(0).essential)?.type).toBe('ambience'));
		expect(essentialAutoTag(f.clip(0).essential)).toBeNull();
		off();
	});

	it('low confidence is shown; silent clips stay untyped; the badge is dotted with its confidence', async () => {
		const f = fixture([
			{ category: 'sfx', confidence: 0.42 },
			{ category: null, confidence: 0, silent: true },
		]);
		f.select([0, 1]);
		const off = f.mount();
		fireEvent.click(screen.getByTestId('essential-auto-tag'));
		await waitFor(() => expect(readEssentialSound(f.clip(0).essential)?.type).toBe('sfx'));
		expect(f.clip(1).essential).toBeUndefined();
		const toast = toasts
			.getState()
			.toasts.map((t) => t.title)
			.join();
		expect(toast).toContain('1 with low confidence');
		expect(toast).toContain('1 silent');
		act(() => f.select([0]));
		await waitFor(() => screen.getByTestId('essential-auto-tag-low'));
		expect(clipBadges(f.seq(), f.clip(0), { width: 120, licenceWarning: false }).auto).toBe(0.42);
		const deco = clipDecorations.list().find((d) => d.id === 'sound.badges')!;
		expect(deco.appliesTo(f.clip(0))).toBe(true);
		const Badge = deco.badge!;
		const props = {
			clip: f.clip(0),
			x: 0,
			y: 0,
			w: 120,
			h: 40,
			selected: false,
		} as unknown as ClipDecorationProps;
		render(
			<SessionProvider session={f.session}>
				<Badge {...props} />
			</SessionProvider>,
		);
		const b = document.querySelector('[data-sound-badge="type-sfx"]')!;
		expect(b.getAttribute('data-auto-tag')).toBe('true');
		expect(b.getAttribute('aria-label')).toContain('auto-tagged, 42 % confident');
		expect(b.className).toContain('border-dashed');
		off();
	});

	it('Clip ▸ Audio Options and the clip context menu run audio.autoTag; failures are reported', async () => {
		const f = fixture([
			{ category: 'music', confidence: 0.9 },
			{ category: 'music', confidence: 0.9 },
		]);
		const clipMenu = MENUBAR.find((m) => m.label === 'Clip')!;
		const flat = JSON.stringify(clipMenu);
		expect(flat).toContain('audio.autoTag');
		f.select([0]);
		const items = clipMenuExtensions
			.list()
			.filter((e) => e.id === 'audio-fx')
			.flatMap((e) =>
				e.items({ session: f.session, clip: f.clip(0), selection: [f.ids[0]!], runCommand: run } as never),
			) as MenuItemSpec[];
		const toastsSeen: string[] = [];
		const ctx = createCommandContext({
			engine: mocks.client as never,
			session: f.session,
			focus: { panel: 'timeline', instanceId: 'x' },
			capabilities: ['engine'],
			toast: (r) => toastsSeen.push(r.message),
		});
		async function run(id: string, args?: unknown) {
			const r = await runCommand(id, ctx, args);
			expect(r.ran, r.reason).toBe(true);
		}
		const entry = items.find((i) => i.kind === 'item' && i.label === 'Auto Tag Audio Types') as {
			run(): void;
		};
		expect(entry).toBeDefined();
		entry.run();
		await waitFor(() => expect(readEssentialSound(f.clip(0).essential)?.type).toBe('music'));
		expect(f.clip(1).essential).toBeUndefined();
		// the command over the selection, with a failing engine
		const g = fixture(
			[
				{ category: 'music', confidence: 0.9 },
				{ category: 'music', confidence: 0.9 },
			],
			true,
		);
		g.select([0, 1]);
		const seen: { message: string; detail?: string }[] = [];
		const gctx = createCommandContext({
			engine: mocks.client as never,
			session: g.session,
			focus: { panel: 'timeline', instanceId: 'x' },
			capabilities: ['engine'],
			toast: (r) => seen.push(r as never),
		});
		const r = await runCommand('audio.autoTag', gctx);
		expect(r.ran).toBe(true);
		await waitFor(() => expect(seen.some((x) => x.message === 'Auto Tag failed')).toBe(true));
		expect(seen.find((x) => x.message === 'Auto Tag failed')!.detail).toContain('ffmpeg exited 1');
		expect(g.clip(0).essential).toBeUndefined();
		void toastsSeen;
	});
});
