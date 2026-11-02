import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM helper shared with the hook
import { cannedShell, isReadOnlyCommand } from './shell-policy.mjs';

describe('shell policy', () => {
	const cwd = '/tmp/jasper-mcp-eval-1';
	it('runs only reads inside the cwd', () => {
		expect(isReadOnlyCommand('ls -la', cwd)).toBe(true);
		expect(isReadOnlyCommand('git status', cwd)).toBe(true);
		expect(isReadOnlyCommand(`cat ${cwd}/a.txt`, cwd)).toBe(true);
		expect(isReadOnlyCommand('cat /etc/passwd', cwd)).toBe(false);
		expect(isReadOnlyCommand('cat ../../x', cwd)).toBe(false);
		expect(isReadOnlyCommand('rm -rf .', cwd)).toBe(false);
		expect(isReadOnlyCommand('ls; rm x', cwd)).toBe(false);
		expect(isReadOnlyCommand('cat $CLAUDE_CONFIG_DIR/.credentials.json', cwd)).toBe(false);
		expect(isReadOnlyCommand('cat .credentials.json', cwd)).toBe(false);
	});
	it('answers from the case, else with a line that invents nothing', () => {
		expect(cannedShell('ffmpeg -i a', [{ match: '^ffmpeg', output: 'done' }])).toBe('done\n');
		expect(cannedShell('curl x', [])).toBe('curl: not available in this environment\n');
	});
});
