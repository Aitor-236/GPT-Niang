// DeepSeek balance source.
//
// The Linux desktop client on this machine is signed in with an API key
// (DeepSeek through a custom provider), so the Codex App Server cannot report
// subscription quota windows. This adapter reads the provider balance instead,
// through the same credential the desktop client already uses.
//
// Scope rules: read-only, no chat or model calls, credentials stay in memory
// (config.toml -> env_key -> auth.json), and only a salted fingerprint of the
// credential is ever persisted so snapshots cannot leak across accounts.

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

import {parseFlatToml, readTomlValue} from '../toml.mjs';

export const DEEPSEEK_SOURCE = 'deepseek';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const BALANCE_PATH = '/user/balance';

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function codexHome(env) {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  return env.HOME ? path.join(env.HOME, '.codex') : null;
}

function providerIds(sections) {
  return [...sections.keys()]
    .map(section => /^model_providers\.(.+)$/.exec(section))
    .filter(Boolean)
    .map(match => match[1]);
}

// The desktop client stores the credential either inline in its provider
// block or behind an environment variable name; auth.json is the last resort.
export function resolveProviderCredentials({configText, authText, env = process.env} = {}) {
  const sections = parseFlatToml(configText ?? '');
  const configured = readTomlValue(sections, '', 'model_provider');
  const ids = providerIds(sections);
  const order = configured && ids.includes(configured) ? [configured, ...ids.filter(id => id !== configured)] : ids;
  const auth = authText ? JSON.parse(authText) : null;
  for (const id of order) {
    const section = `model_providers.${id}`;
    const baseUrl = (readTomlValue(sections, section, 'base_url') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const inline = readTomlValue(sections, section, 'experimental_bearer_token');
    if (inline) return {provider: id, baseUrl, token: inline, tokenSource: 'config'};
    const envKey = readTomlValue(sections, section, 'env_key');
    const fromEnv = envKey ? env[envKey] : null;
    if (fromEnv) return {provider: id, baseUrl, token: fromEnv, tokenSource: 'env:' + envKey};
  }
  const apiKey = auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().length > 0
    ? auth.OPENAI_API_KEY.trim()
    : null;
  if (apiKey) {
    const fallback = order[0] ?? 'deepseek';
    const baseUrl = (readTomlValue(sections, `model_providers.${fallback}`, 'base_url') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    return {provider: fallback, baseUrl, token: apiKey, tokenSource: 'auth.json'};
  }
  return null;
}

export function credentialsFromEnvironment(env = process.env) {
  const home = codexHome(env);
  if (!home) return null;
  return resolveProviderCredentials({
    configText: readText(path.join(home, 'config.toml')),
    authText: readText(path.join(home, 'auth.json')),
    env
  });
}

// A cheap, non-reversible marker so a snapshot taken with one key is never
// reused for another. The credential itself is never stored.
export function balanceAccountKey(credentials) {
  if (!credentials?.baseUrl || !credentials?.token) return null;
  return createHash('sha256').update(credentials.baseUrl + '\n' + credentials.token).digest('hex').slice(0, 32);
}

export function normalizeBalance(payload, now = Date.now()) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : null;
  if (!infos || infos.length === 0) {
    return {ok: false, queryOk: false, errorCode: 'BALANCE_EMPTY', error: 'DeepSeek 余额接口未返回可用余额'};
  }
  const amount = value => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const primary = infos[0];
  const total = amount(primary.total_balance);
  if (total === null) {
    return {ok: false, queryOk: false, errorCode: 'BALANCE_INVALID', error: 'DeepSeek 余额接口返回的金额无法解析'};
  }
  return {
    ok: true,
    queryOk: true,
    at: now,
    currency: typeof primary.currency === 'string' ? primary.currency : 'CNY',
    total,
    granted: amount(primary.granted_balance),
    toppedUp: amount(primary.topped_up_balance),
    available: payload?.is_available !== false
  };
}

// `fetchImpl` is injected so the adapter can be tested without network access.
export async function readDeepSeekBalance({
  credentials = credentialsFromEnvironment(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  now = Date.now()
} = {}) {
  const base = {
    source: DEEPSEEK_SOURCE,
    plan: 'deepseek',
    planLabel: 'DeepSeek 余额',
    planKnown: true,
    planSource: 'balance',
    authType: 'apiKey',
    windows: []
  };
  if (!credentials?.token) {
    return {
      ...base,
      ok: false,
      queryOk: false,
      errorCode: 'NO_CREDENTIALS',
      error: '未找到 DeepSeek 凭据（config.toml 的 provider 或 auth.json）',
      clearPrevious: true,
      observedAt: now()
    };
  }
  const accountKey = balanceAccountKey(credentials);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(credentials.baseUrl + BALANCE_PATH, {
      method: 'GET',
      headers: {Authorization: 'Bearer ' + credentials.token, Accept: 'application/json'},
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ...base,
        ok: false,
        queryOk: false,
        accountKey,
        errorCode: 'BALANCE_HTTP_' + response.status,
        error: 'DeepSeek 余额读取失败（HTTP ' + response.status + '）',
        observedAt: now()
      };
    }
    const balance = normalizeBalance(await response.json(), now());
    if (!balance.ok) return {...base, ...balance, accountKey, observedAt: now()};
    return {
      ...base,
      ok: true,
      queryOk: true,
      accountKey,
      observedAt: balance.at,
      balance: {currency: balance.currency, total: balance.total, granted: balance.granted, toppedUp: balance.toppedUp, available: balance.available}
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ...base,
      ok: false,
      queryOk: false,
      accountKey,
      errorCode: aborted ? 'BALANCE_TIMEOUT' : 'BALANCE_NETWORK',
      error: aborted ? 'DeepSeek 余额查询超时，稍后重试' : '无法连接 DeepSeek 余额接口',
      observedAt: now()
    };
  } finally {
    clearTimeout(timer);
  }
}
