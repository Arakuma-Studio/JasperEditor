// The managed account a run uses, named explicitly: there is no default, never the system login, never an API key.
//
// Credentials stay where Orquester keeps them. A sample points the CLI at the account's real home and nothing here
// copies, links, moves or rewrites a credential file: OAuth refresh tokens rotate, so a refresh that landed in a copy
// would strand the real login. `credentialState` reads only the expiry number and returns no token material.
//
// A CLI spends its refresh token only in the last 5 minutes of the access token; the Orquester daemon renews ahead of
// that. A sample starts only with MIN_TOKEN_MINUTES left and is killed at SAMPLE_TIMEOUT_MS, so an eval process can
// never reach its own refresh window and never races the daemon or a live chat for a single-use token.
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Agent = 'claude' | 'codex';

export type AccountRecord = {
	id: string;
	agent: string;
	label: string;
	needsReauth?: boolean;
};

export type EvalAccount = { id: string; label: string; agent: Agent; home: string };

/** Longest a sample may run, after which it is killed. */
export const SAMPLE_TIMEOUT_MS = 6 * 60_000;
/** Access-token time a sample needs to start: the timeout plus the CLI's 5-minute refresh window, with margin. */
export const MIN_TOKEN_MINUTES = 25;

/** Environment that would override the account's own login. Removed from every sample. */
export const AUTH_ENV = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'OPENAI_API_KEY',
	'CODEX_API_KEY',
	'CODEX_ACCESS_TOKEN',
] as const;

const CONFIG_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

const CREDENTIAL_FILE: Record<Agent, string> = { claude: '.credentials.json', codex: 'auth.json' };

/** Orquester's appdir: `--appdir`, else ORQUESTER_APPDIR, else the home that holds `daemon/`, else ~/.orquester. */
export function resolveAppdir(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (flag) return flag;
	if (env.ORQUESTER_APPDIR) return env.ORQUESTER_APPDIR;
	const home = homedir();
	try {
		lstatSync(join(home, 'daemon', 'agent-accounts.json'));
		return home;
	} catch {
		return join(home, '.orquester');
	}
}

/** One account of `agent` by label, the part of the label before `@`, or an id prefix. Refuses anything else. */
export function pickAccount(accounts: readonly AccountRecord[], agent: Agent, wanted: string): AccountRecord {
	const query = wanted.trim().toLowerCase();
	if (query.length === 0 || query === 'system')
		throw new Error('Name a managed account (--account <label or id>); the system login is never used.');
	const mine = accounts.filter((a) => a.agent === agent);
	const hits = mine.filter(
		(a) =>
			a.id.toLowerCase().startsWith(query) ||
			a.label.toLowerCase() === query ||
			a.label.toLowerCase().split('@')[0] === query,
	);
	const known = mine.map((a) => a.label).join(', ');
	if (hits.length === 0) throw new Error(`No managed ${agent} account "${wanted}". Known: ${known}.`);
	if (hits.length > 1)
		throw new Error(`"${wanted}" names ${hits.length} accounts; use more of the id. Known: ${known}.`);
	return hits[0]!;
}

/** The account named `wanted` under `appdir`, checked to hold a login of its own in a regular file. */
export function resolveAccount(appdir: string, agent: Agent, wanted: string): EvalAccount {
	const index = JSON.parse(readFileSync(join(appdir, 'daemon', 'agent-accounts.json'), 'utf8')) as {
		accounts: AccountRecord[];
	};
	const account = pickAccount(index.accounts, agent, wanted);
	if (account.needsReauth) throw new Error(`Account ${account.label} needs a new login in Orquester first.`);
	const home = join(appdir, 'daemon', 'agent-accounts', agent, account.id, 'home');
	assertCredentialFile(agent, home, account.label);
	return { id: account.id, label: account.label, agent, home };
}

