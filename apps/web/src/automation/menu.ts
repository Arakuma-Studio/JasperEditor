// Sequence ▸ Automate (spec 15 EA-040): the editing-automation passes, one dialog each. Later work packages (reactions,
// slides, music, stingers; style recipes, Apply Style…, Style Check) add their entries to this list — the menubar
// builds the submenu from it, so nothing else changes. `separatorBefore` starts a new group.
export type AutomateMenuEntry = {
	/** The UI command it runs (`commands/automation.ts`). */
	command: string;
	/** English label (translated when the menu is read). */
	label: string;
	separatorBefore?: boolean;
};

export const AUTOMATE_MENU: AutomateMenuEntry[] = [
	{ command: 'automation.decorateCuts', label: 'Decorate Cuts…' },
	{ command: 'automation.punchIns', label: 'Punch-ins…' },
	{ command: 'automation.kenBurns', label: 'Ken Burns…' },
];
