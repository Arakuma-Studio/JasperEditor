import { EngineClient } from '@jasper/engine-client';
import {
	type AnyMgTemplate,
	createMgRegistry,
	MG_CATALOG,
	type MgAnimeTemplateDefinition,
	titleReveal,
} from '@jasper/mg-templates';
import { type Clip, createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext, registerCommands, runCommand } from '../src/commands/index.ts';
import { mgCommands } from '../src/commands/mg.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { MgTemplateSection } from '../src/panels/motionTemplates/TemplateSection.tsx';

/** title-reveal@2 with an upgrade step from v1 (uppercases the title). */
const revealV2: MgAnimeTemplateDefinition = {
	...(titleReveal as MgAnimeTemplateDefinition),
	version: 2,
	name: 'Title Reveal 2',
	upgrades: [{ fromVersion: 1, migrate: (p) => ({ ...p, title: String(p.title).toUpperCase() }) }],
};

async function openSession(defs: readonly AnyMgTemplate[] = MG_CATALOG) {
	const ids = createCounterIdSource(9);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Anime', preset: 'hd-1080p-30' });
	store.put(doc);
	const session = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(createMgRegistry(defs)) },
	});
	const seqId = session.store.getState().activeSequenceId!;
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 90,
				track: 'V2',
				template: { id: 'title-reveal', version: 1 },
				params: { title: 'Hello' },
				ref: '$a',
			},
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 90,
				track: 'V1',
				template: { id: 'lower-third', version: 1 },
				ref: '$f',
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, seqId, anime: r.refs.$a!, fframes: r.refs.$f! };
}

const clipOf = (s: EditorSession, seqId: string, id: string) =>
	s.store.getState().document.sequences[seqId]!.clips[id] as Extract<Clip, { kind: 'motion-graphic' }>;

const engine = () =>
	new EngineClient({
		fetch: (async () => new Response('{}', { status: 501, headers: { 'x-jasper-api': '1' } })) as never,
	});

let unregister: (() => void) | undefined;

afterEach(() => {
	unregister?.();
	vi.useRealTimers();
});

describe('fframes-only actions are hidden for anime templates (S11:ATP-008)', () => {
	it('mg.rerender is disabled with only anime clips selected; anime clips have no jasper-mg spec', async () => {
		unregister = registerCommands(mgCommands);
		const { session, anime } = await openSession();
		const ctx = createCommandContext({ engine: engine(), session, capabilities: ['fframes'] });
		session.select('timeline', [anime], 'replace');
		expect((await runCommand('mg.rerender', ctx)).reason).toBe('disabled');
		await session.close();
	});
});

describe('template upgrades (S11:ATP-009)', () => {
	it('mg.updateTemplate upgrades the selected clips in one undo step', async () => {
		unregister = registerCommands(mgCommands);
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const toasts: string[] = [];
		const ctx = createCommandContext({ engine: engine(), session, toast: (t) => toasts.push(t.message) });
		session.select('timeline', [fframes], 'replace');
		// Enabled whatever the selection (agents pass clipIds); without an upgradable selection it only explains.
		expect(await runCommand('mg.updateTemplate', ctx)).toEqual({ ran: true });
		expect(clipOf(session, seqId, anime).template.version).toBe(1);
		session.select('timeline', [anime, fframes], 'replace');
		expect(await runCommand('mg.updateTemplate', ctx)).toEqual({ ran: true });
		expect(clipOf(session, seqId, anime).template).toEqual({
			id: 'title-reveal',
			version: 2,
			renderer: 'anime',
		});
		expect(clipOf(session, seqId, anime).params.title).toBe('HELLO');
		expect(session.undo().ok).toBe(true);
		expect(clipOf(session, seqId, anime).template.version).toBe(1);
		expect(clipOf(session, seqId, anime).params.title).toBe('Hello');
		await session.close();
	});

	it('mg.updateTemplate honours its clipIds arg without a selection (review fix)', async () => {
		unregister = registerCommands(mgCommands);
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const ctx = createCommandContext({ engine: engine(), session, toast: () => {} });
		session.select('timeline', [], 'replace');
		expect(await runCommand('mg.updateTemplate', ctx, { clipIds: [anime] })).toEqual({ ran: true });
		expect(clipOf(session, seqId, anime).template.version).toBe(2);
		expect(await runCommand('mg.updateTemplate', ctx, { clipIds: [fframes] })).toMatchObject({
			ran: false,
			reason: 'error',
		});
		await session.close();
	});
});

describe('Properties ▸ Template section', () => {
	it('mixed selections offer Re-render when any clip is fframes, in either order (review fix)', async () => {
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const view = (ids: string[]) =>
			render(
				<MgTemplateSection
					session={session}
					clips={ids.map((id) => clipOf(session, seqId, id))}
					frame={0}
					sequenceId={seqId}
				/>,
			);
		const m = view([anime, fframes]);
		expect(m.queryByTestId('mg-template-rerender')).not.toBeNull();
		m.unmount();
		const r = view([fframes, anime]);
		expect(r.queryByTestId('mg-template-rerender')).not.toBeNull();
		r.unmount();
		const add = session.apply({
			label: 'add',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 100,
					duration: 60,
					track: 'V2',
					template: { id: 'counter', version: 1 },
					ref: '$c',
				},
			] as never,
		});
		if (!add.ok) throw new Error(JSON.stringify(add.errors));
		const a = view([anime, add.refs.$c!]);
		expect(a.queryByTestId('mg-template-rerender')).toBeNull();
		a.unmount();
		await session.close();
	});
});

describe('Effect Controls stopwatches on anime template params (S11:ATP-006, S05:ECP-008)', () => {
	it('numeric and colour params have stopwatches; toggling one keys the param; fframes params stay static', async () => {
		const { session, seqId, anime, fframes } = await openSession();
		act(() => {
			session.select('timeline', [anime], 'replace');
			session.transport.seek(20);
		});
		const view = render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="anime-ec" visible />
			</SessionProvider>,
		);
		expect(view.getByTestId('stopwatch-params.y')).toBeTruthy();
		expect(view.queryByTestId('stopwatch-params.title')).toBeNull();
		act(() => fireEvent.click(view.getByTestId('stopwatch-params.titleColor')));
		expect(clipOf(session, seqId, anime).paramKeyframes?.titleColor).toHaveLength(1);
		act(() => session.select('timeline', [fframes], 'replace'));
		expect(view.queryByTestId('stopwatch-params.titleColor')).toBeNull();
		await session.close();
	});
});
