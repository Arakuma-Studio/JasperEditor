// Spec 19 TL-113: Import Layer Styles. Each style of the file with its report: what mapped, what was approximated, what
// is not supported, by name. Ported from Pachislop src/ui/PsStyleDialog.tsx and PsStyleImport.tsx: the size a style was
// made for is confirmed here, since a style holds pixels and a look holds percentages (TL-012). The looks go to the project,
// to My Looks (TL-054: the engine's user library, for every project), or both.
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
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import {
	ensureUserLooks,
	saveUserLooks,
	userLooksUnavailable,
	useUserLooks,
} from '../title-looks/user-library.ts';

export const LAYER_STYLE_DIALOG = 'delivery.layerStyles';

type Props = { session: EditorSession; engine: EngineClient; file: LayerStyleFile };
type Choice = { on: boolean; size: number };

/** Where imported looks go: the project (undoable), My Looks (the engine's user library, not undoable), or both. */
export type ImportTarget = { project: boolean; myLooks: boolean };

/** The project's looks, as one undoable transaction of `look.create`. Returns the created look ids. */
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

/** Imported looks into My Looks, under free names. Returns the saved user look ids. */
export async function saveImportedToMyLooks(
	looks: { name: string; look: PsStyleLook }[],
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
	const why = userLooksUnavailable();
	if (why) return { ok: false, message: why };
	try {
		const saved = await saveUserLooks(
			looks.map(({ name, look }) => ({ name: name.slice(0, MAX_TITLE_LOOK_NAME), recipe: look.recipe })),
		);
		return { ok: true, ids: saved.map((l) => l.id) };
	} catch (e) {
		return { ok: false, message: (e as Error)?.message ?? String(e) };
	}
}

/**
 * Stores the chosen looks where the person asked. The project first: it can be undone, so a My Looks refusal after it
 * leaves nothing that cannot be taken back.
 */
export async function importLooksTo(
	session: EditorSession,
	looks: { name: string; look: PsStyleLook }[],
	target: ImportTarget,
): Promise<{ ok: true; lookIds: string[]; userLookIds: string[] } | { ok: false; message: string }> {
	let lookIds: string[] = [];
	if (target.project) {
		const r = saveImportedLooks(session, looks);
		if (!r.ok) return r;
		lookIds = r.lookIds;
	}
	let userLookIds: string[] = [];
	if (target.myLooks) {
		const r = await saveImportedToMyLooks(looks);
		if (!r.ok)
			return {
				ok: false,
				message: target.project ? t('Added to this project, but not to My Looks: {0}', r.message) : r.message,
			};
		userLookIds = r.ids;
	}
	return { ok: true, lookIds, userLookIds };
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

function LayerStyleDialog({ session, engine, file, close }: Props & HostedDialogProps) {
	const library = useUserLooks();
	useEffect(() => {
		void ensureUserLooks(engine);
	}, [engine]);
	const myLooksWhy = userLooksUnavailable(library);
	const [target, setTarget] = useState<ImportTarget>({ project: true, myLooks: false });
	const [busy, setBusy] = useState(false);
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

	const toMyLooks = target.myLooks && !myLooksWhy;
	const nowhere = !target.project && !toMyLooks;
	const importChosen = async () => {
		setBusy(true);
		const r = await importLooksTo(session, chosen, { project: target.project, myLooks: toMyLooks });
		setBusy(false);
		if (r.ok) close(r.lookIds);
		else {
			setError(r.message);
			// What the project already took stays (undoable); only My Looks is left to retry.
			if (target.project && toMyLooks) setTarget({ project: false, myLooks: true });
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(o) => !o && close()}
			title={`Import Layer Styles · ${file.fileName}`}
			size="large"
			primaryLabel={chosen.length === 1 ? 'Import 1 style' : `Import ${chosen.length} styles`}
			primaryDisabled={chosen.length === 0 || nowhere || busy}
			onPrimary={() => {
				void importChosen();
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
			<fieldset className="mt-2 flex flex-wrap items-center gap-3" data-testid="layer-style-target">
				<legend className="sr-only">Add the looks to</legend>
				<span className="text-pr-small text-pr-muted">Add the looks to:</span>
				<Checkbox
					checked={target.project}
					onCheckedChange={(project) => setTarget((p) => ({ ...p, project }))}
					label="This project"
				/>
				<span title={myLooksWhy ?? t('My Looks are kept by the engine, for every project. Not undoable.')}>
					<Checkbox
						checked={toMyLooks}
						disabled={!!myLooksWhy}
						onCheckedChange={(myLooks) => setTarget((p) => ({ ...p, myLooks }))}
						label="My Looks"
					/>
				</span>
				{myLooksWhy ? (
					<span className="text-pr-small text-pr-muted" data-testid="layer-style-my-looks-why">
						{myLooksWhy}
					</span>
				) : nowhere ? (
					<span className="text-pr-small text-pr-warning">Choose where the looks go.</span>
				) : null}
			</fieldset>
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
