/**
 * Solana Pay payment monitor
 *
 * Flow:
 *  1. Bot generates a unique `reference` for each payment intent (crypto-random)
 *  2. User scans QR / clicks deep-link → sends USDC or SOL to merchant wallet
 *     including the `reference` account in tx accounts list (Solana Pay spec)
 *  3. This monitor polls pending payments every ~30 s and confirms them via RPC
 *  4. On confirmation the user's plan is upgraded and they receive a bot message
 *
 * Reference verification follows the Solana Pay spec:
 *  - find any transaction where `reference` appears as an account key
 *  - verify recipient == merchantWallet and amount >= expected
 */

import { randomBytes } from 'crypto';

// SOL prices in USD — we use a conservative estimate or fetch live price
// For simplicity we let users pay the exact USD amount in USDC (stablecoin)
// and a SOL-denominated amount calculated at payment creation time via CoinGecko

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS = 6;

// Plan durations
const PLAN_DURATION_DAYS = { test: 1, pro: 30 };

class SolanaPayMonitor {
  constructor(config, logger, db, onPaymentConfirmed) {
    this.config = config.solanaPay;
    this.logger = logger;
    this.db = db;
    this.onPaymentConfirmed = onPaymentConfirmed; // async (userId, planName) => void
    this.rpcUrl = this.config.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.merchantWallet = this.config.merchantWallet;
    this.enabled = !!this.merchantWallet;
    this._timer = null;
    this._running = false;
  }

