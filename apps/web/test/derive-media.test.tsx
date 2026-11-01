// spec 18 AF-OPS-002: Project panel ▸ Derive Media ▸ <op>… — menu entries, one dialog per op with validation and
// coded errors, and the job → one undoable media.derive.
import type { DeriveResult, EngineJob } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaAsset,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import '../src/commands/process.ts';
import { DeriveMediaDialog } from '../src/derive/DeriveMediaDialog.tsx';
import { defaultDeriveForm, recipeFromForm } from '../src/derive/model.ts';
import { deriveOpsFor } from '../src/derive/register.ts';
import type { MenuItemSpec } from '../src/extensions/index.ts';
import { projectItemMenuExtensions } from '../src/extensions/index.ts';

const KEY = 'mk_source_1';

function probe(opts: { video?: boolean; audio?: boolean; seconds?: number } = {}) {
	const streams: MediaAsset['probe']['streams'] = [];
	if (opts.video !== false)
		streams.push({
			index: 0,
			type: 'video',
			codec: 'h264',
			width: 640,
			height: 360,
			pixelAspect: { num: 1, den: 1 },
			frameRate: { num: 25, den: 1 },
			pixelFormat: 'yuv420p',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
			browserDecodable: true,
		});
	if (opts.audio !== false)
		streams.push({
			index: streams.length,
			type: 'audio',
			codec: 'aac',
			sampleRate: 48000,
			channels: 2,
			channelLayout: 'stereo',
		});
	return {
		durationFlicks: (opts.seconds ?? 6) * FLICKS_PER_SECOND,
		startTimecode: null,
		streams,
		rotationDegrees: 0 as const,
		hasAlpha: false,
		variableFrameRate: false,
	};
}

function makeSession(p = probe(), kind: 'video' | 'audio' = 'video') {
	const ids = createCounterIdSource(7);
	const document = createEmptyProject({ ids, name: 'Derive test', preset: 'hd-1080p-25' });
	const session = new EditorSession({
		projectId: 'prj_test',
		document,
		ctx: { ids, now: () => '2026-10-31T10:00:00.000Z', registries: defaultRegistries(mgRegistry) },
		coalesceWindowMs: 0,
	});
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: {
					kind,
					fingerprint: `q1:${'ab'.repeat(32)}`,
					originalName: 'take.mp4',
					sizeBytes: 1000,
					container: 'mov,mp4',
					probe: p,
					locators: [{ type: 'engine-store', engineId: 'local', key: KEY }],
				},
				ref: '$m',
				itemRef: '$i',
			},
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, mediaId: r.refs.$m!, itemId: r.refs.$i! };
}

const job = (state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob => ({
	id: 'job_d1',
	kind: 'derive',
	title: 'Derive',
	origin: { type: 'user' },
	state,
	progress: state === 'succeeded' ? 1 : 0.4,
	createdAt: '2026-10-31T10:00:00.000Z',
	priority: 'user',
	cpuSlots: 2,
	...extra,
});

function reversedResult(): DeriveResult {
	return {
		registered: {
			mediaKey: 'mk_rev_1',
			fingerprint: `q1:${'cd'.repeat(32)}`,
			kind: 'video',
			originalName: 'take [Reversed].mov',
			sizeBytes: 5000,
			container: 'mov,mp4,m4a,3gp,3g2,mj2',
			probe: probe(),
			locators: [{ type: 'path', path: '/tmp/take.reverse.mov', relativeToProject: null }],
			browserPlayable: 'no',
		} as DeriveResult['registered'],
		fromMediaKey: KEY,
		recipe: { op: 'reverse' },
		recipeVersion: 1,
		recipeHash: 'e'.repeat(64),
		reused: false,
		notes: ['reversed in 1 segment of ≤ 250 frames'],
	};
}

type Call = { method: string; url: string; body: unknown };
function fakeEngine(onDerive: () => Response, jobs: () => EngineJob) {
	const calls: Call[] = [];
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (url === `/api/media/${KEY}/derive`) return onDerive();
		if (url === '/api/jobs/job_d1') return json(jobs());
		if (url === '/api/jobs/job_d1/cancel') return json(job('cancelling'));
		return json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls, json };
}
const jsonResponse = (b: unknown, status = 200) =>
	new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });

afterEach(() => cleanup());

/** Types a value into a ScrubbyNumber (Enter to edit, type, Enter to commit). */
function typeInto(name: string, value: string) {
	fireEvent.keyDown(screen.getByRole('spinbutton', { name }), { key: 'Enter' });
	const input = screen.getByTestId('scrubby-input');
	fireEvent.change(input, { target: { value } });
	fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Derive Media menu (AF-OPS-002)', () => {
	it('lists every op for video media and the audio/timing ops for audio media', () => {
		const { session, itemId } = makeSession();
		const item = session.getCommitted().items[itemId]!;
		const ext = projectItemMenuExtensions.list().find((e) => e.id === 'derive')!;
		const out = ext.items({ session, items: [item], readOnly: false } as never) as MenuItemSpec[];
		expect(out).toHaveLength(1);
		const sub = out[0] as Extract<MenuItemSpec, { kind: 'submenu' }>;
		expect(sub.label).toBe('Derive Media');
		expect(sub.items.map((i) => (i as { label: string }).label)).toEqual([
			'Conform to Constant Frame Rate…',
			'Reverse…',
			'Denoise Audio…',
			'Extract Audio…',
			'Time Stretch…',
			'Subclip Range…',
		]);
		expect(deriveOpsFor({ kind: 'audio' })).toEqual([
			'reverse',
			'denoise-audio',
			'extract-audio',
			'time-stretch',
			'range',
		]);
		expect(deriveOpsFor({ kind: 'image' })).toEqual([]);
		const ro = ext.items({ session, items: [item], readOnly: true } as never) as MenuItemSpec[];
		expect(
			(ro[0] as Extract<MenuItemSpec, { kind: 'submenu' }>).items.every(
				(i) => (i as { disabled?: boolean }).disabled,
			),
		).toBe(true);
	});

	it('form defaults and recipes', () => {
		const f = defaultDeriveForm({ probe: probe() } as never, {
			in: { flicks: FLICKS_PER_SECOND },
			out: null,
		});
		expect(f.inSec).toBe(1);
		expect(f.outSec).toBe(6);
		expect(f.fps).toBe('25/1');
		expect(recipeFromForm('range', f)).toEqual({
			op: 'range',
			inFlicks: FLICKS_PER_SECOND,
			outFlicks: 6 * FLICKS_PER_SECOND,
		});
		expect(recipeFromForm('conform-cfr', { ...f, fps: '30000/1001' })).toEqual({
			op: 'conform-cfr',
			frameRate: { num: 30000, den: 1001 },
		});
	});
});

