// wp speech, client side: what a "Generate Transcript" request covers, the options it remembers, and the commands a
// finished `transcription` job commits (`transcript.attach`, one undo step "Generate Transcript").
import type { SpeechModel, TranscribeOptions, TranscriptionResult } from '@jasper/api';
import {
	type AudioClip,
	type CommandInput,
	type MediaAsset,
	mixFingerprint,
	type ProjectDocument,
	type Sequence,
	transcriptAttachPlan,
	transcriptForMedia,
} from '@jasper/project';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';

/** OpenAI Whisper's languages (tokenizer.py `LANGUAGES`), by ISO 639-1 code (`yue` = Cantonese). */
export const WHISPER_LANGUAGES: ReadonlyArray<[string, string]> = [
	['en', 'English'],
	['zh', 'Chinese'],
	['de', 'German'],
	['es', 'Spanish'],
	['ru', 'Russian'],
	['ko', 'Korean'],
	['fr', 'French'],
	['ja', 'Japanese'],
	['pt', 'Portuguese'],
	['tr', 'Turkish'],
	['pl', 'Polish'],
	['ca', 'Catalan'],
	['nl', 'Dutch'],
	['ar', 'Arabic'],
	['sv', 'Swedish'],
	['it', 'Italian'],
	['id', 'Indonesian'],
	['hi', 'Hindi'],
	['fi', 'Finnish'],
	['vi', 'Vietnamese'],
	['he', 'Hebrew'],
	['uk', 'Ukrainian'],
	['el', 'Greek'],
	['ms', 'Malay'],
	['cs', 'Czech'],
	['ro', 'Romanian'],
	['da', 'Danish'],
	['hu', 'Hungarian'],
	['ta', 'Tamil'],
	['no', 'Norwegian'],
	['th', 'Thai'],
	['ur', 'Urdu'],
	['hr', 'Croatian'],
	['bg', 'Bulgarian'],
	['lt', 'Lithuanian'],
	['la', 'Latin'],
	['mi', 'Maori'],
	['ml', 'Malayalam'],
	['cy', 'Welsh'],
	['sk', 'Slovak'],
	['te', 'Telugu'],
	['fa', 'Persian'],
	['lv', 'Latvian'],
	['bn', 'Bengali'],
	['sr', 'Serbian'],
	['az', 'Azerbaijani'],
	['sl', 'Slovenian'],
	['kn', 'Kannada'],
	['et', 'Estonian'],
	['mk', 'Macedonian'],
	['br', 'Breton'],
	['eu', 'Basque'],
	['is', 'Icelandic'],
	['hy', 'Armenian'],
	['ne', 'Nepali'],
	['mn', 'Mongolian'],
	['bs', 'Bosnian'],
	['kk', 'Kazakh'],
	['sq', 'Albanian'],
	['sw', 'Swahili'],
	['gl', 'Galician'],
	['mr', 'Marathi'],
	['pa', 'Punjabi'],
	['si', 'Sinhala'],
	['km', 'Khmer'],
	['sn', 'Shona'],
	['yo', 'Yoruba'],
	['so', 'Somali'],
	['af', 'Afrikaans'],
	['oc', 'Occitan'],
	['ka', 'Georgian'],
	['be', 'Belarusian'],
	['tg', 'Tajik'],
	['sd', 'Sindhi'],
	['gu', 'Gujarati'],
	['am', 'Amharic'],
	['yi', 'Yiddish'],
	['lo', 'Lao'],
	['uz', 'Uzbek'],
	['fo', 'Faroese'],
	['ht', 'Haitian Creole'],
	['ps', 'Pashto'],
	['tk', 'Turkmen'],
	['nn', 'Nynorsk'],
	['mt', 'Maltese'],
	['sa', 'Sanskrit'],
	['lb', 'Luxembourgish'],
	['my', 'Myanmar'],
	['bo', 'Tibetan'],
	['tl', 'Tagalog'],
	['mg', 'Malagasy'],
	['as', 'Assamese'],
	['tt', 'Tatar'],
	['haw', 'Hawaiian'],
	['ln', 'Lingala'],
	['ha', 'Hausa'],
	['ba', 'Bashkir'],
	['jw', 'Javanese'],
	['su', 'Sundanese'],
	['yue', 'Cantonese'],
];

