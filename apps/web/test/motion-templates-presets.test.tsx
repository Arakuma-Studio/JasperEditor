// C3: the Motion Templates gallery shows one card per template preset (poster, hover preview, search, category,
// insert and drag apply the preset's params); templates without presets keep their single card.
import { EngineClient } from '@jasper/engine-client';
import { counter, mgRegistry } from '@jasper/mg-templates';
import { type Clip, createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext, registerCommands, runCommand } from '../src/commands/index.ts';
import { mgCommands } from '../src/commands/mg.ts';
import {
	insertMotionTemplate,
	readMgTemplateDrag,
	writeMgTemplateDrag,
} from '../src/panels/motionTemplates/insert.ts';
import { MotionTemplatesPanel } from '../src/panels/motionTemplates/MotionTemplatesPanel.tsx';
import { EngineProvider } from '../src/state/engine.tsx';

/** The poster / hover preview props of every card (the Remotion player itself is not under test here). */
const previews: { label?: string; inputProps: Record<string, unknown> }[] = [];
vi.mock('../src/panels/motionTemplates/PreviewThumb.tsx', () => ({
	PreviewThumb: (p: { label?: string; inputProps: Record<string, unknown> }) => {
		previews.push({ label: p.label, inputProps: p.inputProps });
		return <div data-testid="preview-thumb" />;
	},
}));

/** The engine's font catalogue (`GET /api/fonts`) a test serves; null: the route answers 501 like every other. */
let fontCatalog: unknown = null;
const engine = () =>
	new EngineClient({
		fetch: (async (input: RequestInfo | URL) =>
			fontCatalog && String(input).includes('/api/fonts')
				? new Response(JSON.stringify(fontCatalog), {
						status: 200,
						headers: { 'content-type': 'application/json', 'x-jasper-api': '1' },
					})
				: new Response(JSON.stringify({ code: 'NOT_IMPLEMENTED', message: 'later', retryable: false }), {
						status: 501,
						headers: { 'x-jasper-api': '1' },
					})) as unknown as typeof fetch,
	});

async function openSession() {
	const ids = createCounterIdSource(7);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Presets', preset: 'hd-1080p-25' });
	store.put(doc);
	return EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(mgRegistry) },
	});
}

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;
const mgClips = (s: EditorSession) =>
	Object.values(Object.values(s.getCommitted().sequences)[0]!.clips).filter(
		(c): c is MgClip => c.kind === 'motion-graphic',
	);

let unregister: (() => void) | undefined;
afterEach(() => {
	unregister?.();
	unregister = undefined;
	previews.length = 0;
	fontCatalog = null;
	cleanup();
});

function gallery(session: EditorSession) {
	return render(
		<EngineProvider client={engine()}>
			<SessionProvider session={session}>
				<MotionTemplatesPanel instanceId="mgt-presets" visible />
			</SessionProvider>
		</EngineProvider>,
	);
}

