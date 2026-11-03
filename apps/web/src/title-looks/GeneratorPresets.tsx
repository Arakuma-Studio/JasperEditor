// Spec 19 TL-063: a generator's presets as chips at the top of its inspector: the opened generator layer in Properties ▸
// Appearance and in Effect Controls, and the section of a standalone generator effect. A chip sets every own param of
// the generator to the preset (its params over the defaults), in one undo step, at the playhead like any other edit:
// an animated param gets a key there. The chip whose values the generator holds now reads as pressed.
import {
	type Command,
	type EffectInstance,
	type EffectSpec,
	GENERATOR_LAYER_PREFIX,
	type GeneratorPreset,
	isPaintParam,
	TITLE_GENERATORS,
	type TitleGenerator,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import type { EffectEditorProps } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import { GENERATOR_EFFECT_PREFIX } from '../panels/effects/drag.ts';
import {
	bindEffectParam,
	makeRow,
	PLAYHEAD_PLANNER,
	type Row,
	rowValue,
} from '../panels/properties/lib/model.ts';

/** The generator of a look layer type (`generator:<id>`) or of an effect (`jasper.generator.<id>`). */
export function generatorOf(typeOrEffectId: string): TitleGenerator | undefined {
	const id = typeOrEffectId.startsWith(GENERATOR_LAYER_PREFIX)
		? typeOrEffectId.slice(GENERATOR_LAYER_PREFIX.length)
		: typeOrEffectId.startsWith(GENERATOR_EFFECT_PREFIX)
			? typeOrEffectId.slice(GENERATOR_EFFECT_PREFIX.length)
			: null;
	return id === null ? undefined : TITLE_GENERATORS.find((g) => g.id === id);
}

/** What a preset sets: every own param of the generator (its colours too, not its look paint), preset over default. */
export function presetValues(g: TitleGenerator, preset: GeneratorPreset): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of g.params) if (!isPaintParam(p)) out[p.name] = p.default;
	for (const [k, v] of Object.entries(preset.params)) if (k in out) out[k] = v;
	return out;
}

/** The param a row edits (the last part of its path). */
const paramOf = (row: Row): string | undefined => {
	const b = row.bindings[0];
	return b?.param ?? b?.path?.[b.path.length - 1];
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether the rows hold the preset's values now (every clip of the rows). */
export function holdsPreset(g: TitleGenerator, preset: GeneratorPreset, rows: readonly Row[]): boolean {
	const want = presetValues(g, preset);
	let seen = 0;
	for (const row of rows) {
		const name = paramOf(row);
		if (!name || !(name in want)) continue;
		seen++;
		const { mixed, value } = rowValue(row);
		if (mixed || !same(value, want[name])) return false;
	}
	return seen > 0;
}

/** The edits of a chip at `frame`: only the params that differ, each written as its row writes it. */
export function presetCommands(
	g: TitleGenerator,
	preset: GeneratorPreset,
	rows: readonly Row[],
	frame: number,
): Command[] {
	const want = presetValues(g, preset);
	const out: Command[] = [];
	for (const row of rows) {
		const name = paramOf(row);
		if (!name || !(name in want)) continue;
		const v = want[name];
		if (row.bindings.every((b) => same(b.resolved.value, v))) continue;
		out.push(...PLAYHEAD_PLANNER.set(row, frame, () => v).commands);
	}
	return out;
}

export function GeneratorPresetChips(props: {
	generator: TitleGenerator;
	rows: readonly Row[];
	frame: number;
	readOnly?: boolean;
	apply(label: string, commands: Command[]): void;
	'data-testid'?: string;
}) {
	const { generator: g, rows } = props;
	const presets = g.presets ?? [];
	if (presets.length === 0) return null;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons; a fieldset would draw a frame
		<div
			role="group"
			aria-label={t('{0} presets', g.label)}
			className="flex flex-wrap items-center gap-1 py-1"
			data-testid={props['data-testid'] ?? 'generator-presets'}
		>
			{presets.map((p) => {
				const on = holdsPreset(g, p, rows);
				return (
					<button
						key={p.id}
						type="button"
						aria-pressed={on}
						disabled={props.readOnly}
						className={cx(
							'h-[20px] rounded-full border px-2 text-pr-small',
							on
								? 'border-pr-accent bg-pr-selected text-pr-text'
								: 'border-pr-border-strong text-pr-muted hover:bg-pr-hover hover:text-pr-text',
							'disabled:opacity-50',
						)}
						onClick={() => {
							const commands = presetCommands(g, p, rows, props.frame);
							if (commands.length) props.apply(t('Preset: {0}', p.label), commands);
						}}
						data-preset={p.id}
					>
						{p.label}
					</button>
				);
			})}
		</div>
	);
}

/** The rows of a standalone generator effect's own params (what its chips read and write). */
export function effectPresetRows(
	session: EditorSession,
	clip: EffectEditorProps['clip'],
	fx: EffectInstance,
	effect: EffectSpec,
	sequenceId: string,
	frame: number,
): Row[] {
	const doc = session.getCommitted();
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const live = seq.clips[clip.id] ?? clip;
	return effect.params
		.map((p) => makeRow(`effect.${fx.id}.${p.name}`, [bindEffectParam(doc, seq, live, fx, effect, p, frame)]))
		.filter((r): r is Row => !!r);
}

/** Effect Controls: the chips above a standalone generator's params (registered per generator effect). */
export function GeneratorEffectPresets(props: EffectEditorProps) {
	const g = generatorOf(props.fx.effectId);
	if (!g) return null;
	const rows = effectPresetRows(
		props.session,
		props.clip,
		props.fx,
		props.effect,
		props.sequenceId,
		props.frame,
	);
	return (
		<div className="pr-1 pl-4">
			<GeneratorPresetChips
				generator={g}
				rows={rows}
				frame={props.frame}
				readOnly={props.session.getState().readOnly}
				apply={(label, commands) =>
					props.session.apply({ label, origin: 'user', sequenceId: props.sequenceId, commands })
				}
				data-testid={`generator-presets-${props.fx.id}`}
			/>
		</div>
	);
}
