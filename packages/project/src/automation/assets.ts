// Asset roles of the overlay passes (spec 15 EA-011, EA-023, EA-025): the reaction images and the music playlist are
// the user's own files — a project bin (by id or name, recipes store names), an engine-local folder (the engine lists
// and probes its files; the proposal's setup items add them to the project, in a bin named after the role) and / or
// explicit project media. Nothing is shipped. Pure: the engine passes the folder's registrations in.
import { mediaDisplaySize, mediaDurationFlicks } from '../interpret/model.ts';
import type { ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { SOUND_PROPOSAL_SETUP_GROUP } from '../sound/proposal-draft.ts';
import { AutomationInputError } from './common.ts';
import type { AutomationAssets } from './params.ts';

/** What a pass uses an asset as. */
export type AssetRole = 'image' | 'audio';

/** Most assets a pass takes from its sources (a playlist or a reaction set). */
export const MAX_PASS_ASSETS = 256;

/** A file of an engine folder, probed: its registration command (`mediaRegisterCommand` of `@jasper/api`). */
export type FolderAsset = {
	/** File name (with extension); folder order = sorted by name. */
	name: string;
	fingerprint: string;
	/** A `media.register` command (asset with probe and locators); its refs are replaced here. */
	register: { type: 'media.register'; asset: Record<string, unknown> & { kind: string }; name?: string };
};

/** An asset a pass places. */
export type PassAsset = {
	/** Stable key: the project media id, or `file:<name>` for a folder file not in the project yet. */
	key: string;
	/** What commands name: a project media id, or the `$ref` its setup item defines. */
	mediaRef: string;
	/** Display name (the file name without its extension). */
	name: string;
	width: number | null;
	height: number | null;
	durationFlicks: number | null;
	/** The setup item that adds it to the project (folder files), else null. */
	setup: string | null;
};

export type ResolvedAssets = {
	assets: PassAsset[];
	setup: ProposalItemInput[];
	warnings: { code: string; message: string }[];
};

const baseName = (n: string) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || n;

function kindFits(kind: unknown, role: AssetRole): boolean {
	return role === 'image' ? kind === 'image' : kind === 'audio';
}

/** A bin by id, else the first bin with that name (case-insensitive), depth first from the root. */
export function findBin(doc: ProjectDocument, ref: string): string | null {
	const direct = doc.items?.[ref];
	if (direct?.kind === 'bin') return direct.id;
	const want = ref.trim().toLowerCase();
	const seen = new Set<string>();
	const visit = (ids: readonly string[], depth: number): string | null => {
		if (depth > 32) return null;
		for (const id of ids) {
			const it = doc.items?.[id];
			if (it?.kind !== 'bin' || seen.has(id)) continue;
			seen.add(id);
			if (it.name.trim().toLowerCase() === want) return it.id;
			const r = visit(Array.isArray(it.children) ? it.children : [], depth + 1);
			if (r) return r;
		}
		return null;
	};
	return visit(doc.rootItems ?? [], 0);
}

/** Media ids in a bin and its sub-bins (bin order, depth first, cycle-safe). */
export function binMediaIds(doc: ProjectDocument, binId: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string, depth: number) => {
		if (depth > 32 || seen.has(id) || out.length >= MAX_PASS_ASSETS * 4) return;
		seen.add(id);
		const it = doc.items?.[id];
		if (!it) return;
		if (it.kind === 'media') out.push(it.mediaId);
		else if (it.kind === 'bin')
			for (const c of Array.isArray(it.children) ? it.children : []) visit(c, depth + 1);
	};
	visit(binId, 0);
	return out;
}

function projectAsset(doc: ProjectDocument, mediaId: string, role: AssetRole): PassAsset | null {
	const m = doc.media?.[mediaId];
	if (!m || !kindFits(m.kind, role) || m.derivation) return null;
	let size: { width: number; height: number } | null = null;
	let dur: number | null = null;
	try {
		size = mediaDisplaySize(m as never);
	} catch {
		size = null;
	}
	try {
		dur = mediaDurationFlicks(m as never);
	} catch {
		dur = null;
	}
	const itemName = Object.values(doc.items ?? {}).find(
		(it) => it.kind === 'media' && it.mediaId === mediaId,
	)?.name;
	return {
		key: mediaId,
		mediaRef: mediaId,
		name: baseName(itemName ?? m.originalName ?? mediaId),
		width: size?.width ?? null,
		height: size?.height ?? null,
		durationFlicks: dur,
		setup: null,
	};
}

function rootBin(doc: ProjectDocument, name: string): string | null {
	for (const id of doc.rootItems ?? []) {
		const it = doc.items?.[id];
		if (it?.kind === 'bin' && it.name === name) return it.id;
	}
	return null;
}

