// Paste Attributes… / Remove Attributes… dialogs (S01:CLB-005, S03:FX-011/012, Premiere parity): a checkbox per
// attribute grouped by Video / Audio / Effects / Text / Shape, every available row checked by default; Paste
// adds "Scale Attribute Times". Resolves `close({keys, scaleTimes})`, undefined on cancel.
import { Checkbox, Dialog, type HostedDialogProps } from '@jasper/ui';
import { useState } from 'react';
import type { AttributeGroup, AttributeOption } from './attributes.ts';

export const PASTE_ATTRIBUTES_DIALOG = 'clipboard.pasteAttributes';
export const REMOVE_ATTRIBUTES_DIALOG = 'clipboard.removeAttributes';

export type AttributesDialogResult = { keys: string[]; scaleTimes: boolean };

const GROUPS: { id: AttributeGroup; title: string }[] = [
	{ id: 'video', title: 'Video Attributes' },
	{ id: 'audio', title: 'Audio Attributes' },
	{ id: 'effects', title: 'Effects' },
	{ id: 'text', title: 'Text' },
	{ id: 'shape', title: 'Shape' },
];

export function AttributesDialog(
	props: HostedDialogProps<{
		mode: 'paste' | 'remove';
		options: AttributeOption[];
		/** "From <clip>" / the number of target clips, for the description. */
		sourceName?: string;
		targetCount: number;
	}>,
) {
	const [checked, setChecked] = useState<Set<string>>(
		() => new Set(props.options.filter((o) => o.available).map((o) => o.key)),
	);
	const [scale, setScale] = useState(true);
	const paste = props.mode === 'paste';
	const title = paste ? 'Paste Attributes' : 'Remove Attributes';
	const n = props.targetCount;
	const toward = `${n} selected clip${n === 1 ? '' : 's'}`;
	const description = paste
		? `Attributes ${props.sourceName ? `of ${props.sourceName} ` : ''}to paste onto ${toward}`
		: `Attributes to reset or remove from ${toward}`;
	const toggle = (key: string, on: boolean) => {
		const next = new Set(checked);
		if (on) next.add(key);
		else next.delete(key);
		setChecked(next);
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.close(undefined);
			}}
			title={title}
			description={description}
			size="small"
			primaryLabel={paste ? 'Paste' : 'Remove'}
			primaryDisabled={checked.size === 0}
			onPrimary={() =>
				props.close({ keys: [...checked], scaleTimes: paste && scale } satisfies AttributesDialogResult)
			}
			data-testid={paste ? 'paste-attributes-dialog' : 'remove-attributes-dialog'}
		>
			<div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto p-1">
				<p className="text-pr-small text-pr-muted">{description}</p>
				{paste ? (
					<span data-testid="attr-scale-times">
						<Checkbox checked={scale} onCheckedChange={setScale} label="Scale Attribute Times" />
					</span>
				) : null}
				{props.options.length === 0 ? (
					<p className="text-pr-ui text-pr-muted">Nothing to {paste ? 'paste' : 'remove'}.</p>
				) : null}
				{GROUPS.map((g) => {
					const rows = props.options.filter((o) => o.group === g.id);
					if (!rows.length) return null;
					return (
						<fieldset key={g.id} className="flex flex-col gap-1.5" data-attr-group={g.id}>
							<legend className="mb-1 font-semibold text-pr-strong">{g.title}</legend>
							{rows.map((o) => (
								<span
									key={o.key}
									title={o.available ? undefined : o.reason}
									className="pl-2"
									data-attr={o.key}
								>
									<Checkbox
										checked={o.available && checked.has(o.key)}
										disabled={!o.available}
										onCheckedChange={(on) => toggle(o.key, on)}
										label={o.label}
									/>
								</span>
							))}
						</fieldset>
					);
				})}
			</div>
		</Dialog>
	);
}
