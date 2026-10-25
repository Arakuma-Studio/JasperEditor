// social-comment §7.8: template fonts / emoji in engine renders. Snapshots resolve a template's declared faces against
// the bundled catalogue, then the remote manifest, and its emoji against the manifest's packs; before anything renders
// the planner downloads what is remote (network policy permitting) and blocks the export, naming the font or the emoji
// and its pack, when something is unavailable — never a silent substitute (AGENTS §4).
import { REMOTE_FONT_PREFIX, type RemoteAssetMissing, type RemoteAssetPrefetchRequest } from '@jasper/api';
import { mgRegistry, templateAssetOptions } from '@jasper/mg-templates';
import type { RenderSnapshot, RenderVisualClip, SnapshotOptions } from '@jasper/project';
import type { FontCatalogService } from '../fonts/catalog.ts';

/** PlanError code of exports that need an unavailable template font or emoji. */
export const TEMPLATE_ASSETS_UNAVAILABLE = 'TEMPLATE_ASSETS_UNAVAILABLE';

/**
 * `SnapshotOptions.templateAssets` of engine renders: engine-relative URLs (`sign` makes them absolute signed URLs for
 * the headless browser).
 */
export function engineTemplateAssets(
	fonts: FontCatalogService,
	sign: (path: string) => string = (p) => p,
): NonNullable<SnapshotOptions['templateAssets']> {
	return templateAssetOptions(mgRegistry, {
		font: (face) => fonts.templateFaceFiles(face)?.map((f) => ({ ...f, url: sign(f.url) })) ?? null,
		emoji: (pack, grapheme) => {
			const url = fonts.remote?.emojiUrl(pack, grapheme) ?? null;
			return url ? sign(url) : null;
		},
	});
}

/** One unavailable asset of a plan, by clip. */
export type TemplateAssetIssue = {
	clipIds: string[];
	kind: 'font' | 'emoji';
	/** `font "Chirp" 700`, `emoji 😀 of the apple pack`. */
	label: string;
	reason: string;
	code: string;
	retryable: boolean;
};

type Clip = Pick<RenderVisualClip, 'clipId' | 'name' | 'source'>;

const faceKey = (f: { family: string; weight: number; style: string }) =>
	`${f.family.toLowerCase()}|${f.weight}|${f.style}`;
const faceLabel = (f: { family: string; weight: number; style: string }) =>
	`font "${f.family}" ${f.weight}${f.style === 'italic' ? ' italic' : ''}`;

/**
 * Checks (and downloads) every template font and emoji the clips draw. Unresolvable ones (not bundled, not in the
 * manifest) and failed downloads are returned as issues; an empty list means every asset is cached or bundled.
 */
export async function checkTemplateAssets(
	snapshot: Pick<RenderSnapshot, 'fonts' | 'emoji'>,
	clips: readonly Clip[],
	fonts: FontCatalogService,
): Promise<TemplateAssetIssue[]> {
	const issues = new Map<string, TemplateAssetIssue>();
	const add = (key: string, clipId: string, i: Omit<TemplateAssetIssue, 'clipIds'>) => {
		const hit = issues.get(key);
		if (hit) {
			if (!hit.clipIds.includes(clipId)) hit.clipIds.push(clipId);
		} else issues.set(key, { ...i, clipIds: [clipId] });
	};
	const resolvedFaces = new Set(snapshot.fonts.filter((f) => f.fontId.startsWith('template:')).map(faceKey));
	const emojiTable = snapshot.emoji ?? {};
	const req: Required<Pick<RemoteAssetPrefetchRequest, 'fonts'>> & {
		emoji: { pack: string; graphemes: string[] }[];
	} = { fonts: [], emoji: [] };
	const users = new Map<string, string[]>();
	const use = (key: string, clipId: string) => {
		const list = users.get(key) ?? [];
		if (!list.includes(clipId)) list.push(clipId);
		users.set(key, list);
		return list.length === 1;
	};
	for (const c of clips) {
		const assets = 'mg' in c.source ? c.source.mg.assets : undefined;
		if (!assets) continue;
		for (const face of assets.fonts) {
			const key = `font:${faceKey(face)}`;
			if (!resolvedFaces.has(faceKey(face))) {
				add(key, c.clipId, {
					kind: 'font',
					label: faceLabel(face),
					reason: 'it is neither bundled nor in the remote-asset manifest',
					code: 'REMOTE_ASSET_UNKNOWN',
					retryable: false,
				});
				continue;
			}
			const remote = fonts.templateFaceFiles(face)?.some((f) => f.url.startsWith(REMOTE_FONT_PREFIX));
			if (remote && use(key, c.clipId)) req.fonts.push(face);
		}
		for (const { pack, graphemes } of assets.emoji) {
			for (const g of graphemes) {
				const key = `emoji:${pack}:${g}`;
				if (!(`${pack}:${g}` in emojiTable)) {
					add(key, c.clipId, {
						kind: 'emoji',
						label: `emoji ${g} of the ${pack} pack`,
						reason: fonts.remote?.pack(pack)
							? 'it is not an emoji of that pack'
							: 'the pack is not in the remote-asset manifest',
						code: 'REMOTE_ASSET_UNKNOWN',
						retryable: false,
					});
					continue;
				}
				if (!use(key, c.clipId)) continue;
				let entry = req.emoji.find((e) => e.pack === pack);
				if (!entry) req.emoji.push((entry = { pack, graphemes: [] }));
				entry.graphemes.push(g);
			}
		}
	}
	if ((req.fonts.length || req.emoji.length) && fonts.remote) {
		const r = await fonts.remote.prefetch(req, (face) => fonts.isBundledFace(face));
		for (const m of r.missing) {
			const key = m.kind === 'font' ? `font:${faceKey(m)}` : `emoji:${m.pack}:${m.grapheme}`;
			for (const clipId of users.get(key) ?? [])
				add(key, clipId, {
					kind: m.kind,
					label: missingLabel(m),
					reason: m.error.message,
					code: m.error.code,
					retryable: m.error.retryable,
				});
		}
	} else if (req.fonts.length || req.emoji.length) {
		for (const [key, clipIds] of users)
			for (const clipId of clipIds)
				add(key, clipId, {
					kind: key.startsWith('font:') ? 'font' : 'emoji',
					label: key,
					reason: 'this engine has no remote-asset service',
					code: 'REMOTE_ASSET_UNKNOWN',
					retryable: false,
				});
	}
	return [...issues.values()];
}

function missingLabel(m: RemoteAssetMissing): string {
	return m.kind === 'font' ? faceLabel(m) : `emoji ${m.grapheme} of the ${m.pack} pack`;
}

/** One sentence naming every unavailable asset and the clips that draw it, with what the user can do. */
export function templateAssetsMessage(issues: readonly TemplateAssetIssue[], clips: readonly Clip[]): string {
	const names = new Map(clips.map((c) => [c.clipId, c.name]));
	const parts = issues.slice(0, 6).map((i) => {
		const who = i.clipIds
			.slice(0, 3)
			.map((id) => `"${names.get(id) ?? id}"`)
			.join(', ');
		return `${i.label} (clip ${who}${i.clipIds.length > 3 ? ` +${i.clipIds.length - 3}` : ''}): ${i.reason}`;
	});
	const more = issues.length > 6 ? `; and ${issues.length - 6} more` : '';
	return `Template assets are not available — ${parts.join('; ')}${more}. Retry the download, switch the emoji style, or remove the emoji.`;
}