function assertCredentialFile(agent: Agent, home: string, label: string): void {
	const path = join(home, CREDENTIAL_FILE[agent]);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		throw new Error(`Account ${label} has no login in its home.`);
	}
	if (!stat.isFile()) throw new Error(`Account ${label}: ${CREDENTIAL_FILE[agent]} is not a regular file.`);
}

export type CredentialState = {
	/** Minutes until the access token expires; null when the file holds none. */
	minutesLeft: number | null;
	mtimeMs: number;
	size: number;
	mode: number;
};

/** Minutes left on the access token, from the expiry alone. `null` when unknown. Pure, for the tests. */
export function minutesLeftOf(agent: Agent, credentials: unknown, now: number): number | null {
	const root = credentials as {
		claudeAiOauth?: { expiresAt?: unknown };
		tokens?: { access_token?: unknown };
	} | null;
	let expiresMs: number | null = null;
	if (agent === 'claude') {
		const at = root?.claudeAiOauth?.expiresAt;
		if (typeof at === 'number') expiresMs = at;
	} else {
		const jwt = root?.tokens?.access_token;
		const payload = typeof jwt === 'string' ? jwt.split('.')[1] : undefined;
		if (payload) {
			try {
				const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
				if (typeof exp === 'number') expiresMs = exp * 1000;
			} catch {
				expiresMs = null;
			}
		}
	}
	return expiresMs === null ? null : Math.floor((expiresMs - now) / 60_000);
}

/** The file's metadata and the expiry number. Holds no token: nothing here can reach a log. */
export function credentialState(account: EvalAccount, now = Date.now()): CredentialState {
	const path = join(account.home, CREDENTIAL_FILE[account.agent]);
	const stat = lstatSync(path);
	if (!stat.isFile())
		throw new Error(`Account ${account.label}: credentials are not a regular file any more.`);
	let minutesLeft: number | null = null;
	try {
		minutesLeft = minutesLeftOf(account.agent, JSON.parse(readFileSync(path, 'utf8')), now);
	} catch {
		minutesLeft = null;
	}
	return { minutesLeft, mtimeMs: stat.mtimeMs, size: stat.size, mode: stat.mode & 0o777 };
}

/** Whether a sample may start now. An unknown expiry is refused: the rule can't be shown to hold. */
export function canStartSample(state: Pick<CredentialState, 'minutesLeft'>): boolean {
	return state.minutesLeft !== null && state.minutesLeft >= MIN_TOKEN_MINUTES;
}

/**
 * The environment of a sample: the caller's without any auth or config-dir override, pointed at the account's real
 * home the way Orquester launches a chat. No temporary home: a copied login is how a refresh gets lost.
 */
export function sampleEnv(
	account: EvalAccount,
	base: NodeJS.ProcessEnv,
	extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of AUTH_ENV) delete env[key];
	for (const key of CONFIG_ENV) delete env[key];
	env[account.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = account.home;
	return { ...env, ...extra };
}

const AUTH_FAILURE =
	/invalid_grant|refresh_token_(?:reused|expired|invalidated)|could not be refreshed|please (?:run \/login|log ?in|sign in)|not logged in|oauth token (?:has )?expired|authentication_error|401 unauthorized/i;

/** Output of a sample that means the login itself failed: the run stops instead of retrying a dead login. */
export function isAuthFailure(text: string): boolean {
	return AUTH_FAILURE.test(text);
}

/** Account-usage limits, which move a run to another account or stop it; never a model failure. */
export function isQuotaFailure(text: string): boolean {
	return /usage limit|rate[ _-]?limit(?:ed)?|limit reached|quota exceeded|out of (?:extra )?usage/i.test(
		text,
	);
}

/** The per-cwd session directory a Claude sample leaves in the home; the only path cleanup may remove. */
export function claudeSessionDir(home: string, cwd: string): string {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	if (!slug.includes('jasper-mcp-eval-'))
		throw new Error(`Refusing a session directory outside the eval's throwaway cwds: ${cwd}`);
	return join(home, 'projects', slug);
}
