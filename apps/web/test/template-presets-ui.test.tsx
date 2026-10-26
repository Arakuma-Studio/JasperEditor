// C3: template UI hints in Properties and Effect Controls (groups, labels, tooltips, visibility, keyframes), the
// custom template-param control registry (undoable writes, coalescing, crash isolation) and preset insertion.
import {
	type AnyMgTemplate,
	createMgRegistry,
	MG_CATALOG,
	type MgAnimeTemplateDefinition,
} from '@jasper/mg-templates';
import { type Clip, createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	registerTemplateParamControl,
	type TemplateParamControlProps,
	templateParamControls,
} from '../src/extensions/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';

const channel = z.number().min(0).max(1);
const cardParams = z.strictObject({
	variant: z.enum(['reply', 'post']).default('reply'),
	text: z.string().max(2000).default('Nice video!'),
	views: z.number().int().min(0).default(10),
	scale: z.number().min(0.1).max(4).default(1),
	accent: z.array(channel).length(4).default([1, 0, 0, 1]),
});
const card: MgAnimeTemplateDefinition<z.infer<typeof cardParams>> = {
	id: 'test-card',
	version: 1,
	name: 'Test Card',
	category: 'Social',
	renderer: 'anime',
	renderVersion: 1,
	paramsSchema: cardParams,
	defaults: cardParams.parse({}),
	introFrames: 10,
	outroFrames: 10,
	defaultDurationSeconds: 3,
	canvases: [{ width: 1920, height: 1080 }],
	presets: [
		{ id: 'reply', name: 'Reply', params: {} },
		{ id: 'post', name: 'Post', params: { variant: 'post', views: 1200 } },
	],
	ui: {
		groups: [
			{ id: 'look', label: 'Look', params: ['variant', 'scale'] },
			{ id: 'content', label: 'Content', params: ['text', 'views'] },
		],
		params: {
			text: {
				label: 'Comment',
				description: 'What the viewer wrote',
				multiline: true,
				control: 'test-upper',
			},
			views: { label: 'View Count', visibleWhen: { param: 'variant', in: ['post'] } },
		},
	},
};

type MgClip = Extract<Clip, { kind: 'motion-graphic' }>;

async function openSession(defs: readonly AnyMgTemplate[] = [...MG_CATALOG, card]) {
	const ids = createCounterIdSource(11);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'UI hints', preset: 'hd-1080p-30' });
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
				track: 'V1',
				template: { id: 'test-card', version: 1 },
				ref: '$c',
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const clipId = r.refs.$c!;
	act(() => {
		session.select('timeline', [clipId], 'replace');
		session.transport.seek(20);
	});
	const clip = () => session.store.getState().document.sequences[seqId]!.clips[clipId] as MgClip;
	const setParam = (name: string, value: unknown) =>
		act(() => {
			const res = session.apply({
				label: 'set',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'param.set', target: ['clip', clipId, 'params', name], value }] as never,
			});
			if (!res.ok) throw new Error(JSON.stringify(res.errors));
		});
	return { session, seqId, clipId, clip, setParam };
}

const history = (s: EditorSession) => s.getState().history.entries.length;

let offs: (() => void)[] = [];
afterEach(() => {
	for (const off of offs) off();
	offs = [];
	cleanup();
	localStorage.clear();
});

function properties(session: EditorSession) {
	return render(
		<SessionProvider session={session}>
			<PropertiesPanel instanceId="tpl-ui-props" visible />
		</SessionProvider>,
	);
}

describe('Properties ▸ Parameters with template ui hints', () => {
	it('groups params into ordered sub-sections with labels and tooltips, hiding params that do not apply', async () => {
		const { session, setParam } = await openSession();
		const view = properties(session);
		const params = view.container.querySelector('[data-section="properties.template"]')!;
		expect(within(params as HTMLElement).getByText('Parameters · Test Card')).toBeTruthy();
		// sections in the template's order: Look, then Content
		const groups = [...params.querySelectorAll('[data-template-group]')].map((g) =>
			g.getAttribute('data-template-group'),
		);
		expect(groups).toEqual(['look', 'content']);
		const rowsOf = (id: string) =>
			[...params.querySelectorAll(`[data-template-group="${id}"] [data-row]`)].map((r) =>
				r.getAttribute('data-row'),
			);
		expect(rowsOf('look')).toEqual(['params.variant', 'params.scale']);
		// views applies to the "post" variant only
		expect(rowsOf('content')).toEqual(['params.text']);
		// the accent param is in no group: drawn before the groups
		expect(params.querySelector('[data-row="params.accent"]')).not.toBeNull();
		// label and tooltip from the hints; the multi-line text area (no custom control registered: default editor)
		const label = within(params.querySelector('[data-row="params.text"]') as HTMLElement).getByText(
			'Comment',
		);
		expect(label.getAttribute('title')).toBe('What the viewer wrote');
		expect(params.querySelector('[data-row="params.text"] textarea')).not.toBeNull();
		setParam('variant', 'post');
		expect(rowsOf('content')).toEqual(['params.text', 'params.views']);
		expect(within(params as HTMLElement).getByText('View Count')).toBeTruthy();
		await session.close();
	});
});

