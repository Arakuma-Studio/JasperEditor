import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import { createEmptyProject, createSeededIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createCommandContext,
	registerCommands,
	resetCommandRegistry,
	runCommand,
} from '../src/commands/index.ts';
import { mgCommands, mgSpecForClip } from '../src/commands/mg.ts';
import motionTemplatesPanel from '../src/panels/motionTemplates/index.ts';
import {
	MG_TEMPLATE_MIME,
	planMotionTemplateInsert,
	readMgTemplateDrag,
	targetVideoTrack,
	writeMgTemplateDrag,
} from '../src/panels/motionTemplates/insert.ts';
import {
	filterEntries,
	galleryEntries,
	MotionTemplatesPanel,
	previewSvg,
} from '../src/panels/motionTemplates/MotionTemplatesPanel.tsx';
import { getPanelDefinition } from '../src/panels/registry.ts';
import { EngineProvider } from '../src/state/engine.tsx';

function fakeEngine(onRender?: (body: unknown) => void) {
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		if (url === '/api/motion-graphics/templates')
			return json({
				templates: mgRegistry.catalogJson().map((t) => ({ ...t, native: true })),
				renderer: { status: 'ready', version: '0.1.0' },
			});
		if (url === '/api/motion-graphics/render') {
			onRender?.(JSON.parse(String(init?.body)));
			return json(
				{
					id: 'job_1',
					kind: 'mg-render',
					title: 'mg',
					origin: { type: 'user' },
					state: 'queued',
					progress: 0,
					createdAt: 't',
					priority: 'interactive',
					cpuSlots: 4,
				},
				202,
			);
		}
		return json({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }, 501);
	}) as unknown as typeof fetch;
	return new EngineClient({ fetch: fetchImpl });
}

async function openSession() {
	const ids = createSeededIdSource(7);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'MG', preset: 'hd-1080p-25' });
	store.put(doc);
	return EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(mgRegistry) },
	});
}

afterEach(() => resetCommandRegistry());

