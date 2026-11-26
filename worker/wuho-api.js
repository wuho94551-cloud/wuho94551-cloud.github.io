/*
 * 우호 차트 도우미 서버 (Cloudflare Workers, 무료 요금제용)
 *
 * 하는 일
 *  1) 막힌 거래소 공지 대신 가져오기   GET  /notices?ex=upbit|okx|hl
 *  2) 영어 뉴스 제목 한국어 번역        POST /translate   {titles:[...]}
 *  3) 설정 동기화 (코드로)              POST /sync/new · GET|PUT /sync/:code
 *  4) 텔레그램 알림                  PUT  /alerts/:code (가격·변동률·펀딩비·거래대금) · PUT /opt/:code · 1분마다 확인(cron)
 *     업비트 상장 공지와 ★★★ 뉴스도 텔레그램으로 보내고, 봇 명령어(/btc, /list, /help)에 답해요
 *
 * 필요한 설정 (대시보드 > Settings)
 *  - KV 바인딩 이름: WUHO
 *  - 비밀값(Secret): TG_TOKEN (텔레그램 봇 토큰), ANTHROPIC_API_KEY (번역용, 없으면 번역만 꺼짐)
 *  - 변수(Variable, 선택): ALLOW_ORIGIN·SITE_URL (기본 https://wuho94551-cloud.github.io), MODEL (기본 claude-opus-5-5)
 *  - Cron 트리거: * * * * *  (1분마다)
 */

const VERSION = '1.2';
const DEFAULT_ORIGIN = 'https://wuho94551-cloud.github.io';
const UA = { 'user-agent': 'Mozilla/5.0 (wuho-api)', accept: 'application/json,text/html' };

/* ---------- 공통 ---------- */
const cors = (env, req) => {
  const allow = (env.ALLOW_ORIGIN || DEFAULT_ORIGIN).split(',').map(s => s.trim());
  const o = req.headers.get('origin') || '';
  const ok = allow.includes('*') || allow.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return { 'access-control-allow-origin': ok ? o || allow[0] : allow[0], 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'origin' };
};
const json = (env, req, data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(env, req), ...extra } });
const CODE_RE = /^[A-Z2-9]{10}$/;
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map(x => A[x % A.length]).join('') };
const getJ = async (url, opt = {}) => { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) } }); if(!r.ok) throw new Error(url + ' ' + r.status); return r.json() };

/* 같은 서버 인스턴스 안에서만 쓰는 짧은 메모리 캐시 (KV 쓰기 한도를 아끼려고) */
const MEM = new Map();
const memo = async (key, ttl, fn) => { const h = MEM.get(key); if(h && Date.now() - h.at < ttl) return h.v; const v = await fn(); MEM.set(key, { at: Date.now(), v }); return v };

/* 아주 단순한 요청 횟수 제한 (IP별, 인스턴스 메모리) */
const HITS = new Map();
const limited = (req, bucket, max, winMs) => { const ip = req.headers.get('cf-connecting-ip') || '?', k = bucket + ip, now = Date.now();
  const a = (HITS.get(k) || []).filter(t => now - t < winMs); a.push(now); HITS.set(k, a); return a.length > max };

/* ---------- 1) 거래소 공지 ---------- */
const NOTICE = {
  async upbit(){
    const d = await getJ('https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=30&category=all');
    const list = (d.data && (d.data.notices || d.data.list)) || [];
    return list.map(a => ({ ex: 'Upbit', id: +a.id, title: a.title, t: Date.parse(a.listed_at || a.first_listed_at || a.created_at), link: `https://upbit.com/service_center/notice?id=${a.id}` }));
  },
  async okx(){
    const d = await getJ('https://www.okx.com/api/v5/support/announcements?page=1');
    const list = (d.data && d.data[0] && d.data[0].details) || [];
    return list.map(a => ({ ex: 'OKX', title: a.title, t: +a.pTime, link: a.url }));
  }
};

