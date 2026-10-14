// Chooses which quota source answers a refresh.
//
// `auto` (the default) keeps the official behaviour first: the Codex App
// Server result is used whenever it produced usable windows. Only when the
// login cannot report subscription quota - an API key login, or an account
// without quota windows - does it fall back to the provider balance, and only
// if credentials for that provider exist.

import {readUsage, resolveCodexExecutable} from './usage.mjs';
import {DEEPSEEK_SOURCE, readDeepSeekBalance} from './sources/deepseek.mjs';

export const QUOTA_SOURCES = ['auto', 'codex', 'deepseek'];
// Results that mean "this login has no subscription quota", not "the query
// failed" - a network failure must not silently switch sources.
const FALLBACK_CODES = new Set(['AUTH_MODE_UNSUPPORTED', 'NO_WINDOWS']);

export function normalizeQuotaSource(value) {
  return QUOTA_SOURCES.includes(value) ? value : 'auto';
}

export async function readQuota(config = {}, {
  codexPath = resolveCodexExecutable(config.codexPath),
  onAccount = () => {},
  readCodex = readUsage,
  readBalance = readDeepSeekBalance,
  now = Date.now
} = {}) {
  const preference = normalizeQuotaSource(config.quotaSource);
  if (preference === DEEPSEEK_SOURCE) {
    return {...(await readBalance({now})), source: DEEPSEEK_SOURCE};
  }
  const official = {...(await readCodex(codexPath, {onAccount})), source: 'codex'};
  if (preference === 'codex') return official;
  if (official.ok || !FALLBACK_CODES.has(official.errorCode)) return official;
  let balance;
  try {
    balance = await readBalance({now});
  } catch {
    return official;
  }
  // Keep the official error when the balance source has nothing to offer, so
  // the widget still explains why the subscription quota is missing.
  return balance?.ok ? balance : official;
}
