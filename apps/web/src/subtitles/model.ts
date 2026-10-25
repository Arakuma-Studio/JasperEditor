// spec 13 AS-040 / AS-022: the Create Subtitles dialog's model — the options (persisted per user), the templates
// it offers (built-ins, the project's copies, the user library), the `captions.generate` command it sends, and the
// preview: the same command applied to a copy of the document (pure), so the counts and the rendered first subtitle
// are exactly what Create will make.
import {
	applyTransaction,
	BUILTIN_SUBTITLE_TEMPLATES,
	type CommandInput,
	type CutAwareInput,
	createRandomIdSource,
	defaultRegistries,
	GENERIC_SUBTITLE_RULES,
	GENERIC_SUBTITLE_TEXT,
	type ProjectDocument,
	projectSubtitleTemplates,
	resolveCutAware,
	resolveSubtitleRules,
	resolveSubtitleText,
	type SubtitleRules,
	type SubtitleRulesInput,
	type SubtitleTemplate,
	type SubtitleText,
	type SubtitleTextInput,
} from '@jasper/project';
import { z } from 'zod';

export type SubtitleSourceChoice =
	| { kind: 'sequence' }
	| { kind: 'media'; mediaId: string }
	| { kind: 'clips'; clipIds: string[] };

export type CreateSubtitlesOptions = {
	templateId: string;
	output: 'template' | 'text-clips' | 'caption-track';
	/** Overrides of the template's rules / text transforms (absent field = the template's default). */
	rules: SubtitleRulesInput;
	text: SubtitleTextInput;
	cutAware: CutAwareInput;
	language: string;
	nest: boolean;
	inOutOnly: boolean;
};

export const DEFAULT_CREATE_OPTIONS: CreateSubtitlesOptions = {
	templateId: 'builtin:pixel-pop',
	output: 'template',
	rules: {},
	text: {},
	cutAware: {},
	language: '',
	nest: false,
	inOutOnly: false,
};

const OPTIONS_KEY = 'jasper:create-subtitles';

const StoredOptions = z.object({
	templateId: z.string().min(1).max(80).catch(DEFAULT_CREATE_OPTIONS.templateId),
	output: z.enum(['template', 'text-clips', 'caption-track']).catch('template'),
	language: z.string().max(35).catch(''),
	nest: z.boolean().catch(false),
	inOutOnly: z.boolean().catch(false),
});

/** The last choices (template, output, language, nest) — rule overrides start from the template each time. */
export function loadCreateOptions(): CreateSubtitlesOptions {
	try {
		const raw = globalThis.localStorage?.getItem(OPTIONS_KEY);
		const v = StoredOptions.safeParse(raw ? JSON.parse(raw) : {});
		if (v.success) return { ...DEFAULT_CREATE_OPTIONS, ...v.data };
	} catch {
		/* storage unavailable or malformed: defaults */
	}
	return { ...DEFAULT_CREATE_OPTIONS };
}

export function saveCreateOptions(o: CreateSubtitlesOptions): void {
	try {
		const { templateId, output, language, nest, inOutOnly } = o;
		globalThis.localStorage?.setItem(
			OPTIONS_KEY,
			JSON.stringify({ templateId, output, language, nest, inOutOnly }),
		);
	} catch {
		/* storage unavailable */
	}
}

export type TemplateEntry = { template: SubtitleTemplate; origin: 'built-in' | 'project' | 'library' };

/** Every template the dialog offers: built-ins, then the project's copies, then the user library (by id, first wins). */
export function availableTemplates(
	doc: ProjectDocument,
	library: readonly SubtitleTemplate[],
): TemplateEntry[] {
	const out: TemplateEntry[] = [];
	const seen = new Set<string>();
	const add = (template: SubtitleTemplate, origin: TemplateEntry['origin']) => {
		if (seen.has(template.id)) return;
		seen.add(template.id);
		out.push({ template, origin });
	};
	for (const t of BUILTIN_SUBTITLE_TEMPLATES) add(t, 'built-in');
	for (const t of Object.values(projectSubtitleTemplates(doc))) add(t, 'project');
	for (const t of library) add(t, 'library');
	return out;
}

/** The template's own defaults, and the generic (Premiere-like) ones, for the two rule columns. */
export function ruleColumns(t: SubtitleTemplate | null): {
	generic: SubtitleRules;
	template: SubtitleRules;
	genericText: SubtitleText;
	templateText: SubtitleText;
} {
	return {
		generic: { ...GENERIC_SUBTITLE_RULES },
		template: resolveSubtitleRules(undefined, t?.rules ?? {}),
		genericText: { ...GENERIC_SUBTITLE_TEXT },
		templateText: resolveSubtitleText(undefined, (t?.text ?? {}) as Partial<SubtitleText>),
	};
}