export const languageName = (code: string): string =>
	WHISPER_LANGUAGES.find(([c]) => c === code)?.[1] ?? code;

/** Options of the Generate Transcript dialog (remembered between uses). */
export type GenerateOptions = Required<Pick<TranscribeOptions, 'model' | 'language' | 'task'>> & {
	speakerLabels: boolean;
	/** 0 = automatic. */
	speakerCount: number;
	/** Sequences: a transcript per clip media (`media`) or the sequence's mixed audio (`mix`). */
	analysis: 'media' | 'mix';
	/** Mix: only the In/Out range. */
	inOutOnly: boolean;
	/** Re-transcribe media that already have a transcript (otherwise they are skipped). */
	replace: boolean;
	/** spec 16 SG-010: Standard (greedy) or Best (beam 5); null = the Transcription preference. */
	accuracy: 'standard' | 'best' | null;
	/** spec 14 TC-003: keep filler words (a verbatim prompt in the language). */
	verbatim: boolean;
};

const KEY = 'jasper:speech-options';

export function defaultOptions(model = 'whisper-small'): GenerateOptions {
	return {
		model,
		language: 'auto',
		task: 'transcribe',
		speakerLabels: false,
		speakerCount: 0,
		analysis: 'media',
		inOutOnly: false,
		replace: true,
		accuracy: null,
		verbatim: false,
	};
}

export function parseGenerateOptions(value: unknown, defaultModel: string): GenerateOptions {
	const base = defaultOptions(defaultModel);
	const parsed = z
		.object({
			model: z.string().min(1).catch(base.model),
			language: z.string().min(1).catch(base.language),
			task: z.enum(['transcribe', 'translate']).catch(base.task),
			speakerLabels: z.boolean().catch(base.speakerLabels),
			speakerCount: z.number().int().min(0).max(32).catch(base.speakerCount),
			analysis: z.enum(['media', 'mix']).catch(base.analysis),
			inOutOnly: z.boolean().catch(base.inOutOnly),
			replace: z.boolean().catch(base.replace),
			accuracy: z.enum(['standard', 'best']).nullable().catch(base.accuracy),
			verbatim: z.boolean().catch(base.verbatim),
		})
		.safeParse(value);
	return parsed.success ? parsed.data : base;
}

export function loadOptions(defaultModel: string): GenerateOptions {
	const base = defaultOptions(defaultModel);
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		return parseGenerateOptions(raw ? JSON.parse(raw) : null, defaultModel);
	} catch {
		return base;
	}
}

export function saveOptions(o: GenerateOptions): void {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(o));
	} catch {
		/* storage unavailable */
	}
}

/** The engine request options of the dialog options. */
export function requestOptions(o: GenerateOptions, multilingual: boolean): TranscribeOptions {
	return {
		model: o.model,
		...(multilingual && o.language !== 'auto' ? { language: o.language } : {}),
		...(!multilingual ? { language: 'en' } : {}),
		...(multilingual && o.task === 'translate' ? { task: 'translate' as const } : {}),
		...(o.speakerLabels ? { speakerLabels: true } : {}),
		...(o.speakerLabels && o.speakerCount > 0 ? { speakerCount: o.speakerCount } : {}),
		...(o.accuracy ? { accuracy: o.accuracy } : {}),
		...(o.verbatim ? { verbatim: true } : {}),
	};
}

