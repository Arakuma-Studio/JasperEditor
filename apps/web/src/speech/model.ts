// wp speech, client side: what a "Generate Transcript" request covers, the options it remembers, and the commands a
// finished `transcription` job commits (`transcript.attach`, one undo step "Generate Transcript").
import type { TranscribeOptions, TranscriptionResult } from '@jasper/api';
import {
	type Command,
	type MediaAsset,
	mixFingerprint,
	type ProjectDocument,
	type Sequence,
	transcriptAttachPlan,
	transcriptForMedia,
} from '@jasper/project';

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
};

const KEY = 'jasper:speech-options';

export function defaultOptions(model = 'whisper-base'): GenerateOptions {
	return {
		model,
		language: 'auto',
		task: 'transcribe',
		speakerLabels: false,
		speakerCount: 0,
		analysis: 'media',
		inOutOnly: false,
		replace: true,
	};
}

export function loadOptions(defaultModel: string): GenerateOptions {
	const base = defaultOptions(defaultModel);
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		const v = raw ? (JSON.parse(raw) as Partial<GenerateOptions>) : null;
		return v && typeof v === 'object' ? { ...base, ...v } : base;
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
	};
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
	const probe = m.probe as { streams?: Array<{ type?: string }> } | undefined;
	if (probe?.streams) return probe.streams.some((s) => s.type === 'audio');
	return m.kind === 'audio' || m.kind === 'video';
}

/** The media a sequence's enabled audio clips play (in timeline order), and those with a transcript already. */
export function sequenceMedia(doc: ProjectDocument, seq: Sequence): { all: string[]; transcribed: string[] } {
	const clips = Object.values(seq.clips)
		.filter((c) => c.kind === 'audio' && c.enabled)
		.sort((a, b) => a.start - b.start) as Array<{ mediaId: string }>;
	const all = [...new Set(clips.map((c) => c.mediaId))].filter((id) => hasAudio(doc.media[id] as MediaAsset));
	return { all, transcribed: all.filter((id) => !!transcriptForMedia(doc, id)) };
}

/** The media of timeline clips (audio and video clips), deduplicated. */
export function clipMedia(doc: ProjectDocument, clipIds: readonly string[]): string[] {
	const out: string[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const id of clipIds) {
			const c = seq.clips[id] as { kind: string; mediaId?: string } | undefined;
			if (c && (c.kind === 'audio' || c.kind === 'video') && c.mediaId && !out.includes(c.mediaId))
				out.push(c.mediaId);
		}
	return out.filter((id) => hasAudio(doc.media[id] as MediaAsset));
}

type Attach = { commands: Command[]; summary: string } | { error: string };

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
		commands: plan.commands as unknown as Command[],
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
		commands: plan.commands as unknown as Command[],
		summary: `${words} words for ${plan.media.length} media · ${languageName(res.language)}${
			plan.unassigned ? ` · ${plan.unassigned} words outside the audio clips were dropped` : ''
		}`,
	};
}
