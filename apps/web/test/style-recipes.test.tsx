// Style recipes in the editor (spec 15 EA-010…EA-013, EA-040): Sequence ▸ Automate ▸ Apply Style… (the recipe, its
// steps, the dry run per step with skipped reasons, Propose → review), Style Check (measures, look-here timecodes move
// the playhead), Style Recipes… (use as active, delete a project copy, save the Automate dialogs' last settings as a
// recipe in the library), and the pass dialogs starting from the active recipe's parameters.
import type { ApplyStyleResult, EngineJob, StyleCheckResponse, StyleRecipeEntry } from '@jasper/api';
import { BUILTIN_STYLE_RECIPES, builtinStyleRecipe, projectStyleRecipes } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { ApplyStyleDialog } from '../src/automation/ApplyStyleDialog.tsx';
import { StyleCheckDialog } from '../src/automation/StyleCheckDialog.tsx';
import { StyleRecipesDialog } from '../src/automation/StyleRecipesDialog.tsx';
import { connectStyleLibrary, rememberPassParams } from '../src/automation/style-store.ts';
import { automationCommands } from '../src/commands/automation.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => {
	cleanup();
	connectStyleLibrary(null);
});

const settle = (ms = 400) => act(async () => new Promise((r) => setTimeout(r, ms)));

function dryResult(seqId: string, o: Partial<ApplyStyleResult> = {}): ApplyStyleResult {
	return {
		mode: 'dryRun',
		projectId: 'prj',
		sequenceId: seqId,
		recipe: { id: 'builtin:fast-long-form', name: 'Fast Long-form', revision: 1 },
		stages: [
			{
				stage: 'cleanup',
				name: 'Voice cleanup',
				status: 'planned',
				count: 12,
				items: 1,
				dropped: [],
				cost: 'native',
				warnings: [],
			},
			{
				stage: 'subtitles',
				name: 'Subtitles',
				status: 'planned',
				count: 40,
				items: 1,
				dropped: [],
				cost: 'hybrid',
				warnings: [],
			},
			{
				stage: 'decorate-cuts',
				name: 'Cut kits',
				status: 'planned',
				count: 30,
				items: 34,
				dropped: [],
				cost: 'remotion',
				warnings: [],
			},
			{
				stage: 'music',
				name: 'Music beds',
				status: 'skipped',
				count: 0,
				items: 0,
				reason:
					'“Fast Long-form” places music beds from your songs, but the project has no bin named “Music”',
				dropped: [],
				cost: null,
				warnings: [
					{
						code: 'W_ROLE_MISSING',
						message: 'no bin named “Music”: import your songs into a bin with that name',
					},
				],
			},
			{
				stage: 'stingers',
				name: 'Stingers',
				status: 'off',
				count: 0,
				items: 0,
				dropped: [],
				cost: null,
				warnings: [],
			},
		],
		cost: 'remotion',
		budget: { fits: true, items: 37, commands: 160 },
		proposalId: null,
		revision: 3,
		itemCount: 37,
		invalid: [],
		warnings: [
			{
				code: 'W_ROLE_MISSING',
				message: 'no bin named “Music”: import your songs into a bin with that name',
			},
		],
		...o,
	};
}

function libEngine() {
	const calls: { name: string; args: unknown[] }[] = [];
	const entries: StyleRecipeEntry[] = BUILTIN_STYLE_RECIPES.map((r) => ({
		id: r.id,
		name: r.name,
		source: 'builtin' as const,
		readOnly: true,
		recipe: r as never,
	}));
	return {
		calls,
		engine: {
			async styleRecipes() {
				return {
					revision: 1,
					recipes: entries,
					repairs: [{ action: 'adopt', entity: 'rcp_1', detail: 'A recipe file was added back' }],
					readOnly: false,
				};
			},
			async createStyleRecipe(req: { recipe: Record<string, unknown> }) {
				calls.push({ name: 'create', args: [req] });
				const recipe = { ...req.recipe, id: 'rcp_0000000000000011', revision: 1 };
				entries.push({
					id: recipe.id,
					name: String(req.recipe.name),
					source: 'library',
					readOnly: false,
					recipe,
				});
				return {
					id: recipe.id,
					name: String(req.recipe.name),
					source: 'library' as const,
					readOnly: false,
					recipe,
				};
			},
			async updateStyleRecipe() {
				throw new Error('x');
			},
			async duplicateStyleRecipe(id: string) {
				calls.push({ name: 'duplicate', args: [id] });
				return entries[0]!;
			},
			async deleteStyleRecipe() {},
		},
	};
}

