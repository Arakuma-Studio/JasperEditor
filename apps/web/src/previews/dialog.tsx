// Changing preview settings retains other cached formats so switching back can reuse them.
import { PREVIEW_FORMATS, type PreviewFormat, previewSettingsOf } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useState } from 'react';

export const PREVIEW_SETTINGS_DIALOG = 'previews.settings';

let registered = false;
export function registerPreviewDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(PREVIEW_SETTINGS_DIALOG, PreviewSettingsDialog);
}

export const FORMAT_LABELS: Record<PreviewFormat, string> = {
	'h264-iframe': 'I-Frame Only H.264 (MP4) — frame-exact, fastest seeking',
	h264: 'H.264 (MP4) — keyframe every 15 frames, smaller files',
	vp9: 'VP9 (WebM)',
};

type Props = { session: EditorSession; sequenceId: string };

export function PreviewSettingsDialog(props: HostedDialogProps<Props>) {
	const seq = props.session.getCommitted().sequences[props.sequenceId];
	const cur = previewSettingsOf(seq ?? {});
	const [open, setOpen] = useState(true);
	const [format, setFormat] = useState<PreviewFormat>(cur.format);
	const [size, setSize] = useState<'full' | 'half'>(cur.size);
	const [quality, setQuality] = useState<'standard' | 'high'>(cur.quality);
	const [error, setError] = useState<string | null>(null);
	const finish = (r?: unknown) => {
		setOpen(false);
		props.close(r);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && finish()}
			title="Video Previews"
			description="Preview file format, size and quality of this sequence"
			size="small"
			primaryLabel="OK"
			data-testid="preview-settings-dialog"
			onPrimary={() => {
				const r = props.session.apply({
					label: 'Preview Settings',
					origin: 'user',
					sequenceId: props.sequenceId,
					commands: [
						{ type: 'sequence.setPreviewSettings', sequenceId: props.sequenceId, format, size, quality },
					] as never[],
				});
				if (!r.ok) {
					setError(r.errors[0]?.message ?? 'The settings could not be applied');
					return false;
				}
				finish(true);
				return true;
			}}
		>
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<span className="w-[120px] shrink-0 text-pr-muted">Preview File Format</span>
					<Select
						label="Preview File Format"
						value={format}
						onValueChange={(v) => setFormat(v as PreviewFormat)}
						options={PREVIEW_FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f] }))}
						className="flex-1"
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-[120px] shrink-0 text-pr-muted">Frame Size</span>
					<Select
						label="Frame Size"
						value={size}
						onValueChange={(v) => setSize(v === 'half' ? 'half' : 'full')}
						options={[
							{ value: 'full', label: 'Full (sequence frame size)' },
							{ value: 'half', label: 'Half (faster renders; not used by exports)' },
						]}
						className="flex-1"
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="w-[120px] shrink-0 text-pr-muted">Quality</span>
					<Select
						label="Quality"
						value={quality}
						onValueChange={(v) => setQuality(v === 'high' ? 'high' : 'standard')}
						options={[
							{ value: 'standard', label: 'Standard' },
							{ value: 'high', label: 'Maximum Render Quality (larger files)' },
						]}
						className="flex-1"
					/>
				</div>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}
