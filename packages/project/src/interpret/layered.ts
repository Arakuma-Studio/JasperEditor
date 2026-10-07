// Layered documents (Photoshop `.psd` / `.psb`) imported as layers (imports workstream, docs/wp-notes/imports.md):
// Premiere's Import Layered File dialog — Merge All Layers (the flattened asset), Merged Layers (chosen layers merged
// into one picture, made by the engine), Individual Layers (each chosen layer an item in a bin) and Sequence (the
// layers stacked on tracks of a new sequence: positions, opacity × fill opacity, blend modes, visibility, groups and
// clipping masks). Pure: builds the commands of one undoable transaction.
import type { Command } from '../commands/schemas/index.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Rational } from '../time.ts';

export const LAYERED_IMPORT_MODES = ['merged-all', 'merged', 'individual', 'sequence'] as const;
export type LayeredImportMode = (typeof LAYERED_IMPORT_MODES)[number];

/** A layer as the engine extracted it (`LayeredLayer` of @jasper/api) with the asset its picture registers as. */
export type LayeredImportLayer = {
	index: number;
	name: string;
	kind: 'pixel' | 'group' | 'text' | 'shape' | 'adjustment' | 'smart-object' | 'empty';
	visible: boolean;
	opacity: number;
	blendMode: string;
	clipping: boolean;
	left: number;
	top: number;
	width: number;
	height: number;
	/** The layer picture's asset (without id), null for groups / empty / adjustment layers. */
	asset: Omit<MediaAsset, 'id' | 'importedAt' | 'derivation'> | null;
	children?: LayeredImportLayer[];
	notes?: string[];
};

/** Photoshop blend mode names (`linear-dodge`…) → the editor's blend modes (`add`…). */
export function layeredBlendMode(mode: string): string {
	if (mode === 'linear-dodge') return 'add';
	if (mode === 'pass-through') return 'normal';
	return mode;
}

/** Every layer of the tree (depth-first, bottom to top). */
export function flattenLayers(layers: readonly LayeredImportLayer[]): LayeredImportLayer[] {
	const out: LayeredImportLayer[] = [];
	const walk = (ls: readonly LayeredImportLayer[], depth: number) => {
		if (depth > 64) return;
		for (const l of ls) {
			out.push(l);
			if (l.children) walk(l.children, depth + 1);
		}
	};
	walk(layers, 0);
	return out;
}

export type LayeredImportInput = {
	/** The document's name (bin and sequence names). */
	docName: string;
	documentSize: { width: number; height: number };
	frameRate: Rational;
	layers: readonly LayeredImportLayer[];
	/** Layer indexes to import (default: every layer with a picture). Groups follow their children. */
	selected?: ReadonlySet<number>;
	mode: 'individual' | 'sequence';
	/** Bin to create the import bin in (null = root). */
	binId?: string | null;
	now: string;
	/** Prefix of the temp refs (several documents in one transaction need different ones). Default `$l`. */
	refPrefix?: string;
};

/** Whether a group must become a nested sequence (its blend mode, opacity or mask isolate it). */
const isolated = (g: LayeredImportLayer) =>
	g.blendMode !== 'pass-through' || g.opacity < 1 - 1e-6 || (g.notes ?? []).some((n) => n.includes('group mask'));

/**
 * The commands that import the layers: a bin "<doc> Layers" holding one media item per chosen layer, and for
 * `sequence` mode a sequence named after the document (document size, `frameRate`) with every layer on its own track
 * (bottom layer on V1) at its position, with its opacity, blend mode and visibility; layers clipped to the layer below
 * (Photoshop clipping masks) read that layer's track through a Track Matte Key (Matte Alpha); groups that isolate
 * (blend mode other than Pass Through, opacity, group mask) become nested sequences, the others are flattened into the
 * parent. Temp refs (prefix `$l`): `$lbin`, `$lseq`, `$lm<i>` (media), `$lseq…t<i>` / `$lseq…c<i>` (track / clip).
 */
export function layeredImportCommands(input: LayeredImportInput): { commands: Command[]; notes: string[] } {
	const commands: Command[] = [];
	const notes: string[] = [];
	const all = flattenLayers(input.layers);
	const P = input.refPrefix ?? '$l';
	const chosen = (l: LayeredImportLayer) => !input.selected || input.selected.has(l.index);
	commands.push({
		type: 'bin.create',
		name: `${input.docName} Layers`,
		parentBinId: input.binId ?? null,
		ref: `${P}bin`,
	} as Command);
	for (const l of all) {
		if (!l.asset || !chosen(l)) continue;
		commands.push({
			type: 'media.register',
			asset: {
				...JSON.parse(JSON.stringify(l.asset)),
				importedAt: input.now,
				derivation: null,
				layerSource: {
					document: input.docName,
					name: l.name,
					index: l.index,
					...(groupPath(input.layers, l.index).length ? { groups: groupPath(input.layers, l.index) } : {}),
				},
			},
			binId: `${P}bin`,
			name: l.name,
			ref: `${P}m${l.index}`,
		} as Command);
		for (const n of l.notes ?? []) notes.push(`${l.name}: ${n}`);
	}
	if (input.mode === 'individual') return { commands, notes };
	stack(input, input.layers, `${P}seq`, input.docName, commands, notes, chosen, 0, P);
	return { commands, notes };
}

