// Sequence ▸ Automate ▸ Style Recipes… (spec 15 EA-010, EA-011, EA-040): the built-in recipes, the user's library
// (shared by every project; what loading it repaired is said once) and the project's copies, with the project's active
// recipe marked. Use makes a recipe the active one (a library recipe is copied into the project: one undo step); the
// pass dialogs then start from its parameters. Duplicate, Rename and Delete act on the library (deleting asks first:
// the library has no undo; a project keeps its own copy); a project-only copy is removed from the project (undoable).
// Save Current Settings as Recipe… saves a new library recipe from the active one with the parameters the pass
// dialogs last proposed with in this window.
import {
	type AutomationPass,
	projectStyleRecipes,
	recipeWithPassParams,
	type StyleRecipe,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	TextField,
	toast,
} from '@jasper/ui';
import { useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t, translateName } from '../i18n/runtime.ts';
import { AUTOMATION_PASS_TITLES } from './AutomationDialog.tsx';
import {
	createLibraryRecipe,
	defaultRecipeId,
	deleteLibraryRecipe,
	duplicateLibraryRecipe,
	lastPassParams,
	type RecipeChoice,
	recipeChoices,
	renameLibraryRecipe,
	useStyleLibrary,
} from './style-store.ts';

export const STYLE_RECIPES_DIALOG = 'automation.styleRecipes';

let registered = false;
export function registerStyleRecipesDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(STYLE_RECIPES_DIALOG, StyleRecipesDialog);
}

const name = (s: string) => translateName(s) ?? s;
const SOURCE_TEXT: Record<RecipeChoice['source'], string> = {
	builtin: 'Built in',
	library: 'Your library',
	project: 'This project',
};

/** Repairs of the library the user has been told about (once per window). */
const toldRepairs = new Set<string>();

export type StyleRecipesDialogProps = { session: EditorSession; sequenceId: string };

