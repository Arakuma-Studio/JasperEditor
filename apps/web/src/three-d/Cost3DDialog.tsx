// Spec 19 TL-078: 3D layers render on the Remotion path, every frame in a browser, where a 2D title is baked once. The
// cost is said before it is taken on: the first time a clip turns 3D or a 3D title template is inserted, until "Do not
// show again".
import { COST_CLASSES } from '@jasper/project';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog } from '@jasper/ui';
import { useState } from 'react';

export const COST_3D_DIALOG = 'threeD.cost';
const STORAGE_KEY = 'jasper:3d-cost-acknowledged';

export function cost3dAcknowledged(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

function acknowledge(): void {
	try {
		localStorage.setItem(STORAGE_KEY, '1');
	} catch {
		// No storage: the dialog simply asks again.
	}
}

/** What the dialog asks before: making a layer 3D (the default), or inserting a 3D title template. */
export type Cost3DDialogProps = { title?: string; primaryLabel?: string };

function Cost3DDialog({ close, title, primaryLabel }: HostedDialogProps<Cost3DDialogProps>) {
	const [dontAsk, setDontAsk] = useState(false);
	return (
		<Dialog
			open
			onOpenChange={(o) => {
				if (!o) close(false);
			}}
			title={title ?? 'Make 3D Layer'}
			size="small"
			primaryLabel={primaryLabel ?? 'Make 3D'}
			onPrimary={() => {
				if (dontAsk) acknowledge();
				close(true);
			}}
			onCancel={() => close(false)}
			data-testid="cost-3d-dialog"
		>
			<Cost3DContent dontAsk={dontAsk} onDontAsk={setDontAsk} />
		</Dialog>
	);
}

export function Cost3DContent(props: { dontAsk: boolean; onDontAsk(v: boolean): void }) {
	return (
		<>
			<p className="max-w-[46ch] text-pr-ui text-pr-text">{COST_CLASSES['3d'].detail}.</p>
			<p className="mt-2 max-w-[46ch] text-pr-ui text-pr-muted">{COST_CLASSES['3d-heavy'].detail}.</p>
			<div className="mt-3">
				<Checkbox
					checked={props.dontAsk}
					onCheckedChange={(v) => props.onDontAsk(v === true)}
					label="Do not show again"
				/>
			</div>
		</>
	);
}

let registered = false;
export function registerCost3DDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(COST_3D_DIALOG, Cost3DDialog);
}
