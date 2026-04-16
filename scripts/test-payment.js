#!/usr/bin/env node
/**
 * TrendScout — Solana Pay manual test script
 *
 * Usage:
 *   node scripts/test-payment.js                    # list pending payments
 *   node scripts/test-payment.js intent starter SOL  # create payment intent
 *   node scripts/test-payment.js check <reference>   # check one payment
 *   node scripts/test-payment.js simulate <reference> <tx_sig>  # simulate confirm (dev only)
 */

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────

const config = {
  dbPath: process.env.DB_PATH || path.join(__dirname, '../data/trendscout.db'),
  solanaPay: {
    merchantWallet: process.env.SOLANA_MERCHANT_WALLET,
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

const logger = {
  info:  (msg) => console.log(`\x1b[36m[INFO]\x1b[0m  ${msg}`),
  warn:  (msg) => console.log(`\x1b[33m[WARN]\x1b[0m  ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  debug: (msg) => console.log(`\x1b[90m[DEBUG]\x1b[0m ${msg}`),
};

// ── Imports ──────────────────────────────────────────────────────────────────

let db, monitor;
try {
  const { default: TrendDatabase }    = await import('../src/db/database.js');
  const { default: SolanaPayMonitor } = await import('../src/billing/solana-pay.js');

  db      = new TrendDatabase(config.dbPath, logger);
  monitor = new SolanaPayMonitor(config, logger, db, async (userId, planName) => {
    console.log(`\n\x1b[32m✅ PAYMENT CONFIRMED!\x1b[0m user_id=${userId} plan=${planName}\n`);
  });
} catch (e) {
  logger.warn(`Не удалось загрузить базу данных: ${e.message}`);
  logger.info('Тестирование без БД (только Solana Pay логика)');

  // Mock DB для тестирования Solana Pay логики без БД
  db = {
    getPaymentByReference: () => null,
    getPendingPayments: () => [],
    expireOldPayments: () => {},
    confirmPayment: () => {},
    upgradePlan: () => {},
    db: { prepare: () => ({ all: () => [], get: () => null }) },
    close: () => {},
  };

  // Mock SolanaPayMonitor для тестирования
  const { default: SolanaPayMonitor } = await import('../src/billing/solana-pay.js');
  monitor = new SolanaPayMonitor(config, logger, db, async (userId, planName) => {
    console.log(`\n\x1b[32m✅ PAYMENT CONFIRMED!\x1b[0m user_id=${userId} plan=${planName}\n`);
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

const [,, cmd, arg1, arg2, arg3] = process.argv;

switch (cmd) {

  // ─────────────────────────────────────────────────────────────────────────
  case 'intent': {
    // node scripts/test-payment.js intent <plan> <currency>
    const plan     = arg1 || 'starter';
    const currency = arg2 || 'USDC';

    console.log(`\nGenerating ${currency} payment intent for plan: \x1b[1m${plan}\x1b[0m`);
    try {
      const intent = await monitor.createPaymentIntent(plan, currency);
      console.log('\n─────────────────────────────────────────');
      console.log(`Amount:    \x1b[32m${intent.amount} ${intent.currency}\x1b[0m`);
      console.log(`Reference: \x1b[36m${intent.reference}\x1b[0m`);
      console.log(`Pay URL:   ${intent.payUrl}`);
      console.log('─────────────────────────────────────────\n');
      console.log('Next step:');
      console.log(`  node scripts/test-payment.js check ${intent.reference}\n`);
    } catch (e) {
      logger.error(e.message);
    }
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  case 'check': {
    // node scripts/test-payment.js check <reference>
    const reference = arg1;
    if (!reference) { console.error('Usage: test-payment.js check <reference>'); break; }

    const payment = db.getPaymentByReference(reference);
    if (!payment) {
      logger.warn(`No payment found with reference: ${reference}`);
      break;
    }
    console.log('\nPayment record:');
    console.table({ ...payment });

    if (payment.status !== 'pending') {
      console.log(`\nStatus: \x1b[33m${payment.status}\x1b[0m — nothing to verify`);
      break;
    }

    console.log('\nQuerying Solana RPC for transaction...');
    try {
      // Call the internal verify method via the monitor
      const LAMPORTS_PER_SOL = 1_000_000_000;
      const rpcUrl = config.solanaPay.heliusApiKey
        ? `https://mainnet.helius-rpc.com/?api-key=${config.solanaPay.heliusApiKey}`
        : config.solanaPay.rpcUrl;

      const rpc = async (method, params) => {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        const json = await res.json();
        if (json.error) throw new Error(`RPC: ${JSON.stringify(json.error)}`);
        return json.result;
      };

      const sigs = await rpc('getSignaturesForAddress', [reference, { limit: 5, commitment: 'confirmed' }]);
      if (!sigs || sigs.length === 0) {
        console.log('\x1b[33m⏳ No transaction found yet for this reference.\x1b[0m');
        console.log('The payment has not been sent, or is still propagating.');
      } else {
        console.log(`\nFound ${sigs.length} signature(s):`);
        sigs.forEach(s => console.log(`  ${s.signature} err=${s.err || 'null'}`));
        console.log('\nRunning full verification...');

        // Trigger real verification cycle
        db.expireOldPayments();
        const pending = db.getPendingPayments().filter(p => p.reference === reference);
        if (pending.length) {
          // Use the monitor's internal _checkPendingPayments
          await monitor._checkPendingPayments();
          const updated = db.getPaymentByReference(reference);
          console.log(`\nResult: \x1b[1m${updated.status}\x1b[0m tx=${updated.tx_signature || 'none'}`);
        }
      }
    } catch (e) {
      logger.error(e.message);
    }
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  case 'list': {
    // node scripts/test-payment.js list
    const all = db.db.prepare(`
      SELECT p.*, u.telegram_chat_id FROM payments p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC LIMIT 20
    `).all();

    if (all.length === 0) { console.log('\nNo payments in database.'); break; }
    console.log('\nRecent payments (last 20):');
    all.forEach(p => {
      const status = p.status === 'confirmed' ? '\x1b[32m✓\x1b[0m' :
                     p.status === 'expired'   ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⏳\x1b[0m';
      console.log(`  ${status} [${p.status.padEnd(9)}] ${p.amount} ${p.currency.padEnd(4)} ${p.plan_name.padEnd(8)} ref=${p.reference} user=${p.telegram_chat_id}`);
    });
    console.log();
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  case 'simulate': {
    // node scripts/test-payment.js simulate <reference> <tx_sig>
    // WARNING: dev-only, manually marks a payment as confirmed
    const reference = arg1;
    const txSig     = arg2 || 'SIMULATED_TX_' + Date.now();

    if (!reference) { console.error('Usage: test-payment.js simulate <reference> [tx_sig]'); break; }

    const payment = db.getPaymentByReference(reference);
    if (!payment) { logger.warn(`Payment not found: ${reference}`); break; }
    if (payment.status !== 'pending') { logger.warn(`Payment is ${payment.status}, not pending`); break; }

    console.log(`\n\x1b[33m⚠️  SIMULATION MODE — no real blockchain verification\x1b[0m`);
    db.confirmPayment(reference, txSig);
    db.upgradePlan(payment.user_id, payment.plan_name, 30);

    const updated = db.getPaymentByReference(reference);
    const user = db.db.prepare('SELECT * FROM users WHERE id = ?').get(payment.user_id);
    console.log(`\nSimulated confirmation:`);
    console.log(`  Payment: \x1b[32m${updated.status}\x1b[0m`);
    console.log(`  User plan: ${user?.plan_id}`);
    console.log(`  Sub expires: ${user?.subscription_expires_at}`);
    console.log('\nDon\'t forget to send the real payment for production testing!\n');
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  case 'rpc': {
    // node scripts/test-payment.js rpc — test RPC connectivity
    const rpcUrl = config.solanaPay.heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${config.solanaPay.heliusApiKey}`
      : config.solanaPay.rpcUrl;
    console.log(`\nTesting RPC: ${rpcUrl.split('?')[0]}`);
    console.log('Config: Helius API ' + (config.solanaPay.heliusApiKey ? '✓' : '✗'));
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
        signal: AbortSignal.timeout(8_000),
      });
      const json = await res.json();
      console.log(`RPC health: \x1b[32m${json.result || JSON.stringify(json)}\x1b[0m\n`);
    } catch (e) {
      console.log(`\n\x1b[31m❌ RPC не доступен: ${e.message}\x1b[0m`);
      console.log(`\x1b[36mЭто нормально для локального тестирования.\x1b[0m`);
      console.log(`На production сервере RPC должен работать.\n`);
    }
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  case 'sol-price': {
    // node scripts/test-payment.js sol-price
    console.log('\nFetching SOL/USD price from CoinGecko...');
    let price = null;
    try {
      const res  = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(5_000) });
      const data = await res.json();
      price = data?.solana?.usd;
    } catch (e) {
      price = null;
    }

    if (!price) {
      console.log(`\x1b[33m⚠️  CoinGecko не доступен, используется fallback цена: $150\x1b[0m\n`);
      price = 150;
    } else {
      console.log(`SOL price: \x1b[32m$${price}\x1b[0m\n`);
    }

    // Show what SOL amounts look like for each plan
    console.log('SOL amounts per plan (rounded up to 3 decimals):');
    const plans = { starter: 29, pro: 79, elite: 199 };
    for (const [plan, usd] of Object.entries(plans)) {
      const sol = Math.ceil((usd / price) * 1000) / 1000;
      console.log(`  ${plan.padEnd(8)}: $${usd} → ${sol} SOL`);
    }
    console.log();
    break;
  }

  // ─────────────────────────────────────────────────────────────────────────
  default: {
    console.log(`
TrendScout — Solana Pay Test Script

Commands:
  rpc                           Test Solana RPC connectivity (Helius or mainnet)
  sol-price                     Fetch current SOL/USD price and plan amounts
  intent <plan> <currency>      Create a payment intent (starter/pro/elite, SOL/USDC)
  list                          Show all payments in DB
  check <reference>             Verify a specific payment on-chain
  simulate <reference> [txsig]  ⚠️  DEV: manually confirm payment without blockchain

Example flow:
  1. node scripts/test-payment.js rpc                      # verify RPC works
  2. node scripts/test-payment.js sol-price                # check current SOL price
  3. node scripts/test-payment.js intent starter USDC      # generate payment link
  4. Send payment using the URL / wallet
  5. node scripts/test-payment.js check <reference>        # verify on-chain
`);
  }
}

db.close();