function setupApply(initial?: (seqId: string) => ApplyStyleResult) {
	const { session, seqId } = makeSession();
	const proposals = new FakeEngine(() => session);
	proposalsFor(session, { engine: proposals });
	const calls: Record<string, unknown>[] = [];
	let dry = initial ? initial(seqId) : dryResult(seqId);
	const engine = {
		async applyStyle(_p: string, req: Record<string, unknown>) {
			calls.push(req);
			if (req.mode === 'dryRun') return dry;
			return {
				id: 'job_s',
				state: 'queued',
				kind: 'apply-style',
				title: 'Apply Style',
			} as unknown as EngineJob;
		},
		async getJob() {
			const id = proposals.create(
				{
					feature: 'edit-automation',
					title: 'Apply Style: Fast Long-form',
					sequenceId: seqId,
					items: [
						{
							id: 'kit:60',
							label: 'Jolt',
							group: 'cut-kits',
							commands: [{ type: 'marker.add', frame: 60 }],
							meta: { group: 'cut-kits', frame: 60 },
						},
					],
				},
				'user',
			).id;
			return {
				id: 'job_s',
				state: 'succeeded',
				kind: 'apply-style',
				title: 'x',
				result: { ...dryResult(seqId), mode: 'propose', proposalId: id },
			} as unknown as EngineJob;
		},
		async cancelJob() {},
		async styleCheck() {
			throw new Error('unused');
		},
	};
	const reviewed: number[] = [];
	render(
		<SessionProvider session={session}>
			<ApplyStyleDialog
				session={session}
				engine={engine as never}
				sequenceId={seqId}
				close={() => {}}
				onReview={() => reviewed.push(1)}
			/>
		</SessionProvider>,
	);
	return { session, seqId, calls, reviewed, setDry: (d: ApplyStyleResult) => (dry = d) };
}

describe('Apply Style…', () => {
	it('starts from the built-in for the aspect, shows every step of the dry run with the reasons, sends switched steps', async () => {
		const t = setupApply();
		const dialog = await screen.findByTestId('apply-style-dialog');
		await settle();
		expect(t.calls[0]).toEqual({
			sequenceId: t.seqId,
			recipeId: 'builtin:fast-long-form',
			seed: 1,
			mode: 'dryRun',
		});
		expect(within(dialog).getByTestId('apply-style-stage-cleanup').getAttribute('data-status')).toBe(
			'planned',
		);
		expect(within(dialog).getByTestId('apply-style-stage-music').getAttribute('data-status')).toBe('skipped');
		expect(within(dialog).getByTestId('apply-style-reason-music').textContent).toContain(
			'no bin named “Music”',
		);
		expect(within(dialog).getByTestId('apply-style-cost').textContent).toContain('Remotion');
		expect(dialog.querySelector('[data-apply-style-warning="W_ROLE_MISSING"]')).toBeTruthy();
		// turn the stingers on and the cleanup off for this run
		const sw = (s: string) =>
			within(within(dialog).getByTestId(`apply-style-switch-${s}`)).getByRole('checkbox');
		await act(async () => {
			fireEvent.click(sw('stingers'));
			fireEvent.click(sw('cleanup'));
		});
		await settle();
		expect(t.calls.at(-1)).toMatchObject({ mode: 'dryRun', passes: { stingers: true, cleanup: false } });
	});

	it('Propose runs the job, opens review on the proposal and applies nothing', async () => {
		const t = setupApply();
		const dialog = await screen.findByTestId('apply-style-dialog');
		await settle();
		const rev = t.session.revision;
		vi.useFakeTimers();
		try {
			await act(async () => {
				fireEvent.click(within(dialog).getByRole('button', { name: 'Propose' }));
			});
			await act(async () => vi.runAllTimersAsync());
		} finally {
			vi.useRealTimers();
		}
		expect(t.calls.some((c) => c.mode === 'propose')).toBe(true);
		expect(t.reviewed).toEqual([1]);
		expect(t.session.revision).toBe(rev);
	});

	it('Propose is disabled when no step plans anything', async () => {
		setupApply((seqId) =>
			dryResult(seqId, {
				stages: [
					{
						stage: 'cleanup',
						name: 'Voice cleanup',
						status: 'off',
						count: 0,
						items: 0,
						dropped: [],
						cost: null,
						warnings: [],
					},
				],
				itemCount: 0,
				warnings: [],
			}),
		);
		const dialog = await screen.findByTestId('apply-style-dialog');
		await settle();
		expect(within(dialog).getByTestId('apply-style-cost').textContent).toBe(
			'Nothing to propose with this recipe here',
		);
		expect((within(dialog).getByRole('button', { name: 'Propose' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});
});

describe('Style Check', () => {
	it('lists the measures and moves the playhead to a look-here timecode', async () => {
		const { session, seqId } = makeSession();
		const res: StyleCheckResponse = {
			projectId: 'prj',
			sequenceId: seqId,
			recipe: { id: 'builtin:fast-long-form', name: 'Fast Long-form' },
			durationSeconds: 60,
			metrics: [
				{
					id: 'kitCoverage',
					label: 'Cuts with a kit',
					unit: 'share',
					value: 0.5,
					target: { value: 0.951, tolerance: 0.06 },
					status: 'off',
					message: '9 of 18 cuts have a kit',
					count: 9,
					of: 18,
					lookHere: [{ frame: 90, timecode: '00:00:03:00', note: 'a cut without a kit' }],
				},
				{
					id: 'musicGainDb',
					label: 'Music level',
					unit: 'db',
					value: -33,
					target: { value: -33, tolerance: 2 },
					status: 'ok',
					message: 'ok',
					lookHere: [],
				},
				{
					id: 'deadAirPerMinute',
					label: 'Dead air',
					unit: 'seconds-per-minute',
					value: null,
					target: { max: 1 },
					status: 'unmeasured',
					message: 'Not measured',
					lookHere: [],
				},
				{
					id: 'cutsPerMinute',
					label: 'Cuts per minute',
					unit: 'per-minute',
					value: 12,
					target: null,
					status: 'unchecked',
					message: '',
					lookHere: [],
				},
			],
			counts: { ok: 1, off: 1, unmeasured: 1, unchecked: 1 },
			warnings: [],
		};
		const calls: unknown[] = [];
		const engine = {
			async styleCheck(_p: string, req: unknown) {
				calls.push(req);
				return res;
			},
		};
		render(
			<SessionProvider session={session}>
				<StyleCheckDialog session={session} engine={engine as never} sequenceId={seqId} close={() => {}} />
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('style-check-dialog');
		await settle(50);
		expect(calls[0]).toEqual({ sequenceId: seqId, recipeId: 'builtin:fast-long-form' });
		expect(within(dialog).getByTestId('style-check-kitCoverage').getAttribute('data-status')).toBe('off');
		expect(within(dialog).getByTestId('style-check-kitCoverage').textContent).toContain('50 %');
		expect(within(dialog).getByTestId('style-check-kitCoverage').textContent).toContain('95 % ± 6 %');
		expect(within(dialog).queryByTestId('style-check-cutsPerMinute')).toBeNull();
		expect(within(dialog).getByTestId('style-check-counts').textContent).toBe(
			'1 on target · 1 off · 1 not measured',
		);
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: '00:00:03:00' }));
		});
		expect(session.transport.getState().frame).toBe(90);
	});
});

