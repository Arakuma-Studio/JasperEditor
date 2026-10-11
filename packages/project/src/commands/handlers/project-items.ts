import type { DDoc, HandlerContext } from '../context.ts';
export function insertItem(
	doc: DDoc,
	itemId: string,
	parentBinId: string | null | undefined,
	index?: number,
): void {
	let list: string[];
	if (parentBinId) {
		const bin = doc.items[parentBinId];
		if (bin?.kind !== 'bin') throw new Error(`not a bin: ${parentBinId}`);
		list = bin.children;
	} else list = doc.rootItems;
	if (index === undefined || index >= list.length) list.push(itemId);
	else list.splice(index, 0, itemId);
}

export function assertBin(doc: DDoc, binId: string | null | undefined, h: HandlerContext): void {
	if (!binId) return;
	const bin = doc.items[binId];
	if (!bin) h.fail('E_NOT_FOUND', `Bin not found: ${binId}`);
	if (bin.kind !== 'bin') h.fail('E_INVALID_PARAM', `Item ${binId} is not a bin`);
}
