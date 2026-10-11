// Shape values and keyframes use param.set / keyframe.* on
// ["clip", clipId, "shape", "items", itemId, field…].
import { z } from 'zod';
import { ShapeItemInputSchema, ShapeItemPatchSchema } from '../../vector/input.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';
import { MaskPathOpSchema } from './mask.ts';

const ItemId = z.string().min(1).describe('Shape item id (unique within the clip)');
const ParentId = z
	.string()
	.min(1)
	.nullable()
	.optional()
	.describe('Group to put the items in (null/absent = the top level of the clip)');

/**
 * Adds items (or a shape preset's items) to a vector shape. `index` is the position in the parent's list (0 = top;
 * absent = the bottom of the list, where operators and paints apply to everything above). Items are given in the
 * relaxed input form (static values or Animatables, colours as RGBA or hex, `path` as SVG path data or a path value).
 */
export const ShapeAddItemsCmd = cmd('shape.addItems', {
	clipId: IdRefSchema,
	items: z.array(ShapeItemInputSchema).min(1).max(1000).optional(),
	/** A shape preset id (`SHAPE_PRESETS`): its items are added instead of `items`. */
	preset: z.string().optional(),
	parentId: ParentId,
	index: z.number().int().min(0).optional(),
	ref: RefDeclSchema.optional(),
});

/** Changes fields of one item (static values replace keyframes like TransformPatch; `null` removes dashes/taper/wave). */
export const ShapeUpdateItemCmd = cmd('shape.updateItem', {
	clipId: IdRefSchema,
	itemId: ItemId,
	patch: ShapeItemPatchSchema,
});

export const ShapeRemoveItemsCmd = cmd('shape.removeItems', {
	clipId: IdRefSchema,
	itemIds: z.array(ItemId).min(1),
});

/** Moves an item to `index` in `parentId`'s list (reorder, or move into / out of a group). */
export const ShapeMoveItemCmd = cmd('shape.moveItem', {
	clipId: IdRefSchema,
	itemId: ItemId,
	parentId: ParentId,
	index: z.number().int().min(0),
});

/** Duplicates an item (with fresh ids) just above it. */
export const ShapeDuplicateItemCmd = cmd('shape.duplicateItem', {
	clipId: IdRefSchema,
	itemId: ItemId,
	ref: RefDeclSchema.optional(),
});

/** Wraps sibling items in a new group (at the position of the topmost one). */
export const ShapeGroupItemsCmd = cmd('shape.groupItems', {
	clipId: IdRefSchema,
	itemIds: z.array(ItemId).min(1),
	name: z.string().max(200).optional(),
	ref: RefDeclSchema.optional(),
});

/** Replaces the whole contents of a vector shape. */
export const ShapeSetContentsCmd = cmd('shape.setContents', {
	clipId: IdRefSchema,
	contents: z.array(ShapeItemInputSchema).max(10000),
});

/**
 * Converts a rectangle / ellipse clip into an editable vector shape (rectangle or ellipse path, stroke and fill
 * items with the same values and keyframes); the picture does not change.
 */
export const ShapeConvertToVectorCmd = cmd('shape.convertToVector', {
	clipId: IdRefSchema,
});

/**
 * Geometry edits of a path item (the mask path operations, in layer pixels around the layer centre): shape edits
 * (set, moveVertices, setVertex, transform, convert) at `at` (a keyframe when the path is animated) or, with
 * `allKeyframes`, on every key; topology edits (insertVertex, removeVertices, appendVertex, setClosed) on the value
 * and every key. Feather points do not apply to shapes.
 */
export const ShapeEditPathCmd = cmd('shape.editPath', {
	clipId: IdRefSchema,
	itemId: ItemId,
	at: ParamAtSchema.optional(),
	allKeyframes: z.boolean().optional(),
	ops: z.array(MaskPathOpSchema).min(1),
});

/**
 * After Effects' Convert to Bezier Path: a rectangle / ellipse / polystar path item becomes a free path item with the
 * geometry it has at `at` (its keyframes and parameters are not kept, as in After Effects); its vertices are then
 * editable.
 */
export const ShapeConvertToPathCmd = cmd('shape.convertToPath', {
	clipId: IdRefSchema,
	itemId: ItemId,
	at: ParamAtSchema.optional(),
	ref: RefDeclSchema.optional(),
});

export const SHAPE_COMMANDS = [
	ShapeConvertToPathCmd,
	ShapeEditPathCmd,
	ShapeAddItemsCmd,
	ShapeUpdateItemCmd,
	ShapeRemoveItemsCmd,
	ShapeMoveItemCmd,
	ShapeDuplicateItemCmd,
	ShapeGroupItemsCmd,
	ShapeSetContentsCmd,
	ShapeConvertToVectorCmd,
] as const;
