// Anime templates in the web app (wp-m2-anime-templates): fframes-only actions are hidden for anime templates
// (S11:ATP-008), "Update template to vN" (ATP-009, one undo step), the Properties ▸ Template section and the hover
// preview of fframes cards (ATP-007).
import { EngineClient } from '@jasper/engine-client';
import {
	type AnyMgTemplate,
	createMgRegistry,
	MG_CATALOG,
	type MgAnimeTemplateDefinition,
	titleReveal,
} from '@jasper/mg-templates';
import { type Clip, createEmptyProject, createSeededIdSource, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createCommandContext,
	registerCommands,
	resetCommandRegistry,
	runCommand,
} from '../src/commands/index.ts';
import { mgCommands, mgSpecForClip, templateUpgradeFor, updateTemplates } from '../src/commands/mg.ts';
import { clipSections } from '../src/extensions/index.ts';
import { buildGroups } from '../src/panels/effectControls/items.ts';
import { HOVER_PREVIEW_DELAY_MS, PreviewThumb } from '../src/panels/motionTemplates/PreviewThumb.tsx';
import { MgTemplateSection, templateEngineLabel } from '../src/panels/motionTemplates/TemplateSection.tsx';
import { planStopwatch } from '../src/panels/properties/lib/model.ts';

/** title-reveal@2 with an upgrade step from v1 (uppercases the title). */
const revealV2: MgAnimeTemplateDefinition = {
	...(titleReveal as MgAnimeTemplateDefinition),
	version: 2,
	name: 'Title Reveal 2',
	upgrades: [{ fromVersion: 1, migrate: (p) => ({ ...p, title: String(p.title).toUpperCase() }) }],
};

