/*
 * 우호 차트 도우미 서버 (Cloudflare Workers, 무료 요금제용)
 *
 * 하는 일
 *  1) 막힌 거래소 공지 대신 가져오기   GET  /notices?ex=upbit|okx|hl
 *  2) 영어 뉴스 제목 한국어 번역        POST /translate   {titles:[...]}
 *  3) 설정 동기화 (코드로)              POST /sync/new · GET|PUT /sync/:code
 *  4) 텔레그램 가격 알림                PUT  /alerts/:code · GET /tg/status/:code · 1분마다 확인(cron)
 *
 * 필요한 설정 (대시보드 > Settings)
 *  - KV 바인딩 이름: WUHO
 *  - 비밀값(Secret): TG_TOKEN (텔레그램 봇 토큰), ANTHROPIC_API_KEY (번역용, 없으면 번역만 꺼짐)
 *  - 변수(Variable, 선택): ALLOW_ORIGIN (기본 https://wuho94551-cloud.github.io), MODEL (기본 claude-opus-5-5)
 *  - Cron 트리거: * * * * *  (1분마다)
 */

const VERSION = '1.0';
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
    return list.map(a => ({ ex: 'Upbit', title: a.title, t: Date.parse(a.listed_at || a.first_listed_at || a.created_at), link: `https://upbit.com/service_center/notice?id=${a.id}` }));
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

/* ---------- 4) 텔레그램 알림 ---------- */
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const fmt = v => { const a = Math.abs(v); return a >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : a >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(5) };

