// Spec 15 EA-010: project copies of style recipes and the active recipe (`ProjectDocument.styleRecipes`; schema v9,
// read leniently by `projectStyleRecipes`, checked by INV-STYLE-RECIPE). docs/wp-notes/edit-automation.md "Style recipes".
import {
	builtinStyleRecipe,
	isNewerRecipe,
	MAX_PROJECT_STYLE_RECIPES,
	type ProjectStyleRecipes,
	parseStyleRecipe,
} from '../../automation/recipes.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import { latest } from '../draft-read.ts';
import { clone, type HandlerMap } from './util.ts';

export const STYLE_RECIPES_OWNER = 'style-recipes';

/** The record, created when missing (unreadable values were repaired on load; a draft never holds one). */
function record(doc: DDoc, h: HandlerContext): ProjectStyleRecipes {
	const d = doc as { styleRecipes?: unknown };
	const cur = d.styleRecipes as ProjectStyleRecipes | undefined;
	if (cur !== undefined && (typeof cur !== 'object' || cur === null || typeof cur.recipes !== 'object'))
		h.fail('E_INVALID_PARAM', 'The project style recipes are unreadable: reopen the project to repair them');
	if (!cur) d.styleRecipes = { recipes: {} } as ProjectStyleRecipes;
	return d.styleRecipes as ProjectStyleRecipes;
}

function tidy(doc: DDoc): void {
	const d = doc as { styleRecipes?: ProjectStyleRecipes };
	const r = d.styleRecipes;
	if (r && !Object.keys(latest(r.recipes)).length && r.active === undefined) delete d.styleRecipes;
}

export const styleRecipeHandlers = {
	'styleRecipe.add': (doc, cmd, h) => {
		const p = parseStyleRecipe(cmd.recipe);
		if (!p.ok)
			return h.fail(
				p.code === 'E_TOO_LARGE' ? 'E_LIMIT' : 'E_INVALID_PARAM',
				`Invalid style recipe: ${p.message}`,
				{
					path: ['recipe'],
				},
			);
		const rec = record(doc, h);
		const recipes = latest(rec.recipes) as Record<string, unknown>;
		const existing = recipes[p.recipe.id];
		if (existing !== undefined && isNewerRecipe(existing))
			h.fail(
				'E_INVALID_PARAM',
				`The project's recipe ${p.recipe.id} was made by a newer JasperEditor and is read-only here`,
			);
		if (existing === undefined && Object.keys(recipes).length >= MAX_PROJECT_STYLE_RECIPES)
			h.fail('E_LIMIT', `A project keeps at most ${MAX_PROJECT_STYLE_RECIPES} style recipes`);
		const { builtIn: _b, ...copy } = p.recipe;
		if (existing === undefined || JSON.stringify(latest(existing)) !== JSON.stringify(copy))
			rec.recipes[p.recipe.id] = clone(copy);
		if (cmd.activate === true) rec.active = p.recipe.id;
		return { recipeId: p.recipe.id, active: rec.active ?? null };
	},
	'styleRecipe.remove': (doc, cmd, h) => {
		const d = doc as { styleRecipes?: ProjectStyleRecipes };
		const rec = d.styleRecipes;
		if (!rec || !Object.hasOwn(latest(rec.recipes), cmd.recipeId))
			return h.fail('E_NOT_FOUND', `The project has no style recipe ${cmd.recipeId}`);
		delete rec.recipes[cmd.recipeId];
		if (rec.active === cmd.recipeId) delete rec.active;
		tidy(doc);
		return { recipeId: cmd.recipeId };
	},
	'styleRecipe.setActive': (doc, cmd, h) => {
		const d = doc as { styleRecipes?: ProjectStyleRecipes };
		if (cmd.recipeId === null) {
			if (d.styleRecipes) {
				delete d.styleRecipes.active;
				tidy(doc);
			}
			return { active: null };
		}
		const known =
			(d.styleRecipes && Object.hasOwn(latest(d.styleRecipes.recipes), cmd.recipeId)) ||
			builtinStyleRecipe(cmd.recipeId) !== null;
		if (!known)
			return h.fail(
				'E_NOT_FOUND',
				`Style recipe ${cmd.recipeId} is neither built in nor copied into the project: add it first (styleRecipe.add with activate: true)`,
			);
		const rec = record(doc, h);
		const stored = (latest(rec.recipes) as Record<string, unknown>)[cmd.recipeId];
		if (stored !== undefined && isNewerRecipe(stored))
			h.fail(
				'E_INVALID_PARAM',
				`Recipe ${cmd.recipeId} was made by a newer JasperEditor and cannot be used here`,
			);
		rec.active = cmd.recipeId;
		return { active: cmd.recipeId };
	},
} satisfies HandlerMap;