describe('Motion Templates gallery model', () => {
	it('lists the fframes templates with native flags, durations and aspects', () => {
		const offline = galleryEntries(null);
		expect(offline.map((e) => [e.ref.id, e.native, e.durationSeconds])).toEqual([
			['lower-third', false, 5],
			['title-card', false, 4],
		]);
		expect(offline[0]!.aspects).toEqual(['16:9', '9:16', '1:1']);
		const online = galleryEntries(mgRegistry.catalogJson().map((t) => ({ ...t, native: true })));
		expect(online.every((e) => e.native)).toBe(true);
		expect(
			filterEntries(online, { query: 'lower', category: null, engine: 'all' }).map((e) => e.ref.id),
		).toEqual(['lower-third']);
		expect(filterEntries(online, { query: '', category: 'Titles', engine: 'all' })).toHaveLength(1);
		expect(filterEntries(online, { query: '', category: null, engine: 'remotion' })).toEqual([]);
		expect(previewSvg(online[0]!.def)).toContain('<svg');
	});

	it('plans inserts at the playhead on the topmost targeted unlocked video track', () => {
		const ids = createSeededIdSource(3);
		const doc = createEmptyProject({ ids, name: 'p', preset: 'hd-1080p-25' });
		const seq = Object.values(doc.sequences)[0]!;
		const [v1, v2, v3] = seq.videoTracks.map((t) => t.id);
		expect(targetVideoTrack(seq, { targeting: { video: [v1!, v2!], audio: [] } })).toBe(v2);
		expect(targetVideoTrack(seq, null)).toBe(v3);
		const plan = planMotionTemplateInsert(
			doc,
			seq.id,
			{ id: 'title-card', version: 1 },
			{
				at: 40,
				view: { targeting: { video: [v1!], audio: [] } },
			},
		);
		expect(plan.command).toMatchObject({
			type: 'clip.addMotionGraphic',
			at: 40,
			duration: 100, // 4 s at 25 fps
			track: v1,
			template: { id: 'title-card', version: 1 },
		});
		expect(() =>
			planMotionTemplateInsert(doc, seq.id, { id: 'nope', version: 1 }, { at: 0, view: null }),
		).toThrow();
	});

	it('round-trips the drag payload', () => {
		const data = new Map<string, string>();
		const dt = {
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeMgTemplateDrag(dt, { id: 'lower-third', version: 1 });
		expect(data.has(MG_TEMPLATE_MIME)).toBe(true);
		expect(readMgTemplateDrag(dt)?.template).toEqual({ id: 'lower-third', version: 1 });
		expect(readMgTemplateDrag({ getData: () => 'garbage' })).toBeNull();
	});
});

describe('Motion Templates panel', () => {
	it('is registered with the Motion Templates title', () => {
		expect(getPanelDefinition('motionTemplates')).toBe(motionTemplatesPanel);
		expect(motionTemplatesPanel.title({})).toBe('Motion Templates');
	});

	it('shows the gallery with static previews and inserts on double-click via clip.addMotionGraphic', async () => {
		const session = await openSession();
		session.transport.seek(12);
		render(
			<EngineProvider client={fakeEngine()} connectEvents={false}>
				<SessionProvider session={session}>
					<MotionTemplatesPanel instanceId="mgt-1" visible />
				</SessionProvider>
			</EngineProvider>,
		);
		const cards = await screen.findAllByRole('listitem');
		expect(cards).toHaveLength(2);
		expect(cards[0]!.querySelector('[data-mg-preview] svg')).not.toBeNull();
		await waitFor(() =>
			expect(document.querySelector('[data-mg-renderer]')?.getAttribute('data-mg-renderer')).toBe('ready'),
		);
		fireEvent.doubleClick(cards[0]!);
		const doc = session.getCommitted();
		const seq = Object.values(doc.sequences)[0]!;
		const clips = Object.values(seq.clips).filter((c) => c.kind === 'motion-graphic');
		expect(clips).toHaveLength(1);
		expect(clips[0]).toMatchObject({ start: 12, duration: 125, template: { id: 'lower-third', version: 1 } });
		expect(session.store.getState().selection.timeline.clips).toEqual([clips[0]!.id]);
		// search filters the grid
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'card' } });
		expect(screen.getAllByRole('listitem')).toHaveLength(1);
		await session.close();
	});

	it('renders without an open project and explains why inserting is disabled', async () => {
		render(
			<EngineProvider client={fakeEngine()} connectEvents={false}>
				<MotionTemplatesPanel instanceId="mgt-2" visible />
			</EngineProvider>,
		);
		expect(await screen.findByText('Open a sequence to insert templates')).toBeTruthy();
	});
});

describe('mg commands', () => {
	it('mg.insert adds a template at the playhead; mg.rerender sends the clip spec to the engine', async () => {
		registerCommands(mgCommands);
		const session = await openSession();
		const rendered = vi.fn();
		const ctx = createCommandContext({ engine: fakeEngine(rendered), session, capabilities: ['fframes'] });
		session.transport.seek(5);
		expect(await runCommand('mg.insert', ctx, { templateId: 'title-card' })).toEqual({ ran: true });
		const state = session.store.getState();
		const seqId = state.activeSequenceId!;
		const clipId = state.selection.timeline.clips[0]!;
		expect(state.document.sequences[seqId]!.clips[clipId]).toMatchObject({
			kind: 'motion-graphic',
			start: 5,
		});
		const spec = mgSpecForClip(state.document, seqId, clipId)!;
		expect(spec).toMatchObject({
			template: { id: 'title-card', version: 1 },
			width: 1920,
			height: 1080,
			fps: { num: 25, den: 1 },
			durationFrames: 100,
			sourceInFrames: 0,
		});
		expect(await runCommand('mg.rerender', ctx)).toEqual({ ran: true });
		expect(rendered).toHaveBeenCalledWith({ spec, quality: 'preview' });
		const noFframes = createCommandContext({ engine: fakeEngine(), session });
		expect((await runCommand('mg.rerender', noFframes)).reason).toBe('disabled');
		expect((await runCommand('mg.insert', ctx, { templateId: 'nope' })).reason).toBe('error');
		await session.close();
	});
});
