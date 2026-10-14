import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

import {parseFlatToml, readTomlValue} from '../runtime/toml.mjs';
import {
  balanceAccountKey,
  normalizeBalance,
  readDeepSeekBalance,
  resolveProviderCredentials
} from '../runtime/sources/deepseek.mjs';

const CONFIG = `model = "deepseek-v4-flash"
model_provider = "deepseek"

[desktop]
avatar-overlay-pet-visible = false

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
wire_api = "responses"
experimental_bearer_token = "sk-inline"

[projects."/home/USER/Desktop"]
trust_level = "trusted"
`;

test('parseFlatToml reads sections, comments and quoted table names', () => {
  const sections = parseFlatToml(CONFIG);
  assert.equal(readTomlValue(sections, '', 'model_provider'), 'deepseek');
  assert.equal(readTomlValue(sections, 'model_providers.deepseek', 'base_url'), 'https://api.deepseek.com/');
  assert.equal(readTomlValue(sections, 'projects./home/USER/Desktop', 'trust_level'), 'trusted');
  // A hash inside a quoted value is not a comment.
  const withHash = parseFlatToml('token = "abc#def" # trailing\n');
  assert.equal(readTomlValue(withHash, '', 'token'), 'abc#def');
});

test('resolveProviderCredentials prefers the inline token, then env_key, then auth.json', () => {
  assert.deepEqual(
    resolveProviderCredentials({configText: CONFIG, env: {}}),
    {provider: 'deepseek', baseUrl: 'https://api.deepseek.com', token: 'sk-inline', tokenSource: 'config'}
  );
  const viaEnv = CONFIG.replace('experimental_bearer_token = "sk-inline"', 'env_key = "MY_PROVIDER_KEY"');
  assert.deepEqual(
    resolveProviderCredentials({configText: viaEnv, env: {MY_PROVIDER_KEY: 'sk-env'}}),
    {provider: 'deepseek', baseUrl: 'https://api.deepseek.com', token: 'sk-env', tokenSource: 'env:MY_PROVIDER_KEY'}
  );
  // env_key present but unset falls through to auth.json.
  const auth = JSON.stringify({OPENAI_API_KEY: 'sk-auth', auth_mode: 'apikey'});
  assert.deepEqual(
    resolveProviderCredentials({configText: viaEnv, authText: auth, env: {}}),
    {provider: 'deepseek', baseUrl: 'https://api.deepseek.com', token: 'sk-auth', tokenSource: 'auth.json'}
  );
  assert.equal(resolveProviderCredentials({configText: 'model = "x"\n', env: {}}), null);
});

test('balanceAccountKey is stable, key-specific and does not contain the token', () => {
  const a = balanceAccountKey({baseUrl: 'https://api.deepseek.com', token: 'sk-one'});
  const b = balanceAccountKey({baseUrl: 'https://api.deepseek.com', token: 'sk-two'});
  assert.equal(a, balanceAccountKey({baseUrl: 'https://api.deepseek.com', token: 'sk-one'}));
  assert.notEqual(a, b);
  assert.equal(a.length, 32);
  assert.ok(!a.includes('sk-one'));
  assert.equal(
    a,
    createHash('sha256').update('https://api.deepseek.com\nsk-one').digest('hex').slice(0, 32)
  );
  assert.equal(balanceAccountKey({baseUrl: 'https://api.deepseek.com'}), null);
});

test('normalizeBalance parses amounts and rejects unusable payloads', () => {
  const parsed = normalizeBalance({is_available: true, balance_infos: [{currency: 'CNY', total_balance: '4.07', granted_balance: '0.00', topped_up_balance: '4.07'}]}, 1000);
  assert.deepEqual(parsed, {ok: true, queryOk: true, at: 1000, currency: 'CNY', total: 4.07, granted: 0, toppedUp: 4.07, available: true});
  assert.equal(normalizeBalance({balance_infos: []}, 1).errorCode, 'BALANCE_EMPTY');
  assert.equal(normalizeBalance({balance_infos: [{currency: 'CNY', total_balance: 'unknown'}]}, 1).errorCode, 'BALANCE_INVALID');
  assert.equal(normalizeBalance(null, 1).errorCode, 'BALANCE_EMPTY');
});

const okResponse = payload => ({
  ok: true,
  status: 200,
  json: async () => payload
});

test('readDeepSeekBalance returns a snapshot shaped like the official source', async () => {
  let requested = null;
  const snapshot = await readDeepSeekBalance({
    credentials: {provider: 'deepseek', baseUrl: 'https://api.deepseek.com', token: 'sk-test'},
    fetchImpl: async (url, options) => {
      requested = {url, authorization: options.headers.Authorization};
      return okResponse({is_available: true, balance_infos: [{currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00'}]});
    },
    now: () => 5000
  });
  assert.equal(requested.url, 'https://api.deepseek.com/user/balance');
  assert.equal(requested.authorization, 'Bearer sk-test');
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.queryOk, true);
  assert.equal(snapshot.source, 'deepseek');
  assert.equal(snapshot.planLabel, 'DeepSeek 余额');
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(snapshot.balance, {currency: 'CNY', total: 12.5, granted: 2.5, toppedUp: 10, available: true});
  assert.equal(snapshot.accountKey, balanceAccountKey({baseUrl: 'https://api.deepseek.com', token: 'sk-test'}));
});

test('readDeepSeekBalance reports missing credentials, HTTP errors and network failures', async () => {
  const missing = await readDeepSeekBalance({credentials: null, fetchImpl: async () => okResponse({}), now: () => 1});
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'NO_CREDENTIALS');
  assert.equal(missing.clearPrevious, true);

  const credentials = {provider: 'deepseek', baseUrl: 'https://api.deepseek.com', token: 'sk-test'};
  const unauthorized = await readDeepSeekBalance({
    credentials,
    fetchImpl: async () => ({ok: false, status: 401, json: async () => ({})}),
    now: () => 2
  });
  assert.equal(unauthorized.errorCode, 'BALANCE_HTTP_401');
  assert.equal(unauthorized.ok, false);

  const offline = await readDeepSeekBalance({
    credentials,
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
    now: () => 3
  });
  assert.equal(offline.errorCode, 'BALANCE_NETWORK');

  const timedOut = await readDeepSeekBalance({
    credentials,
    fetchImpl: async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
    now: () => 4
  });
  assert.equal(timedOut.errorCode, 'BALANCE_TIMEOUT');
});
