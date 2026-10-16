// WP4.2b mixing UI (spec 12 §2.7 "Essential Sound SFX additions", P4-R4 / P4-R5): Essential Sound's Auto gain (level,
// reason, badge; off = the user's gain; on = solved again through the engine's rebalance), Rebalance, Room send (creates
// the glue, per-track send level as one undo step, mute), Stop before next / Build of the linked cue (validated, written
// into the mix); Properties ▸ Cue (Write Now on an unfilled cue); the Cue Seam's written vs stored span bars; Sequence ▸
// Sound Design ▸ Rebalance SFX Levels / Room Glue… / Delivery Target… (menus, dialogs, job progress, result, Undo).
import type { EngineJob, SfxRebalanceRequest, SoundDeliveryRequest } from '@jasper/api';
import type { AudioClip, Sequence } from '@jasper/project';
import { readSoundDesignMix } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { runCommand } from '../src/commands/registry.ts';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { CueSeam } from '../src/sound/cues/CueSeam.tsx';
import { cuesOf, SEAM_PX } from '../src/sound/cues/model.ts';
import { EssentialSfxSection } from '../src/sound/EssentialSfx.tsx';
import { DeliveryDialog, RoomGlueDialog } from '../src/sound/MixDialogs.tsx';
import { CueProperties } from '../src/sound/SoundSection.tsx';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({
		client: mocks.client,
		status: 'connected',
		subscribe: () => () => {},
		capabilities: null,
	}),
	useEngineOrNull: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {} }),
	useCapabilities: () => ({ capabilities: null, flags: new Set(['engine']) }),
	createEditorEngineClient: () => mocks.client,
}));
const { ShellRuntimeProvider } = await import('../src/shell/context.tsx');
const { registerAllCommands: registerAll } = await import('../src/commands/index.ts');

