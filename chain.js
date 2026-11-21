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
//   transfer(fromId, toId, n, kind, memo) · mintNow(id, n, kind, memo) · burnNow(id, n, kind, memo) → tx  (서버 안에서 바로 반영하고, 다음 블록에서 확정)
//   supply()                     → { minted, burned, supply, held, ok }  (발행량 = 모든 지갑 잔액의 합인지)
// tx = { hash, type, address, amount, ref, memo, status:'pending'|'confirmed'|'failed', blockNumber, confirmations, createdAt, confirmedAt, error }
'use strict';
const crypto = require('crypto');

class InternalAdapter {
  // deps: { S, save, accounts: { ids(), wallet(id), add(id, delta), credit(id, n, tx), debit(id, n, tx) → bool, exchangeable(id) }, blockMs }
  // 계정 id: 기업 id · 'exp:전문가id' · 'platform'(운영 기관)
  constructor(deps) {
    this.d = deps;
    const S = deps.S;
    if (!S.chain) S.chain = { height: 0, txs: [], salt: crypto.randomBytes(8).toString('hex') };
    this.c = S.chain;
    if (this.c.minted == null) { this.c.minted = 0; this.c.burned = 0; }
    // 처음 켤 때: 지금 있는 잔액을 첫 블록(genesis)에서 발행한 것으로 기록 → 이후 발행량 = 잔액 합
    if (!this.c.genesis) {
      for (const id of deps.accounts.ids()) { const n = deps.accounts.wallet(id); if (n > 0) this.push({ type: 'mint', kind: 'genesis', address: this.addressOf(id), amount: n, memo: '시작 잔액', applied: true }); this.c.minted += Math.max(0, n); }
      this.c.genesis = Date.now();
    }
    this.blockMs = deps.blockMs || 1000;
    this.timer = setInterval(() => this.mine(), this.blockMs); this.timer.unref();
  }
  info() { return { chain: 'hamkkebot-internal', adapter: 'internal', token: { symbol: 'HBT', name: '함께봇 토큰', decimals: 0 }, blockNumber: this.c.height, blockTimeMs: this.blockMs }; }
  addressOf(id) { return 'hb1' + crypto.createHash('sha256').update(this.c.salt + ':' + id).digest('hex').slice(0, 38); }
  accountOf(address) {
    if (!/^hb1[0-9a-f]{38}$/.test(address || '')) return null;
    this.cache = this.cache || new Map();
    const hit = this.cache.get(address); if (hit && this.d.accounts.ids().includes(hit)) return hit;
    for (const id of this.d.accounts.ids()) this.cache.set(this.addressOf(id), id); // 주소 → 계정 (새 계정이 생기면 다시 채움)
    const id = this.cache.get(address); return id && this.d.accounts.ids().includes(id) ? id : null;
  }
  balanceOf(address) {
    const id = this.accountOf(address); if (!id) return null;
    const pending = this.c.txs.filter(t => t.address === address && t.status === 'pending' && t.type === 'mint').reduce((a, t) => a + t.amount, 0);
    return { address, balance: this.d.accounts.wallet(id), exchangeable: this.d.accounts.exchangeable(id), pendingMint: pending };
  }
  view(t) { return { ...t, confirmations: t.blockNumber ? this.c.height - t.blockNumber + 1 : 0 }; }
  getTx(hash) { const t = this.c.txs.find(x => x.hash === hash); return t ? this.view(t) : null; }
  txsOf(address, limit = 50) { return this.c.txs.filter(t => t.address === address || t.from === address || t.to === address).slice(-limit).reverse().map(t => this.view(t)); }
  push(t) {
    const tx = { hash: '0x' + crypto.createHash('sha256').update(`${t.type}:${t.kind || ''}:${t.from || ''}:${t.address || t.to}:${t.amount}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`).digest('hex'), ref: '', memo: '', clientId: '', idem: '', status: 'pending', blockNumber: null, createdAt: Date.now(), confirmedAt: null, error: null, ...t };
    tx.memo = String(tx.memo || '').slice(0, 200);
    this.c.txs.push(tx); if (this.c.txs.length > 20000) this.c.txs.splice(0, this.c.txs.length - 20000);
    return tx;
  }
  // 서버 안의 토큰 이동 (봇 사용·환불·몫 나눔·이용권·보상·상담비 등): 바로 반영, 다음 블록에서 확정
  transfer(fromId, toId, n, kind, memo) {
    if (!(n > 0)) return null;
    if (this.d.accounts.wallet(fromId) < n) throw new Error(`잔액 부족: ${fromId} ${n}`);
    this.d.accounts.add(fromId, -n); this.d.accounts.add(toId, n);
    return this.push({ type: 'transfer', kind, from: this.addressOf(fromId), to: this.addressOf(toId), address: this.addressOf(toId), amount: n, memo, applied: true });
  }
  mintNow(id, n, kind, memo) { if (!(n > 0)) return null; this.d.accounts.add(id, n); this.c.minted += n; return this.push({ type: 'mint', kind, address: this.addressOf(id), amount: n, memo, applied: true }); }
  burnNow(id, n, kind, memo) { if (!(n > 0)) return null; if (this.d.accounts.wallet(id) < n) throw new Error(`잔액 부족: ${id} ${n}`); this.d.accounts.add(id, -n); this.c.burned += n; return this.push({ type: 'burn', kind, address: this.addressOf(id), amount: n, memo, applied: true }); }
  supply() { const held = this.d.accounts.ids().reduce((a, id) => a + this.d.accounts.wallet(id), 0), supply = this.c.minted - this.c.burned; return { minted: this.c.minted, burned: this.c.burned, supply, held, ok: supply === held }; }
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
      this.c.burned += amount; t.applied = true;
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
      if (!id && !t.applied) { t.status = 'failed'; t.error = '계정이 없어졌어요'; continue; }
      if (t.type === 'mint' && !t.applied) { this.d.accounts.credit(id, t.amount, t); this.c.minted += t.amount; t.applied = true; }
      t.status = 'confirmed'; t.blockNumber = this.c.height; t.confirmedAt = Date.now();
      if (this.d.onConfirm && t.clientId) this.d.onConfirm(t, id);
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
