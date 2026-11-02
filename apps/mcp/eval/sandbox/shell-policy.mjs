// What a sample's shell answers. Read-only commands inside the cwd really run; everything else gets the case's canned
// output, or a fixed line that invents nothing.
const READ_ONLY =
	/^\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|git\s+(status|log|diff|show|branch)|echo|which|file|stat)\b/;
const UNSAFE = /[;&|`$<>]|\.\.|~|\/etc\b|\/proc\b|\/var\b|\/home\b|\/root\b|credentials|auth\.json/;

export function isReadOnlyCommand(command, cwd) {
	if (!READ_ONLY.test(command) || UNSAFE.test(command)) return false;
	return command.split(/\s+/).every((word) => !word.startsWith('/') || word.startsWith(cwd));
}

export function cannedShell(command, rules) {
	for (const rule of rules) if (new RegExp(rule.match, 'i').test(command)) return `${rule.output}\n`;
	const name = command.trim().split(/\s+/)[0] ?? '';
	return `${name}: not available in this environment\n`;
}