/* ---------- 2) 번역 ---------- */
async function translate(env, titles){
  const key = env.ANTHROPIC_API_KEY; if(!key) throw Object.assign(new Error('번역 키가 아직 없어요'), { code: 503 });
  const out = {}, need = [];
  titles.forEach(t => { const h = MEM.get('tr:' + t); if(h) out[t] = h.v; else need.push(t) });
  if(need.length){
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-opus-5-5', max_tokens: 4000, fallbacks: 'default',
        output_config: { effort: 'low' },
        system: '너는 암호화폐·주식 뉴스 제목 번역가야. 영어 제목을 한국 금융 기사 제목처럼 짧고 자연스러운 한국어로 옮겨. 종목 티커, 회사·거래소 이름, 숫자, $ 표기는 그대로 둬. 설명을 붙이지 말고 JSON 문자열 배열 하나만, 입력과 같은 순서·같은 개수로 답해.',
        messages: [{ role: 'user', content: JSON.stringify(need) }]
      })
    });
    if(!r.ok) throw Object.assign(new Error('번역 서버 응답 ' + r.status), { code: 502 });
    const m = await r.json();
    if(m.stop_reason === 'refusal') throw Object.assign(new Error('번역이 거절됐어요'), { code: 422 });
    const text = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let arr = []; try{ arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) }catch(e){}
    need.forEach((t, i) => { const v = typeof arr[i] === 'string' && arr[i].trim(); if(v){ out[t] = v; MEM.set('tr:' + t, { at: Date.now(), v }) } });
    if(MEM.size > 3000) [...MEM.keys()].slice(0, 1000).forEach(k => MEM.delete(k));
  }
  return out;
}

/* ---------- 3) 동기화 ---------- */
const MAX_SYNC = 200 * 1024;

/* ---------- 4) 텔레그램 ---------- */
const SITE = env => (env.SITE_URL || DEFAULT_ORIGIN).replace(/\/+$/, '');
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const say = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, disable_web_page_preview: true, ...extra }).catch(() => {});
const chartBtn = (env, a) => ({ reply_markup: { inline_keyboard: [[{ text: '📈 차트 열기', url: `${SITE(env)}/?s=${encodeURIComponent(a.sym)}&m=${a.m}` }]] } });
const fmt = v => { const a = Math.abs(v); return a >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : a >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(5) };
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const rec = async (env, code) => JSON.parse(await env.WUHO.get('al:' + code) || '{}');
const putRec = (env, code, r) => env.WUHO.put('al:' + code, JSON.stringify(r));
async function addIndex(env, code){ const idx = JSON.parse(await env.WUHO.get('al:index') || '[]'); if(!idx.includes(code)){ idx.push(code); await env.WUHO.put('al:index', JSON.stringify(idx.slice(-500))) } }

/* 웹훅: 봇 메시지를 바로 받아요 (서버 주소로 첫 요청이 올 때 자동 등록) */
async function ensureWebhook(env, origin){
  if(!env.TG_TOKEN) return;
  return memo('wh:' + origin, 6 * 36e5, async () => { const sec = (await hash(env.TG_TOKEN)).slice(0, 32);
    const r = await tg(env, 'setWebhook', { url: origin + '/tg/hook', secret_token: sec, allowed_updates: ['message'] }); return r.ok });
}