export function StyleRecipesDialog(props: HostedDialogProps<StyleRecipesDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const seq = doc.sequences[sequenceId];
	const lib = useStyleLibrary();
	const choices = useMemo(() => recipeChoices(doc, lib), [doc, lib]);
	const active = projectStyleRecipes(doc).active;
	const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
	const [saving, setSaving] = useState<{ name: string; use: boolean } | null>(null);
	const [busy, setBusy] = useState(false);
	const offline = lib.status !== 'ready';
	const vertical = !!seq && seq.settings.height > seq.settings.width;
	const baseId = active ?? defaultRecipeId(doc, vertical);
	const base = choices.find((c) => c.id === baseId)?.recipe ?? null;
	const last = lastPassParams(session.projectId);
	const lastPasses = Object.keys(last) as AutomationPass[];
	const repairKey = JSON.stringify(lib.repairs);
	const showRepairs = lib.repairs.length > 0 && !toldRepairs.has(repairKey);

	const apply = (label: string, commands: Record<string, unknown>[]) => {
		const r = session.apply({ label, origin: 'user', commands: commands as never });
		if (!r.ok)
			toast({ kind: 'warning', title: t('{0}: not possible', t(label)), detail: r.errors[0]?.message });
		return r.ok;
	};
	const run = async (what: string, fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
		} catch (e) {
			toast({
				kind: 'warning',
				title: t('{0}: not possible', what),
				detail: (e as Error)?.message ?? String(e),
			});
		} finally {
			setBusy(false);
		}
	};
	const use = (c: RecipeChoice) => {
		if (!c.recipe) return;
		if (c.source === 'library')
			apply('Set Active Style Recipe', [{ type: 'styleRecipe.add', recipe: c.recipe, activate: true }]);
		else apply('Set Active Style Recipe', [{ type: 'styleRecipe.setActive', recipeId: c.id }]);
	};
	const remove = (c: RecipeChoice) => {
		if (c.source === 'project') {
			apply('Remove Style Recipe', [{ type: 'styleRecipe.remove', recipeId: c.id }]);
			return;
		}
		if (
			!window.confirm(
				t('Delete the recipe “{0}” from your library? Projects keep their own copies.', name(c.name)),
			)
		)
			return;
		void run(t('Delete'), () => deleteLibraryRecipe(c.id));
	};
	const duplicate = (c: RecipeChoice) =>
		void run(t('Duplicate'), async () => {
			if (c.source === 'project' && c.recipe)
				await createLibraryRecipe({ ...c.recipe, name: `${c.recipe.name} copy`.slice(0, 120) });
			else await duplicateLibraryRecipe(c.id);
		});
	const saveCurrent = () =>
		void run(t('Save'), async () => {
			if (!base || !saving) return;
			const recipe = recipeWithPassParams(base, last);
			const { builtIn: _b, ...plain } = recipe as StyleRecipe;
			const saved = await createLibraryRecipe({ ...plain, name: saving.name.trim() });
			if (saving.use && saved.recipe)
				apply('Set Active Style Recipe', [{ type: 'styleRecipe.add', recipe: saved.recipe, activate: true }]);
			toast({ kind: 'info', title: t('Recipe “{0}” saved', saved.name) });
			setSaving(null);
		});

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					if (showRepairs) toldRepairs.add(repairKey);
					finish();
				}
			}}
			title={t('Style Recipes')}
			size="medium"
			primaryLabel={t('Close')}
			onPrimary={() => {
				if (showRepairs) toldRepairs.add(repairKey);
				return true;
			}}
			data-testid="style-recipes-dialog"
		>
			<div className="flex flex-col gap-3 text-pr-ui">
				<p className="text-pr-small text-pr-muted">
					{t(
						'A style recipe holds the settings of every step: voice cleanup, subtitles and the decorations. The active recipe of the project is what Apply Style and the Automate dialogs start from.',
					)}
				</p>
				{offline ? (
					<span className="text-pr-small text-pr-muted" data-testid="style-recipes-offline">
						{lib.status === 'loading'
							? t('Loading your library…')
							: t(
									'Your library is kept by the engine, which is not connected: only the built-in recipes and the project’s copies are shown.',
								)}
					</span>
				) : null}
				{lib.readOnly ? (
					<span className="text-pr-small text-pr-warning" data-testid="style-recipes-read-only">
						{t('Your recipe library was written by a newer JasperEditor: it is read-only here.')}
					</span>
				) : null}
				{showRepairs ? (
					<div className="flex flex-col gap-0.5" data-testid="style-recipes-repairs">
						<span className="text-pr-small text-pr-warning">
							{t('Your recipe library was repaired when it was opened:')}
						</span>
						{lib.repairs.slice(0, 8).map((r) => (
							<span key={r.action + r.entity} className="pl-3 text-pr-small text-pr-muted">
								{r.detail}
							</span>
						))}
					</div>
				) : null}
				<ul className="flex flex-col gap-1" data-testid="style-recipes-list">
					{choices.map((c) => {
						const isActive = c.id === active;
						const canEdit = c.source === 'library' && !c.readOnly && !lib.readOnly && !offline;
						return (
							<li
								key={c.id}
								className="flex items-center gap-2 rounded-pr-control px-1 py-0.5 hover:bg-pr-field"
								data-testid={`style-recipe-${c.id}`}
								data-active={isActive || undefined}
							>
								<span className="w-[14px] shrink-0 text-center text-pr-text" aria-hidden="true">
									{isActive ? '●' : ''}
								</span>
								{isActive ? <span className="sr-only">{t('Active')}</span> : null}
								<span className="min-w-0 flex-1 truncate">
									{renaming?.id === c.id ? (
										<TextField
											aria-label={t('Name')}
											value={renaming.value}
											autoFocus
											onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
											onKeyDown={(e) => {
												// Enter / Escape belong to the field here, not to the dialog (which would close)
												if (e.key === 'Enter' || e.key === 'Escape') {
													e.preventDefault();
													e.stopPropagation();
												}
												if (e.key === 'Escape') setRenaming(null);
												if (e.key === 'Enter' && renaming.value.trim())
													void run(t('Rename'), async () => {
														await renameLibraryRecipe(c.id, renaming.value.trim());
														setRenaming(null);
													});
											}}
										/>
									) : (
										<>
											{name(c.name)}
											<span className="ml-2 text-pr-small text-pr-muted">
												{SOURCE_TEXT[c.source]}
												{c.recipe ? ` · ${t('version {0}', c.recipe.revision)}` : ''}
												{c.projectRevision !== undefined
													? ` · ${t('this project uses version {0}', c.projectRevision)}`
													: ''}
												{c.newer ? ` · ${t('newer version')}` : ''}
											</span>
										</>
									)}
								</span>
								<Button
									variant="quiet"
									disabled={readOnly || !c.recipe || (isActive && c.projectRevision === undefined) || busy}
									onClick={() => use(c)}
									data-testid="style-recipe-use"
								>
									{t('Use')}
								</Button>
								<Button
									variant="quiet"
									disabled={!c.recipe || offline || lib.readOnly || busy}
									onClick={() => duplicate(c)}
									data-testid="style-recipe-duplicate"
								>
									{t('Duplicate')}
								</Button>
								<Button
									variant="quiet"
									disabled={!canEdit || busy}
									onClick={() => setRenaming({ id: c.id, value: c.name })}
									data-testid="style-recipe-rename"
								>
									{t('Rename')}
								</Button>
								<Button
									variant="quiet"
									disabled={busy || (c.source === 'project' ? readOnly : !canEdit)}
									onClick={() => remove(c)}
									data-testid="style-recipe-delete"
								>
									{t('Delete')}
								</Button>
							</li>
						);
					})}
				</ul>
				{saving ? (
					<div className="flex flex-col gap-2" data-testid="style-recipes-save">
						<span className="text-pr-small text-pr-muted">
							{lastPasses.length
								? t(
										'A new recipe from “{0}” with the settings you last used in: {1}.',
										name(base?.name ?? ''),
										lastPasses.map((p) => AUTOMATION_PASS_TITLES[p]).join(', '),
									)
								: t(
										'A new recipe from “{0}” (no Automate dialog was used in this project yet).',
										name(base?.name ?? ''),
									)}
						</span>
						<TextField
							aria-label={t('Recipe name')}
							placeholder={t('Recipe name')}
							value={saving.name}
							autoFocus
							onChange={(e) => setSaving({ ...saving, name: e.target.value })}
							onKeyDown={(e) => {
								if (e.key !== 'Enter' && e.key !== 'Escape') return;
								e.preventDefault();
								e.stopPropagation();
								if (e.key === 'Escape') setSaving(null);
								else if (saving.name.trim() && base && !busy) saveCurrent();
							}}
							data-testid="style-recipes-save-name"
						/>
						<Checkbox
							checked={saving.use}
							onCheckedChange={(v) => setSaving({ ...saving, use: v })}
							label={t('Use it in this project')}
							disabled={readOnly}
						/>
						<div className="flex gap-2">
							<Button
								variant="primary"
								disabled={!saving.name.trim() || busy || !base}
								onClick={saveCurrent}
								data-testid="style-recipes-save-confirm"
							>
								{t('Save')}
							</Button>
							<Button variant="quiet" onClick={() => setSaving(null)}>
								{t('Cancel')}
							</Button>
						</div>
					</div>
				) : (
					<Button
						variant="secondary"
						disabled={offline || lib.readOnly || !base}
						disabledReason={
							offline
								? t('The engine is not connected')
								: lib.readOnly
									? t('Your library is read-only')
									: undefined
						}
						onClick={() => setSaving({ name: '', use: true })}
						data-testid="style-recipes-save-current"
					>
						{t('Save Current Settings as Recipe…')}
					</Button>
				)}
			</div>
		</Dialog>
	);
}
