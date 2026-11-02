// What a sample's shell answers. Read-only commands inside the cwd really run; everything else gets the case's canned
// output, or a fixed line that invents nothing. A read outside the sandbox finds nothing rather than claiming the shell
// is broken: a sample that believes it cannot list files is testing the sandbox, not the server.
const READ_ONLY =
	/^\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|git\s+(status|log|diff|show|branch)|echo|which|file|stat)\b/;
const UNSAFE = /[`$<>|]|\.\.|~|\/etc\b|\/proc\b|\/var\b|\/home\b|\/root\b|credentials|auth\.json/;

/** The commands of a `;` or `&&` chain, with harmless stderr redirects dropped. */
const parts = (command) =>
	command
		.replaceAll('2>/dev/null', '')
		.split(/;|&&/)
		.map((p) => p.trim())
		.filter(Boolean);

export function isReadOnlyCommand(command, cwd) {
	const all = parts(command);
	return (
		all.length > 0 &&
		all.every(
			(part) =>
				READ_ONLY.test(part) &&
				!UNSAFE.test(part) &&
				part.split(/\s+/).every((word) => !word.startsWith('/') || word.startsWith(cwd)),
		)
	);
}

export function cannedShell(command, rules) {
	for (const rule of rules) if (new RegExp(rule.match, 'i').test(command)) return `${rule.output}\n`;
	if (parts(command).every((part) => READ_ONLY.test(part))) return '';
	const name = command.trim().split(/\s+/)[0] ?? '';
	return `${name}: not available in this environment\n`;
}