/**
 * The assets of a role from its sources: the bin's media, then the folder's files (registered by setup items unless
 * the project has the same file), then the explicit media — of the role's kind, without repeats, at most
 * `MAX_PASS_ASSETS`. `E_NOT_FOUND` for an unknown bin or media id; a source without usable files is a warning.
 */
export function resolveAssets(
	doc: ProjectDocument,
	src: AutomationAssets,
	role: AssetRole,
	opts: { folder?: readonly FolderAsset[]; binName: string; prefix: string },
): ResolvedAssets {
	const out: PassAsset[] = [];
	const setup: ProposalItemInput[] = [];
	const warnings: { code: string; message: string }[] = [];
	const seen = new Set<string>();
	const add = (a: PassAsset | null) => {
		if (!a || seen.has(a.key) || out.length >= MAX_PASS_ASSETS) return;
		seen.add(a.key);
		out.push(a);
	};
	const what = role === 'image' ? 'images' : 'audio files';
	if (src.bin !== undefined) {
		const bin = findBin(doc, src.bin);
		if (!bin) throw new AutomationInputError('E_NOT_FOUND', `Bin not found: ${src.bin}`);
		const before = out.length;
		for (const id of binMediaIds(doc, bin)) add(projectAsset(doc, id, role));
		if (out.length === before)
			warnings.push({ code: 'W_NO_ASSETS', message: `The bin "${src.bin}" holds no ${what}` });
	}
	if (src.folder !== undefined) {
		const files = [...(opts.folder ?? [])]
			.filter((f) => kindFits(f.register?.asset?.kind, role))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (!files.length)
			warnings.push({ code: 'W_NO_ASSETS', message: `The folder holds no ${what} JasperEditor can read` });
		let binRef: string | null = rootBin(doc, opts.binName);
		let n = 0;
		for (const f of files) {
			if (out.length >= MAX_PASS_ASSETS) break;
			const existing = Object.values(doc.media ?? {}).find(
				(m) => m.fingerprint === f.fingerprint && !m.derivation && kindFits(m.kind, role),
			);
			if (existing) {
				add(projectAsset(doc, existing.id, role));
				continue;
			}
			const key = `file:${f.name}`;
			if (seen.has(key)) continue;
			if (!binRef) {
				binRef = `$${opts.prefix}Bin`;
				setup.push({
					id: `${opts.prefix}-bin`,
					label: `Bin "${opts.binName}"`.slice(0, 200),
					group: SOUND_PROPOSAL_SETUP_GROUP,
					commands: [{ type: 'bin.create', name: opts.binName, ref: binRef }],
					meta: { setup: true, kind: 'bin' },
				});
			}
			const ref = `$${opts.prefix}${n}`;
			const id = `${opts.prefix}-asset-${n}`;
			n++;
			setup.push({
				id,
				label: `Import ${f.name}`.slice(0, 200),
				group: SOUND_PROPOSAL_SETUP_GROUP,
				commands: [
					{
						...f.register,
						type: 'media.register',
						binId: binRef,
						ref,
						itemRef: `${ref}Item`,
					},
				],
				meta: { setup: true, kind: 'media', file: f.name },
				...(binRef.startsWith('$') ? { requires: [`${opts.prefix}-bin`] } : {}),
			});
			const asset = f.register.asset as Parameters<typeof mediaDisplaySize>[0];
			let size: { width: number; height: number } | null = null;
			let dur: number | null = null;
			try {
				size = mediaDisplaySize(asset);
				dur = mediaDurationFlicks(asset);
			} catch {
				// unreadable probe: placed with defaults
			}
			add({
				key,
				mediaRef: ref,
				name: baseName(f.name),
				width: size?.width ?? null,
				height: size?.height ?? null,
				durationFlicks: dur,
				setup: id,
			});
		}
	}
	for (const id of src.mediaIds ?? []) {
		if (!doc.media?.[id]) throw new AutomationInputError('E_NOT_FOUND', `Media not found: ${id}`);
		const a = projectAsset(doc, id, role);
		if (!a) warnings.push({ code: 'W_ASSET_KIND', message: `Media ${id} is not one of the ${what}` });
		add(a);
	}
	// a setup item no kept asset needs is dropped (a repeat of a project file)
	const used = new Set(out.map((a) => a.setup).filter(Boolean));
	const kept = setup.filter((s) => s.id.endsWith('-bin') || used.has(s.id));
	const binUsed = kept.some((s) => !s.id.endsWith('-bin'));
	return { assets: out, setup: binUsed ? kept : kept.filter((s) => !s.id.endsWith('-bin')), warnings };
}
