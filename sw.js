/* 우호: 홈 화면 앱용 서비스 워커. 시세가 늘 새로워야 해서 아무것도 저장하지 않고 그대로 인터넷에서 받아요.
   인터넷이 끊겼을 때만 안내 문구를 보여 줘요. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if(e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#0b0c0f;color:#e6e8ec;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>인터넷 연결이 없어요. 연결되면 다시 열어 주세요.</p>', { headers:{ 'Content-Type':'text/html; charset=utf-8' } })));
});
