// edit-ux: Program monitor guide dialogs (Premiere View ▸ Add Guide… and Guide Templates ▸ Save Guides as Template…
// / Manage Guides…). Guides are frame pixels or a percentage of the frame.
import { Button, Dialog, type HostedDialogProps, registerDialog, Select, TextField } from '@jasper/ui';
import { useState, useSyncExternalStore } from 'react';
import {
	addGuide,
	allTemplates,
	applyGuideTemplate,
	deleteGuideTemplate,
	monitorExtras,
	saveGuidesAsTemplate,
} from './monitor-view.ts';

export const ADD_GUIDE_DIALOG = 'program.addGuide';
export const GUIDE_TEMPLATES_DIALOG = 'program.guideTemplates';

let registered = false;
export function registerGuideDialogs(): void {
	if (registered) return;
	registered = true;
	registerDialog(ADD_GUIDE_DIALOG, AddGuideDialog);
	registerDialog(GUIDE_TEMPLATES_DIALOG, GuideTemplatesDialog);
}

type FrameProps = { sequenceId: string; width: number; height: number };

/** Parses a guide position: "540" (px) or "50%" of the frame dimension. */
export function parseGuidePosition(text: string, size: number): number | null {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*(%|px)?\s*$/.exec(text);
	if (!m) return null;
	const v = Number(m[1]);
	const px = m[2] === '%' ? (size * v) / 100 : v;
	return px >= 0 && px <= size ? px : null;
}

export function AddGuideDialog(props: HostedDialogProps<FrameProps>) {
	const [open, setOpen] = useState(true);
	const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
	const [pos, setPos] = useState('50%');
	const [error, setError] = useState<string | null>(null);
	const close = () => {
		setOpen(false);
		props.close();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && close()}
			title="Add Guide"
			size="small"
			primaryLabel="OK"
			onPrimary={() => {
				const size = orientation === 'horizontal' ? props.height : props.width;
				const p = parseGuidePosition(pos, size);
				if (p === null) {
					setError(`Enter a position between 0 and ${size} px (or a percentage)`);
					return false;
				}
				addGuide(props.sequenceId, { orientation, position: p });
				monitorExtras.setState({ showGuides: true });
				close();
				return true;
			}}
			data-testid="add-guide-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<Select
					value={orientation}
					onValueChange={(v) => setOrientation(v as 'horizontal' | 'vertical')}
					options={[
						{ value: 'horizontal', label: 'Horizontal' },
						{ value: 'vertical', label: 'Vertical' },
					]}
					label="Orientation"
				/>
				<TextField
					value={pos}
					onChange={(e) => setPos(e.target.value)}
					aria-label="Guide position (px or %)"
					data-testid="add-guide-position"
				/>
				{error ? (
					<p className="text-pr-small text-pr-danger" role="alert">
						{error}
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

export function GuideTemplatesDialog(props: HostedDialogProps<FrameProps & { save?: boolean }>) {
	const [open, setOpen] = useState(true);
	useSyncExternalStore(monitorExtras.subscribe, monitorExtras.getState, monitorExtras.getState);
	const templates = allTemplates(props.width, props.height);
	const [name, setName] = useState('My Guides');
	const [message, setMessage] = useState<string | null>(null);
	const close = () => {
		setOpen(false);
		props.close();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => !o && close()}
			title={props.save ? 'Save Guides as Template' : 'Manage Guides'}
			size="small"
			data-testid="guide-templates-dialog"
		>
			<div className="flex flex-col gap-2 text-pr-ui">
				<div className="flex items-center gap-2">
					<TextField
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-label="Template name"
						data-testid="guide-template-name"
					/>
					<Button
						onClick={() => {
							const err = saveGuidesAsTemplate(props.sequenceId, name);
							setMessage(err ?? `Saved “${name.trim()}”`);
						}}
						data-testid="guide-template-save"
					>
						Save Current Guides
					</Button>
				</div>
				{message ? <p className="text-pr-small text-pr-muted">{message}</p> : null}
				<ul className="max-h-[240px] overflow-auto">
					{templates.map((t) => (
						<li key={t.name} className="flex h-[26px] items-center gap-2">
							<span className="min-w-0 flex-1 truncate">
								{t.name}
								<span className="text-pr-muted"> · {t.guides.length} guides</span>
							</span>
							<Button
								onClick={() => {
									applyGuideTemplate(props.sequenceId, t.name, props.width, props.height);
									setMessage(`Applied “${t.name}”`);
								}}
								data-testid={`guide-template-apply-${t.name}`}
							>
								Apply
							</Button>
							{t.builtIn ? null : (
								<Button
									onClick={() => deleteGuideTemplate(t.name)}
									data-testid={`guide-template-delete-${t.name}`}
								>
									Delete
								</Button>
							)}
						</li>
					))}
				</ul>
			</div>
		</Dialog>
	);
}
