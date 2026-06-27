import test from 'node:test';
import assert from 'node:assert/strict';

import SolanaPayMonitor from '../src/billing/solana-pay.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeDb() {
  return {
    db: {
      prepare() {
        return { get: () => null, run: () => undefined };
      },
    },
  };
}

function monitorWithRpc(solanaPay = {}) {
  const calls = [];
  const monitor = new SolanaPayMonitor(
    {
      solanaPay: {
        merchantWallet: 'merchant-wallet',
        rpcUrl: 'https://rpc.example.invalid',
        ...solanaPay,
      },
    },
    logger,
    fakeDb(),
    null,
  );

  monitor._rpc = async (method, params) => {
    calls.push({ method, params });

    if (method === 'getSignaturesForAddress' && params[0] === 'reference-address') {
      return [];
    }
    if (method === 'getSignaturesForAddress' && params[0] === 'merchant-wallet') {
      return [{ signature: 'manual-transfer-sig', blockTime: 1_800_000_000 }];
    }
    if (method === 'getTransaction') {
      return {
        transaction: { message: { accountKeys: ['merchant-wallet'] } },
        meta: { preBalances: [0], postBalances: [1_000_000_000] },
      };
    }

    return null;
  };

  return { monitor, calls };
}

const payment = {
  id: 1,
  reference: 'reference-address',
  currency: 'SOL',
  amount: 1,
  created_at: '2026-06-28 12:00:00',
};

test('manual-transfer fallback is disabled by default', async () => {
  const { monitor, calls } = monitorWithRpc();

  const confirmed = await monitor._verifyPayment(payment);

  assert.equal(confirmed, null);
  assert.deepEqual(
    calls.filter(call => call.method === 'getSignaturesForAddress').map(call => call.params[0]),
    ['reference-address'],
  );
});

test('manual-transfer fallback runs only when explicitly enabled', async () => {
  const { monitor, calls } = monitorWithRpc({ manualFallback: true });

  const confirmed = await monitor._verifyPayment(payment);

  assert.deepEqual(confirmed, { signature: 'manual-transfer-sig' });
  assert.deepEqual(
    calls.filter(call => call.method === 'getSignaturesForAddress').map(call => call.params[0]),
    ['reference-address', 'merchant-wallet'],
  );
});
