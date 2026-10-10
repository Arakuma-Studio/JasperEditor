// Types of the fixture plug-in for TypeScript importers (apps/engine/test/fuzz.test.ts uses `makePsd` for seeds).
/** The 320×240 layered Photoshop test document (blend modes, opacity, hidden layer, group, masks), as bytes. */
export function makePsd(agPsd: unknown): Buffer;
export function fixtures(ctx: unknown): Promise<unknown>;