describe('Motion Templates gallery ▸ presets', () => {
	it('shows one card per preset (counter) and one card for templates without presets', async () => {
		const session = await openSession();
		const view = gallery(session);
		const cards = [...view.container.querySelectorAll('[data-template="counter@1"]')];
		expect(cards.map((c) => c.getAttribute('data-preset'))).toEqual([
			'subscribers',
			'percentage',
			'money-raised',
		]);
		expect(screen.queryByRole('listitem', { name: 'Counter (Counters)' })).toBeNull();
		expect(screen.getByRole('listitem', { name: 'Percentage · Counter (Counters)' })).toBeTruthy();
		const lowerThird = view.container.querySelectorAll('[data-template="lower-third@1"]');
		expect(lowerThird).toHaveLength(1);
		expect(lowerThird[0]!.hasAttribute('data-preset')).toBe(false);
		// posters and hover previews get the preset's params over the defaults; template cards none
		const percentage = previews.find((p) => p.label === 'Percentage preview')!;
		const { assets: _a, ...percentageProps } = percentage.inputProps;
		expect(percentageProps).toEqual({
			templateId: 'counter',
			version: 1,
			params: { to: 100, suffix: '%', label: 'Complete' },
		});
		const { assets: _b, ...lowerThirdProps } = previews.find(
			(p) => p.label === 'Lower Third preview',
		)!.inputProps;
		expect(lowerThirdProps).toEqual({ templateId: 'lower-third', version: 1 });
		await session.close();
	});

	it('posters and hover previews resolve the fonts and emoji templates declare from the engine catalogue (no markers)', async () => {
		fontCatalog = {
			fonts: [
				{
					family: 'TikTok Sans',
					source: 'bundled',
					weights: [600],
					styles: ['normal'],
					files: [
						{ weight: 600, style: 'normal', url: '/fonts/tiktok-sans/tiktok-sans-latin-600-normal.woff2' },
					],
				},
			],
			emojiPacks: [
				{ id: 'apple', name: 'Apple', version: 'v1', format: 'png', licence: 'test', attribution: null },
			],
			images: [],
		};
		const session = await openSession();
		gallery(session);
		type Assets = {
			font(face: { family: string; weight: number; style: 'normal' | 'italic' }): unknown;
			emoji(pack: string, grapheme: string): string | null;
		};
		const reply = () =>
			previews.filter((p) => p.label?.startsWith('TikTok · Comment reply')).at(-1)?.inputProps.assets as
				| Assets
				| undefined;
		// the catalogue arrives after the first render; the cards then get a resolver over it
		await vi.waitFor(() =>
			expect(reply()?.font({ family: 'TikTok Sans', weight: 600, style: 'normal' })).toBeTruthy(),
		);
		expect(JSON.stringify(reply()!.font({ family: 'TikTok Sans', weight: 600, style: 'normal' }))).toContain(
			'tiktok-sans-latin-600-normal.woff2',
		);
		expect(reply()!.emoji('apple', '😊')).toMatch(/^\/fonts\/emoji\/apple\/v1\/1f60a\.png$/);
		// never another weight or family
		expect(reply()!.font({ family: 'TikTok Sans', weight: 700, style: 'normal' })).toBeNull();
		await session.close();
	});

	it('search and category filters match preset names and the template', async () => {
		const session = await openSession();
		const view = gallery(session);
		const shown = () =>
			[...view.container.querySelectorAll('li[data-template]')].map(
				(c) =>
					`${c.getAttribute('data-template')}${c.getAttribute('data-preset') ? `:${c.getAttribute('data-preset')}` : ''}`,
			);
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'money' } });
		expect(shown()).toEqual(['counter@1:money-raised']);
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'counter' } });
		expect(shown()).toEqual(['counter@1:subscribers', 'counter@1:percentage', 'counter@1:money-raised']);
		fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Counters' }));
		expect(shown()).toEqual(['counter@1:subscribers', 'counter@1:percentage', 'counter@1:money-raised']);
		await session.close();
	});

	it('double-click and Enter insert the preset (one undo step); drag carries it to drops', async () => {
		const session = await openSession();
		gallery(session);
		act(() => {
			fireEvent.doubleClick(screen.getByRole('listitem', { name: 'Percentage · Counter (Counters)' }));
		});
		expect(mgClips(session)).toHaveLength(1);
		expect(mgClips(session)[0]!.params).toEqual({
			...counter.defaults,
			to: 100,
			suffix: '%',
			label: 'Complete',
		});
		expect(session.getState().history.entries.at(-1)?.label).toBe('Add Percentage');
		act(() => {
			session.undo();
		});
		expect(mgClips(session)).toHaveLength(0);
		act(() => {
			fireEvent.keyDown(screen.getByRole('listitem', { name: 'Money Raised · Counter (Counters)' }), {
				key: 'Enter',
			});
		});
		expect(mgClips(session)[0]!.params).toMatchObject({ to: 25000, prefix: '$', label: 'Raised' });
		// drag: the payload names the preset; a drop inserts it
		const data = new Map<string, string>();
		const dt = {
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		fireEvent.dragStart(screen.getByRole('listitem', { name: 'Subscribers · Counter (Counters)' }), {
			dataTransfer: dt,
		});
		expect(data.get('text/plain')).toBe('counter@1:subscribers');
		const drop = readMgTemplateDrag(dt)!;
		expect(drop.template).toEqual({ id: 'counter', version: 1, preset: 'subscribers' });
		act(() => {
			insertMotionTemplate(session, drop.template, { at: 200 });
		});
		expect(mgClips(session).find((c) => c.start === 200)?.params).toEqual(counter.defaults);
		await session.close();
	});

	it('refuses unknown presets and malformed drag payloads; mg.insert takes a preset', async () => {
		const session = await openSession();
		expect(() => insertMotionTemplate(session, { id: 'counter', version: 1, preset: 'nope' })).toThrow(
			/no preset/,
		);
		expect(() => insertMotionTemplate(session, { id: 'lower-third', version: 1, preset: 'x' })).toThrow(
			/no preset/,
		);
		expect(
			readMgTemplateDrag({
				getData: () =>
					JSON.stringify({ type: 'jasper/mg-template', template: { id: 'counter', version: 1, preset: '' } }),
			}),
		).toBeNull();
		const data = new Map<string, string>();
		writeMgTemplateDrag(
			{ setData: (k: string, v: string) => data.set(k, v), effectAllowed: 'none' } as unknown as DataTransfer,
			{ id: 'counter', version: 1 },
		);
		expect(data.get('text/plain')).toBe('counter@1');
		unregister = registerCommands(mgCommands);
		const ctx = createCommandContext({ engine: engine(), session });
		expect(await runCommand('mg.insert', ctx, { templateId: 'counter', preset: 'percentage' })).toEqual({
			ran: true,
		});
		expect(mgClips(session)[0]!.params).toMatchObject({ to: 100, suffix: '%' });
		await session.close();
	});
});
