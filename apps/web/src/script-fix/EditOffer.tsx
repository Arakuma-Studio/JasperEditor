// The offer after a manual word fix in Text ▸ Transcript (spec 17 SC-071 / SC-085): "glimer box → Glimmerbox:
// Replace all 4 · Remember · ×". "Replace all N" applies the same correction to the other occurrences of that
// recogniser spelling in the sequence's transcripts — one `transcript.replaceWords` per transcript in ONE transaction
// (one undo step; subtitles made from them are patched in place). "Remember" teaches the personal speech glossary
// (`rememberGlossaryEntry`), so Fix Transcript and future transcriptions know the name. Never automatic, dismissable;
// each action's outcome (or refusal) is said in the bar.
import type { EngineClient } from '@jasper/engine-client';
import type { Command } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button } from '@jasper/ui';
import { useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { fixErrorText } from './engine.ts';
import type { EditOffer } from './model.ts';

/** The glossary call the offer makes (the editor's EngineClient). */
export type RememberEngine = Pick<EngineClient, 'rememberGlossaryEntry'>;

export function EditOfferBar(p: {
	session: EditorSession;
	sequenceId: string;
	offer: EditOffer;
	engine: RememberEngine | null;
	onClose(): void;
}) {
	const { offer } = p;
	const n = offer.plan.occurrences.length;
	const [replaced, setReplaced] = useState<number | null>(null);
	const [remembered, setRemembered] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const replaceAll = () => {
		setError(null);
		const r = p.session.apply({
			label: t('Replace All: {0} → {1}', offer.from, offer.to),
			origin: 'user',
			sequenceId: p.sequenceId,
			commands: offer.plan.commands as unknown as Command[],
		});
		if (!r.ok) {
			setError(
				t(
					'Not replaced: {0}',
					r.errors[0]?.message ?? t('the transcript changed since; edit the word again'),
				),
			);
			return;
		}
		setReplaced(n);
	};
	const remember = async () => {
		if (!p.engine) return;
		setBusy(true);
		setError(null);
		try {
			await p.engine.rememberGlossaryEntry({
				from: [offer.from],
				to: offer.to,
				...(offer.lang ? { lang: offer.lang } : {}),
			});
			setRemembered(true);
		} catch (e) {
			setError(t('Not remembered: {0}', fixErrorText(e)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="flex shrink-0 flex-wrap items-center gap-2 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			role="status"
			data-testid="text.transcript.offer"
		>
			<span className="min-w-0 truncate text-pr-text" title={`${offer.from} → ${offer.to}`}
				data-no-i18n>
				“{offer.from}” → “{offer.to}”
			</span>
			{n > 0 ? (
				replaced !== null ? (
					<span className="text-pr-success" data-testid="text.transcript.offer.replaced">
						{replaced === 1 ? t('Replaced 1 more') : t('Replaced {0} more', replaced)}
					</span>
				) : (
					<Button
						variant="secondary"
						onClick={replaceAll}
						title={offer.plan.occurrences
							.slice(0, 8)
							.map((o) => `… ${o.before} [${o.edit.expect.join(' ')}] ${o.after} …`)
							.join('\n')}
						data-testid="text.transcript.offer.replaceAll"
					>
						{t('Replace all {0}', n)}
						{offer.plan.truncated ? ` (+${offer.plan.truncated})` : ''}
					</Button>
				)
			) : null}
			{offer.canRemember ? (
				remembered ? (
					<span className="text-pr-success" data-testid="text.transcript.offer.remembered">
						{t('Remembered in your speech glossary')}
					</span>
				) : (
					<Button
						variant="quiet"
						busy={busy}
						disabled={!p.engine}
						disabledReason={t('The engine is not connected')}
						onClick={() => void remember()}
						title={t(
							'Add “{0}” → “{1}” to your speech glossary (Fix Transcript and transcriptions use it)',
							offer.from,
							offer.to,
						)}
						data-testid="text.transcript.offer.remember"
					>
						{t('Remember')}
					</Button>
				)
			) : null}
			{error ? (
				<span className="text-pr-warning" role="alert" data-testid="text.transcript.offer.error">
					{error}
				</span>
			) : null}
			<span className="flex-1" />
			<Button
				variant="quiet"
				onClick={p.onClose}
				aria-label={t('Dismiss')}
				data-testid="text.transcript.offer.dismiss"
			>
				×
			</Button>
		</div>
	);
}
