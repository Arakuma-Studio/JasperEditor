// Spec 15 EA-010: the project's copies of style recipes (`ProjectDocument.styleRecipes`) and the active recipe the
// pass dialogs start from. Each command is one undo step; the user library lives in the engine
// (`<appdir>/style-recipes/`), Apply Style stores a copy of the recipe it used with `styleRecipe.add`.
import { z } from 'zod';
import { cmd } from './common.ts';

const RecipeId = z.string().min(1).max(80);

export const StyleRecipeAddCmd = cmd('styleRecipe.add', {
	/** A recipe (format "jasper-style-recipe"); the project copy of the same id is replaced. */
	recipe: z.record(z.string(), z.unknown()),
	/** Also make it the project's active recipe (default false). */
	activate: z.boolean().optional(),
});

export const StyleRecipeRemoveCmd = cmd('styleRecipe.remove', {
	recipeId: RecipeId,
});

export const StyleRecipeSetActiveCmd = cmd('styleRecipe.setActive', {
	/** A project copy or a built-in id (`builtin:fast-shorts`…); null = no active recipe. */
	recipeId: RecipeId.nullable(),
});

export const STYLE_RECIPE_COMMANDS = [StyleRecipeAddCmd, StyleRecipeRemoveCmd, StyleRecipeSetActiveCmd] as const;