async function openSession(defs: readonly AnyMgTemplate[] = MG_CATALOG) {
	const ids = createSeededIdSource(9);
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

afterEach(() => {
	resetCommandRegistry();
	vi.useRealTimers();
});

describe('fframes-only actions are hidden for anime templates (S11:ATP-008)', () => {
	it('mg.rerender is disabled with only anime clips selected; anime clips have no jasper-mg spec', async () => {
		registerCommands(mgCommands);
		const { session, seqId, anime, fframes } = await openSession();
		const ctx = createCommandContext({ engine: engine(), session, capabilities: ['fframes'] });
		session.select('timeline', [anime], 'replace');
		expect((await runCommand('mg.rerender', ctx)).reason).toBe('disabled');
		expect(mgSpecForClip(session.getCommitted(), seqId, anime)).toBeNull();
		expect(mgSpecForClip(session.getCommitted(), seqId, fframes)).not.toBeNull();
		await session.close();
	});
});

describe('template upgrades (S11:ATP-009)', () => {
	it('mg.updateTemplate upgrades the selected clips in one undo step', async () => {
		registerCommands(mgCommands);
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const reg = session.ctx.registries.mgTemplates;
		expect(templateUpgradeFor(reg, clipOf(session, seqId, anime))).toBe(2);
		expect(templateUpgradeFor(reg, clipOf(session, seqId, fframes))).toBeNull();
		const toasts: string[] = [];
		const ctx = createCommandContext({ engine: engine(), session, toast: (t) => toasts.push(t.message) });
		session.select('timeline', [fframes], 'replace');
		// Enabled whatever the selection (agents pass clipIds); without an upgradable selection it only explains.
		expect(await runCommand('mg.updateTemplate', ctx)).toEqual({ ran: true });
		expect(toasts.at(-1)).toMatch(/template has an update/);
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
		expect(updateTemplates(session, [fframes])).toEqual({
			ok: false,
			message: 'No template update is available',
		});
		await session.close();
	});

	it('mg.updateTemplate honours its clipIds arg without a selection (review fix)', async () => {
		registerCommands(mgCommands);
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const ctx = createCommandContext({ engine: engine(), session, toast: () => {} });
		session.select('timeline', [], 'replace');
		expect(await runCommand('mg.updateTemplate', ctx, { clipIds: [anime] })).toEqual({ ran: true });
		expect(clipOf(session, seqId, anime).template.version).toBe(2);
		// clipIds without an upgrade: the command fails with the reason
		expect(await runCommand('mg.updateTemplate', ctx, { clipIds: [fframes] })).toMatchObject({
			ran: false,
			reason: 'error',
		});
		await session.close();
	});
});

describe('Properties ▸ Template section', () => {
	it('is registered for motion-graphic clips', () => {
		const def = clipSections.list().find((s) => s.id === 'mg-template')!;
		expect(def.component).toBe(MgTemplateSection);
		expect(def.appliesTo([{ kind: 'motion-graphic' } as Clip])).toBe(true);
		expect(def.appliesTo([{ kind: 'text' } as Clip])).toBe(false);
	});

	it('shows the engine, offers "Update template to vN" and hides Re-render for anime templates', async () => {
		const { session, seqId, anime, fframes } = await openSession([...MG_CATALOG, revealV2]);
		const view = (id: string) =>
			render(
				<MgTemplateSection
					session={session}
					clips={[clipOf(session, seqId, id)]}
					frame={0}
					sequenceId={seqId}
				/>,
			);
		const a = view(anime);
		expect(a.getByTestId('mg-template-engine').textContent).toContain('anime · Remotion');
		expect(a.queryByTestId('mg-template-rerender')).toBeNull();
		const button = a.getByTestId('mg-template-update');
		expect(button.textContent).toBe('Update template to v2');
		fireEvent.click(button);
		expect(clipOf(session, seqId, anime).template.version).toBe(2);
		a.unmount();
		const f = view(fframes);
		expect(f.getByTestId('mg-template-engine').textContent).toContain('fframes');
		expect(f.queryByTestId('mg-template-rerender')).not.toBeNull();
		expect(f.queryByTestId('mg-template-update')).toBeNull();
		f.unmount();
		const unknown = { ...clipOf(session, seqId, anime), template: { id: 'gone', version: 3 } };
		expect(templateEngineLabel(session.ctx.registries.mgTemplates, unknown)).toBe('not installed');
		const u = render(<MgTemplateSection session={session} clips={[unknown]} frame={0} sequenceId={seqId} />);
		expect(u.container.textContent).toContain('is not installed');
		u.unmount();
		await session.close();
	});

	it('mixed selections: every engine is listed and Re-render shows when any clip is fframes (review fix)', async () => {
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
		// anime first: Re-render is still offered for the fframes clip; the anime clip's update too
		const m = view([anime, fframes]);
		expect(m.container.textContent).toContain('Different templates selected.');
		expect(m.getByTestId('mg-template-engine').textContent).toBe('anime · Remotion / fframes');
		expect(m.queryByTestId('mg-template-rerender')).not.toBeNull();
		expect(m.getByTestId('mg-template-update').textContent).toBe('Update template to v2');
		m.unmount();
		// fframes first: no Re-render-only bias either way
		const r = view([fframes, anime]);
		expect(r.queryByTestId('mg-template-rerender')).not.toBeNull();
		expect(r.getByTestId('mg-template-update').textContent).toBe('Update template to v2');
		r.unmount();
		// two anime clips of different templates: no Re-render
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
		expect(a.getByTestId('mg-template-engine').textContent).toBe('anime · Remotion');
		expect(a.queryByTestId('mg-template-rerender')).toBeNull();
		a.unmount();
		await session.close();
	});
});

describe('fframes cards keep their SVG poster and gain the hover preview (S11:ATP-007)', () => {
	it('custom poster, then the shared Player after the hover delay', () => {
		vi.useFakeTimers();
		vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const Probe = () => <span data-probe="" />;
		render(
			<PreviewThumb
				component={Probe}
				inputProps={{}}
				durationInFrames={30}
				fps={30}
				width={640}
				height={360}
				posterFrame={0}
				label="Lower Third preview"
				poster={<svg data-twin-poster="" />}
			/>,
		);
		const thumb = screen.getByLabelText('Lower Third preview');
		expect(thumb.getAttribute('data-preview-thumb')).toBe('poster');
		expect(thumb.querySelector('[data-twin-poster]')).not.toBeNull();
		fireEvent.pointerEnter(thumb, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS + 10);
		});
		expect(thumb.getAttribute('data-preview-thumb')).toBe('playing');
		expect(thumb.querySelector('[data-twin-poster]')).toBeNull();
		vi.unstubAllGlobals();
	});
});

describe('Effect Controls stopwatches on anime template params (S11:ATP-006, S05:ECP-008)', () => {
	it('numeric and colour params have stopwatches; toggling one keys the param; fframes params stay static', async () => {
		const { session, seqId, anime, fframes } = await openSession();
		const state = () => session.store.getState();
		const templateRows = (clipId: string) =>
			buildGroups(
				state().document,
				state().document.sequences[seqId]!,
				[clipOf(session, seqId, clipId)],
				20,
				session.ctx.registries,
			)
				.flatMap((g) => g.sections)
				.find((s) => s.id === `${clipId}:template`)!.rows;
		const color = templateRows(anime).find((r) => r.id === 'params.titleColor')!;
		expect(color.spec.animatable).toBe('continuous');
		expect(templateRows(anime).find((r) => r.id === 'params.title')!.spec.animatable).toBe('no');
		expect(templateRows(fframes).every((r) => r.spec.animatable === 'no')).toBe(true);
		const plan = planStopwatch(color, 20, true);
		expect(plan.commands).toEqual([
			{
				type: 'param.setAnimated',
				target: ['clip', anime, 'params', 'titleColor'],
				animated: true,
				at: { sequenceFrame: 20 },
			},
		]);
		const r = session.apply({ label: 'kf', origin: 'user', sequenceId: seqId, commands: plan.commands });
		expect(r.ok).toBe(true);
		const after = templateRows(anime).find((x) => x.id === 'params.titleColor')!;
		expect(after.bindings[0]!.resolved.animated).toBe(true);
		expect(clipOf(session, seqId, anime).paramKeyframes?.titleColor).toHaveLength(1);
		await session.close();
	});
});
