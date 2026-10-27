// The video script of a sequence (spec 14 TC-012, TC-030, TC-040; spec 17 SC-001 / SC-002): paste or load it (plain
// text or Markdown, ≤ 256 KB), attach it to the sequence (`cleanup.configure`, undoable), replace or detach it. One
// script per sequence, shared by Clean Up (off-script talk, head / tail chatter, retake groups named by their line)
// and Fix Transcript (recognition errors fixed from it). Opened from Text ▸ Transcript ("Script…") and from Clean Up.
// Shows what the parser reads (SC-002: sections found, directions and headings skipped) and, after a Clean Up
// analysis, the lines never said.
import {
	CLEANUP_SCRIPT_MAX_BYTES,
	readSequenceCleanup,
	type Sequence,
	transcriptForMedia,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, TextField, toast } from '@jasper/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { scriptSummary, scriptSummaryText } from '../../../script-fix/model.ts';
import { cleanupFor } from './controller.ts';

/** Largest file read (the attach validates the 256 KB of text; a bigger file is refused before reading). */
const MAX_FILE_BYTES = 4 * CLEANUP_SCRIPT_MAX_BYTES;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

export function ScriptDrawer({ session, seq }: { session: EditorSession; seq: Sequence }) {
	const c = cleanupFor(session);
	const stored = readSequenceCleanup(seq).script;
	const [name, setName] = useState(stored?.name ?? '');
	const [text, setText] = useState(stored?.text ?? '');
	useEffect(() => {
		setName(stored?.name ?? '');
		setText(stored?.text ?? '');
	}, [stored?.name, stored?.text]);
	const file = useRef<HTMLInputElement>(null);
	const analysis = useStoreSelector(c.store, (s) => (s.sequenceId === seq.id ? s.analysis : null));
	const bytes = utf8Length(text);
	const tooLong = bytes > CLEANUP_SCRIPT_MAX_BYTES;
	const changed = text !== (stored?.text ?? '') || name !== (stored?.name ?? '');
	// the language of the sequence's speech (the first transcribed audio clip's), for "&" and English words
	const language = useStoreSelector(session.store, (s) => {
		for (const clip of Object.values(seq.clips))
			if (clip.kind === 'audio') {
				const tr = transcriptForMedia(s.document, clip.mediaId);
				if (tr?.language) return tr.language;
			}
		return null;
	});
	const summary = useMemo(() => (tooLong ? null : scriptSummary(text, language)), [text, language, tooLong]);
	// always this sequence's script (the Clean Up controller may be on another sequence)
	const configure = (fields: { script: { name: string; text: string } | null }, label: string) => {
		const r = session.apply({
			label,
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'cleanup.configure', sequenceId: seq.id, ...fields }] as never[],
		});
		return r.ok
			? { ok: true as const }
			: { ok: false as const, reason: r.errors[0]?.message ?? t('The change was refused') };
	};
	const attach = () => {
		const r = configure(
			{ script: { name: name.trim() || t('Script'), text } },
			stored ? t('Replace Script') : t('Attach Script'),
		);
		if (!r.ok) toast({ kind: 'warning', title: t('The script was not attached'), detail: r.reason });
	};
	const unsaid = analysis?.script?.filter((l) => !l.said) ?? [];
	return (
		<div
			className="max-h-[50%] shrink-0 overflow-auto border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small"
			data-testid="text.cleanup.scriptDrawer"
		>
			<div className="mb-1 flex flex-wrap items-center gap-1">
				<TextField
					className="min-w-32 flex-1"
					value={name}
					placeholder="Script name"
					aria-label="Script name"
					onChange={(e) => setName(e.currentTarget.value.slice(0, 500))}
					data-testid="text.cleanup.script.name"
				/>
				<Button variant="quiet" onClick={() => file.current?.click()} data-testid="text.cleanup.script.load">
					Load File…
				</Button>
				<input
					ref={file}
					type="file"
					accept=".txt,.md,.text,text/plain"
					className="hidden"
					data-testid="text.cleanup.script.input"
					onChange={async (e) => {
						const f = e.currentTarget.files?.[0];
						e.currentTarget.value = '';
						if (!f) return;
						if (f.size > MAX_FILE_BYTES) {
							toast({ kind: 'warning', title: t('The script file is too large (at most 256 KB of text)') });
							return;
						}
						try {
							setText(await f.text());
							if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ''));
						} catch (err) {
							toast({ kind: 'warning', title: t('The file could not be read'), detail: String(err) });
						}
					}}
				/>
				<Button
					variant="primary"
					disabled={!text.trim() || tooLong || !changed}
					disabledReason={
						tooLong ? t('The script is longer than 256 KB') : t('Paste or load the script first')
					}
					onClick={attach}
					data-testid="text.cleanup.script.attach"
				>
					{stored ? t('Replace') : t('Attach')}
				</Button>
				{stored ? (
					<Button
						variant="quiet"
						onClick={() => {
							const r = configure({ script: null }, t('Detach Script'));
							if (!r.ok)
								toast({ kind: 'warning', title: t('The script was not detached'), detail: r.reason });
						}}
						data-testid="text.cleanup.script.detach"
					>
						Detach
					</Button>
				) : null}
			</div>
			<textarea
				className="h-28 w-full resize-y rounded-pr-control border border-pr-border bg-pr-field p-1 font-pr text-pr-small text-pr-text"
				value={text}
				placeholder="Paste the script here: one sentence or line per take."
				aria-label="Script text"
				onChange={(e) => setText(e.currentTarget.value)}
				data-testid="text.cleanup.script.text"
			/>
			<p className={`m-0 ${tooLong ? 'text-pr-danger' : 'text-pr-muted'}`}>
				{t('{0} KB of 256 KB', Math.ceil(bytes / 1024))}
				{stored ? ` · ${t('Attached: {0}', stored.name)}` : ''}
			</p>
			{summary ? (
				<p className="m-0 text-pr-muted" data-testid="text.cleanup.script.summary">
					{scriptSummaryText(summary)}
				</p>
			) : null}
			{analysis?.script ? (
				<div className="mt-1" data-testid="text.cleanup.script.report">
					<p className="m-0 text-pr-text">
						{t('{0} of {1} lines said', analysis.script.length - unsaid.length, analysis.script.length)}
					</p>
					{unsaid.length ? (
						<ul className="m-0 list-disc pl-4 text-pr-muted">
							{unsaid.slice(0, 50).map((l) => (
								<li key={l.index}>{t('Line {0} not said: {1}', l.index + 1, l.text)}</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
