// Motion-graphic templates in the engine (wp-m2-anime-templates, S11:ATP-008/010, FIX-008): which clips are anime
// templates (drawn by Remotion, baked by the layer-bake extension, never rendered by jasper-mg) and which reference
// templates this build does not have (they block every export path instead of exporting the placeholder card).
import {
	isAnimeTemplate,
	type MgRegistry,
	mgRegistry,
	socialCommentUnavailableVariant,
	VARIANT_LABELS,
} from '@jasper/mg-templates';
import type { RenderSnapshot, RenderVisualClip } from '@jasper/project';

type MgClip = Pick<RenderVisualClip, 'source'>;

function mgOf(c: MgClip) {
	return 'mg' in c.source ? c.source.mg : null;
}

/**
 * True for motion-graphic clips drawn by anime.js: the registry definition decides for installed templates, the
 * clip's renderer stamp for the others (S11:ATP-002).
 */
export function isAnimeTemplateClip(c: MgClip, registry: MgRegistry = mgRegistry): boolean {
	const mg = mgOf(c);
	if (!mg) return false;
	const def = registry.getDefinition(mg.template.id, mg.template.version);
	return def ? isAnimeTemplate(def) : mg.renderer === 'anime';
}

export type MissingTemplate = { clipId: string; name: string; template: string };

/** Motion-graphic clips of a snapshot whose template (or social-comment card style) is not installed (S11:ATP-010). */
export function missingTemplates(
	snapshot: RenderSnapshot,
	registry: MgRegistry = mgRegistry,
): MissingTemplate[] {
	const out: MissingTemplate[] = [];
	for (const t of snapshot.videoTracks)
		for (const c of t.clips) {
			const mg = mgOf(c);
			if (!mg) continue;
			const key = `${mg.template.id}@${mg.template.version}`;
			if (!registry.getDefinition(mg.template.id, mg.template.version))
				out.push({ clipId: c.clipId, name: c.name, template: key });
			else if (key === 'social-comment@1') {
				// a social-comment card style this build does not draw yet (its preview is a "not available" card)
				const variant = socialCommentUnavailableVariant(mg.params);
				if (variant)
					out.push({ clipId: c.clipId, name: c.name, template: `${key} (${VARIANT_LABELS[variant]} card)` });
			}
		}
	return out;
}

/** "template id@vN is not installed" (one line per template). */
export function missingTemplatesMessage(missing: readonly MissingTemplate[]): string {
	const templates = [...new Set(missing.map((m) => m.template))];
	return templates.length === 1
		? `Motion-graphic template ${templates[0]} is not installed`
		: `Motion-graphic templates ${templates.join(', ')} are not installed`;
}

/** Plan error code for exports/stills that reference templates this build lacks. */
export const TEMPLATE_NOT_INSTALLED = 'TEMPLATE_NOT_INSTALLED';

/** Error detail of a TEMPLATE_NOT_INSTALLED plan error (per-clip blockers, every path). */
export function missingTemplatesDetail(missing: readonly MissingTemplate[]) {
	return {
		blockers: missing.map((m) => ({
			itemId: m.clipId,
			path: 'native' as const,
			reason: `template ${m.template} is not installed (clip "${m.name}")`,
		})),
		hint: 'Install a JasperEditor build that ships these templates, or delete or replace the clips.',
	};
}