/* 가격 묶음: 바이낸스 선물 → 막히면 OKX·바이비트, 하이퍼리퀴드는 HL 심볼용 */
async function prices(need){
  const px = {};
  const wantBn = need.some(a => a.m !== 'hl'), wantHl = need.some(a => a.m === 'hl');
  if(wantBn){
    try{ (await getJ('https://fapi.binance.com/fapi/v2/ticker/price')).forEach(x => px['f:' + x.symbol] = +x.price) }
    catch(e){
      try{ (await getJ('https://www.okx.com/api/v5/market/tickers?instType=SWAP')).data.forEach(x => { const m = x.instId.match(/^(.+)-USDT-SWAP$/); if(m) px['f:' + m[1] + 'USDT'] = +x.last }) }catch(e2){}
      try{ (await getJ('https://api.bybit.com/v5/market/tickers?category=linear')).result.list.forEach(x => { if(px['f:' + x.symbol] == null) px['f:' + x.symbol] = +x.lastPrice }) }catch(e3){}
    }
    if(need.some(a => a.m === 'spot')){
      try{ (await getJ('https://data-api.binance.vision/api/v3/ticker/price')).forEach(x => px['s:' + x.symbol] = +x.price) }catch(e){}
    }
  }
  if(wantHl){
    const dexes = [...new Set(need.filter(a => a.m === 'hl').map(a => a.sym.includes(':') ? a.sym.split(':')[0] : ''))];
    await Promise.all(dexes.map(async dex => { try{
      const d = await getJ('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dex ? { type: 'allMids', dex } : { type: 'allMids' }) });
      Object.entries(d).forEach(([k, v]) => px['h:' + k] = +v) }catch(e){} }));
  }
  return px;
}
const akey = a => a.sym + '|' + a.lv;
const pkey = a => (a.m === 'hl' ? 'h:' : a.m === 'spot' ? 's:' : 'f:') + a.sym;

async function cron(env){
  if(!env.TG_TOKEN) return;
  /* 1) 봇에게 온 "/start 코드" 메시지로 텔레그램 연결 */
  const off = +(await env.WUHO.get('tg:off') || 0);
  const up = await tg(env, 'getUpdates', { offset: off + 1, timeout: 0, allowed_updates: ['message'] }).catch(() => null);
  if(up && up.ok && up.result.length){
    let last = off;
    for(const u of up.result){ last = Math.max(last, u.update_id); const msg = u.message; if(!msg || !msg.text) continue;
      const m = msg.text.trim().match(/^\/start\s+([A-Za-z2-9]{10})$/), chat = msg.chat.id;
      if(m){ const code = m[1].toUpperCase(), rec = JSON.parse(await env.WUHO.get('al:' + code) || '{}');
        rec.chat = chat; rec.list = rec.list || []; await env.WUHO.put('al:' + code, JSON.stringify(rec)); await addIndex(env, code);
        await tg(env, 'sendMessage', { chat_id: chat, text: `우호 차트와 연결됐어요 ✅\n차트에 그은 가격 알림선이 닿으면 여기로 알려드릴게요.\n연결 코드: ${code}` });
      } else if(/^\/start/.test(msg.text)) await tg(env, 'sendMessage', { chat_id: chat, text: '사이트의 텔레그램 연결 버튼으로 들어오면 자동으로 연결돼요.' });
    }
    await env.WUHO.put('tg:off', String(last));
  }
  /* 2) 알림 확인 */
  const idx = JSON.parse(await env.WUHO.get('al:index') || '[]'); if(!idx.length) return;
  const recs = (await Promise.all(idx.map(async c => [c, JSON.parse(await env.WUHO.get('al:' + c) || 'null')]))).filter(([, r]) => r && r.chat && r.list && r.list.length);
  if(!recs.length) return;
  const px = await prices(recs.flatMap(([, r]) => r.list));
  for(const [code, r] of recs){
    const fired = [];
    r.list = r.list.filter(a => { const p = px[pkey(a)]; if(p == null) return true;
      const hit = a.dir === 'up' ? p >= a.lv : p <= a.lv; if(hit) fired.push([a, p]); return !hit });
    if(!fired.length) continue;
    r.done = [...new Set([...(r.done || []), ...fired.map(([a]) => akey(a))])].slice(-300);
    for(const [a, p] of fired) await tg(env, 'sendMessage', { chat_id: r.chat, text: `🔔 ${a.name || a.sym} 가격 알림\n${fmt(a.lv)} ${a.dir === 'up' ? '위로 돌파' : '아래로 이탈'}\n지금 ${fmt(p)}${a.note ? '\n' + a.note : ''}` }).catch(() => {});
    await env.WUHO.put('al:' + code, JSON.stringify(r));
  }
}
async function addIndex(env, code){ const idx = JSON.parse(await env.WUHO.get('al:index') || '[]'); if(!idx.includes(code)){ idx.push(code); await env.WUHO.put('al:index', JSON.stringify(idx.slice(-500))) } }

/* ---------- 라우터 ---------- */
export default {
  async fetch(req, env, ctx){
    if(req.method === 'OPTIONS') return new Response(null, { headers: cors(env, req) });
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, '') || '/', J = (d, s, x) => json(env, req, d, s, x);
    try{
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
          const b = JSON.parse(raw); await env.WUHO.put(k, JSON.stringify({ at: Date.now(), data: b.data || {} })); return J({ ok: true, at: Date.now() }) }
      }
      m = p.match(/^\/tg\/status\/([A-Z2-9]{10})$/);
      if(m){ const r = JSON.parse(await env.WUHO.get('al:' + m[1]) || '{}'); return J({ linked: !!r.chat, alerts: (r.list || []).length }) }
      m = p.match(/^\/alerts\/([A-Z2-9]{10})$/);
      if(m){ const k = 'al:' + m[1], r = JSON.parse(await env.WUHO.get(k) || '{}');
        if(req.method === 'GET') return J({ linked: !!r.chat, list: r.list || [] });
        if(req.method === 'PUT'){ if(!(await env.WUHO.get('sy:' + m[1]))) return J({ error: '없는 코드예요' }, 404);
          const b = await req.json(); const list = (b.list || []).filter(a => a && typeof a.sym === 'string' && isFinite(a.lv) && (a.dir === 'up' || a.dir === 'dn')).slice(0, 200)
            .map(a => ({ sym: a.sym.slice(0, 40), m: ['hl', 'spot'].includes(a.m) ? a.m : 'futures', lv: +a.lv, dir: a.dir, name: String(a.name || '').slice(0, 40), note: String(a.note || '').slice(0, 80) }));
          /* 이미 울린 알림선은 다시 올라와도 무시해요. 사이트에서 선을 지우면 기록도 지워져요 */
          const keys = new Set(list.map(akey)); r.done = (r.done || []).filter(x => keys.has(x));
          r.list = list.filter(a => !r.done.includes(akey(a))); await env.WUHO.put(k, JSON.stringify(r)); if(r.chat) await addIndex(env, m[1]); return J({ ok: true, n: r.list.length, linked: !!r.chat }) }
        if(req.method === 'DELETE'){ await env.WUHO.delete(k); return J({ ok: true }) }
      }
      if(p === '/tg/test' && req.method === 'POST'){
        const b = await req.json(); if(!CODE_RE.test(b.code || '')) return J({ error: '코드가 이상해요' }, 400);
        const r = JSON.parse(await env.WUHO.get('al:' + b.code) || '{}'); if(!r.chat) return J({ error: '아직 텔레그램이 연결되지 않았어요' }, 409);
        await tg(env, 'sendMessage', { chat_id: r.chat, text: '우호 차트 시험 알림이에요 🔔' }); return J({ ok: true });
      }
      return J({ error: 'not found' }, 404);
    }catch(e){ return J({ error: String(e.message || e) }, e.code || 500) }
  },
  async scheduled(ev, env, ctx){ ctx.waitUntil(cron(env)) }
};
