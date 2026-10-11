import {
	Button,
	Dialog,
	type HostedDialogProps,
	IconButton,
	openDialog,
	registerDialog,
	TextField,
} from '@jasper/ui';
import { useId, useState, useSyncExternalStore } from 'react';
import { trackHeightPresets } from './track-heights.ts';

export const NAME_PROMPT_DIALOG = 'gaps.namePrompt';
export const MANAGE_HEIGHT_PRESETS_DIALOG = 'gaps.manageHeightPresets';
export const EXIT_DIALOG = 'gaps.exit';

type NamePromptProps = {
	title: string;
	label: string;
	initial?: string;
	primaryLabel?: string;
	maxLength?: number;
	/** Returns an error message to keep the dialog open. */
	validate?(name: string): string | null;
};

function NamePromptDialog(props: HostedDialogProps<NamePromptProps>) {
	const [name, setName] = useState(props.initial ?? '');
	const [error, setError] = useState<string | null>(null);
	const id = useId();
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={props.title}
			size="small"
			primaryLabel={props.primaryLabel ?? 'OK'}
			primaryDisabled={!name.trim()}
			onPrimary={() => {
				const v = name.trim();
				const e = props.validate?.(v) ?? null;
				if (e) {
					setError(e);
					return false;
				}
				props.close(v);
				return false;
			}}
			data-testid="name-prompt-dialog"
		>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={id} className="text-pr-muted">
					{props.label}
				</label>
				<TextField
					id={id}
					autoFocus
					value={name}
					maxLength={props.maxLength ?? 120}
					invalid={!!error}
					data-testid="name-prompt-input"
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
				/>
				{error ? (
					<span role="alert" className="text-pr-small text-pr-danger">
						{error}
					</span>
				) : null}
			</div>
		</Dialog>
	);
}

/** Asks for a name; resolves with it, or null on cancel. */
export async function promptName(props: NamePromptProps): Promise<string | null> {
	registerSmallDialogs();
	const r = await openDialog<string>(NAME_PROMPT_DIALOG, props);
	return typeof r === 'string' && r ? r : null;
}

function ManagePresetsDialog(props: HostedDialogProps<{ onApply?(id: string): void }>) {
	const list = useSyncExternalStore(trackHeightPresets.subscribe, () => trackHeightPresets.list());
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title="Manage Track Height Presets"
			size="medium"
			data-testid="manage-height-presets-dialog"
		>
			{list.length === 0 ? (
				<p className="text-pr-muted">
					No presets yet. Use Timeline Display Settings ▸ Save Preset… to save the current track heights.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-pr-border-subtle rounded-pr-control border border-pr-border-subtle">
					{list.map((p, i) => (
						<li key={p.id} className="flex h-8 items-center gap-2 px-2" data-testid={`height-preset-${i}`}>
							<span className="w-6 text-pr-dim">{i + 1}</span>
							{renaming?.id === p.id ? (
								<TextField
									autoFocus
									aria-label="Preset name"
									className="min-w-0 flex-1"
									value={renaming.name}
									onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											trackHeightPresets.rename(p.id, renaming.name);
											setRenaming(null);
										} else if (e.key === 'Escape') {
											e.preventDefault();
											e.stopPropagation();
											setRenaming(null);
										}
									}}
								/>
							) : (
								<span className="min-w-0 flex-1 truncate">
									{p.name}{' '}
									<span className="text-pr-dim">
										({p.video.length} video, {p.audio.length} audio)
									</span>
								</span>
							)}
							<IconButton
								icon="app.chevronDown"
								label="Move up"
								size="small"
								className="rotate-180"
								disabled={i === 0}
								onClick={() => trackHeightPresets.move(p.id, -1)}
							/>
							<IconButton
								icon="app.chevronDown"
								label="Move down"
								size="small"
								disabled={i === list.length - 1}
								onClick={() => trackHeightPresets.move(p.id, 1)}
							/>
							{props.onApply ? (
								<Button variant="quiet" onClick={() => props.onApply?.(p.id)}>
									Apply
								</Button>
							) : null}
							<Button variant="quiet" onClick={() => setRenaming({ id: p.id, name: p.name })}>
								Rename
							</Button>
							<Button variant="quiet" onClick={() => trackHeightPresets.remove(p.id)}>
								Delete
							</Button>
						</li>
					))}
				</ul>
			)}
		</Dialog>
	);
}

export type ExitChoice = 'save' | 'discard' | 'cancel';

function ExitDialog(props: HostedDialogProps<{ projectName: string }>) {
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close('cancel')}
			title="Save changes before exiting?"
			size="small"
			primaryLabel="Save"
			onPrimary={() => {
				props.close('save');
				return false;
			}}
			footerExtra={
				<Button variant="secondary" onClick={() => props.close('discard')} data-testid="exit-discard">
					Don’t Save
				</Button>
			}
			data-testid="exit-dialog"
		>
			<p>
				“{props.projectName}” has changes that are not saved yet. Unsaved changes stay in the crash-recovery
				journal and are offered again the next time you open the project.
			</p>
		</Dialog>
	);
}

/** Asks what to do with unsaved changes before quitting. */
export async function askExit(projectName: string): Promise<ExitChoice> {
	registerSmallDialogs();
	const r = await openDialog<ExitChoice>(EXIT_DIALOG, { projectName });
	return r === 'save' || r === 'discard' ? r : 'cancel';
}

let registered = false;
export function registerSmallDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(NAME_PROMPT_DIALOG, NamePromptDialog);
	registerDialog(MANAGE_HEIGHT_PRESETS_DIALOG, ManagePresetsDialog);
	registerDialog(EXIT_DIALOG, ExitDialog);
}