/** "≈ 3.2 min per 10 min of audio (estimated)" / "(measured, last run)" (SG-030). */
export function speedText(m: Pick<SpeechModel, 'speed'>): string | null {
	const s = m.speed;
	if (!s) return null;
	const v = s.minutesPer10Min < 10 ? s.minutesPer10Min.toFixed(1) : String(Math.round(s.minutesPer10Min));
	return s.basis === 'measured'
		? t('{0} min per 10 min of audio (measured, last run)', v)
		: t('≈ {0} min per 10 min of audio (estimated)', v);
}

/** "Runs on: NVIDIA GeForce RTX 3060 (CUDA) encoder · CPU decoder · 8 threads" (SG-030). */
export function runsOnText(m: Pick<SpeechModel, 'runsOn'>): string | null {
	const r = m.runsOn;
	if (!r) return null;
	return t('Runs on: {0} · {1} threads', r.device, r.threads);
}

/** The Project panel name of a sequence. */
export function sequenceName(doc: ProjectDocument, sequenceId: string): string {
	for (const it of Object.values(doc.items) as Array<{ kind: string; sequenceId?: string; name?: string }>)
		if (it.kind === 'sequence' && it.sequenceId === sequenceId && it.name) return it.name;
	return 'Sequence';
}

/** Whether a media can be transcribed (it has an audio stream). */
export function hasAudio(m: MediaAsset | undefined): boolean {
	if (!m) return false;
	return m.probe.streams.some((stream) => stream.type === 'audio');
}

/** The media a sequence's enabled audio clips play (in timeline order), and those with a transcript already. */
export function sequenceMedia(doc: ProjectDocument, seq: Sequence): { all: string[]; transcribed: string[] } {
	const clips = Object.values(seq.clips)
		.filter((c): c is AudioClip => c.kind === 'audio' && c.enabled)
		.sort((a, b) => a.start - b.start);
	const all = [...new Set(clips.map((c) => c.mediaId))].filter((id) => hasAudio(doc.media[id]));
	return { all, transcribed: all.filter((id) => !!transcriptForMedia(doc, id)) };
}

/** The media of timeline clips (audio and video clips), deduplicated. */
export function clipMedia(doc: ProjectDocument, clipIds: readonly string[]): string[] {
	const out: string[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const id of clipIds) {
			const c = seq.clips[id];
			if (c && (c.kind === 'audio' || c.kind === 'video') && c.mediaId && !out.includes(c.mediaId))
				out.push(c.mediaId);
		}
	return out.filter((id) => hasAudio(doc.media[id]));
}

type Attach = { commands: CommandInput[]; summary: string } | { error: string };

/** `transcript.attach` for a finished media job. */
export function mediaAttach(
	doc: ProjectDocument,
	mediaId: string,
	res: TranscriptionResult,
	mode: 'replace' | 'keep',
): Attach {
	const plan = transcriptAttachPlan(doc, res, { mediaId, replace: mode === 'replace' });
	if ('error' in plan) return plan;
	return {
		commands: plan.commands,
		summary: `${res.words.length} words · ${languageName(res.language)}${res.task === 'translate' ? ' → English' : ''}${
			Object.keys(res.speakers).length > 1 ? ` · ${Object.keys(res.speakers).length} speakers` : ''
		}`,
	};
}

/** `transcript.attach` per media heard in a sequence-mix result (refused when the sequence changed since). */
export function mixAttach(doc: ProjectDocument, res: TranscriptionResult, replace: boolean): Attach {
	if (res.target.type !== 'sequence') return { error: 'not a sequence result' };
	const plan = transcriptAttachPlan(doc, res, {
		replace,
		currentMixHash: doc.sequences[res.target.sequenceId] ? mixFingerprint(doc, res.target.sequenceId) : '',
	});
	if ('error' in plan) return plan;
	const words = plan.media.reduce((s, m) => s + m.words, 0);
	return {
		commands: plan.commands,
		summary: `${words} words for ${plan.media.length} media · ${languageName(res.language)}${
			plan.unassigned ? ` · ${plan.unassigned} words outside the audio clips were dropped` : ''
		}`,
	};
}
