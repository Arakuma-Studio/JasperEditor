import { it } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import type { ShellMenuItem } from '../src/shell/menus/resolve.ts';
it('lists', () => {
	registerAllCommands();
	const out: string[] = [];
	let total = 0;
	const walk = (items: readonly ShellMenuItem[], path: string) => {
		for (const i of items) {
			if (i.type === 'command') { total++; if (!getCommand(i.command)) out.push(`${path} > ${i.label} [${i.command}]`); }
			else if (i.type === 'submenu') walk(i.items, `${path} > ${i.label}`);
		}
	};
	for (const m of MENUBAR) walk(m.items, m.label);
	require('node:fs').writeFileSync('/tmp/polish/menu.txt', `TOTAL ${total}\n${out.join('\n')}`);
});