  start(intervalMs = 30_000) {
    if (!this.enabled) {
      this.logger.warn('Solana Pay: merchant wallet not configured — payment monitoring disabled');
      return;
    }
    this.logger.info(`Solana Pay monitor started (interval: ${intervalMs / 1000}s)`);
    this._timer = setInterval(() => this._checkPendingPayments(), intervalMs);
    // First check immediately
    this._checkPendingPayments();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Generate a payment intent — returns { reference, payUrl, amount, currency }
   */
  async createPaymentIntent(planName, currency = 'USDC') {
    const prices = { test: 5, pro: 100 };
    const usdAmount = prices[planName];
    if (!usdAmount) throw new Error(`Unknown plan: ${planName}`);

    const reference = this._generateReference();

    let amount, payUrl;

    if (currency === 'USDC') {
      amount = usdAmount; // 1 USDC = 1 USD
      payUrl = this._buildSolanaPayUrl(amount, reference, planName, 'USDC');
    } else {
      // SOL: fetch approximate price
      if (planName === 'test') {
        amount = 0.01;
      } else {
        const solPrice = await this._fetchSolPrice();
        amount = Math.ceil((usdAmount / solPrice) * 1000) / 1000; // round up to 3 decimals
      }
      payUrl = this._buildSolanaPayUrl(amount, reference, planName, 'SOL');
    }

    return { reference, payUrl, amount, currency };
  }

  _buildSolanaPayUrl(amount, reference, planName, currency) {
    const params = new URLSearchParams({
      amount: String(amount),
      reference,
      label: 'TrendScout',
      message: `TrendScout ${planName} plan`,
    });

    if (currency === 'USDC') {
      params.set('spl-token', USDC_MINT);
    }

    return `solana:${this.merchantWallet}?${params.toString()}`;
  }

  // ── Payment verification ───────────────────────────────────────────────────

  async _checkPendingPayments() {
    if (this._running) return;
    this._running = true;

    try {
      // Expire stale payments first
      this.db.expireOldPayments();

      const pending = this.db.getPendingPayments();
      if (pending.length === 0) {
        this._running = false;
        return;
      }

      this.logger.debug(`Solana Pay: checking ${pending.length} pending payment(s)`);

      for (const payment of pending) {
        try {
          const confirmed = await this._verifyPayment(payment);
          if (confirmed) {
            const durationDays = PLAN_DURATION_DAYS[payment.plan_name] || 30;
            const upgraded = this.db.confirmPaymentAndUpgrade(
              payment.reference,
              confirmed.signature,
              durationDays
            );
            if (!upgraded) continue;
            this.logger.info(`Payment confirmed: user ${payment.user_id} → plan ${payment.plan_name} (tx: ${confirmed.signature})`);

            if (this.onPaymentConfirmed) {
              await this.onPaymentConfirmed(payment.user_id, payment.plan_name).catch(e =>
                this.logger.error(`onPaymentConfirmed callback failed: ${e.message}`)
              );
            }
          }
        } catch (e) {
          this.logger.warn(`Payment check failed for ref ${payment.reference}: ${e.message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Solana Pay monitor error: ${e.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * Verify a payment by searching for a transaction containing the reference account.
   * Returns { signature } if confirmed, null otherwise.
   */
  async _verifyPayment(payment) {
    // 1. Search by reference (QR Code method)
    try {
      const signatures = await this._rpc('getSignaturesForAddress', [
        payment.reference,
        { limit: 5, commitment: 'confirmed' },
      ]);

      if (signatures && signatures.length > 0) {
        for (const sigInfo of signatures) {
          if (sigInfo.err) continue;

          // Check if tx is already consumed by another payment
          const existing = this.db.db.prepare('SELECT id FROM payments WHERE tx_signature=?').get(sigInfo.signature);
          if (existing) continue;

          const tx = await this._rpc('getTransaction', [
            sigInfo.signature,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx) continue;

          const verified = payment.currency === 'USDC' 
            ? this._verifyUSDCTransfer(tx, payment)
            : this._verifySOLTransfer(tx, payment);

          if (verified) return { signature: sigInfo.signature };
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('Invalid Base58')) {
        // Legacy base64 reference - expire it to stop log spam
        this.db.db.prepare('UPDATE payments SET status="expired" WHERE id=?').run(payment.id);
        return null;
      }
    }

    // 2. Fallback: Search by amount matching (Option 2: Manual Transfer)
    try {
      const merchantSigs = await this._rpc('getSignaturesForAddress', [
        this.merchantWallet,
        { limit: 10, commitment: 'confirmed' }
      ]);
      
      if (merchantSigs && merchantSigs.length > 0) {
        for (const sigInfo of merchantSigs) {
          if (sigInfo.err) continue;

          // Must be newer than payment creation (with a small safety buffer)
          const createdStr = payment.created_at.endsWith('Z') ? payment.created_at : payment.created_at + 'Z';
          const paymentSec = new Date(createdStr).getTime() / 1000;
          if (isNaN(paymentSec)) {
            this.logger.warn(`Bad created_at for payment ${payment.id}: ${payment.created_at}`);
          } else if (sigInfo.blockTime && sigInfo.blockTime < (paymentSec - 120)) continue;

          // Check if tx is already consumed
          const existing = this.db.db.prepare('SELECT id FROM payments WHERE tx_signature=?').get(sigInfo.signature);
          if (existing) continue;

          const tx = await this._rpc('getTransaction', [
            sigInfo.signature,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx) continue;

          const verified = payment.currency === 'USDC' 
            ? this._verifyUSDCTransfer(tx, payment)
            : this._verifySOLTransfer(tx, payment);

          if (verified) return { signature: sigInfo.signature };
        }
      }
    } catch (err) {
      this.logger.warn(`Manual payment check error: ${err.message}`);
    }

    return null;
  }

  _verifySOLTransfer(tx, payment) {
    try {
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const merchantIdx = accountKeys.findIndex(k =>
        (k.pubkey || k) === this.merchantWallet
      );
      if (merchantIdx === -1) return false;

      const pre  = tx.meta?.preBalances?.[merchantIdx]  || 0;
      const post = tx.meta?.postBalances?.[merchantIdx] || 0;
      const received = (post - pre) / LAMPORTS_PER_SOL;

      // Allow 1% tolerance (for minor SOL price changes)
      return received >= payment.amount * 0.99;
    } catch (e) {
      return false;
    }
  }

  _verifyUSDCTransfer(tx, payment) {
    try {
      // PRIMARY METHOD: check postTokenBalances for merchant receiving USDC
      // postTokenBalances is the most reliable - it shows actual owner of token accounts
      const postBalances = tx.meta?.postTokenBalances || [];
      const preBalances  = tx.meta?.preTokenBalances  || [];

      for (const post of postBalances) {
        if (post.mint !== USDC_MINT) continue;
        if (post.owner !== this.merchantWallet) continue;

        const pre = preBalances.find(b => b.accountIndex === post.accountIndex);
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
        const received = postAmt - preAmt;

        this.logger.debug(`USDC check: merchant received ${received} USDC, expected ${payment.amount}`);

        if (received >= payment.amount * 0.99) {
          return true;
        }
      }

      // FALLBACK: parse instructions (handles both transferChecked and transfer)
      const instructions = tx.transaction?.message?.instructions || [];
      const innerInstructions = tx.meta?.innerInstructions || [];
      const allInstructions = [
        ...instructions,
        ...innerInstructions.flatMap(ii => ii.instructions || []),
      ];

      for (const ix of allInstructions) {
        if (ix.program !== 'spl-token') continue;

        if (ix.parsed?.type === 'transferChecked') {
          const info = ix.parsed.info;
          if (!info || info.mint !== USDC_MINT) continue;
          const tokenAmount = parseFloat(info.tokenAmount?.uiAmount || 0);
          if (tokenAmount < payment.amount * 0.99) continue;

          // Check if destination ATA belongs to our merchant wallet
          const destBalance = postBalances.find(b =>
            b.mint === USDC_MINT && b.owner === this.merchantWallet
          );
          if (destBalance) return true;
        }

        if (ix.parsed?.type === 'transfer') {
          const info = ix.parsed.info;
          if (!info) continue;
          const tokenAmount = parseFloat(info.amount || 0) / Math.pow(10, USDC_DECIMALS);
          if (tokenAmount < payment.amount * 0.99) continue;

          const destBalance = postBalances.find(b =>
            b.mint === USDC_MINT && b.owner === this.merchantWallet
          );
          if (destBalance) return true;
        }
      }

      return false;
    } catch (e) {
      this.logger.warn(`USDC verify error: ${e.message}`);
      return false;
    }
  }

  // ── Solana RPC ─────────────────────────────────────────────────────────────

  async _rpc(method, params = []) {
    const url = this.config.heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${this.config.heliusApiKey}`
      : this.rpcUrl;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);

    const json = await response.json();
    if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    return json.result;
  }

  // ── SOL price oracle ───────────────────────────────────────────────────────

  async _fetchSolPrice() {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { signal: AbortSignal.timeout(5_000) }
      );
      const data = await res.json();
      return data?.solana?.usd || 150; // fallback to $150
    } catch {
      return 150; // conservative fallback
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  _generateReference() {
    return this._generateBase58(32);
  }

  _generateBase58(byteLen) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = randomBytes(byteLen);
    const digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let str = '';
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) str += '1';
    for (let i = digits.length - 1; i >= 0; i--) str += ALPHABET[digits[i]];
    return str;
  }
}

export default SolanaPayMonitor;
