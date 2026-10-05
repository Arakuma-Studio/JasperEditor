// New Preset Bin / Rename Bin (S05:EFX-002 custom bins inside Effects ▸ Presets): one name field; resolves with
// the trimmed name, or undefined on Cancel.
import { Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { useState } from 'react';

export const PRESET_BIN_DIALOG = 'effects.presetBin';

export type PresetBinDialogProps = { title: string; initial?: string; confirmLabel?: string };

export function PresetBinDialog(props: HostedDialogProps<PresetBinDialogProps>) {
	const [open, setOpen] = useState(true);
	const [name, setName] = useState(props.initial ?? 'New Bin');
	const finish = (v?: string) => {
		setOpen(false);
		props.close(v);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) finish();
			}}
			title={props.title}
			size="small"
			primaryLabel={props.confirmLabel ?? 'OK'}
			primaryDisabled={!name.trim()}
			onPrimary={() => {
				finish(name.trim());
				return false;
			}}
			data-testid="preset-bin-dialog"
		>
			<TextField
				aria-label="Bin name"
				value={name}
				maxLength={120}
				autoFocus
				onChange={(e) => setName(e.target.value)}
				onFocus={(e) => e.currentTarget.select()}
				className="w-full"
				data-testid="preset-bin-name"
			/>
		</Dialog>
	);
}

registerDialog(PRESET_BIN_DIALOG, PresetBinDialog);
