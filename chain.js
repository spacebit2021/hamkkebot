// 토큰 원장 어댑터: 블록체인과 같은 인터페이스 (주소·거래 해시·블록·확정)
// 지금은 InternalAdapter가 data.json 안의 장부로 동작하고, 나중에 실제 블록체인 어댑터로 바꿔 끼움.
// 어댑터가 지켜야 할 인터페이스:
//   info()                       → { chain, adapter, token:{symbol,decimals}, blockNumber }
//   addressOf(accountId)         → 주소 (계정마다 고정)
//   accountOf(address)           → 계정 id 또는 null
//   balanceOf(address)           → { balance, exchangeable, pending }
//   submit({type:'mint'|'burn', address, amount, ref, memo, clientId, idem}) → tx (status 'pending')
//   getTx(hash)                  → tx 또는 null
//   txsOf(address, limit)        → [tx]
// tx = { hash, type, address, amount, ref, memo, status:'pending'|'confirmed'|'failed', blockNumber, confirmations, createdAt, confirmedAt, error }
'use strict';
const crypto = require('crypto');

class InternalAdapter {
  // deps: { S, save, accounts: { get(id), wallet(id), credit(id, n, tx), debit(id, n, tx) → bool, exchangeable(id) }, blockMs }
  constructor(deps) {
    this.d = deps;
    const S = deps.S;
    if (!S.chain) S.chain = { height: 0, txs: [], salt: crypto.randomBytes(8).toString('hex') };
    this.c = S.chain;
    this.blockMs = deps.blockMs || 1000;
    this.timer = setInterval(() => this.mine(), this.blockMs); this.timer.unref();
  }
  info() { return { chain: 'hamkkebot-internal', adapter: 'internal', token: { symbol: 'HBT', name: '함께봇 토큰', decimals: 0 }, blockNumber: this.c.height, blockTimeMs: this.blockMs }; }
  addressOf(id) { return 'hb1' + crypto.createHash('sha256').update(this.c.salt + ':' + id).digest('hex').slice(0, 38); }
  accountOf(address) { if (!/^hb1[0-9a-f]{38}$/.test(address || '')) return null; return this.d.accounts.ids().find(id => this.addressOf(id) === address) || null; }
  balanceOf(address) {
    const id = this.accountOf(address); if (!id) return null;
    const pending = this.c.txs.filter(t => t.address === address && t.status === 'pending' && t.type === 'mint').reduce((a, t) => a + t.amount, 0);
    return { address, balance: this.d.accounts.wallet(id), exchangeable: this.d.accounts.exchangeable(id), pendingMint: pending };
  }
  view(t) { return { ...t, confirmations: t.blockNumber ? this.c.height - t.blockNumber + 1 : 0 }; }
  getTx(hash) { const t = this.c.txs.find(x => x.hash === hash); return t ? this.view(t) : null; }
  txsOf(address, limit = 50) { return this.c.txs.filter(t => t.address === address).slice(-limit).reverse().map(t => this.view(t)); }
  submit(req) {
    const { type, address, amount, ref = '', memo = '', clientId = '', idem = '' } = req;
    if (idem) { const same = this.c.txs.find(t => t.clientId === clientId && t.idem === idem); if (same) return { tx: this.view(same), replay: true }; }
    if (!['mint', 'burn'].includes(type)) return { error: 'type은 mint 또는 burn이에요' };
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1e7) return { error: 'amount는 1 이상 정수예요' };
    const id = this.accountOf(address); if (!id) return { error: '없는 주소예요' };
    const t = { hash: '0x' + crypto.createHash('sha256').update(`${clientId}:${idem}:${type}:${address}:${amount}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`).digest('hex'), type, address, amount, ref: String(ref).slice(0, 80), memo: String(memo).slice(0, 200), clientId, idem: String(idem).slice(0, 80), status: 'pending', blockNumber: null, createdAt: Date.now(), confirmedAt: null, error: null };
    if (type === 'burn') {
      // 환전: 보낼 때 바로 잡아 둠 (다른 곳에서 같은 토큰을 쓰지 못하게)
      if (amount > this.d.accounts.exchangeable(id)) return { error: `환전할 수 있는 토큰은 ${this.d.accounts.exchangeable(id)}개예요 (다른 기업에게서 번 토큰만 환전할 수 있어요)` };
      if (!this.d.accounts.debit(id, amount, t)) return { error: '잔액이 부족해요' };
    }
    this.c.txs.push(t); if (this.c.txs.length > 5000) this.c.txs.splice(0, this.c.txs.length - 5000);
    this.d.save();
    return { tx: this.view(t) };
  }
  // 블록 하나: 대기 중인 거래를 확정
  mine() {
    const pend = this.c.txs.filter(t => t.status === 'pending'); if (!pend.length) return;
    this.c.height++;
    for (const t of pend) {
      const id = this.accountOf(t.address);
      if (!id) { t.status = 'failed'; t.error = '계정이 없어졌어요'; continue; }
      if (t.type === 'mint') this.d.accounts.credit(id, t.amount, t);
      t.status = 'confirmed'; t.blockNumber = this.c.height; t.confirmedAt = Date.now();
      if (this.d.onConfirm) this.d.onConfirm(t, id);
    }
    this.d.save();
  }
}

// 나중에 붙일 실제 블록체인 어댑터 자리 (예: EVM 계열 ERC-20). 같은 메서드를 구현하면 서버 코드는 그대로.
class ChainAdapterNotReady { constructor(name) { throw new Error(`${name} 어댑터는 아직 연결되지 않았어요. CHAIN_ADAPTER=internal 로 실행하세요.`); } }

// ----- API 서명 (거래소 API와 같은 방식) -----
// 서명 = HMAC-SHA256(secret, `${METHOD}\n${PATH}\n${TIMESTAMP}\n${NONCE}\n${sha256(body)}`)  (hex)
const bodyHash = raw => crypto.createHash('sha256').update(raw || '').digest('hex');
function sign(secret, method, path, ts, nonce, raw) { return crypto.createHmac('sha256', secret).update(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash(raw)}`).digest('hex'); }
function signedHeaders(keyId, secret, method, path, raw) {
  const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString('hex');
  return { 'x-hb-key': keyId, 'x-hb-timestamp': ts, 'x-hb-nonce': nonce, 'x-hb-signature': sign(secret, method, path, ts, nonce, raw), 'content-type': 'application/json' };
}

module.exports = { InternalAdapter, ChainAdapterNotReady, sign, signedHeaders, bodyHash };
