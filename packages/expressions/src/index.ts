// @jasper/expressions — After Effects-style expressions on any animatable property (docs/wp-notes/expressions.md).
export * from './api.ts';
export { bindDocumentExpressions, bindSnapshotExpressions, bindWorld, worldOfDocument } from './bind.ts';
export * from './presets.ts';
export * from './reference.ts';
export {
	checkExpressionSyntax,
	isExpressionEngineLoaded,
	MAX_DEPTH,
	MEMORY_LIMIT_BYTES,
	OPERATION_BUDGET,
	STACK_LIMIT_BYTES,
} from './runtime.ts';
export type { PropKind } from './values.ts';
export { type EvalStatus, type ResolvedProp, type SelectorInput, World } from './world.ts';
