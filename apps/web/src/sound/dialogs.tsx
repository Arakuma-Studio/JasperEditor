// Sound Library dialogs (spec 12 §2.7, P1-R7/R8): Show Licence… (a library sound's licence, author, source and credit
// line) and File ▸ Export ▸ Sound Credits… (the credits of the sounds a sequence or the project uses, as Markdown,
// plain text or CSV, all of them or only those whose licence asks for a credit; `soundCredits` from @jasper/project).
import type { SoundEntry } from '@jasper/api';
import {
	creditLine,
	licenseClass,
	licenseUrlOf,
	requiresAttribution,
	type SoundCreditRow,
	soundCredits,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { downloadBytes } from '../panels/text/state.ts';
import { LICENSE_BADGE_TITLES, sourceLine } from './model.ts';

export const SOUND_LICENSE_DIALOG = 'sound.license';
export const SOUND_CREDITS_DIALOG = 'sound.credits';

let registered = false;
export function registerSoundDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(SOUND_LICENSE_DIALOG, SoundLicenseDialog);
	registerDialog(SOUND_CREDITS_DIALOG, SoundCreditsDialog);
}

/** The credit line of a library sound (its verbatim attribution, else built like the credits export). */
export function soundCreditLine(e: SoundEntry): string {
	const row: SoundCreditRow = {
		mediaId: '',
		soundId: e.id,
		title: e.title,
		author: e.author,
		license: e.license,
		licenseUrl: e.licenseUrl ?? licenseUrlOf(e.license),
		sourceUrl: e.sourceUrl ?? null,
		attribution: e.attribution,
		requiresAttribution: requiresAttribution(e.license),
		usedIn: [],
		sequenceIds: [],
	};
	return creditLine(row);
}

const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2">
			<dt className="w-[110px] shrink-0 text-pr-muted">{label}</dt>
			<dd className="min-w-0 flex-1 break-words text-pr-text">{children}</dd>
		</div>
	);
}