/** The names of the groups enclosing layer `index` (outermost first). */
function groupPath(layers: readonly LayeredImportLayer[], index: number): string[] {
	const path: string[] = [];
	const find = (ls: readonly LayeredImportLayer[]): boolean => {
		for (const l of ls) {
			if (l.index === index) return true;
			if (l.children) {
				path.push(l.name);
				if (find(l.children)) return true;
				path.pop();
			}
		}
		return false;
	};
	find(layers);
	return path;
}

/** Layers of a (sub)tree in drawing order (bottom first), with pass-through groups flattened into it. */
function drawList(layers: readonly LayeredImportLayer[]): LayeredImportLayer[] {
	const out: LayeredImportLayer[] = [];
	for (const l of layers) {
		if (l.kind === 'group' && l.children && !isolated(l)) out.push(...drawList(l.children));
		else out.push(l);
	}
	return out;
}

function stack(
	input: LayeredImportInput,
	layers: readonly LayeredImportLayer[],
	seqRef: string,
	name: string,
	commands: Command[],
	notes: string[],
	chosen: (l: LayeredImportLayer) => boolean,
	depth: number,
	P: string,
): boolean {
	if (depth > 32) return false;
	const list = drawList(layers).filter(
		(l) => (l.kind === 'group' ? !!l.children?.length && flattenLayers(l.children).some((c) => c.asset && chosen(c)) : l.asset && chosen(l)),
	);
	if (!list.length) return false;
	commands.push({
		type: 'sequence.create',
		name,
		settings: {
			width: Math.max(16, input.documentSize.width - (input.documentSize.width % 2)),
			height: Math.max(16, input.documentSize.height - (input.documentSize.height % 2)),
			frameRate: input.frameRate,
		},
		binId: `${P}bin`,
		tracks: { video: 1, audio: 1 },
		ref: seqRef,
	} as Command);
	let baseTrack: string | null = null;
	list.forEach((l, i) => {
		const track = `${seqRef}t${l.index}`;
		// One track per layer, appended above the ones before (the sequence's empty V1 is removed at the end).
		commands.push({ type: 'track.add', sequenceId: seqRef, kind: 'video', ref: track } as Command);
		void i;
		const clipRef = `${seqRef}c${l.index}`;
		let source: Record<string, string>;
		let w: number;
		let h: number;
		if (l.kind === 'group') {
			const sub = `${seqRef}g${l.index}`;
			stack(input, l.children ?? [], sub, `${name} ▸ ${l.name}`, commands, notes, chosen, depth + 1, P);
			source = { sequenceId: sub };
			w = input.documentSize.width;
			h = input.documentSize.height;
		} else {
			source = { mediaId: `${P}m${l.index}` };
			w = l.width;
			h = l.height;
		}
		commands.push({
			type: 'clip.place',
			sequenceId: seqRef,
			source,
			at: 0,
			tracks: { video: track },
			video: true,
			audio: false,
			matchSequence: 'keep',
			scaling: 'none',
			...(l.kind === 'group' ? { nest: true } : {}),
			ref: clipRef,
		} as Command);
		// Default anchor = the box centre: the picture's centre goes where it sits in the document.
		commands.push({
			type: 'param.set',
			target: ['clip', clipRef, 'transform', 'position'],
			value: l.kind === 'group' ? [w / 2, h / 2] : [l.left + w / 2, l.top + h / 2],
		} as Command);
		if (l.opacity < 1 - 1e-6)
			commands.push({
				type: 'param.set',
				target: ['clip', clipRef, 'opacity'],
				value: Math.round(l.opacity * 10000) / 100,
			} as Command);
		const blend = layeredBlendMode(l.blendMode);
		const update: Record<string, unknown> = {};
		if (blend !== 'normal') update.blendMode = blend;
		if (!l.visible) update.enabled = false;
		if (Object.keys(update).length)
			commands.push({ type: 'clip.update', clipId: clipRef, patch: update } as Command);
		if (l.clipping && baseTrack)
			commands.push({
				type: 'effect.add',
				target: { clipId: clipRef },
				effectId: 'jasper.track-matte-key',
				params: { matteTrack: baseTrack, compositeUsing: 'matteAlpha', reverse: false },
			} as Command);
		else if (l.clipping) notes.push(`${l.name}: clipped to nothing (no layer below it)`);
		if (!l.clipping) baseTrack = track;
	});
	// The empty V1 `sequence.create` made (the layers got their own tracks above it).
	commands.push({ type: 'track.remove', sequenceId: seqRef, trackIds: ['V1'] } as Command);
	return true;
}
