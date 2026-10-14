import test from 'node:test';
import assert from 'node:assert/strict';

import {normalizeQuotaSource, readQuota} from '../runtime/source.mjs';

const officialFailure = errorCode => ({
  ok: false,
  queryOk: false,
  errorCode,
  error: 'official failure',
  windows: [],
  accountKey: 'codex-account'
});

const officialSuccess = () => ({
  ok: true,
  queryOk: true,
  windows: [{label: '5 小时', minutes: 300, remaining: 80}],
  accountKey: 'codex-account'
});

const balanceSuccess = () => ({
  ok: true,
  queryOk: true,
  source: 'deepseek',
  windows: [],
  balance: {currency: 'CNY', total: 4.07, granted: 0, toppedUp: 4.07, available: true},
  accountKey: 'balance-account'
});

test('normalizeQuotaSource keeps known values and defaults to auto', () => {
  assert.equal(normalizeQuotaSource('deepseek'), 'deepseek');
  assert.equal(normalizeQuotaSource('codex'), 'codex');
  assert.equal(normalizeQuotaSource('auto'), 'auto');
  assert.equal(normalizeQuotaSource('nonsense'), 'auto');
  assert.equal(normalizeQuotaSource(undefined), 'auto');
});

test('auto keeps the official result and tags its source', async () => {
  const result = await readQuota({}, {
    readCodex: async () => officialSuccess(),
    readBalance: async () => balanceSuccess()
  });
  assert.equal(result.source, 'codex');
  assert.equal(result.ok, true);
  assert.equal(result.windows.length, 1);
});

test('auto falls back to the balance only for logins without subscription quota', async () => {
  for (const errorCode of ['AUTH_MODE_UNSUPPORTED', 'NO_WINDOWS']) {
    const result = await readQuota({}, {
      readCodex: async () => officialFailure(errorCode),
      readBalance: async () => balanceSuccess()
    });
    assert.equal(result.source, 'deepseek', errorCode + ' should fall back');
    assert.equal(result.balance.total, 4.07);
  }
});

test('auto never hides a real query failure behind the balance source', async () => {
  const result = await readQuota({}, {
    readCodex: async () => officialFailure('RATE_LIMITS_READ_FAILED'),
    readBalance: async () => balanceSuccess()
  });
  assert.equal(result.source, 'codex');
  assert.equal(result.errorCode, 'RATE_LIMITS_READ_FAILED');
});

test('auto keeps the official error when the balance source has no credentials', async () => {
  const result = await readQuota({}, {
    readCodex: async () => officialFailure('AUTH_MODE_UNSUPPORTED'),
    readBalance: async () => ({ok: false, queryOk: false, errorCode: 'NO_CREDENTIALS', windows: [], source: 'deepseek'})
  });
  assert.equal(result.source, 'codex');
  assert.equal(result.errorCode, 'AUTH_MODE_UNSUPPORTED');
});

test('an explicit source is honoured and skips the other one', async () => {
  let codexCalls = 0;
  const deepseek = await readQuota({quotaSource: 'deepseek'}, {
    readCodex: async () => {
      codexCalls += 1;
      return officialSuccess();
    },
    readBalance: async () => balanceSuccess()
  });
  assert.equal(codexCalls, 0);
  assert.equal(deepseek.source, 'deepseek');

  const codex = await readQuota({quotaSource: 'codex'}, {
    readCodex: async () => officialFailure('AUTH_MODE_UNSUPPORTED'),
    readBalance: async () => balanceSuccess()
  });
  assert.equal(codex.source, 'codex');
  assert.equal(codex.errorCode, 'AUTH_MODE_UNSUPPORTED');
});