describe('Style Recipes…', () => {
	it('uses a built-in as the active recipe (one undo step) and tells the library repairs once', async () => {
		const { session, seqId } = makeSession();
		const lib = libEngine();
		connectStyleLibrary(lib.engine as never);
		render(
			<SessionProvider session={session}>
				<StyleRecipesDialog session={session} sequenceId={seqId} close={() => {}} />
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('style-recipes-dialog');
		await settle(50);
		expect(within(dialog).getByTestId('style-recipes-repairs').textContent).toContain('added back');
		const row = within(dialog).getByTestId('style-recipe-builtin:clean');
		await act(async () => {
			fireEvent.click(within(row).getByTestId('style-recipe-use'));
		});
		expect(projectStyleRecipes(session.getCommitted()).active).toBe('builtin:clean');
		expect(within(dialog).getByTestId('style-recipe-builtin:clean').getAttribute('data-active')).toBe('true');
		session.undo();
		expect(projectStyleRecipes(session.getCommitted()).active).toBeNull();
	});

	it('regression: Enter in the rename field renames the recipe and keeps the dialog open', async () => {
		const { session, seqId } = makeSession();
		const lib = libEngine();
		const renamed: unknown[] = [];
		(lib.engine as { updateStyleRecipe: unknown }).updateStyleRecipe = async (id: string, req: unknown) => {
			renamed.push([id, req]);
			return { id, name: 'Renamed', source: 'library', readOnly: false };
		};
		await lib.engine.createStyleRecipe({ recipe: { ...builtinStyleRecipe('builtin:clean')!, name: 'Mine' } });
		connectStyleLibrary(lib.engine as never);
		const closed: unknown[] = [];
		render(
			<SessionProvider session={session}>
				<StyleRecipesDialog session={session} sequenceId={seqId} close={(x) => closed.push(x)} />
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('style-recipes-dialog');
		await settle(50);
		const row = within(dialog).getByTestId('style-recipe-rcp_0000000000000011');
		await act(async () => {
			fireEvent.click(within(row).getByTestId('style-recipe-rename'));
		});
		const field = within(row).getByRole('textbox', { name: 'Name' });
		// the dialog is a form: Enter in a field would submit it (close) unless the field keeps the key
		const enter = createEvent.keyDown(field, { key: 'Enter' });
		await act(async () => {
			fireEvent.change(field, { target: { value: 'Renamed' } });
			fireEvent(field, enter);
		});
		expect(enter.defaultPrevented).toBe(true);
		await settle(50);
		expect(renamed).toEqual([['rcp_0000000000000011', { name: 'Renamed' }]]);
		expect(closed).toEqual([]);
		expect(screen.getByTestId('style-recipes-dialog')).toBeTruthy();
	});

	it('saves the Automate dialogs’ last settings as a new library recipe and uses it in the project', async () => {
		const { session, seqId } = makeSession();
		const lib = libEngine();
		connectStyleLibrary(lib.engine as never);
		rememberPassParams(session.projectId, 'ken-burns', {
			share: 0.4,
			scale: 125,
			seed: 9,
			range: { start: 0, end: 10 },
		});
		render(
			<SessionProvider session={session}>
				<StyleRecipesDialog session={session} sequenceId={seqId} close={() => {}} />
			</SessionProvider>,
		);
		const dialog = await screen.findByTestId('style-recipes-dialog');
		await settle(50);
		await act(async () => {
			fireEvent.click(within(dialog).getByTestId('style-recipes-save-current'));
		});
		expect(within(dialog).getByTestId('style-recipes-save').textContent).toContain('Ken Burns');
		await act(async () => {
			fireEvent.change(within(dialog).getByTestId('style-recipes-save-name'), {
				target: { value: 'My long form' },
			});
		});
		await act(async () => {
			fireEvent.click(within(dialog).getByTestId('style-recipes-save-confirm'));
		});
		await settle(50);
		// biome-ignore lint/suspicious/noExplicitAny: the recipe JSON is read loosely by the assertions
		const made = lib.calls.find((c) => c.name === 'create')!.args[0] as { recipe: Record<string, any> };
		expect(made.recipe.name).toBe('My long form');
		expect(made.recipe.passes['ken-burns']).toEqual({
			enabled: true,
			params: { share: 0.4, scale: 125, seed: 9 },
		});
		expect(made.recipe.passes['punch-ins'].params.scale).toBe(180);
		const p = projectStyleRecipes(session.getCommitted());
		expect(p.active).toBe('rcp_0000000000000011');
		expect(p.recipes.rcp_0000000000000011!.name).toBe('My long form');
	});
});

describe('the pass dialogs start from the active recipe', () => {
	it('Ken Burns… opens with the active recipe’s parameters (its asset roles filled in)', () => {
		const { session } = makeSession();
		const r = session.apply({
			label: 'use',
			origin: 'user',
			commands: [{ type: 'styleRecipe.setActive', recipeId: 'builtin:fast-shorts' }] as never,
		});
		expect(r.ok).toBe(true);
		const opened: { kind: string; props: Record<string, unknown> }[] = [];
		const ctx = {
			session,
			focus: { panel: 'timeline', instanceId: null },
			capabilities: new Set(['engine']),
			services: { get: () => undefined },
			engine: {},
			ui: {
				toast() {},
				openDialog: (kind: string, props: Record<string, unknown>) => opened.push({ kind, props }),
			},
		} as unknown as CommandCtx;
		automationCommands.find((c) => c.id === 'automation.kenBurns')!.run(ctx, undefined);
		expect(opened[0]!.props.initialParams).toEqual(
			builtinStyleRecipe('builtin:fast-shorts')!.passes['ken-burns']!.params,
		);
		automationCommands.find((c) => c.id === 'automation.reactions')!.run(ctx, undefined);
		expect(opened[1]!.props.initialParams).toMatchObject({ assets: { bin: 'Reactions' } });
		// explicit parameters win
		automationCommands.find((c) => c.id === 'automation.kenBurns')!.run(ctx, { params: { share: 0.3 } });
		expect(opened[2]!.props.initialParams).toEqual({ share: 0.3 });
		automationCommands.find((c) => c.id === 'automation.applyStyle')!.run(ctx, { recipeId: 'builtin:clean' });
		expect(opened[3]).toMatchObject({ kind: 'automation.applyStyle', props: { recipeId: 'builtin:clean' } });
	});
});