describe('custom template param controls (registerTemplateParamControl)', () => {
	const seen: TemplateParamControlProps[] = [];
	/** The test control: shows the value, uppercases it on click, "types" twice with coalescing. */
	function UpperControl(p: TemplateParamControlProps) {
		seen.push(p);
		return (
			<span>
				<span data-testid="upper-value">{String(p.value)}</span>
				<span data-testid="upper-variant">{String(p.params.variant)}</span>
				<button
					type="button"
					disabled={p.disabled}
					onClick={() => p.onChange(String(p.value).toUpperCase())}
					data-testid="upper-apply"
				>
					Upper
				</button>
				<button
					type="button"
					onClick={() => {
						p.onChange('typing a');
						p.onChange('typing ab', { coalesce: true });
						p.onChange('typing abc', { coalesce: true });
					}}
					data-testid="upper-type"
				>
					Type
				</button>
			</span>
		);
	}

	it('renders the registered control with the contract props; edits are undoable param commands', async () => {
		const { session, clipId, clip } = await openSession();
		offs.push(registerTemplateParamControl('test-upper', UpperControl));
		properties(session);
		expect(screen.getByTestId('upper-value').textContent).toBe('Nice video!');
		expect(screen.getByTestId('upper-variant').textContent).toBe('reply');
		expect(seen.at(-1)).toMatchObject({ clipId, paramName: 'text', value: 'Nice video!', disabled: false });
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('upper-apply')));
		expect(clip().params.text).toBe('NICE VIDEO!');
		expect(history(session)).toBe(before + 1);
		expect(screen.getByTestId('upper-value').textContent).toBe('NICE VIDEO!');
		act(() => {
			expect(session.undo().ok).toBe(true);
		});
		expect(clip().params.text).toBe('Nice video!');
		act(() => {
			expect(session.redo().ok).toBe(true);
		});
		expect(clip().params.text).toBe('NICE VIDEO!');
		await session.close();
	});

	it('coalesces edits flagged coalesce into one undo step', async () => {
		const { session, clip } = await openSession();
		offs.push(registerTemplateParamControl('test-upper', UpperControl));
		properties(session);
		const before = history(session);
		act(() => fireEvent.click(screen.getByTestId('upper-type')));
		expect(clip().params.text).toBe('typing abc');
		// the first edit opens an entry; the two coalesced ones merge into the next one
		expect(history(session)).toBe(before + 2);
		act(() => {
			session.undo();
		});
		expect(clip().params.text).toBe('typing a');
		act(() => {
			session.undo();
		});
		expect(clip().params.text).toBe('Nice video!');
		await session.close();
	});

	it('isolates a control that throws and falls back to the default editor when unregistered', async () => {
		const { session } = await openSession();
		const off = registerTemplateParamControl('test-upper', () => {
			throw new Error('boom');
		});
		const view = properties(session);
		expect(screen.getByTestId('template-param-control-error').textContent).toContain('boom');
		// the rest of the panel still works
		expect(view.container.querySelector('[data-row="params.variant"] select')).not.toBeNull();
		act(() => off());
		expect(screen.queryByTestId('template-param-control-error')).toBeNull();
		expect(view.container.querySelector('[data-row="params.text"] textarea')).not.toBeNull();
		expect(() => registerTemplateParamControl(' ', UpperControl)).toThrow();
		expect(templateParamControls.get('test-upper')).toBeUndefined();
		await session.close();
	});

	it('is disabled in read-only projects', async () => {
		const { session } = await openSession();
		offs.push(registerTemplateParamControl('test-upper', UpperControl));
		act(() => session.store.setState({ readOnly: true } as never));
		properties(session);
		expect(seen.at(-1)?.disabled).toBe(true);
		expect((screen.getByTestId('upper-apply') as HTMLButtonElement).disabled).toBe(true);
		await session.close();
	});
});

describe('Effect Controls ▸ Template with ui hints', () => {
	it('draws group sub-headers in order, hides params that do not apply and keeps stopwatches', async () => {
		const { session, clip, setParam } = await openSession();
		const view = render(
			<SessionProvider session={session}>
				<EffectControlsPanel instanceId="tpl-ui-ec" visible />
			</SessionProvider>,
		);
		const groups = [...view.container.querySelectorAll('[data-ec-param-group]')];
		expect(groups.map((g) => g.getAttribute('data-ec-param-group'))).toEqual(['look', 'content']);
		const rowsIn = (id: string) =>
			[...view.container.querySelectorAll(`[data-ec-param-group="${id}"] [data-row]`)].map((r) =>
				r.getAttribute('data-row'),
			);
		expect(rowsIn('look')).toEqual(['params.variant', 'params.scale']);
		expect(rowsIn('content')).toEqual(['params.text']);
		expect(view.queryByTestId('stopwatch-params.views')).toBeNull();
		// keyframable params keep their stopwatch inside a group
		act(() => fireEvent.click(view.getByTestId('stopwatch-params.scale')));
		expect(clip().paramKeyframes?.scale).toHaveLength(1);
		// collapsing a group hides its rows
		act(() => fireEvent.click(view.getByTestId('ec-group-toggle-look')));
		expect(rowsIn('look')).toEqual([]);
		setParam('variant', 'post');
		expect(rowsIn('content')).toEqual(['params.text', 'params.views']);
		await session.close();
	});
});