beforeAll(() => registerAll());
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** A fake engine for the mixing jobs: each start returns a job; the first poll runs `build` (which may edit). */
function fakeMixEngine(session: EditorSession) {
	const rebalances: SfxRebalanceRequest[] = [];
	const deliveries: SoundDeliveryRequest[] = [];
	const jobs = new Map<string, () => unknown>();
	let n = 0;
	const job = (id: string, state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob => ({
		id,
		kind: 'sound-design',
		title: 'Sound design',
		origin: { type: 'user' },
		projectId: session.projectId,
		state,
		progress: state === 'succeeded' ? 1 : 0.4,
		stage: state === 'running' ? 'Measuring' : undefined,
		createdAt: '2026-10-16T10:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 1,
		...extra,
	});
	const start = (run: () => unknown) => {
		const id = `job_${++n}`;
		jobs.set(id, run);
		return job(id, 'queued');
	};
	let rebalance: (req: SfxRebalanceRequest) => unknown = () => null;
	let delivery: (req: SoundDeliveryRequest) => unknown = () => null;
	return {
		rebalances,
		deliveries,
		onRebalance(f: (req: SfxRebalanceRequest) => unknown) {
			rebalance = f;
		},
		onDelivery(f: (req: SoundDeliveryRequest) => unknown) {
			delivery = f;
		},
		client: {
			async rebalanceSfx(req: SfxRebalanceRequest) {
				rebalances.push(req);
				return start(() => rebalance(req));
			},
			async applyDelivery(req: SoundDeliveryRequest) {
				deliveries.push(req);
				return start(() => delivery(req));
			},
			async getJob(id: string) {
				const run = jobs.get(id);
				if (!run) throw Object.assign(new Error('no job'), { code: 'JOB_NOT_FOUND' });
				jobs.delete(id);
				return job(id, 'succeeded', { result: run() });
			},
			async cancelJob(id: string) {
				return job(id, 'cancelled');
			},
		},
	};
}

const counts = (o: Partial<Record<string, number>> = {}) => ({
	clips: 1,
	solved: 1,
	changed: 1,
	limited: 1,
	skipped: 0,
	...o,
});
const levels = {
	delivery: 'web',
	programLufs: -14,
	truePeakCeilingDb: -1,
	clusters: 1,
	clusterSeconds: 2,
	renders: { bed: 1, sound: 1, voice: 0, cached: 0 },
	ms: 10,
};

/** Music on A1, a hero cue at 150 filled by a sound on A2 (solver level, limited by dialogue A1), a second cue at 240. */
function fixture() {
	const { session, seqId } = makeSession();
	const ok = (commands: unknown[], label = 'setup') => {
		const r = session.apply({ label, origin: 'user', sequenceId: seqId, commands: commands as never[] });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const reg = ok([
		{ type: 'media.register', asset: audioAsset(10), ref: '$music' },
		{ type: 'media.register', asset: audioAsset(1), ref: '$hit' },
		{ type: 'clip.place', source: { mediaId: '$music' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 150, kind: 'land', weight: 'hero', source: 'user' },
				{ frame: 240, kind: 'cut', weight: 'support', source: 'user' },
			],
		},
	]);
	const hit = reg.refs.$hit!;
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const [cueId, cue2] = cuesOf(seq()).map((c) => c.id) as [string, string];
	ok([
		{
			type: 'soundDesign.place',
			cueId,
			layers: [{ mediaId: hit, track: 'A2', align: 'start', ref: '$sfx' }],
		},
	]);
	const clipId = Object.values(seq().clips).find((c) => c.trackId === seq().audioTracks[1]!.id)!.id;
	ok([
		{
			type: 'soundDesign.applyGains',
			gains: { [clipId]: -6 },
			report: {
				[clipId]: {
					targetLiftDb: 5,
					achievedLiftDb: 1.5,
					limitedBy: ['dialogue'],
					reason: '−6 dB, limited by dialogue A1',
				},
			},
		},
	]);
	const engine = fakeMixEngine(session);
	mocks.client = engine.client;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	const clip = () => seq().clips[clipId] as AudioClip;
	return { session, seqId, ok, seq, cueId, cue2, clipId, clip, hit, engine, labels };
}

function mountEssential(f: ReturnType<typeof fixture>) {
	const view = () => (
		<SessionProvider session={f.session}>
			<ShellRuntimeProvider session={f.session}>
				<EssentialSfxSection session={f.session} seq={f.seq()} clips={[f.clip()]} />
				<DialogHost />
			</ShellRuntimeProvider>
		</SessionProvider>
	);
	const r = render(view());
	const off = f.session.store.subscribe(() => r.rerender(view()));
	return { rerender: () => r.rerender(view()), off };
}

const toastTitles = () => toasts.getState().toasts.map((x) => x.title);
const toastAction = (title: string, label: string) => {
	const tt = toasts.getState().toasts.find((x) => x.title === title);
	return tt?.actions?.find((a) => a.label === label);
};

describe('Essential Sound ▸ Auto gain', () => {
	it('shows the solver level and why; off keeps the gain as manual; on solves it again (one undo step)', async () => {
		const f = fixture();
		mountEssential(f);
		const row = screen.getByTestId('essential-auto-gain');
		expect(screen.getByTestId('essential-auto-gain-text').textContent).toBe(
			'−6.0 dB · limited by dialogue A1',
		);
		expect(within(row).getByText('Solver').getAttribute('data-owner')).toBe('solver');
		expect(screen.getByTestId('essential-auto-gain-lift').textContent).toBe(
			'Lift over the bed +1.5 dB of +5.0 dB',
		);
		const box = within(row).getByRole('checkbox', { name: 'Auto gain (masking-aware)' });
		expect(box.getAttribute('aria-checked')).toBe('true');
		await act(async () => {
			fireEvent.click(box);
		});
		expect(f.labels().at(-1)).toBe('Auto Gain Off');
		expect(f.clip().gainDb).toBe(-6);
		expect(screen.getByTestId('essential-auto-gain-text').textContent).toBe(
			'−6.0 dB · Auto gain off (last solve: −6.0 dB)',
		);
		expect(within(row).getByText('Manual')).toBeTruthy();
		// Rebalance is for automatic gains only
		expect((screen.getByTestId('essential-rebalance') as HTMLButtonElement).disabled).toBe(true);
		// on: the engine solves the named clip; it relays ONE transaction as the user's edit
		f.engine.onRebalance((req) => {
			const r = f.ok(
				[
					{
						type: 'soundDesign.applyGains',
						gains: { [req.clipIds![0]!]: -4.5 },
						report: { [req.clipIds![0]!]: { targetLiftDb: 5, achievedLiftDb: 5, limitedBy: [] } },
					},
				],
				'Rebalance SFX Levels',
			);
			return {
				projectId: f.session.projectId,
				sequenceId: f.seqId,
				mode: 'apply',
				applied: true,
				revision: f.session.revision,
				proposalId: null,
				report: {
					version: 1,
					sequenceId: f.seqId,
					events: [],
					skipped: [],
					conflicts: [],
					warnings: [],
					counts: counts({ limited: 0 }),
					levels,
				},
				_r: r.ok,
			};
		});
		const n = f.labels().length;
		await act(async () => {
			fireEvent.click(within(row).getByRole('checkbox', { name: 'Auto gain (masking-aware)' }));
		});
		await waitFor(() => expect(f.clip().gainDb).toBe(-4.5));
		expect(f.engine.rebalances[0]).toMatchObject({ clipIds: [f.clipId], mode: 'apply', sequenceId: f.seqId });
		expect(f.labels().slice(n)).toEqual(['Rebalance SFX Levels']);
		await waitFor(() => expect(toastTitles()).toContain('Rebalanced 1 sound effect'));
		expect(screen.getByTestId('essential-auto-gain-text').textContent).toBe(
			'−4.5 dB · target lift +5.0 dB reached',
		);
		// the toast's Undo undoes that one entry
		act(() => toastAction('Rebalanced 1 sound effect', 'Undo')!.run!());
		expect(f.clip().gainDb).toBe(-6);
	});

	it('Rebalance runs the selection’s automatic gains; nothing to change = no History entry', async () => {
		const f = fixture();
		mountEssential(f);
		f.engine.onRebalance(() => ({
			projectId: f.session.projectId,
			sequenceId: f.seqId,
			mode: 'apply',
			applied: false,
			revision: f.session.revision,
			proposalId: null,
			report: {
				version: 1,
				sequenceId: f.seqId,
				events: [],
				skipped: [],
				conflicts: [],
				warnings: [],
				counts: counts({ changed: 0, limited: 1 }),
				levels,
			},
		}));
		const n = f.labels().length;
		await act(async () => {
			fireEvent.click(screen.getByTestId('essential-rebalance'));
		});
		await waitFor(() =>
			expect(toastTitles()).toContain('Nothing to change: the sound effects are at their solved levels'),
		);
		expect(f.engine.rebalances[0]).toMatchObject({ clipIds: [f.clipId], mode: 'apply' });
		expect(f.labels()).toHaveLength(n);
	});
});

describe('Essential Sound ▸ Room', () => {
	it('creates the glue, sets the track’s send level as one step, mutes it; a bed track is blocked with why', async () => {
		const f = fixture();
		mountEssential(f);
		const room = screen.getByTestId('essential-room');
		expect(screen.getByTestId('essential-room-note').textContent).toBe(
			'Applies to the whole track A2, not only this clip',
		);
		await act(async () => {
			fireEvent.click(within(room).getByRole('checkbox', { name: 'Send A2 to the SFX Room' }));
		});
		expect(f.labels().at(-1)).toBe('SFX Room Glue');
		const glue = readSoundDesignMix(f.seq().soundDesign?.mix)!.room!;
		expect(glue.sends.map((s) => s.trackId)).toEqual([f.seq().audioTracks[1]!.id]);
		expect(screen.getByTestId('essential-room-db').textContent).toBe('−16.0 dB');
		// a keyboard step on the slider: one gesture → one History entry
		const thumb = within(room).getAllByRole('slider')[0]!;
		const n = f.labels().length;
		await act(async () => {
			fireEvent.keyDown(thumb, { key: 'ArrowRight' });
		});
		const send = () => f.seq().audioTracks[1]!.mixer!.sends![0]!;
		expect(send().levelDb.value).toBe(-15.5);
		expect(f.labels().slice(n)).toEqual(['Room Send Level']);
		await act(async () => {
			fireEvent.click(within(room).getByRole('checkbox', { name: 'Send A2 to the SFX Room' }));
		});
		expect(send().mute).toBe(true);
		expect(f.labels().at(-1)).toBe('Room Send Off');
		expect(screen.getByTestId('essential-room-db').textContent).toBe('Off');
		f.session.undo();
		expect(send().mute ?? false).toBe(false);
	});

	it('a track that also plays dialogue cannot send: disabled with the reason', () => {
		const f = fixture();
		f.ok([
			{ type: 'clip.place', source: { mediaId: f.hit }, at: 400, tracks: { audio: 'A2' }, ref: '$d' },
			{ type: 'essentialSound.setType', clipIds: ['$d'], audioType: 'dialogue' },
		]);
		mountEssential(f);
		const room = screen.getByTestId('essential-room');
		expect(
			(within(room).getByRole('checkbox', { name: 'Send A2 to the SFX Room' }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect(screen.getByTestId('essential-room-note').textContent).toBe(
			'A2 also plays dialogue, music or other bed audio: a send would put them in the room too',
		);
	});
});

describe('Essential Sound ▸ Stop before next / Build (the linked cue)', () => {
	it('writes the cue’s stop-before into the music track; validation refuses bad numbers', async () => {
		const f = fixture();
		mountEssential(f);
		const stop = screen.getByTestId('essential-stop');
		await act(async () => {
			fireEvent.click(within(stop).getByRole('checkbox'));
		});
		expect(cuesOf(f.seq())[0]!.stopBefore).toEqual({ seconds: 0.25, depthDb: -24 });
		expect(f.labels().at(-1)).toBe('Stop Before Next');
		expect(screen.getByTestId('essential-stop-status').textContent).toContain(
			'Written into the mix: A1 track volume',
		);
		const len = screen.getByTestId('essential-stop-seconds');
		fireEvent.focus(len);
		fireEvent.change(len, { target: { value: '0' } });
		fireEvent.blur(len);
		expect(screen.getByTestId('essential-stop-error').textContent).toBe(
			'Length must be more than 0 and at most 10 s',
		);
		expect(len.getAttribute('aria-invalid')).toBe('true');
		expect(cuesOf(f.seq())[0]!.stopBefore!.seconds).toBe(0.25);
		fireEvent.focus(len);
		fireEvent.change(len, { target: { value: '0,5' } });
		fireEvent.blur(len);
		expect(cuesOf(f.seq())[0]!.stopBefore).toEqual({ seconds: 0.5, depthDb: -24 });
		expect(screen.queryByTestId('essential-stop-error')).toBeNull();
		const rec = readSoundDesignMix(f.seq().soundDesign?.mix)!.cues![f.cueId]!.stopBefore!;
		expect(rec.seconds).toBe(0.5);
		// build: a falling sweep is refused, a rising one is written
		const build = screen.getByTestId('essential-build');
		await act(async () => {
			fireEvent.click(within(build).getByRole('checkbox'));
		});
		expect(cuesOf(f.seq())[0]!.build).toEqual({ seconds: 2, fromHz: 150, toHz: 2000 });
		const from = screen.getByTestId('essential-build-from');
		fireEvent.focus(from);
		fireEvent.change(from, { target: { value: '3000' } });
		fireEvent.blur(from);
		expect(screen.getByTestId('essential-build-error').textContent).toBe(
			'A build rises: To must be above From',
		);
		expect(cuesOf(f.seq())[0]!.build!.fromHz).toBe(150);
		const to = screen.getByTestId('essential-build-to');
		fireEvent.focus(to);
		fireEvent.change(to, { target: { value: '4000' } });
		fireEvent.blur(to);
		expect(cuesOf(f.seq())[0]!.build).toEqual({ seconds: 2, fromHz: 150, toHz: 4000 });
		expect(screen.getByTestId('essential-build-status').textContent).toContain('A1 track filter');
	});

	it('a sound that fills no cue: disabled with the reason', () => {
		const f = fixture();
		f.ok([
			{ type: 'soundDesign.place', frame: 400, layers: [{ mediaId: f.hit, track: 'A3', align: 'start' }] },
		]);
		const other = Object.values(f.seq().clips).find((c) => c.start >= 390 && c.kind === 'audio') as AudioClip;
		render(
			<SessionProvider session={f.session}>
				<ShellRuntimeProvider session={f.session}>
					<EssentialSfxSection session={f.session} seq={f.seq()} clips={[other]} />
				</ShellRuntimeProvider>
			</SessionProvider>,
		);
		expect(screen.getAllByTestId('essential-no-cue')[0]!.textContent).toBe(
			'This sound fills no cue: stop-before and build belong to a cue (fill a cue or add one)',
		);
	});
});

describe('Properties ▸ Cue and the Cue Seam', () => {
	it('an unfilled cue’s stop-before is stored (dashed); Write Now writes it (solid)', async () => {
		const f = fixture();
		f.ok([{ type: 'soundCue.update', cueId: f.cue2, stopBefore: { seconds: 0.5, depthDb: -18 } }]);
		f.session.select('cues', [f.cue2], 'replace');
		const ui = createTimelineUiStore();
		const layout = computeLayout({
			height: 400,
			dividerRatio: 0.5,
			videoTracks: f.seq().videoTracks,
			audioTracks: f.seq().audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
			dividerPx: SEAM_PX,
		});
		const view = () => (
			<SessionProvider session={f.session}>
				<CueProperties session={f.session} sequenceId={f.seqId} />
				<CueSeam
					session={f.session}
					seq={f.seq()}
					layout={layout}
					viewport={{ scrollFrame: 0, pxPerFrame: 2, width: 1000 }}
					media={{}}
					ui={ui}
					instanceId="t1"
					snapping={false}
					run={() => {}}
					openMenu={() => {}}
					toast={() => {}}
					reveal={() => {}}
				/>
			</SessionProvider>
		);
		const r = render(view());
		f.session.store.subscribe(() => r.rerender(view()));
		const stopBar = () => document.querySelector(`[data-cue-stop="${f.cue2}"]`)!;
		expect(stopBar().getAttribute('data-written')).toBe('false');
		expect(screen.getByTestId('cue-section-stop-before-status').textContent).toContain(
			'Stored on the cue: Written into the mix when the cue is filled',
		);
		expect((screen.getByTestId('cue-section-stop-before-depth') as HTMLInputElement).value).toBe('-18');
		await act(async () => {
			fireEvent.click(screen.getByTestId('cue-section-stop-before-status-write'));
		});
		expect(f.labels().at(-1)).toBe('Stop Before Cue');
		expect(stopBar().getAttribute('data-written')).toBe('true');
		expect(screen.getByTestId('cue-section-stop-before-status').textContent).toContain(
			'Written into the mix: A1 track volume',
		);
		// depth edit through Properties (validated, then written again at the new depth)
		const depth = screen.getByTestId('cue-section-stop-before-depth');
		fireEvent.focus(depth);
		fireEvent.change(depth, { target: { value: '5' } });
		fireEvent.blur(depth);
		expect(screen.getByTestId('cue-section-stop-before-error').textContent).toBe(
			'Depth must be below 0 and at least −60 dB',
		);
		fireEvent.focus(depth);
		fireEvent.change(depth, { target: { value: '-30' } });
		fireEvent.blur(depth);
		expect(cuesOf(f.seq()).find((c) => c.id === f.cue2)!.stopBefore).toEqual({ seconds: 0.5, depthDb: -30 });
		expect(readSoundDesignMix(f.seq().soundDesign?.mix)!.cues![f.cue2]!.stopBefore!.depthDb).toBe(-30);
	});
});

describe('Sequence ▸ Sound Design: Rebalance, Room Glue…, Delivery Target…', () => {
	it('the menu lists them', () => {
		const seqMenu = MENUBAR.find((m) => m.label === 'Sequence')!;
		const sd = seqMenu.items.find((i) => i.type === 'submenu' && i.label === 'Sound Design') as {
			items: { command?: string }[];
		};
		const ids = sd.items.map((i) => i.command).filter(Boolean);
		expect(ids).toEqual(
			expect.arrayContaining(['sound.rebalanceSfx', 'sound.roomGlue', 'sound.deliveryTarget']),
		);
	});

	it('Rebalance SFX Levels (menu): every sound effect, progress, one entry, Undo', async () => {
		const f = fixture();
		const seen: string[] = [];
		f.engine.onRebalance((req) => {
			seen.push(JSON.stringify(req.clipIds ?? null));
			f.ok([{ type: 'soundDesign.applyGains', gains: { [f.clipId]: -9 } }], 'Rebalance SFX Levels');
			return {
				projectId: f.session.projectId,
				sequenceId: f.seqId,
				mode: 'apply',
				applied: true,
				revision: f.session.revision,
				proposalId: null,
				report: {
					version: 1,
					sequenceId: f.seqId,
					events: [],
					skipped: [{ clipId: 'clp_x', code: 'USER_GAIN', reason: 'set by hand' }],
					conflicts: [],
					warnings: [],
					counts: counts({ skipped: 1 }),
					levels,
				},
			};
		});
		const ctx = createCommandContext({
			engine: f.engine.client as never,
			session: f.session,
			capabilities: ['engine'],
		});
		await act(async () => {
			await runCommand('sound.rebalanceSfx', ctx);
		});
		expect(seen).toEqual(['null']);
		expect(f.engine.rebalances[0]).toMatchObject({ mode: 'apply', sequenceId: f.seqId });
		expect(f.clip().gainDb).toBe(-9);
		const t = toasts.getState().toasts.find((x) => x.title === 'Rebalanced 1 sound effect')!;
		expect(t.detail).toBe('1 solved · 1 limited · 1 kept (your gains)');
		act(() => t.actions![0]!.run!());
		expect(f.clip().gainDb).toBe(-6);
	});

	it('Room Glue…: shows which tracks send; Apply creates it with the settings; again off removes it', async () => {
		const f = fixture();
		const msgs: string[] = [];
		const closed: unknown[] = [];
		const mount = () =>
			render(
				<SessionProvider session={f.session}>
					<RoomGlueDialog
						session={f.session}
						sequenceId={f.seqId}
						close={(x) => closed.push(x)}
						toast={(r) => msgs.push(r.message)}
					/>
				</SessionProvider>,
			);
		mount();
		const dialog = await screen.findByTestId('room-glue-dialog');
		expect(screen.getByTestId('room-glue-tracks').textContent).toContain('Sends from: A2');
		fireEvent.click(
			within(dialog).getByRole('checkbox', { name: 'Glue the sound effects with a shared room' }),
		);
		const send = within(screen.getByTestId('room-glue-send')).getByRole('slider');
		await act(async () => {
			fireEvent.keyDown(send, { key: 'ArrowLeft' });
		});
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
		});
		expect(f.labels().at(-1)).toBe('SFX Room Glue');
		const glue = readSoundDesignMix(f.seq().soundDesign?.mix)!.room!;
		expect(glue).toMatchObject({ sendDb: -16.5, decay: 0.6, mix: 100, preDelayMs: 8 });
		expect(msgs.at(-1)).toBe('SFX Room on: 1 tracks send to it');
		cleanup();
		mount();
		const d2 = await screen.findByTestId('room-glue-dialog');
		expect(screen.getByTestId('room-glue-tracks').textContent).toContain(
			'Bus: SFX Room (made by sound design)',
		);
		fireEvent.click(within(d2).getByRole('checkbox', { name: 'Glue the sound effects with a shared room' }));
		await act(async () => {
			fireEvent.click(within(d2).getByRole('button', { name: 'Apply' }));
		});
		expect(f.labels().at(-1)).toBe('Remove SFX Room Glue');
		expect(f.seq().submixTracks ?? []).toEqual([]);
	});

	it('Delivery Target…: presets with numbers, Apply runs the job, shows what it measured, Undo', async () => {
		const f = fixture();
		f.engine.onDelivery((req) => {
			f.ok(
				[{ type: 'soundDesign.applyDelivery', delivery: req.delivery }],
				`Apply Delivery Preset: ${req.delivery}`,
			);
			return {
				projectId: f.session.projectId,
				sequenceId: f.seqId,
				mode: 'apply',
				applied: true,
				revision: f.session.revision,
				proposalId: null,
				report: {
					version: 1,
					sequenceId: f.seqId,
					delivery: req.delivery,
					preset: { label: 'Podcast (−16 LUFS)', integratedLufs: -16, truePeakDb: -1, source: 'AES TD1008' },
					hasDialogue: true,
					clips: [
						{ clipId: 'c', track: 'A1', type: 'music', measuredLufs: -20, targetLufs: -24, gainDb: -4 },
					],
					ducking: [{ clipIds: ['c'], triggers: ['d'], regions: 2 }],
					sfx: { solved: 1, changed: 1, limited: 0, skipped: 0 },
					measure: {
						mixLufs: -18.2,
						mixTruePeakDb: -3.1,
						expectedLufs: -16,
						expectedTruePeakDb: -1.5,
						speechSeconds: 4.3,
						musicUnderVoiceLu: 22.8,
						ambienceUnderVoiceLu: null,
					},
					warnings: [],
					ms: 100,
				},
			};
		});
		render(
			<SessionProvider session={f.session}>
				<DeliveryDialog
					session={f.session}
					engine={f.engine.client as never}
					sequenceId={f.seqId}
					close={() => {}}
				/>
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('delivery-dialog');
		expect(screen.getByTestId('delivery-numbers').textContent).toContain('−14.0 LUFS');
		const trigger = within(dialog).getByRole('combobox', { name: 'Preset' });
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		const opt = await screen.findByRole('option', { name: 'Podcast · −16 LUFS · −1 dBTP' });
		await act(async () => {
			fireEvent.keyDown(opt, { key: 'Enter' });
		});
		expect(screen.getByTestId('delivery-numbers').textContent).toContain('−16.0 LUFS');
		const n = f.labels().length;
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
		});
		await waitFor(() =>
			expect(screen.getByTestId('delivery-summary').textContent).toContain('Export: −16.0 LUFS, −1.5 dBTP'),
		);
		expect(f.engine.deliveries[0]).toMatchObject({
			delivery: 'podcast',
			mode: 'apply',
			loudness: true,
			autoMatch: true,
			ducking: true,
			rebalance: true,
		});
		const summary = screen.getByTestId('delivery-summary').textContent!;
		expect(summary).toContain('Music under the voice: 22.8 LU (at least 8)');
		expect(summary).toContain('Mix before normalisation: −18.2 LUFS, −3.1 dBTP');
		expect(f.labels().slice(n)).toEqual(['Apply Delivery Preset: podcast']);
		expect(
			within(dialog)
				.getAllByRole('button')
				.some((b) => b.textContent === 'Close'),
		).toBe(true);
		await settle();
		const title = 'Applied Podcast · −16 LUFS · −1 dBTP';
		expect(toastTitles()).toContain(title);
		act(() => toastAction(title, 'Undo')!.run!());
		expect(f.session.getState().history.index).toBe(n);
	});
});
