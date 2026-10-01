// M2 MCP tools for shapes (S11:SHP-008, ARCHITECTURE §20.7): add_shape (type, size, fill, stroke, radius,
// position, at, duration, track). Owner: wp-m2-shapes. Contracts: no tools yet.
import type { ToolContext } from '../context.ts';

/** Appended to the server instructions (EDITING_GUIDE) when non-empty. */
export const SHAPES_GUIDE = '';

export function registerShapeTools(_ctx: ToolContext): void {
	// wp-m2-shapes registers its tools here.
}