/* ---------- 가격·캔들·펀딩 ---------- */
const BN_BLOCK = { at: 0 };
const okxId = sym => sym.replace(/USDT$/, '') + '-USDT-SWAP';
async function prices(need){
  const px = {};
  const wantF = need.some(a => a.m === 'futures'), wantS = need.some(a => a.m === 'spot');
  if(wantF){
    let ok = false;
    if(Date.now() - BN_BLOCK.at > 6e5){ try{ (await getJ('https://fapi.binance.com/fapi/v2/ticker/price')).forEach(x => px['f:' + x.symbol] = +x.price); ok = true }catch(e){ BN_BLOCK.at = Date.now() } }
    if(!ok){
      try{ (await getJ('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).data.forEach(x => { const m = x.instId.match(/^(.+)-USDT-SWAP$/); if(m) px['f:' + m[1] + 'USDT'] = +x.last }) }catch(e2){}
      try{ (await getJ('https://api.bybit.com/v5/market/tickers?category=linear')).result.list.forEach(x => { if(px['f:' + x.symbol] == null) px['f:' + x.symbol] = +x.lastPrice }) }catch(e3){}
    }
  }
  if(wantS){ try{ (await getJ('https://data-api.binance.vision/api/v3/ticker/price')).forEach(x => px['s:' + x.symbol] = +x.price) }catch(e){} }
  /* 하이퍼리퀴드: HL 종목 + 바이낸스 주식·원자재처럼 다른 곳에 없는 종목의 대체 가격 */
  const hl = need.flatMap(a => [a.m === 'hl' ? a.sym : null, a.alt || null]).filter(Boolean);
  const dexes = [...new Set(hl.map(s => s.includes(':') ? s.split(':')[0] : ''))];
  await Promise.all(dexes.map(async dex => { try{
    const d = await getJ('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }) });
    Object.entries(d).forEach(([k, v]) => px['h:' + k] = +v) }catch(e){} }));
  return px;
}
const priceOf = (px, a) => { const p = px[(a.m === 'hl' ? 'h:' : a.m === 'spot' ? 's:' : 'f:') + a.sym]; return p != null ? p : a.alt ? px['h:' + a.alt] : undefined };

/* 1분봉 [{t,c,q}] 오래된 것부터 */
async function klines(a, n){
  const hlK = async sym => { const d = await getJ('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin: sym, interval: '1m', startTime: Date.now() - (n + 2) * 6e4, endTime: Date.now() } }) });
    return d.map(k => ({ t: k.t, c: +k.c, q: +k.v * +k.c })) };
  if(a.m === 'hl') return hlK(a.sym);
  if(a.m === 'spot'){ const d = await getJ(`https://data-api.binance.vision/api/v3/klines?symbol=${a.sym}&interval=1m&limit=${n}`); return d.map(k => ({ t: k[0], c: +k[4], q: +k[7] })) }
  if(Date.now() - BN_BLOCK.at > 6e5){ try{ const d = await getJ(`https://fapi.binance.com/fapi/v1/klines?symbol=${a.sym}&interval=1m&limit=${n}`); return d.map(k => ({ t: k[0], c: +k[4], q: +k[7] })) }catch(e){ BN_BLOCK.at = Date.now() } }
  try{ const d = await getJ(`https://www.okx.com/api/v5/market/candles?instId=${okxId(a.sym)}&bar=1m&limit=${Math.min(n, 300)}`); if(d.data && d.data.length) return d.data.map(k => ({ t: +k[0], c: +k[4], q: +k[7] })).reverse() }catch(e){}
  if(a.alt) return hlK(a.alt);
  throw new Error('캔들 없음');
}
/* 펀딩비 % (8시간 기준으로 맞춰요. 하이퍼리퀴드는 1시간 단위라 ×8) */
async function fundings(need){
  const out = {};
  if(need.some(a => a.m === 'futures')){
    try{ if(Date.now() - BN_BLOCK.at < 6e5) throw 0; (await getJ('https://fapi.binance.com/fapi/v1/premiumIndex')).forEach(x => out['f:' + x.symbol] = +x.lastFundingRate * 100) }
    catch(e){ await Promise.all(need.filter(a => a.m === 'futures').map(async a => { try{ const d = await getJ('https://www.okx.com/api/v5/public/funding-rate?instId=' + okxId(a.sym)); out['f:' + a.sym] = +d.data[0].fundingRate * 100 }catch(e2){} })) }
  }
  const hl = need.flatMap(a => [a.m === 'hl' ? a.sym : null, a.alt || null]).filter(Boolean), dexes = [...new Set(hl.map(s => s.includes(':') ? s.split(':')[0] : ''))];
  await Promise.all(dexes.map(async dex => { try{
    const [meta, ctx] = await getJ('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }) });
    meta.universe.forEach((u, i) => { if(ctx[i]) out['h:' + u.name] = +ctx[i].funding * 100 * 8 }) }catch(e){} }));
  return out;
}
const fundOf = (fd, a) => { const v = fd[(a.m === 'hl' ? 'h:' : 'f:') + a.sym]; return v != null ? v : a.alt ? fd['h:' + a.alt] : undefined };

/* ---------- 알림 확인 ---------- */
const COOL = { move: 30 * 6e4, vol: 30 * 6e4, fund: 4 * 36e5 };
const WIN = w => [5, 15, 60, 240].includes(+w) ? +w : 15;
function describe(a){
  if(a.kind === 'move') return `${WIN(a.win)}분 ${a.dir === 'up' ? '+' : a.dir === 'dn' ? '-' : '±'}${a.pct}% 변동`;
  if(a.kind === 'fund') return `펀딩비 ${a.dir === 'dn' ? '≤ -' : a.dir === 'up' ? '≥ ' : '절댓값 ≥ '}${a.lv}%`;
  if(a.kind === 'vol') return `5분 거래대금 ${a.x}배 급증`;
  return `${fmt(a.lv)} ${a.dir === 'up' ? '위로 돌파' : '아래로 이탈'}`;
}
async function checkAlerts(env, recs){
  const all = recs.flatMap(([, r]) => r.list), now = Date.now();
  const live = (r, a) => !(COOL[a.kind] && (r.cool || {})[a.id] && now - r.cool[a.id] < COOL[a.kind]);
  const need = recs.flatMap(([, r]) => r.list.filter(a => live(r, a)));
  if(!need.length) return;
  const px = need.some(a => a.kind === 'price') ? await prices(need.filter(a => a.kind === 'price')) : {};
  const fd = need.some(a => a.kind === 'fund') ? await fundings(need.filter(a => a.kind === 'fund')) : {};
  /* 변동률·거래대금은 종목마다 캔들을 한 번만 받아요 (최대 30종목) */
  const KS = {}, kneed = [...new Map(need.filter(a => a.kind === 'move' || a.kind === 'vol').map(a => [a.m + a.sym, a])).values()].slice(0, 30);
  await Promise.all(kneed.map(async a => { try{ KS[a.m + a.sym] = await klines(a, 245) }catch(e){} }));
  for(const [code, r] of recs){
    const fired = [];
    for(const a of r.list){ if(!live(r, a)) continue; let hit = false, info = '';
      if(a.kind === 'price'){ const p = priceOf(px, a); if(p == null) continue; hit = a.dir === 'up' ? p >= a.lv : p <= a.lv; info = `지금 ${fmt(p)}` }
      else if(a.kind === 'fund'){ const f = fundOf(fd, a); if(f == null) continue; hit = a.dir === 'up' ? f >= a.lv : a.dir === 'dn' ? f <= -a.lv : Math.abs(f) >= a.lv; info = `지금 펀딩비 ${f.toFixed(4)}%` }
      else { const k = KS[a.m + a.sym]; if(!k || k.length < 20) continue; const last = k[k.length - 1];
        if(a.kind === 'move'){ const w = WIN(a.win), base = k[Math.max(0, k.length - 1 - w)].c, ch = (last.c / base - 1) * 100;
          hit = a.dir === 'up' ? ch >= a.pct : a.dir === 'dn' ? ch <= -a.pct : Math.abs(ch) >= a.pct; info = `${w}분 ${pct(ch)} · 지금 ${fmt(last.c)}` }
        else { const sum = (i, j) => k.slice(i, j).reduce((s, x) => s + x.q, 0), n = k.length, cur = sum(n - 5, n), prev = sum(Math.max(0, n - 65), n - 5) / 12;
          hit = prev > 0 && cur >= prev * (+a.x || 3); info = `5분 거래대금 ${(cur / prev).toFixed(1)}배 · 지금 ${fmt(last.c)}` } }
      if(hit) fired.push([a, info]);
    }
    if(!fired.length) continue;
    r.cool = r.cool || {}; r.done = r.done || []; r.hist = r.hist || [];
    for(const [a, info] of fired){
      if(a.kind === 'price') r.done.push(a.id); else r.cool[a.id] = now;
      r.hist.unshift({ id: a.id, sym: a.sym, m: a.m, name: a.name || a.sym, text: describe(a), info, t: now });
      if(r.chat) await say(env, r.chat, `🔔 ${a.name || a.sym} ${describe(a)}\n${info}${a.note ? '\n' + a.note : ''}`, chartBtn(env, a));
    }
    r.list = r.list.filter(a => !(a.kind === 'price' && r.done.includes(a.id)));
    r.done = r.done.slice(-300); r.hist = r.hist.slice(0, 40);
    await putRec(env, code, r);
  }
}

/* ---------- 업비트 상장 공지·★★★ 뉴스 보내기 ---------- */
const UPBIT_HOT = /디지털 자산 추가|마켓 추가|신규 거래지원|거래지원 종료|유의 종목|투자유의|상장/;
const BIG = /SEC\b|FOMC|금리\s?(인상|인하|동결)|rate (cut|hike)|ETF\s?(승인|거부|approv|reject)|해킹|hack|exploit|폭락|폭등|급락|급등|crash|plunge|surge|사상\s?최고|역대\s?최고|all-time high|record high|파산|bankrupt|트럼프|Trump|CPI|비상|emergency|전쟁|war\b|속보|BREAKING|JUST IN/i;
const FEEDS = [['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'], ['Cointelegraph', 'https://cointelegraph.com/rss'], ['토큰포스트', 'https://www.tokenpost.kr/rss'], ['블록미디어', 'https://www.blockmedia.co.kr/feed']];
const unx = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
async function rssItems(){
  const out = [];
  await Promise.all(FEEDS.map(async ([src, u]) => { try{ const r = await fetch(u, { headers: UA }); if(!r.ok) return; const x = (await r.text()).slice(0, 200000);
    for(const m of x.matchAll(/<item[\s>][\s\S]*?<\/item>/g)){
      const it = m[0], g = t => (it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1];
      out.push({ src, title: unx(g('title')), link: unx(g('link')), t: Date.parse(unx(g('pubDate'))) || 0 }) } }catch(e){} }));
  return out;
}
async function pushFeeds(env, recs){
  const chats = recs.filter(([, r]) => r.chat), minute = Math.floor(Date.now() / 6e4);
  if(!chats.length) return;
  const wantUp = chats.filter(([, r]) => (r.opt || {}).upbit !== false), wantNews = chats.filter(([, r]) => (r.opt || {}).news !== false);
  if(wantUp.length){ try{
    const L = await NOTICE.upbit(), lastRaw = await env.WUHO.get('nt:upbit'), last = +(lastRaw || 0), top = Math.max(0, ...L.map(x => x.id || 0));
    if(top > last){
      if(lastRaw) for(const x of L.filter(x => x.id > last && UPBIT_HOT.test(x.title)).reverse())
        for(const [, r] of wantUp) await say(env, r.chat, `📢 업비트 공지\n${x.title}`, { reply_markup: { inline_keyboard: [[{ text: '공지 보기', url: x.link }]] } });
      await env.WUHO.put('nt:upbit', String(top));
    } }catch(e){} }
  if(wantNews.length && minute % 3 === 0){ try{
    const items = (await rssItems()).filter(x => x.title && BIG.test(x.title) && Date.now() - x.t < 40 * 6e4);
    const seenRaw = await env.WUHO.get('nw:seen'), seen = JSON.parse(seenRaw || '[]'), fresh = items.filter(x => !seen.includes(x.title.slice(0, 40)));
    if(fresh.length){
      if(seenRaw) for(const x of fresh.slice(0, 5)) for(const [, r] of wantNews) await say(env, r.chat, `★★★ ${x.src}\n${x.title}`, x.link ? { reply_markup: { inline_keyboard: [[{ text: '기사 보기', url: x.link }]] } } : {});
      await env.WUHO.put('nw:seen', JSON.stringify([...fresh.map(x => x.title.slice(0, 40)), ...seen].slice(0, 300)));
    } }catch(e){} }
}

/* ---------- 봇 메시지 ---------- */
const HELP = '쓸 수 있는 명령어\n/btc, /eth 처럼 종목 이름: 지금 가격\n/list: 걸어 둔 알림\n/upbit on|off: 업비트 상장 공지 받기\n/news on|off: ★★★ 뉴스 받기\n/help: 이 안내';
async function onMessage(env, msg){
  if(!msg || !msg.text) return; const chat = msg.chat.id, t = msg.text.trim();
  let m = t.match(/^\/start\s+([A-Za-z2-9]{10})$/);
  if(m){ const code = m[1].toUpperCase(); if(!(await env.WUHO.get('sy:' + code))) return say(env, chat, '없는 코드예요. 사이트의 텔레그램 연결 버튼으로 다시 들어와 주세요.');
    const r = await rec(env, code); r.chat = chat; r.list = r.list || []; await putRec(env, code, r); await addIndex(env, code); await env.WUHO.put('ch:' + chat, code);
    return say(env, chat, `우호 차트와 연결됐어요 ✅\n차트에 그은 알림선과 알림 목록의 조건이 닿으면 여기로 알려드릴게요.\n\n${HELP}`) }
  if(/^\/start/.test(t)) return say(env, chat, '사이트의 "텔레그램 연결하기" 버튼으로 들어오면 자동으로 연결돼요.');
  const code = await env.WUHO.get('ch:' + chat);
  if(/^\/help/.test(t)) return say(env, chat, HELP);
  if(/^\/list/.test(t)){ if(!code) return say(env, chat, '아직 연결되지 않았어요.'); const r = await rec(env, code), L = r.list || [];
    return say(env, chat, L.length ? '🔔 걸어 둔 알림 ' + L.length + '개\n' + L.slice(0, 40).map(a => `· ${a.name || a.sym} ${describe(a)}`).join('\n') : '걸어 둔 알림이 없어요.') }
  m = t.match(/^\/(upbit|news)\s*(on|off)?$/i);
  if(m){ if(!code) return say(env, chat, '아직 연결되지 않았어요.'); const r = await rec(env, code); r.opt = r.opt || {}; const k = m[1].toLowerCase(), v = (m[2] || 'on').toLowerCase() === 'on';
    r.opt[k] = v; await putRec(env, code, r); return say(env, chat, `${k === 'upbit' ? '업비트 상장 공지' : '★★★ 뉴스'} 알림을 ${v ? '켰어요' : '껐어요'}`) }
  m = t.match(/^\/?([A-Za-z0-9]{2,12})$/);
  if(m){ const b = m[1].toUpperCase(), f = { sym: b + 'USDT', m: 'futures', alt: 'xyz:' + b }, h = { sym: b, m: 'hl' };
    const px = await prices([f, h]); const p = priceOf(px, f) ?? px['h:' + b];
    return say(env, chat, p != null ? `${b} ${fmt(p)}` : `${b} 가격을 못 찾았어요`, p != null ? chartBtn(env, px['f:' + f.sym] != null ? f : px['h:' + b] != null ? h : { sym: f.alt, m: 'hl' }) : {}) }
}
/* 웹훅을 아직 못 쓸 때를 위한 대체 경로 */
async function pollUpdates(env){
  const off = +(await env.WUHO.get('tg:off') || 0);
  const up = await tg(env, 'getUpdates', { offset: off + 1, timeout: 0, allowed_updates: ['message'] }).catch(() => null);
  if(!up || !up.ok || !up.result.length) return; let last = off;
  for(const u of up.result){ last = Math.max(last, u.update_id); await onMessage(env, u.message) }
  await env.WUHO.put('tg:off', String(last));
}

async function cron(env){
  if(!env.TG_TOKEN || !env.WUHO) return;
  await pollUpdates(env);
  const idx = JSON.parse(await env.WUHO.get('al:index') || '[]'); if(!idx.length) return;
  const recs = (await Promise.all(idx.map(async c => [c, JSON.parse(await env.WUHO.get('al:' + c) || 'null')]))).filter(([, r]) => r && r.chat);
  if(!recs.length) return;
  recs.forEach(([, r]) => r.list = r.list || []);
  await Promise.allSettled([checkAlerts(env, recs.filter(([, r]) => r.list.length)), pushFeeds(env, recs)]);
}

/* ---------- 라우터 ---------- */
const KINDS = ['price', 'move', 'fund', 'vol'];
const clean = a => ({ id: String(a.id || (a.sym + '|' + a.lv)).slice(0, 40), sym: String(a.sym).slice(0, 40), m: ['hl', 'spot'].includes(a.m) ? a.m : 'futures', alt: typeof a.alt === 'string' ? a.alt.slice(0, 40) : '',
  kind: KINDS.includes(a.kind) ? a.kind : 'price', lv: +a.lv || 0, dir: ['up', 'dn', 'both'].includes(a.dir) ? a.dir : 'up', pct: Math.max(0.1, +a.pct || 0), win: WIN(a.win), x: Math.max(1.5, +a.x || 3),
  name: String(a.name || '').slice(0, 40), note: String(a.note || '').slice(0, 80) });
export default {
  async fetch(req, env, ctx){
    if(req.method === 'OPTIONS') return new Response(null, { headers: cors(env, req) });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/', J = (d, s, x) => json(env, req, d, s, x);
    try{
      if(p === '/tg/hook' && req.method === 'POST'){
        if(!env.TG_TOKEN || req.headers.get('x-telegram-bot-api-secret-token') !== (await hash(env.TG_TOKEN)).slice(0, 32)) return new Response('no', { status: 403 });
        const u = await req.json().catch(() => ({})); ctx.waitUntil(onMessage(env, u.message).catch(() => {})); return new Response('ok');
      }
      if(env.TG_TOKEN && env.WUHO) ctx.waitUntil(ensureWebhook(env, url.origin).catch(() => {}));
      if(p === '/' || p === '/health') return J({ ok: true, v: VERSION, kv: !!env.WUHO, tg: !!env.TG_TOKEN, ai: !!env.ANTHROPIC_API_KEY, bot: env.TG_TOKEN ? await memo('bot', 36e5, async () => { const r = await tg(env, 'getMe', {}); return r.ok ? r.result.username : null }) : null });

      if(p === '/notices'){
        const ex = (url.searchParams.get('ex') || 'upbit,okx').split(',').filter(x => NOTICE[x]);
        const r = await Promise.allSettled(ex.map(x => memo('n:' + x, 6e4, () => NOTICE[x]())));
        const items = r.flatMap(x => x.status === 'fulfilled' ? x.value : []).filter(x => x.title).sort((a, b) => b.t - a.t);
        return J({ items, fail: ex.filter((x, i) => r[i].status !== 'fulfilled') }, 200, { 'cache-control': 'public, max-age=60' });
      }

      if(p === '/translate' && req.method === 'POST'){
        if(limited(req, 'tr', 20, 6e4)) return J({ error: '잠시 후 다시 해 주세요' }, 429);
        const b = await req.json().catch(() => ({}));
        const titles = [...new Set((b.titles || []).filter(t => typeof t === 'string').map(t => t.slice(0, 300)))].slice(0, 40);
        if(!titles.length) return J({ map: {} });
        return J({ map: await translate(env, titles) });
      }

      if(!env.WUHO) return J({ error: 'KV(WUHO) 연결이 아직 안 됐어요' }, 503);

      if(p === '/sync/new' && req.method === 'POST'){
        if(limited(req, 'new', 10, 36e5)) return J({ error: '잠시 후 다시 해 주세요' }, 429);
        const code = newCode(); await env.WUHO.put('sy:' + code, JSON.stringify({ at: Date.now(), data: {} })); return J({ code });
      }
      let m = p.match(/^\/sync\/([A-Z2-9]{10})$/);
      if(m){ const k = 'sy:' + m[1];
        if(req.method === 'GET'){ const v = await env.WUHO.get(k); return v ? new Response(v, { headers: { 'content-type': 'application/json', ...cors(env, req) } }) : J({ error: '없는 코드예요' }, 404) }
        if(req.method === 'PUT'){ if(!(await env.WUHO.get(k))) return J({ error: '없는 코드예요' }, 404);
          const raw = await req.text(); if(raw.length > MAX_SYNC) return J({ error: '설정이 너무 커요' }, 413);
          const b = JSON.parse(raw), at = Date.now(); await env.WUHO.put(k, JSON.stringify({ at, dev: String(b.dev || '').slice(0, 20), data: b.data || {} })); return J({ ok: true, at }) }
      }
      m = p.match(/^\/tg\/status\/([A-Z2-9]{10})$/);
      if(m){ let r = await rec(env, m[1]);
        if(!r.chat && env.TG_TOKEN){ await memo('lk', 1500, () => pollUpdates(env)); r = await rec(env, m[1]) }
        return J({ linked: !!r.chat, alerts: (r.list || []).length }) }
      m = p.match(/^\/alerts\/([A-Z2-9]{10})$/);
      if(m){ const code = m[1], r = await rec(env, code);
        if(req.method === 'GET') return J({ linked: !!r.chat, list: r.list || [], done: r.done || [], hist: r.hist || [], opt: r.opt || {} });
        if(req.method === 'PUT'){ if(!(await env.WUHO.get('sy:' + code))) return J({ error: '없는 코드예요' }, 404);
          const b = await req.json(); const list = (b.list || []).filter(a => a && typeof a.sym === 'string').slice(0, 200).map(clean);
          /* 이미 울린 가격 알림은 다시 올라와도 무시해요. 사이트에서 선을 지우면 기록도 지워져요 */
          const ids = new Set(list.map(a => a.id)); r.done = (r.done || []).filter(x => ids.has(x));
          r.list = list.filter(a => !(a.kind === 'price' && r.done.includes(a.id)));
          r.cool = Object.fromEntries(Object.entries(r.cool || {}).filter(([k]) => ids.has(k)));
          await putRec(env, code, r); if(r.chat) await addIndex(env, code); return J({ ok: true, n: r.list.length, linked: !!r.chat, done: r.done }) }
        if(req.method === 'DELETE'){ await env.WUHO.delete('al:' + code); return J({ ok: true }) }
      }
      m = p.match(/^\/opt\/([A-Z2-9]{10})$/);
      if(m && req.method === 'PUT'){ const r = await rec(env, m[1]), b = await req.json(); r.opt = { upbit: b.upbit !== false, news: b.news !== false }; await putRec(env, m[1], r); return J({ ok: true, opt: r.opt }) }
      if(p === '/tg/test' && req.method === 'POST'){
        const b = await req.json(); if(!CODE_RE.test(b.code || '')) return J({ error: '코드가 이상해요' }, 400);
        const r = await rec(env, b.code); if(!r.chat) return J({ error: '아직 텔레그램이 연결되지 않았어요' }, 409);
        await say(env, r.chat, '우호 차트 시험 알림이에요 🔔', chartBtn(env, { sym: 'BTCUSDT', m: 'futures' })); return J({ ok: true });
      }
      return J({ error: 'not found' }, 404);
    }catch(e){ return J({ error: String(e.message || e) }, e.code || 500) }
  },
  async scheduled(ev, env, ctx){ ctx.waitUntil(cron(env)) }
};
