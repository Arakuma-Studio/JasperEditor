import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type AccountRecord,
	canStartSample,
	claudeSessionDir,
	credentialState,
	type EvalAccount,
	isAuthFailure,
	MIN_TOKEN_MINUTES,
	pickAccount,
	resolveAccount,
	resolveAppdir,
	SAMPLE_TIMEOUT_MS,
	sampleEnv,
} from './accounts.ts';

const accounts: AccountRecord[] = [
	{ id: 'aaaa1111', agent: 'claude', label: 'one@example.test' },
	{ id: 'aaaa2222', agent: 'claude', label: 'two@example.test' },
	{ id: 'bbbb3333', agent: 'codex', label: 'one@example.test' },
];

describe('pickAccount', () => {
	it('takes a label, the part before @ or an id prefix, for the right agent', () => {
		expect(pickAccount(accounts, 'claude', 'one@example.test').id).toBe('aaaa1111');
		expect(pickAccount(accounts, 'claude', 'two').id).toBe('aaaa2222');
		expect(pickAccount(accounts, 'codex', 'bbbb').id).toBe('bbbb3333');
	});
	it('has no default and never takes the system login', () => {
		expect(() => pickAccount(accounts, 'claude', '')).toThrow(/Name a managed account/);
		expect(() => pickAccount(accounts, 'claude', 'system')).toThrow(/never used/);
	});
	it('refuses unknown and ambiguous names', () => {
		expect(() => pickAccount(accounts, 'claude', 'nobody')).toThrow(/No managed/);
		expect(() => pickAccount(accounts, 'claude', 'aaaa')).toThrow(/2 accounts/);
	});
});

describe('resolveAppdir', () => {
	it('prefers the flag, then the environment', () => {
		expect(resolveAppdir('/flag', { ORQUESTER_APPDIR: '/env' })).toBe('/flag');
		expect(resolveAppdir(undefined, { ORQUESTER_APPDIR: '/env' })).toBe('/env');
	});
});

describe('credentials', () => {
	let dir: string;
	const home = () => join(dir, 'daemon/agent-accounts/claude/aaaa1111/home');
	const account = (): EvalAccount => ({ id: 'aaaa1111', label: 'one', agent: 'claude', home: home() });
	const write = (expiresAt: unknown) =>
		writeFileSync(
			join(home(), '.credentials.json'),
			JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-A', refreshToken: 'SECRET-R', expiresAt } }),
		);
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-eval-accounts-'));
		mkdirSync(home(), { recursive: true });
		writeFileSync(join(dir, 'daemon/agent-accounts.json'), JSON.stringify({ accounts }));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('refuses a needs-reauth account, a missing login and a symlinked credential file', () => {
		expect(() => resolveAccount(dir, 'claude', 'one')).toThrow(/no login/);
		write(1);
		expect(resolveAccount(dir, 'claude', 'one').home).toBe(home());
		rmSync(join(home(), '.credentials.json'));
		symlinkSync('/nonexistent', join(home(), '.credentials.json'));
		expect(() => resolveAccount(dir, 'claude', 'one')).toThrow(/not a regular file/);
		rmSync(join(home(), '.credentials.json'));
		write(1);
		writeFileSync(
			join(dir, 'daemon/agent-accounts.json'),
			JSON.stringify({ accounts: [{ ...accounts[0], needsReauth: true }] }),
		);
		expect(() => resolveAccount(dir, 'claude', 'one')).toThrow(/new login/);
	});

	it('reports the expiry and metadata without token material and without touching the file', () => {
		const now = 1_700_000_000_000;
		write(now + 90 * 60_000);
		const path = join(home(), '.credentials.json');
		const before = readFileSync(path, 'utf8');
		const beforeStat = statSync(path).mtimeMs;
		const state = credentialState(account(), now);
		expect(state.minutesLeft).toBe(90);
		expect(JSON.stringify(state)).not.toMatch(/SECRET/);
		expect(readFileSync(path, 'utf8')).toBe(before);
		expect(statSync(path).mtimeMs).toBe(beforeStat);
		expect(readdirSync(home())).toEqual(['.credentials.json']);
	});

	it('reads a Codex expiry from the access token payload only', () => {
		const now = 1_700_000_000_000;
		const exp = now / 1000 + 3600;
		const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
		const codex = { ...account(), agent: 'codex' as const };
		const path = join(codex.home, 'auth.json');
		writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt } }));
		expect(credentialState(codex, now).minutesLeft).toBe(60);
		writeFileSync(path, JSON.stringify({ tokens: { access_token: 'garbage' } }));
		expect(credentialState(codex, now).minutesLeft).toBeNull();
		writeFileSync(join(home(), '.credentials.json'), '{}');
		expect(credentialState(account(), now).minutesLeft).toBeNull();
	});
});

describe('the refresh rule', () => {
	it('keeps a sample out of the CLI refresh window for its whole life', () => {
		const cliRefreshWindowMinutes = 5;
		expect(MIN_TOKEN_MINUTES - SAMPLE_TIMEOUT_MS / 60_000).toBeGreaterThan(cliRefreshWindowMinutes);
	});
	it('starts a sample only with enough token left, and never on an unknown expiry', () => {
		expect(canStartSample({ minutesLeft: MIN_TOKEN_MINUTES })).toBe(true);
		expect(canStartSample({ minutesLeft: MIN_TOKEN_MINUTES - 1 })).toBe(false);
		expect(canStartSample({ minutesLeft: null })).toBe(false);
	});
});

describe('sampleEnv', () => {
	const account: EvalAccount = { id: 'x', label: 'x', agent: 'claude', home: '/h/claude' };
	it('removes every auth override and points at the real home', () => {
		const env = sampleEnv(account, {
			ANTHROPIC_API_KEY: 'SECRET',
			ANTHROPIC_AUTH_TOKEN: 'SECRET',
			CLAUDE_CODE_OAUTH_TOKEN: 'SECRET',
			OPENAI_API_KEY: 'SECRET',
			CODEX_API_KEY: 'SECRET',
			CODEX_ACCESS_TOKEN: 'SECRET',
			PATH: '/bin',
			CODEX_HOME: '/other',
			CLAUDE_CONFIG_DIR: '/other',
		});
		expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/claude' });
	});
	it('uses CODEX_HOME for a Codex account', () => {
		const env = sampleEnv(
			{ ...account, agent: 'codex', home: '/h/codex' },
			{ CLAUDE_CONFIG_DIR: '/other', CODEX_HOME: '/other' },
		);
		expect(env).toEqual({ CODEX_HOME: '/h/codex' });
	});
});

describe('failure detection and cleanup paths', () => {
	it('recognises a dead login', () => {
		expect(isAuthFailure('Your access token could not be refreshed. Please log out')).toBe(true);
		expect(isAuthFailure('{"error":"invalid_grant"}')).toBe(true);
		expect(isAuthFailure('Added the clip to the timeline')).toBe(false);
	});
	it('computes the session directory only for an eval cwd', () => {
		expect(claudeSessionDir('/h', '/tmp/jasper-mcp-eval-abc')).toBe('/h/projects/-tmp-jasper-mcp-eval-abc');
		expect(() => claudeSessionDir('/h', '/var/lib/orquester/workspaces/x')).toThrow(/Refusing/);
		expect(() => claudeSessionDir('/h', '/')).toThrow(/Refusing/);
	});
});