export function SoundLicenseDialog(
	props: HostedDialogProps<{ entry: SoundEntry; rootLabel?: string | null }>,
) {
	const { open, finish } = useDialogClose(props.close);
	const e = props.entry;
	const cls = licenseClass(e.license);
	const licenseUrl = safeUrl(e.licenseUrl ?? licenseUrlOf(e.license));
	const sourceUrl = safeUrl(e.sourceUrl);
	const credit = soundCreditLine(e);
	const [copied, setCopied] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title={`Licence — ${e.title || e.id}`}
			size="medium"
			primaryLabel="OK"
			onPrimary={() => finish()}
			footerExtra={
				<Button
					variant="secondary"
					onClick={() => {
						void navigator.clipboard
							?.writeText(credit)
							.then(() => setCopied(true))
							.catch(() => setCopied(false));
					}}
				>
					{copied ? 'Copied' : 'Copy Credit Line'}
				</Button>
			}
			data-testid="sound-license-dialog"
		>
			<dl className="flex flex-col gap-1.5 text-pr-ui">
				<Field label="Licence">
					<span data-testid="sound-license-id">{e.license}</span>
					<span
						className={`block text-pr-small ${cls === 'nc' || cls === 'nd' || cls === 'unknown' || cls === 'user-provided' ? 'text-pr-warning' : 'text-pr-muted'}`}
					>
						{LICENSE_BADGE_TITLES[cls]}
					</span>
					{licenseUrl ? (
						<a
							href={licenseUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="block text-pr-small text-pr-accent underline"
						>
							{licenseUrl}
						</a>
					) : null}
				</Field>
				<Field label="Author">{e.author || '—'}</Field>
				<Field label="Source">
					{sourceLine(e, () => props.rootLabel ?? null) || '—'}
					{sourceUrl ? (
						<a
							href={sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="block text-pr-small text-pr-accent underline"
						>
							{sourceUrl}
						</a>
					) : null}
				</Field>
				<Field label="Credit line">
					<span data-testid="sound-credit-line">{credit}</span>
					<span className="block text-pr-small text-pr-muted">
						{requiresAttribution(e.license)
							? 'This licence asks for this credit wherever the sound is used.'
							: 'No credit is required; crediting is still welcome.'}
					</span>
				</Field>
			</dl>
		</Dialog>
	);
}

type CreditsFormat = 'md' | 'txt' | 'csv';
const FORMAT_INFO: Record<CreditsFormat, { ext: string; mime: string }> = {
	md: { ext: 'md', mime: 'text/markdown' },
	txt: { ext: 'txt', mime: 'text/plain' },
	csv: { ext: 'csv', mime: 'text/csv' },
};

export function SoundCreditsDialog(
	props: HostedDialogProps<{ session: EditorSession; sequenceId?: string | null }>,
) {
	const { open, finish } = useDialogClose(props.close);
	const doc = props.session.getCommitted();
	const seqId = props.sequenceId && doc.sequences[props.sequenceId] ? props.sequenceId : null;
	const [format, setFormat] = useState<CreditsFormat>('md');
	const [scope, setScope] = useState<'all' | 'attribution'>('all');
	const [range, setRange] = useState<'sequence' | 'project'>(seqId ? 'sequence' : 'project');
	const credits = useMemo(
		() =>
			soundCredits(doc, range === 'sequence' && seqId ? seqId : undefined, {
				attributionOnly: scope === 'attribution',
			}),
		[doc, range, seqId, scope],
	);
	const body = format === 'md' ? credits.markdown : format === 'txt' ? credits.text : credits.csv;
	const empty = credits.rows.length === 0;
	const seqName = seqId
		? (Object.values(doc.items).find(
				(i) => i.kind === 'sequence' && (i as { sequenceId?: string }).sequenceId === seqId,
			)?.name ?? 'Sequence')
		: null;
	const baseName = (range === 'sequence' && seqName ? seqName : doc.name) || 'project';
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Export Sound Credits"
			size="medium"
			primaryLabel="Save…"
			primaryDisabled={empty}
			onPrimary={() => {
				const info = FORMAT_INFO[format];
				downloadBytes(
					new TextEncoder().encode(body),
					`${baseName.replace(/[^\w.-]+/g, '_')}-sound-credits.${info.ext}`,
					info.mime,
				);
				finish(true);
			}}
			data-testid="sound-credits-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<div className="flex items-center gap-2">
					<span className="w-[110px] shrink-0 text-pr-muted">Credits for</span>
					<Select
						label="Credits for"
						value={range}
						onValueChange={(v) => setRange(v as 'sequence' | 'project')}
						options={[
							...(seqId ? [{ value: 'sequence', label: `Sequence “${seqName}”` }] : []),
							{ value: 'project', label: 'The whole project' },
						]}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-[110px] shrink-0 text-pr-muted">Sounds</span>
					<Select
						label="Sounds"
						value={scope}
						onValueChange={(v) => setScope(v as 'all' | 'attribution')}
						options={[
							{ value: 'all', label: 'All sounds used' },
							{ value: 'attribution', label: 'Only those that need a credit' },
						]}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-[110px] shrink-0 text-pr-muted">Format</span>
					<Select
						label="Format"
						value={format}
						onValueChange={(v) => setFormat(v as CreditsFormat)}
						options={[
							{ value: 'md', label: 'Markdown (.md)' },
							{ value: 'txt', label: 'Plain text (.txt)' },
							{ value: 'csv', label: 'CSV (.csv)' },
						]}
					/>
				</div>
				{empty ? (
					<p className="text-pr-muted" data-testid="sound-credits-empty">
						{scope === 'attribution'
							? 'None of the library sounds used needs a credit.'
							: 'No library sounds are used.'}
					</p>
				) : (
					<textarea
						readOnly
						aria-label="Credits preview"
						data-testid="sound-credits-preview"
						className="h-[180px] w-full resize-none rounded-pr-control bg-pr-field-deep p-2 font-pr-mono text-pr-small text-pr-text"
						value={body}
					/>
				)}
				{credits.warnings.length ? (
					<ul className="flex flex-col gap-0.5" aria-label="Licence warnings">
						{credits.warnings.map((w) => (
							<li key={`${w.code}|${w.mediaId}`} className="text-pr-small text-pr-warning">
								{w.message}
							</li>
						))}
					</ul>
				) : null}
			</div>
		</Dialog>
	);
}
