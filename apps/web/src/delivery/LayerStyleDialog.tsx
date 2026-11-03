// Spec 19 TL-113: Import Layer Styles. Each style of the file with its report: what mapped, what was approximated, what
// is not supported, by name. Ported from Pachislop src/ui/PsStyleDialog.tsx and PsStyleImport.tsx: the size a style was
// made for is confirmed here, since a style holds pixels and a look holds percentages (TL-012).
import type { LayerStyleFile } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	MAX_TITLE_LOOK_NAME,
	mapPsStyle,
	type PsStyle,
	type PsStyleLook,
	PsStyleSchema,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Checkbox, Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { useMemo, useState } from 'react';

export const LAYER_STYLE_DIALOG = 'delivery.layerStyles';

type Props = { session: EditorSession; engine: EngineClient; file: LayerStyleFile };
type Choice = { on: boolean; size: number };

/**
 * The one place an imported look is stored (TL-054's user store replaces this body): today the project's looks, as an
 * undoable `look.create`. Returns the created look ids.
 */
export function saveImportedLooks(
	session: EditorSession,
	looks: { name: string; look: PsStyleLook }[],
): { ok: true; lookIds: string[] } | { ok: false; message: string } {
	const r = session.apply({
		label: looks.length === 1 ? 'Import Layer Style' : 'Import Layer Styles',
		origin: 'user',
		commands: looks.map(({ name, look }) => ({
			type: 'look.create' as const,
			name: name.slice(0, MAX_TITLE_LOOK_NAME),
			recipe: look.recipe,
			link: false,
		})),
	});
	if (!r.ok) return { ok: false, message: r.errors[0]?.message ?? 'The looks could not be saved' };
	return { ok: true, lookIds: r.results.map((x) => (x as { lookId: string }).lookId) };
}

function Lines(props: { title: string; items: string[]; tone: string; testId: string }) {
	if (!props.items.length) return null;
	return (
		<div className={`text-pr-small ${props.tone}`} data-testid={props.testId}>
			<span className="font-semibold">{props.title}: </span>
			{props.items.join(' · ')}
		</div>
	);
}

function LayerStyleDialog({ session, file, close }: Props & HostedDialogProps) {
	const [choices, setChoices] = useState<Choice[]>(() =>
		file.styles.map((s) => ({ on: true, size: s.refPx })),
	);
	const [error, setError] = useState<string | null>(null);
	const converted = useMemo(
		() =>
			file.styles.map((s, i): PsStyleLook | { error: string } => {
				try {
					return mapPsStyle(PsStyleSchema.parse(s.style) as PsStyle, choices[i]!.size);
				} catch (e) {
					return { error: (e as Error).message };
				}
			}),
		[file, choices],
	);
	const update = (i: number, patch: Partial<Choice>) =>
		setChoices((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));
	const chosen = file.styles.flatMap((s, i) => {
		const c = converted[i]!;
		return choices[i]!.on && 'recipe' in c ? [{ name: s.name, look: c }] : [];
	});

	const importChosen = () => {
		const r = saveImportedLooks(session, chosen);
		if (r.ok) close(r.lookIds);
		else setError(r.message);
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && close()}
			title={`Import Layer Styles · ${file.fileName}`}
			size="large"
			primaryLabel={chosen.length === 1 ? 'Import 1 style' : `Import ${chosen.length} styles`}
			primaryDisabled={chosen.length === 0}
			onPrimary={() => {
				importChosen();
				return false;
			}}
			data-testid="layer-style-dialog"
		>
			<p className="mb-2 text-pr-small text-pr-muted">
				Styles hold pixels; looks hold percentages of the text size. Check the size each style was made for:
				the font size when the file has it, otherwise confirm it.
			</p>
			<div className="flex max-h-[50vh] flex-col gap-2 overflow-auto">
				{file.styles.map((s, i) => {
					const c = converted[i]!;
					return (
						<div
							key={file.styles.indexOf(s)}
							className="border-pr-border border-b pb-2"
							data-testid="layer-style-row"
						>
							<div className="flex items-center gap-2">
								<Checkbox
									checked={choices[i]!.on}
									onCheckedChange={(on) => update(i, { on })}
									label={s.name}
								/>
								<span className="text-pr-small text-pr-muted">{s.origin}</span>
								<span className="ml-auto text-pr-small text-pr-muted">{s.refNote}</span>
								<TextField
									aria-label={`Reference size of ${s.name}`}
									className="w-20"
									type="number"
									value={String(choices[i]!.size)}
									min={1}
									max={4000}
									onChange={(e) => {
										const v = Number(e.target.value);
										update(i, { size: Number.isFinite(v) ? Math.min(4000, Math.max(1, v)) : 1 });
									}}
								/>
								<span className="text-pr-small text-pr-muted">px</span>
							</div>
							{'error' in c ? (
								<p role="alert" className="text-pr-small text-pr-danger">
									{c.error}
								</p>
							) : (
								<>
									<Lines title="Mapped" items={c.report.mapped} tone="" testId="style-mapped" />
									<Lines
										title="Approximated"
										items={c.report.approximated}
										tone="text-pr-muted"
										testId="style-approximated"
									/>
									<Lines
										title="Not supported"
										items={c.report.unsupported}
										tone="text-pr-danger"
										testId="style-unsupported"
									/>
								</>
							)}
						</div>
					);
				})}
			</div>
			{file.skipped.length ? (
				<p className="mt-2 text-pr-small text-pr-muted" data-testid="style-skipped">
					Skipped: {file.skipped.join('; ')}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}

/** Picks a `.asl` or `.psd`, sends it to the engine and opens the report. */
export function pickStyleFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.asl,.psd';
		input.onchange = () => resolve(input.files?.[0] ?? null);
		input.oncancel = () => resolve(null);
		input.click();
	});
}

export const readStyleFile = (engine: EngineClient, file: File) =>
	engine.call('layerStylesRead', { body: file, query: { name: file.name } });

let registered = false;
export function registerLayerStyleDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(LAYER_STYLE_DIALOG, LayerStyleDialog);
}
