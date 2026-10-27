// Spec 17 SC-050…SC-055: `transcript.replaceWords` applies exactly what `planReplaceWords` reports (the transcript
// words, then the subtitle text clips and caption-track words that show them, in the same command: one undo step),
// and `scriptFix.configure` edits the sequence's persisted Fix Transcript state. docs/wp-notes/script-correction.md
// "Applying fixes".
import type { Draft } from 'immer';
import { computeReplaceWords } from '../../captions/replace-words.ts';
import type { TextClipCaption } from '../../captions/subtitles/model.ts';
import type { ProjectDocument } from '../../schema/document.ts';
import type { TranscriptWord } from '../../schema/media.ts';
import type { Clip } from '../../schema/sequence.ts';
import {
	readSequenceScriptFix,
	SCRIPT_FIX_MAX_REJECTED,
	type SequenceScriptFix,
	scriptFixSettingsOf,
	sequenceScriptFixIssue,
} from '../../script-fix/sequence-state.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import { latest } from '../draft-read.ts';
import type { CommandOf } from '../schemas/index.ts';
import { layoutText } from './clip-core.ts';
import { clone, type HandlerMap } from './util.ts';

export const SCRIPT_FIX_OWNER = 'script-correction';

type DText = Draft<Extract<Clip, { kind: 'text' }>>;

function replaceWords(doc: DDoc, cmd: CommandOf<'transcript.replaceWords'>, h: HandlerContext) {
	const work = computeReplaceWords(latest(doc) as ProjectDocument, cmd);
	const { plan } = work;
	if (!plan.ok) {
		const p = plan.problem!;
		h.fail(p.code, p.message, p.code === 'E_STALE' ? { path: ['edits', String(plan.stale[0]!.index)] } : {});
	}
	const t = doc.transcripts[cmd.transcriptId]!;
	// breaks first (old indices), then the splices from the last (earlier indices stay valid)
	for (const b of work.breaks) t.words[b.index]!.breakBefore = b.breakBefore;
	for (let i = work.splices.length - 1; i >= 0; i--) {
		const s = work.splices[i]!;
		t.words.splice(s.from, s.to - s.from, ...(clone(s.words) as Draft<TranscriptWord>[]));
	}
	for (const p of work.text) {
		const clip = doc.sequences[p.sequenceId]!.clips[p.clipId] as DText;
		const cap = latest(clip.caption) as TextClipCaption;
		// text and words set together: the upkeep rebuilds the highlight without re-timing (normalize.ts)
		clip.content = clone(p.content) as DText['content'];
		(clip as { caption: TextClipCaption }).caption = { ...clone(cap), words: clone(p.words) };
		clip.name = p.name;
		layoutText(doc, clip, h, doc.sequences[p.sequenceId]!.settings.width);
	}
	for (const p of work.captions) {
		doc.transcripts[p.transcriptId]!.words = clone(p.words) as Draft<TranscriptWord>[];
		doc.sequences[p.sequenceId]!.clips[p.clipId]!.name = p.name;
	}
	for (const s of plan.skipped.slice(0, 20))
		h.warn(
			'W_TRANSCRIPT_PATCH_SKIPPED',
			`${s.kind === 'subtitle' ? 'Subtitle' : 'Caption'} ${s.clipId} not updated (${s.reason})`,
			['sequences', s.sequenceId, 'clips', s.clipId],
		);
	return {
		transcriptId: t.id,
		edits: plan.edits.length,
		words: t.words.length,
		patched: plan.patched,
		skipped: plan.skipped,
	};
}

function configure(doc: DDoc, cmd: CommandOf<'scriptFix.configure'>, h: HandlerContext) {
	const seq = h.sequence(doc, cmd.sequenceId);
	const next: SequenceScriptFix = clone(readSequenceScriptFix(latest(seq) as { scriptFix?: unknown }));
	if (cmd.settings === null) delete next.settings;
	else if (cmd.settings) {
		const merged = { ...(next.settings ?? {}), ...clone(cmd.settings) };
		for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === undefined) delete merged[k];
		if (Object.keys(merged).length) next.settings = merged;
		else delete next.settings;
	}
	if (cmd.clearRejected || cmd.reject || cmd.unreject) {
		const rej = new Set(cmd.clearRejected ? [] : (next.rejected ?? []));
		for (const f of cmd.unreject ?? []) rej.delete(f);
		for (const f of cmd.reject ?? []) rej.add(f);
		if (rej.size > SCRIPT_FIX_MAX_REJECTED)
			h.fail('E_LIMIT', `At most ${SCRIPT_FIX_MAX_REJECTED} rejected fixes per sequence (${rej.size} given)`);
		if (rej.size) next.rejected = [...rej];
		else delete next.rejected;
	}
	const bad = sequenceScriptFixIssue(next);
	if (bad) h.fail('E_INVALID_PARAM', `Fix Transcript settings: ${bad}`);
	const r = seq as unknown as { scriptFix?: SequenceScriptFix };
	if (Object.keys(next).length) r.scriptFix = next;
	else delete r.scriptFix;
	return { settings: scriptFixSettingsOf({ scriptFix: next }), rejected: next.rejected?.length ?? 0 };
}

export const scriptFixHandlers = {
	'transcript.replaceWords': replaceWords,
	'scriptFix.configure': configure,
} satisfies HandlerMap;
