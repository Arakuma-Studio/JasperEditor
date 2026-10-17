// History step labels in the UI language (WP6.5a): the Edit menu's "Undo <step>" / "Redo <step>" and the crash-recovery
// list. A step's label is stored as the command made it (English for the model's names, which agents and the journal
// read); it is translated where it is shown, as the History panel shows it (`translateName`: a model name, a
// sound-design template or names joined by separators such as "Agent: Place Sound Whoosh").
import { t, translateName } from '../i18n/runtime.ts';

export function undoMenuLabel(step: string | null): string {
	return step ? t('Undo {0}', step) : t('Undo');
}

export function redoMenuLabel(step: string | null): string {
	return step ? t('Redo {0}', step) : t('Redo');
}

/** A step label in the UI language (unchanged when nothing in it is a known name). */
export function historyStepLabel(step: string): string {
	return translateName(step) ?? step;
}

/** A crash-recovery change as the session journals it ("Undo <step>", "Redo <step>" or the step). */
export function recoveryChangeLabel(stored: string): string {
	const m = /^(Undo|Redo) (.+)$/s.exec(stored);
	if (m) return m[1] === 'Undo' ? undoMenuLabel(m[2]!) : redoMenuLabel(m[2]!);
	return historyStepLabel(stored);
}