describe('Derive Media dialog (AF-OPS-002)', () => {
	it('shows a coded refusal for media without audio and keeps Derive disabled', () => {
		const { session, mediaId } = makeSession(probe({ audio: false }));
		const { client } = fakeEngine(
			() => jsonResponse(job('queued')),
			() => job('queued'),
		);
		render(
			<DeriveMediaDialog
				session={session}
				mediaId={mediaId}
				op="denoise-audio"
				engine={client}
				close={() => {}}
			/>,
		);
		expect(screen.getByTestId('derive-problems').textContent).toContain('NO_AUDIO');
		expect((screen.getByRole('button', { name: 'Derive' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('validates the range as it is edited (EMPTY_RANGE) and clears when valid', () => {
		const { session, mediaId } = makeSession();
		const { client } = fakeEngine(
			() => jsonResponse(job('queued')),
			() => job('queued'),
		);
		render(
			<DeriveMediaDialog session={session} mediaId={mediaId} op="range" engine={client} close={() => {}} />,
		);
		expect(screen.queryByTestId('derive-problems')).toBeNull();
		typeInto('In', '3');
		typeInto('Out', '2');
		expect(screen.getByTestId('derive-problems').textContent).toContain('EMPTY_RANGE');
		expect((screen.getByRole('button', { name: 'Derive' }) as HTMLButtonElement).disabled).toBe(true);
		typeInto('Out', '4');
		expect(screen.queryByTestId('derive-problems')).toBeNull();
		expect((screen.getByRole('button', { name: 'Derive' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('shows the engine refusal code in the dialog', async () => {
		const { session, mediaId } = makeSession();
		const { client } = fakeEngine(
			() =>
				jsonResponse(
					{
						code: 'OUT_OF_RANGE',
						message: 'The range 0.000 s–9.000 s is outside the media (6.000 s)',
						retryable: false,
					},
					422,
				),
			() => job('queued'),
		);
		render(
			<DeriveMediaDialog session={session} mediaId={mediaId} op="range" engine={client} close={() => {}} />,
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Derive' }));
		});
		await waitFor(() => expect(screen.getByTestId('derive-problems').textContent).toContain('OUT_OF_RANGE'));
		expect(screen.getByTestId('derive-problems').textContent).toContain('outside the media (6.000 s)');
		expect(Object.keys(session.getCommitted().media)).toHaveLength(1);
	});

	it('runs the job and commits ONE undoable media.derive', async () => {
		const { session, mediaId } = makeSession();
		let polls = 0;
		const { client, calls } = fakeEngine(
			() => jsonResponse(job('queued'), 202),
			() =>
				++polls < 2 ? job('running', { stage: 'Reversed' }) : job('succeeded', { result: reversedResult() }),
		);
		let closed: unknown = null;
		render(
			<DeriveMediaDialog
				session={session}
				mediaId={mediaId}
				op="reverse"
				engine={client}
				pollMs={5}
				close={(r) => {
					closed = r ?? 'cancel';
				}}
			/>,
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Derive' }));
		});
		await waitFor(() => expect(closed).not.toBeNull());
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body).toEqual({ projectId: 'prj_test', recipe: { op: 'reverse' } });
		const doc = session.getCommitted();
		const derived = Object.values(doc.media).find((m) => m.id !== mediaId)!;
		expect(derived.derivation).toMatchObject({
			fromMediaId: mediaId,
			recipe: { op: 'reverse' },
			recipeHash: 'e'.repeat(64),
		});
		expect(derived.locators[0]).toEqual({ type: 'engine-store', engineId: 'local', key: 'mk_rev_1' });
		const item = Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === derived.id)!;
		expect(item.name).toBe('take.mp4 [Reversed]');
		expect(session.undo().label).toBe('Derive Media');
		expect(session.getCommitted().media[derived.id]).toBeUndefined();
		session.redo();
		expect(session.getCommitted().media[derived.id]).toBeDefined();
	});

	it('a failed job shows its code in the dialog', async () => {
		const { session, mediaId } = makeSession();
		const { client } = fakeEngine(
			() => jsonResponse(job('queued'), 202),
			() =>
				job('failed', {
					error: { code: 'DERIVE_FAILED', message: 'ffmpeg exited 1: broken input', retryable: true },
				}),
		);
		render(
			<DeriveMediaDialog
				session={session}
				mediaId={mediaId}
				op="reverse"
				engine={client}
				pollMs={5}
				close={() => {}}
			/>,
		);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Derive' }));
		});
		await waitFor(() => expect(screen.getByTestId('derive-problems').textContent).toContain('DERIVE_FAILED'));
		expect(screen.getByTestId('derive-problems').textContent).toContain('broken input');
	});
});