/** The cut awareness the dialog shows (template defaults under the user's overrides). */
export function effectiveCutAware(t: SubtitleTemplate | null, o: CutAwareInput) {
	return resolveCutAware(o, (t?.cutAware ?? {}) as never);
}

/** The `captions.generate` command of the dialog's choices. */
export function generateCommand(
	o: CreateSubtitlesOptions,
	ctx: {
		sequenceId: string;
		source: SubtitleSourceChoice;
		range: { start: number; end: number } | null;
		template: SubtitleTemplate | null;
	},
	dryRun = false,
): CommandInput {
	const t = ctx.template;
	const templateRef: string | Record<string, unknown> | undefined = t
		? t.builtIn
			? t.id
			: (t as unknown as Record<string, unknown>)
		: undefined;
	return {
		type: 'captions.generate',
		sequenceId: ctx.sequenceId,
		...(ctx.source.kind === 'media'
			? { source: { mediaId: ctx.source.mediaId } }
			: ctx.source.kind === 'clips'
				? { source: { clipIds: [...ctx.source.clipIds] } }
				: {}),
		...(ctx.range && o.inOutOnly ? { range: { start: ctx.range.start, end: ctx.range.end } } : {}),
		...(o.output !== 'template' ? { output: o.output } : {}),
		...(templateRef !== undefined ? { template: templateRef } : {}),
		...(Object.keys(o.rules).length ? { rules: { ...o.rules } } : {}),
		...(Object.keys(o.text).length ? { text: { ...o.text } } : {}),
		...(Object.keys(o.cutAware).length ? { cutAware: { ...o.cutAware } } : {}),
		...(o.language ? { language: o.language } : {}),
		...(o.nest ? { nest: true } : {}),
		...(dryRun ? { dryRun: true } : {}),
	} as CommandInput;
}

export type GenerationStats = {
	count: number;
	snappedToCuts: number;
	splitAtCuts: number;
	belowMinimum: number;
	merged: number;
	crossing: number;
	warnings: string[];
};

export type GenerationPreview =
	| {
			ok: true;
			stats: GenerationStats;
			/** The document with the subtitles made (for the rendered preview frame). */
			doc: ProjectDocument;
			sequenceId: string;
			/** First subtitle: its clip (text clips) and a frame where the template's animation has settled. */
			first: { clipId: string | null; frame: number; text: string } | null;
	  }
	| { ok: false; code: string; message: string };

/**
 * The dialog's live preview: `captions.generate` applied to a copy of the committed document (pure, nothing is
 * committed), so counts and the preview frame match what Create makes.
 */
export function previewGeneration(doc: ProjectDocument, command: CommandInput): GenerationPreview {
	const { document, result } = applyTransaction(
		doc,
		{ label: 'Create Subtitles (preview)', origin: 'system', commands: [command] },
		{
			ids: createRandomIdSource(),
			now: () => new Date().toISOString(),
			revision: 0,
			registries: defaultRegistries(),
		},
	);
	if (!result.ok) {
		const e = result.errors[0];
		return { ok: false, code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Subtitles cannot be made' };
	}
	const r = result.results[0] as {
		stats: GenerationStats;
		clipIds: string[];
		groupId?: string;
		nestedSequenceId?: string;
	};
	const sequenceId = (command as { sequenceId: string }).sequenceId;
	const seq = document.sequences[sequenceId];
	const firstId = r.clipIds[0] ?? null;
	const c = firstId && !r.nestedSequenceId ? seq?.clips[firstId] : undefined;
	const first = c
		? {
				clipId: c.kind === 'text' ? c.id : null,
				// a few frames in: the pop-in of animated templates has settled after ~10 frames at 60 fps
				frame:
					c.start +
					Math.min(
						c.duration - 1,
						Math.max(0, Math.round((seq!.settings.frameRate.num / seq!.settings.frameRate.den) * 0.2)),
					),
				text: c.kind === 'text' ? c.content.text : '',
			}
		: null;
	return { ok: true, stats: r.stats, doc: document, sequenceId, first };
}

/** Parses a comma / newline separated word list (profanity). */
export function parseWordList(s: string): string[] {
	return [
		...new Set(
			s
				.split(/[,\n]/)
				.map((w) => w.trim())
				.filter((w) => w.length > 0 && w.length <= 64),
		),
	].slice(0, 2000);
}
