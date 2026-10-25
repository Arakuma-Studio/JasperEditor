import { EngineClient } from '@jasper/engine-client';
import { mgRegistry } from '@jasper/mg-templates';
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext, registerCommands, runCommand } from '../src/commands/index.ts';
import { mgCommands } from '../src/commands/mg.ts';
import {
	MG_TEMPLATE_MIME,
	readMgTemplateDrag,
	writeMgTemplateDrag,
} from '../src/panels/motionTemplates/insert.ts';
import { MotionTemplatesPanel } from '../src/panels/motionTemplates/MotionTemplatesPanel.tsx';
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
	const ids = createCounterIdSource(7);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'MG', preset: 'hd-1080p-25' });
	store.put(doc);
	return EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(mgRegistry) },
	});
}

let unregister: (() => void) | undefined;

afterEach(() => unregister?.());

describe('Motion Templates gallery model', () => {
	it('round-trips the drag payload', () => {
		const data = new Map<string, string>();
		const dt = {
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeMgTemplateDrag(dt, { id: 'lower-third', version: 1 });
		expect(MG_TEMPLATE_MIME).toBe('application/x-jasper-mg-template');
		expect(data.get('application/x-jasper-mg-template')).toBe(
			'{"type":"jasper/mg-template","template":{"id":"lower-third","version":1}}',
		);
		expect(
			readMgTemplateDrag({
				getData: () => '{"type":"jasper/mg-template","template":{"id":"lower-third","version":1}}',
			})?.template,
		).toEqual({ id: 'lower-third', version: 1 });
		expect(readMgTemplateDrag({ getData: () => 'garbage' })).toBeNull();
	});
});

describe('Motion Templates panel', () => {
	it('shows the gallery with static previews and inserts on double-click via clip.addMotionGraphic', async () => {
		const session = await openSession();
		session.transport.seek(12);
		render(
			<EngineProvider client={fakeEngine()}>
				<SessionProvider session={session}>
					<MotionTemplatesPanel instanceId="mgt-1" visible />
				</SessionProvider>
			</EngineProvider>,
		);
		const lowerThird = await screen.findByRole('listitem', { name: 'Lower Third (Lower Thirds)' });
		fireEvent.doubleClick(lowerThird);
		const doc = session.getCommitted();
		const seq = Object.values(doc.sequences)[0]!;
		const clips = Object.values(seq.clips).filter((c) => c.kind === 'motion-graphic');
		expect(clips).toHaveLength(1);
		expect(clips[0]).toMatchObject({ start: 12, duration: 125, template: { id: 'lower-third', version: 1 } });
		expect(session.store.getState().selection.timeline.clips).toEqual([clips[0]!.id]);
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'card' } });
		expect(screen.getByRole('listitem', { name: 'Title Card (Titles)' })).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: '' } });
		fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'anime' } });
		fireEvent.keyDown(screen.getByRole('listitem', { name: 'Subscribers · Counter (Counters)' }), {
			key: 'Enter',
		});
		const after = Object.values(Object.values(session.getCommitted().sequences)[0]!.clips).filter(
			(c) => c.kind === 'motion-graphic',
		);
		expect(after.find((c) => c.kind === 'motion-graphic' && c.template.id === 'counter')).toMatchObject({
			template: { id: 'counter', version: 1, renderer: 'anime' },
			duration: 125,
		});
		await session.close();
	});
});

describe('mg commands', () => {
	it('mg.rerender sends the selected clip spec to the engine when fframes is available', async () => {
		unregister = registerCommands(mgCommands);
		const session = await openSession();
		const rendered = vi.fn();
		const ctx = createCommandContext({ engine: fakeEngine(rendered), session, capabilities: ['fframes'] });
		session.transport.seek(5);
		await runCommand('mg.insert', ctx, { templateId: 'title-card' });
		expect(await runCommand('mg.rerender', ctx)).toEqual({ ran: true });
		expect(rendered).toHaveBeenCalledWith({
			spec: expect.objectContaining({
				template: { id: 'title-card', version: 1 },
				width: 1920,
				height: 1080,
				fps: { num: 25, den: 1 },
				durationFrames: 100,
			}),
			quality: 'preview',
		});
		const noFframes = createCommandContext({ engine: fakeEngine(), session });
		expect((await runCommand('mg.rerender', noFframes)).reason).toBe('disabled');
		await session.close();
	});
});
