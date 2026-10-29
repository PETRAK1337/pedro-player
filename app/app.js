'use strict';
/* Pedro: a small SoundCloud player.
 * Streaming goes through the official SoundCloud Widget API (hidden iframe);
 * this file only draws the UI and drives that widget. */
(() => {
  const $ = (s) => document.querySelector(s);
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ── storage ───────────────────────────────────────────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pedro.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pedro.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // ── state ─────────────────────────────────────────────────
  const S = {
    queue: [],            // [{id,title,artist,art,dur,url,permalink,partial,preview}]
    index: -1,
    mode: 'list',         // 'list': the widget holds the whole list (skip); 'single': load each url
    source: null,         // {url,load,kind,title,author,thumb}
    playing: false,
    loading: false,
    pos: 0, posAt: 0, dur: 0,
    dragging: false,
    pendingSkip: null,    // restored index that has not been sent to the widget yet
    forceStart: null,     // the widget resumes list items where they stopped; rewind this index on play
    history: [],
    shuffle: store.get('shuffle', false),
    repeat: store.get('repeat', 'off'),
    volume: store.get('volume', 80),
    muted: store.get('muted', false),
    tab: 'queue',
    library: store.get('library', []),    // recently opened sources ("Недавнее")
    libView: null,                         // id of the own playlist whose page is open
    libForm: null,                         // 'create' | 'link' while that inline form is shown
    renaming: false, confirmDel: false,
    statsPeriod: store.get('statsPeriod', 'week'), lastStats: null,
    lastQuery: '',
    profile: store.get('profile', null),  // keyless fallback: {name, avatar, url}
    profileEditing: false,
  };

  const el = {
    body: document.body,
    art: $('#art'), artImg: $('#artImg'), sticker: $('#sticker'),
    title: $('#title'), artist: $('#artist'), scLink: $('#scLink'), add: $('#btnAdd'), menu: $('#menu'),
    seek: $('#seek'), tCur: $('#tCur'), tDur: $('#tDur'),
    play: $('#btnPlay'), playIcon: $('#playIcon use'),
    shuffle: $('#btnShuffle'), repeat: $('#btnRepeat'),
    vol: $('#vol'), mute: $('#btnMute'), volIcon: $('#volIcon use'),
    q: $('#q'), omni: $('#omni'), tabs: $('#tabs'), listHead: $('#listHead'), list: $('#list'),
    clip: $('#clip'), clipTitle: $('#clipTitle'), clipKind: $('#clipKind'), clipActs: $('#clipActs'),
    settings: $('#settings'), toast: $('#toast'), frame: $('#sc'),
  };

  // ── helpers ───────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmt(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function fmtTotal(ms) {
    const min = Math.round(ms / 60000);
    return min >= 60 ? Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин' : min + ' мин';
  }
  function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }
  const tracksWord = (n) => n + ' ' + plural(n, 'трек', 'трека', 'треков');
  const artUrl = (u, size) => (u && u.startsWith('file-art:') ? Files.cover(u.slice(9)) : u ? u.replace(/-(large|t\d+x\d+|crop|small|badge|tiny|mini|original)\.(jpg|png)/, '-' + size + '.$2') : '');
  const KIND = { track: 'ТРЕК', playlist: 'ПЛЕЙЛИСТ', artist: 'АРТИСТ', likes: 'ЛАЙКИ', search: 'ПОИСК', feed: 'ЛЕНТА', local: 'МОЙ ПЛЕЙЛИСТ', top: 'ТОП', rec: 'ПОДБОРКА', wave: 'ВОЛНА', track: 'ТРЕК' };
  function fmtListen(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return '<1 мин';
    return min >= 60 ? Math.floor(min / 60) + ' ч ' + (min % 60) + ' мин' : min + ' мин';
  }

  // Accent from the cover (settings): one vivid colour from the artwork fills the play button,
  // progress, the playing row and other black surfaces; borders and text stay black and white.
  const Accent = (() => {
    let on = store.get('accent', false), url = '', rgb = null;
    const root = document.documentElement;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 24;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    // the most present saturated hue (gray, near-black and near-white pixels do not vote)
    function pick(img) {
      cx.clearRect(0, 0, 24, 24);
      cx.drawImage(img, 0, 0, 24, 24);
      const d = cx.getImageData(0, 0, 24, 24).data, bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, l = (mx + mn) / 2;
        if (c < 0.14 || l < 0.1 || l > 0.93) continue;
        let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
        h = (h * 60 + 360) % 360;
        const bin = bins[Math.floor(h / 15) % 24], w = c * c;
        bin.w += w; bin.r += d[i] * w; bin.g += d[i + 1] * w; bin.b += d[i + 2] * w;
      }
      const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
      return best.w < 1.5 ? null : vivid([best.r / best.w, best.g / best.w, best.b / best.w]);
    }
    // the same hue, saturated and of middle lightness, so it reads as an accent
    function vivid([r, g, b]) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
      let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
      h = (h * 60 + 360) % 360;
      const l = clamp((mx + mn) / 2, 0.45, 0.6), s = Math.max(0.62, c / (1 - Math.abs(2 * ((mx + mn) / 2) - 1)));
      const k = (n) => (n + h / 30) % 12, a = Math.min(s, 1) * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
      return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
    }
    function apply() {
      const use = on && !!rgb;
      el.body.classList.toggle('accent', use);
      if (!use) return;
      // the dark theme inverts the whole page, so the colours go in inverted
      const dark = root.classList.contains('dark');
      const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
      let ink = lum > 0.55 ? [13, 13, 13] : [255, 255, 255], c = rgb;
      if (dark) { c = c.map((v) => 255 - v); ink = ink.map((v) => 255 - v); }
      root.style.setProperty('--accent', 'rgb(' + c.join(',') + ')');
      root.style.setProperty('--accent-ink', 'rgb(' + ink.join(',') + ')');
    }
    function load() {
      const want = url;
      if (!on || !want) { rgb = null; apply(); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { if (url !== want) return; try { rgb = pick(img); } catch (e) { rgb = null; } apply(); };
      img.onerror = () => { if (url === want) { rgb = null; apply(); } };
      img.src = want;
    }
    return {
      get on() { return on; },
      from(u) { if (u === url) return; url = u || ''; load(); },
      set(v) { on = v; store.set('accent', v); load(); },
      apply,
    };
  })();

  let toastTimer = 0;
  function toast(msg, err) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', !!err);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
  }

  // ── host bridge (WebView2) ────────────────────────────────
  const pending = new Map();
  let reqId = 0;
  const hostSend = (msg) => { if (host) host.postMessage(msg); };

  function http(opts) {
    if (host) {
      return new Promise((resolve, reject) => {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        hostSend(Object.assign({ type: 'http', id, method: 'GET' }, opts));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Сеть не отвечает')); } }, 20000);
      });
    }
    return fetch(opts.url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body })
      .then(async (r) => ({ status: r.status, body: await r.text(), url: r.url }));
  }

  if (host) {
    host.addEventListener('message', (e) => {
      const m = e.data;
      if (!m || !m.type) return;
      if (m.type === 'http') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      } else if (m.type === 'media') {
        // from Windows media controls: headphones (AirPods 1x / 2x / 3x), media keys, the tray menu
        ({
          playpause: togglePlay,
          play: () => { if (!S.playing) togglePlay(); },
          pause: () => { if (S.playing) pauseNow(); },
          next, prev,
          stop: () => { if (S.playing) pauseNow(); },
        })[m.key]?.();
      } else if (m.type === 'clipboard') {
        onClipboard(m.text || '', !!m.force);
      } else if (m.type === 'mode') {
        applyMode(!!m.mini);
      } else if (m.type === 'shown') {
        Hop.setShown(!!m.on);                // minimized or in the tray: no cover hops, music keeps playing
        BgAnim.setShown(!!m.on);             // and the background stands still
      } else if (m.type === 'beat') {
        Hop.feed(m.l || 0, m.b || 0);
      }
    });
  }

  function openExternal(url) {
    if (host) hostSend({ type: 'open', url }); else window.open(url, '_blank', 'noopener');
  }

  // ── SoundCloud links + oEmbed ─────────────────────────────
  function findScUrl(text) {
    const m = String(text || '').match(/https?:\/\/(?:(?:www|m|on)\.)?soundcloud\.com\/[^\s"'<>]+/i);
    return m ? m[0] : null;
  }
  function cleanUrl(u) {
    try {
      const x = new URL(u);
      x.hostname = x.hostname.replace(/^(www|m)\./i, '');
      x.search = ''; x.hash = '';
      return x.toString().replace(/\/+$/, '');
    } catch (e) { return u; }
  }
  function prettyFromUrl(u) {
    try {
      const parts = new URL(u).pathname.split('/').filter(Boolean).filter((p) => p !== 'sets');
      return decodeURIComponent(parts.join(' / ')).replace(/-/g, ' ') || u;
    } catch (e) { return u; }
  }
  function guessKind(u) {
    try {
      const p = new URL(u).pathname.split('/').filter(Boolean);
      if (p[1] === 'sets') return 'playlist';
      if (p[1] === 'likes') return 'likes';
      if (p.length === 1 || ['tracks', 'popular-tracks', 'albums', 'reposts'].includes(p[1])) return 'artist';
      return 'track';
    } catch (e) { return 'track'; }
  }
  async function oembed(url) {
    const r = await http({ url: 'https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(url) });
    if (r.status !== 200) throw new Error('oembed ' + r.status);
    const j = JSON.parse(r.body);
    const m = /[?&]url=([^&"]+)/.exec(j.html || '');
    const api = m ? decodeURIComponent(m[1]) : '';
    const kind = (api.match(/api\.soundcloud\.com\/(tracks|playlists|users)\//) || [])[1] || '';
    return { title: j.title || '', author: j.author_name || '', thumb: j.thumbnail_url || '', api, kind };
  }
  async function resolveSource(raw) {
    let url = findScUrl(raw);
    if (!url) return null;
    if (/\/\/on\.soundcloud\.com\//i.test(url)) {
      try { const r = await http({ url }); if (r.url && !/on\.soundcloud\.com/.test(r.url)) url = r.url; } catch (e) { /* keep short link */ }
    }
    url = cleanUrl(url);
    const isLikes = /\/likes$/i.test(url);
    let info = null;
    try { info = await oembed(isLikes ? url.replace(/\/likes$/i, '') : url); } catch (e) { /* widget may still manage */ }
    if (isLikes) {
      if (!info || info.kind !== 'users') throw new Error('Не нашёл этот профиль на SoundCloud');
      return { url, load: info.api + '/favorites', kind: 'likes', title: 'Лайки · ' + info.author, author: info.author, thumb: info.thumb };
    }
    const kind = { tracks: 'track', playlists: 'playlist', users: 'artist' }[info && info.kind] || guessKind(url);
    let title = (info && info.title) || prettyFromUrl(url);
    const by = info && info.author ? ' by ' + info.author : '';
    if (by && title.endsWith(by)) title = title.slice(0, -by.length);
    return { url, load: url, kind, title, author: (info && info.author) || '', thumb: (info && info.thumb) || '' };
  }

  // your SoundCloud profile (no sign-in): its likes and tracks play through the widget
  async function saveProfile(raw) {
    raw = raw.trim();
    const url = findScUrl(raw) || (/^[\w-]+$/.test(raw) ? 'https://soundcloud.com/' + raw : null);
    if (!url) { toast('Нужна ссылка на профиль или ник', true); return; }
    const clean = cleanUrl(url).replace(/\/(likes|tracks|sets|reposts|popular-tracks|albums)$/i, '');
    try {
      const info = await oembed(clean);
      if (info.kind !== 'users') throw new Error('not a user');
      S.profile = { name: info.author, avatar: info.thumb, url: clean };
      store.set('profile', S.profile);
      S.profileEditing = false;
      renderList();
      toast('Профиль сохранён');
    } catch (e) {
      toast('Не нашёл такой профиль на SoundCloud', true);
    }
  }

  function toItem(s) {
    return {
      id: s.id || s.urn,
      title: s.title || '',
      artist: (s.user && s.user.username) || '',
      art: s.artwork_url || (s.user && s.user.avatar_url) || '',
      dur: s.duration || 0,
      url: s.secret_uri || s.permalink_url || s.uri || 'https://api.soundcloud.com/tracks/' + s.id,
      permalink: s.permalink_url || '',
      partial: !s.title,
      preview: s.policy === 'SNIP' || s.access === 'preview',
    };
  }

  // ── widget ────────────────────────────────────────────────
  let W = null, loadSeq = 0;
  const WOPTS = { buying: false, sharing: false, download: false, show_artwork: false, show_comments: false, show_playcount: false, show_user: false, show_reposts: false, hide_related: true, visual: false };
  const wcall = (fn) => new Promise((r) => W[fn](r));

  function bootWidget(attempt) {
    if (!window.SC || !SC.Widget) {
      if (!attempt) toast('Нет связи с SoundCloud. Жду интернет…', true);
      const s = document.createElement('script');
      s.src = 'https://w.soundcloud.com/player/api.js?r=' + Date.now();
      s.onload = () => bootWidget((attempt || 0) + 1);
      s.onerror = () => { s.remove(); setTimeout(() => bootWidget((attempt || 0) + 1), 5000); };
      document.body.appendChild(s);
      return;
    }
    // Point the iframe at the widget and bind in the same tick, so READY cannot fire unheard.
    // Start straight on the last source: restoring then needs no second load.
    const last = store.get('last', null);
    const start = last && last.source ? last.source.load : 'https://soundcloud.com/forss/city-ports';
    el.frame.src = 'https://w.soundcloud.com/player/?' + new URLSearchParams(Object.assign({ url: start, auto_play: false }, WOPTS));
    W = SC.Widget(el.frame);
    const E = SC.Widget.Events;
    let first = true;
    W.bind(E.READY, () => {
      applyVolume();
      if (!first) return;
      first = false;
      if (attempt) toast('SoundCloud на связи');
      if (last && last.source) openSource(last.source, { index: last.index || 0, key: last.key, autoplay: false, quiet: true, preloaded: true });
    });
    W.bind(E.PLAY, onPlay);
    W.bind(E.PAUSE, onPause);
    W.bind(E.FINISH, onFinish);
    W.bind(E.ERROR, onWidgetError);
  }

  function wload(url, autoplay) {
    const seq = ++loadSeq;
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(seq === loadSeq ? -1 : 0); } }, 15000);
      W.load(url, Object.assign({}, WOPTS, {
        auto_play: !!autoplay,
        callback: () => {
          if (done) return;
          done = true; clearTimeout(t);
          applyVolume();
          resolve(seq === loadSeq ? seq : 0);
        },
      }));
    });
  }

  const offWidget = () => onFile();             // the widget is idle while a file plays
  function onPlay() {
    if (offWidget()) { W.pause(); return; }  // a late widget start must not play over a file
    S.playing = true;
    S.posAt = performance.now();
    setLoading(false);
    applyVolume();
    hostSend({ type: 'state', playing: true });
    vizSync();
    if (S.mode === 'list') {
      W.getCurrentSoundIndex((i) => {
        if (typeof i === 'number' && i >= 0 && i < S.queue.length && i !== S.index) setCurrent(i, true);
        if (S.forceStart != null && i === S.forceStart) {
          S.forceStart = null;
          W.getPosition((p) => { if (p > 1500) seekTo(0); });
        }
      });
    }
    W.getCurrentSound((s) => {
      if (!s) return;
      const it = S.queue[S.index];
      if (it && (it.id === s.id || (S.mode === 'single' && (it.partial || it.lite)))) {
        S.queue[S.index] = Object.assign(toItem(s), { url: it.url });
        renderNow();
        refreshQueueView();
      }
    });
    W.getDuration((d) => { if (d > 0) { S.dur = d; renderProgress(); } });
    renderState();
  }
  function onPause() {
    if (offWidget()) return;
    S.pos = currentPos();
    S.playing = false;
    hostSend({ type: 'state', playing: false });
    vizSync();
    renderState();
  }
  function onFinish() {
    if (offWidget()) return;
    S.playing = false;
    const n = nextIndex(true);
    if (n < 0) { S.pos = S.dur; renderState(); renderProgress(); return; }
    playIndex(n, true);
  }
  function onWidgetError() {
    if (!S.queue.length || offWidget()) return;
    setLoading(false);
    if (S.queue.length > 1) { toast('Трек недоступен, переключаю', true); setTimeout(() => next(), 1200); }
    else toast('Этот трек нельзя воспроизвести', true);
  }

  const currentPos = () => (S.playing && !S.dragging ? Math.min(S.pos + (performance.now() - S.posAt), S.dur || Infinity) : S.pos);

  function pauseNow() {
    if (onFile()) Files.pause(); else if (W) W.pause();
  }

  // ── playback ──────────────────────────────────────────────
  async function openSource(src, opts) {
    opts = opts || {};
    if (!W) return;
    if (onFile()) { Files.stop(); S.playing = false; renderState(); }
    const autoplay = opts.autoplay !== false;
    S.source = src;
    S.mode = 'list';
    S.history = [];
    S.pendingSkip = null;
    S.needLoad = false;
    setLoading(true);
    if (!opts.quiet) setTab('queue'); else renderList();
    const seq = opts.preloaded ? ++loadSeq : await wload(src.load, false);
    if (seq === 0) return;
    if (seq < 0) { setLoading(false); toast('SoundCloud не отвечает. Проверь ссылку или интернет', true); return; }
    const sounds = await wcall('getSounds');
    if (seq !== loadSeq) return;
    if (!sounds || !sounds.length) { setLoading(false); toast('Здесь нет доступных треков', true); return; }
    const items = sounds.map(toItem);
    items.forEach((x) => Info.apply(x));
    S.allItems = items;
    S.known = new Set(items.map(itemKey));
    // with saved edits the list is ours (removed tracks out, our order) and plays track by track
    const edited = src.kind !== 'track' && Edits.has(src.url);
    S.queue = edited ? Edits.apply(src.url, items) : items;
    S.queueSrc = src.url;
    if (!S.queue.length) { setLoading(false); toast('Все треки отсюда удалены. «Вернуть удалённые» в очереди', true); S.mode = 'single'; renderList(); return; }
    if (edited) S.mode = 'single';
    // the track itself when known: tracks put into the queue shift positions
    const byKey = opts.key ? S.queue.findIndex((x) => itemKey(x) === opts.key) : -1;
    const start = byKey >= 0 ? byKey : clamp(opts.index || 0, 0, S.queue.length - 1);
    setCurrent(start, true);
    renderList();
    if (edited) {
      if (autoplay) playIndex(start, false, true);
      else { S.needLoad = true; setLoading(false); }
    } else if (autoplay) {
      if (start > 0) W.skip(start);
      W.play();
    } else {
      S.pendingSkip = start > 0 ? start : null;
      setLoading(false);
    }
    addToLibrary(src);
    syncSounds(seq);
  }

  // The widget pages long lists (likes, big sets) in over several seconds and fills in
  // partial items, so keep syncing until the list stops changing.
  async function syncSounds(seq) {
    let stable = 0;
    for (let k = 0; k < 60 && stable < 3; k++) {
      await sleep(900);
      if (seq !== loadSeq) { Info.fill(); return; }  // another track loaded: the widget stops filling in
      const sounds = await wcall('getSounds');
      if (seq !== loadSeq || !sounds) { Info.fill(); return; }
      let changed = false;
      if (S.mode === 'list') {
        sounds.forEach((s, i) => {
          const it = S.queue[i];
          if (!it || ((it.partial || it.lite) && s.title)) { S.queue[i] = toItem(s); changed = true; }
        });
      } else {
        // edited list: fill in details, append tracks that arrive later unless removed
        const byKey = new Map(S.queue.map((x) => [itemKey(x), x]));
        sounds.forEach((s) => {
          const it = toItem(s), key = itemKey(it), have = byKey.get(key);
          if (have) { if ((have.partial || have.lite) && !it.partial) { Object.assign(have, it, { url: have.url, lite: false }); changed = true; } return; }
          if (S.known.has(key)) return;
          S.known.add(key);
          if (S.allItems) S.allItems.push(it);
          if (S.source && Edits.isHidden(S.source.url, key)) return;
          S.queue.push(it);
          changed = true;
        });
      }
      if (changed) {
        stable = 0;
        renderNow();
        refreshQueueView();
      } else if (!S.queue.some((x) => x.partial)) {
        stable++;
      }
    }
    Info.fill();
  }

  // the list panel shows the queue: the queue tab, or the library page of the source playing
  const showsQueue = () => S.tab === 'queue' || (S.tab === 'library' && !!S.libView && S.libView === 'src:' + (S.queueSrc || ''));
  function refreshQueueView() {
    if (showsQueue()) { const top = el.list.scrollTop; renderList(); el.list.scrollTop = top; markCurrentRow(true); followCur(); } else renderCounts();
  }

  // Tracks the widget never described (it only does so near the playing one, and stops as soon
  // as another track loads) are filled in from SoundCloud's oEmbed: title, artist and cover, no
  // length. Cached on this computer, so a list opened again is complete at once.
  const Info = {
    cache: store.get('trackInfo', {}),     // id → {t, a, art}
    busy: false, dirty: false,
    async fill() {
      if (this.busy) return;
      this.busy = true;
      try {
        S.queue.forEach((x) => this.apply(x));
        refreshQueueView();
        for (let round = 0; round < 200; round++) {
          const todo = S.queue.filter((x) => x.partial && x.id && !x.noInfo).slice(0, 12);
          if (!todo.length) break;
          await pool(todo, 6, (x) => this.one(x));
          if (S.queue[S.index] && todo.includes(S.queue[S.index])) renderNow();
          refreshQueueView();
        }
      } finally {
        this.busy = false;
        this.save();
      }
      if (S.queue.some((x) => x.partial && x.noInfo)) this.fromWidget();
    },
    // Some tracks refuse oEmbed (403) yet the widget describes them: a second, hidden widget loads
    // the list only to read it, never plays, and is removed afterwards.
    async fromWidget() {
      const src = S.source;
      if (this.widgetBusy || !src || !src.load || !window.SC || !SC.Widget) return;
      this.widgetBusy = true;
      const f = document.createElement('iframe');
      f.className = 'sc-frame';
      f.title = 'SoundCloud (список)';
      f.src = 'https://w.soundcloud.com/player/?' + new URLSearchParams(Object.assign({ url: src.load, auto_play: false }, WOPTS));
      document.body.appendChild(f);
      try {
        const M = SC.Widget(f);
        await new Promise((r) => { M.bind(SC.Widget.Events.READY, r); setTimeout(r, 15000); });
        for (let k = 0; k < 30 && S.source === src; k++) {
          const sounds = await new Promise((r) => { M.getSounds(r); setTimeout(() => r(null), 5000); });
          const byId = new Map((sounds || []).filter((x) => x.title).map((x) => [String(x.id), x]));
          let left = 0, got = 0;
          S.queue.forEach((x) => {
            if (!x.partial) return;
            const it = byId.get(String(x.id));
            if (!it) { left++; return; }
            Object.assign(x, toItem(it), { url: x.url });
            this.cache[String(x.id)] = { t: x.title, a: x.artist, art: x.art };
            this.dirty = true; got++;
          });
          if (got) refreshQueueView();
          if (!left) break;
          await sleep(1000);
        }
      } finally {
        f.remove();
        this.widgetBusy = false;
        this.save();
      }
    },
    apply(x) {
      const c = x.partial && x.id ? this.cache[String(x.id)] : null;
      if (c) Object.assign(x, { title: c.t, artist: c.a, art: c.art, partial: false, lite: true });
      return !!c;
    },
    async one(x) {
      const id = String(x.id);
      if (!this.cache[id]) {
        try {
          const j = await oembed('https://api.soundcloud.com/tracks/' + id.replace(/\D/g, ''));
          const by = ' by ' + j.author;
          this.cache[id] = { t: j.author && j.title.endsWith(by) ? j.title.slice(0, -by.length) : j.title, a: j.author, art: j.thumb };
          this.dirty = true;
        } catch (e) { x.noInfo = true; return; }   // private or removed: the row stays as it is
      }
      this.apply(x);
    },
    save() {
      if (!this.dirty) return;
      const keys = Object.keys(this.cache);
      if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach((k) => delete this.cache[k]);
      store.set('trackInfo', this.cache);
      this.dirty = false;
    },
  };
  // the total length only when every track's length is known (oEmbed does not give it)
  const totalOf = (items) => (items.length && items.every((x) => x.dur > 0) ? ' · ' + fmtTotal(items.reduce((a, x) => a + x.dur, 0)) : '');

  async function playIndex(i, auto, fromHistory) {
    if (i < 0 || i >= S.queue.length) return;
    const file = isFile(S.queue[i]);
    if (!file && !W) return;
    if (!fromHistory && S.index >= 0 && i !== S.index) S.history = S.history.concat(S.index).slice(-50);
    setCurrent(i, true);
    S.pendingSkip = null;
    S.needLoad = false;
    if (file) { Files.play(S.queue[i]); return; }
    if (Files.active()) { Files.stop(); S.playing = false; }
    if (S.mode === 'list') {
      S.forceStart = i;
      W.skip(i);
      W.play();
      return;
    }
    setLoading(true);
    const seq = await wload(S.queue[i].url, true);
    if (seq > 0) W.play();
    else if (seq < 0) { setLoading(false); onWidgetError(); }
  }

  function nextIndex(auto) {
    const n = S.queue.length;
    if (!n) return -1;
    if (auto && S.repeat === 'one') return S.index;
    if (S.shuffle && n > 1) {
      const recent = S.history.slice(-Math.min(n - 1, 12));
      let j, tries = 0;
      do { j = Math.floor(Math.random() * n); } while ((j === S.index || recent.includes(j)) && ++tries < 60);
      return j;
    }
    if (S.index + 1 < n) return S.index + 1;
    return S.repeat === 'all' || !auto ? 0 : -1;
  }

  function togglePlay() {
    if (onFile()) { Files.toggle(S.queue[S.index]); return; }
    if (!W || !S.queue.length) { toast('Сначала вставь ссылку SoundCloud'); el.q.focus(); return; }
    if (S.needLoad) { playIndex(S.index, false, true); return; }
    if (S.pendingSkip != null) { const i = S.pendingSkip; S.pendingSkip = null; S.forceStart = i; W.skip(i); W.play(); return; }
    W.toggle();
  }
  function next() { const n = nextIndex(false); if (n >= 0) playIndex(n); }
  function prev() {
    if (!S.queue.length) return;
    if (currentPos() > 3500) { seekTo(0); return; }
    if (S.shuffle && S.history.length) { const h = S.history[S.history.length - 1]; S.history = S.history.slice(0, -1); playIndex(h, false, true); return; }
    playIndex(S.index > 0 ? S.index - 1 : S.queue.length - 1, false, true);
  }
  function seekTo(ms) {
    if (!S.queue.length || (!W && !onFile())) return;
    ms = clamp(ms, 0, S.dur || 0);
    if (onFile()) Files.seek(ms); else W.seekTo(ms);
    S.pos = ms;
    S.posAt = performance.now();
    renderProgress();
  }
  const seekBy = (d) => seekTo(currentPos() + d);

  function applyVolume() {
    if (W) W.setVolume(S.muted ? 0 : S.volume);
    Files.audio.volume = S.muted ? 0 : S.volume / 100;
  }
  function setVolume(v) {
    S.volume = Math.round(clamp(v, 0, 100));
    if (S.volume > 0) S.muted = false;
    store.set('volume', S.volume); store.set('muted', S.muted);
    applyVolume(); renderVolume();
  }
  function toggleMute() { S.muted = !S.muted; store.set('muted', S.muted); applyVolume(); renderVolume(); }
  function toggleShuffle() { S.shuffle = !S.shuffle; store.set('shuffle', S.shuffle); renderModes(); toast(S.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено'); }
  function cycleRepeat() {
    S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat] || 'off';
    store.set('repeat', S.repeat); renderModes();
    toast({ off: 'Повтор выключен', all: 'Повтор очереди', one: 'Повтор трека' }[S.repeat]);
  }

  function setCurrent(i, resetPos) {
    S.index = i;
    const it = S.queue[i];
    Stats.cur = null;                          // a new track (or a replay) is a new listening session
    if (resetPos) { S.pos = 0; S.posAt = performance.now(); S.dur = it ? it.dur : 0; }
    renderNow();
    renderProgress();
    markCurrentRow();
    if (S.source && S.source.load) store.set('last', { source: S.source, index: i, key: it ? itemKey(it) : '' });
  }

  function setLoading(on) {
    S.loading = on;
    el.body.classList.toggle('loading', on);
    renderState();
    clearTimeout(setLoading.t);
    if (on) setLoading.t = setTimeout(() => { if (S.loading) { setLoading(false); toast('SoundCloud долго не отвечает', true); } }, 16000);
  }

  // ── library ───────────────────────────────────────────────
  function addToLibrary(src) {
    if (!src || !src.url || src.kind === 'search') return;
    const entry = { url: src.url, load: src.load, kind: src.kind, title: src.title, author: src.author || '', thumb: src.thumb || '' };
    if (!entry.thumb && S.queue[0]) entry.thumb = artUrl(S.queue[0].art, 't300x300');
    S.library = [entry].concat(S.library.filter((x) => x.url !== src.url)).slice(0, 40);
    store.set('library', S.library);
    renderCounts();
    if (S.tab === 'library') renderList();
  }
  function removeFromLibrary(i) {
    S.library = S.library.filter((_, k) => k !== i);
    store.set('library', S.library);
    renderCounts(); renderList(); renderListHead();
  }

  // own playlists (kept on this computer) and SoundCloud sources the user pinned
  const Lib = {
    playlists: store.get('playlists', []),  // [{id, name, t, tracks:[{id,url,permalink,title,artist,art,dur}]}]
    saved: store.get('saved', []),          // [{url, load, kind, title, author, thumb}]
    save() { store.set('playlists', this.playlists); store.set('saved', this.saved); Files.save(); },
    get(id) { return id === 'files' ? Files.playlist() : this.playlists.find((p) => p.id === id); },
    create(name) {
      const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: (name || '').trim() || 'Плейлист ' + (this.playlists.length + 1), t: Date.now(), tracks: [] };
      this.playlists.unshift(p);
      this.save();
      return p;
    },
    add(p, it) {
      if (!it || it.partial || !it.title) return 'bad';
      const key = it.permalink || it.url;
      if (p.tracks.some((x) => (x.permalink || x.url) === key)) return 'dup';
      const t = { id: it.id, url: it.url, permalink: it.permalink || '', title: it.title, artist: it.artist, art: it.art, dur: it.dur };
      p.tracks.push(t);
      this.save();
      if (S.source && S.source.url === 'local:' + p.id && !S.queue.some((x) => sameTrack(x, t))) { S.queue.push(Object.assign({}, t)); refreshQueueView(); renderCounts(); }
      return 'ok';
    },
    isSaved(url) { return this.saved.some((x) => x.url === url); },
    pin(src) {
      if (!src || !src.url || !src.load || this.isSaved(src.url)) return false;
      this.saved.unshift({ url: src.url, load: src.load, kind: src.kind, title: src.title, author: src.author || '', thumb: src.thumb || '' });
      this.save();
      return true;
    },
  };

  // ── own audio files (mp3 and other formats the engine plays) ──
  // The files live in this computer's IndexedDB (inside Pedro's own data folder) and play in an
  // <audio> element. A file is an ordinary item with a file: url, so the queue, own playlists,
  // stats and headphone buttons treat it like a track; "Мои MP3" is a playlist made of them.
  const isFile = (it) => !!(it && typeof it.url === 'string' && it.url.startsWith('file:'));
  const onFile = () => isFile(S.queue[S.index]);
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|weba|webm)$/i;

  const Files = (() => {
    const pl = { id: 'files', name: 'Мои MP3', files: true, tracks: store.get('files', []) };
    const covers = {};                          // file id -> object url of its cover (this session)
    const coverData = {};                       // file id -> data url, for Windows media controls
    const audio = new Audio();
    audio.preload = 'auto';
    let want = false, cur = null, url = '';

    // ── IndexedDB: 'files' holds the audio, 'covers' the cover pictures, both by file id ──
    let dbp = null;
    function db() {
      return dbp || (dbp = new Promise((res, rej) => {
        const r = indexedDB.open('pedro-files', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('covers'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => { dbp = null; rej(r.error); };
      }));
    }
    const tx = (name, mode, fn) => db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(name, mode), req = fn(t.objectStore(name));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error || new Error('IndexedDB'));
    }));
    const dbGet = (name, k) => tx(name, 'readonly', (st) => st.get(k));
    const dbPut = (name, k, v) => tx(name, 'readwrite', (st) => st.put(v, k));
    const dbDel = (name, k) => tx(name, 'readwrite', (st) => st.delete(k));
    const dbKeys = (name) => tx(name, 'readonly', (st) => st.getAllKeys());

    // ── ID3 tags: title, artist and the cover picture (v2.2–2.4) ──
    const syncsafe = (b, i) => ((b[i] & 127) << 21) | ((b[i + 1] & 127) << 14) | ((b[i + 2] & 127) << 7) | (b[i + 3] & 127);
    const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    function decodeText(enc, bytes) {
      // encoding 0 is "latin1" by the spec, but Russian tags written that way are cp1251
      const label = enc === 3 ? 'utf-8' : enc === 2 ? 'utf-16be' : enc === 1 ? (bytes[0] === 0xFE && bytes[1] === 0xFF ? 'utf-16be' : 'utf-16le') : 'windows-1251';
      return new TextDecoder(label).decode(bytes).replace(/^﻿/, '').split('\0')[0].trim();
    }
    function picture(d, v22) {
      const enc = d[0];
      let p = 1;
      if (v22) p = 4; else { while (p < d.length && d[p]) p++; p++; }
      p++;                                      // picture type
      if (enc === 1 || enc === 2) { while (p + 1 < d.length && (d[p] || d[p + 1])) p += 2; p += 2; }
      else { while (p < d.length && d[p]) p++; p++; }
      const img = d.subarray(p);
      if (img.length < 64) return null;
      const type = img[0] === 0x89 && img[1] === 0x50 ? 'image/png' : 'image/jpeg';
      return new Blob([img], { type });
    }
    async function readTags(f) {
      const out = {};
      try {
        const h = new Uint8Array(await f.slice(0, 10).arrayBuffer());
        if (h[0] !== 0x49 || h[1] !== 0x44 || h[2] !== 0x33) return out;   // "ID3"
        const ver = h[3], size = syncsafe(h, 6);
        const b = new Uint8Array(await f.slice(10, 10 + Math.min(size, 16 << 20)).arrayBuffer());
        const v22 = ver === 2, idLen = v22 ? 3 : 4, hdr = v22 ? 6 : 10;
        let p = 0;
        if ((h[5] & 0x40) && !v22) p = ver === 4 ? syncsafe(b, 0) : be32(b, 0) + 4;
        while (p + hdr <= b.length) {
          const id = String.fromCharCode.apply(null, b.subarray(p, p + idLen));
          if (!/^[A-Z0-9]+$/.test(id)) break;
          const sz = v22 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : ver === 4 ? syncsafe(b, p + 4) : be32(b, p + 4);
          const d = b.subarray(p + hdr, p + hdr + sz);
          p += hdr + sz;
          if (!d.length) continue;
          if (id === 'TIT2' || id === 'TT2') out.title = decodeText(d[0], d.subarray(1));
          else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(d[0], d.subarray(1));
          else if ((id === 'APIC' || id === 'PIC') && !out.pic) out.pic = picture(d, v22);
        }
      } catch (e) { /* no usable tags */ }
      return out;
    }
    // the cover, cropped to a 400px square JPEG (a full-size scan would bloat the database)
    async function coverOf(blob) {
      try {
        const img = await createImageBitmap(blob), N = 400, k = Math.max(N / img.width, N / img.height);
        const c = document.createElement('canvas');
        c.width = c.height = N;
        c.getContext('2d').drawImage(img, (N - img.width * k) / 2, (N - img.height * k) / 2, img.width * k, img.height * k);
        img.close();
        return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      } catch (e) { return null; }
    }
    function durationOf(f) {
      return new Promise((res) => {
        const a = new Audio(), u = URL.createObjectURL(f);
        const done = (ms) => { clearTimeout(t); URL.revokeObjectURL(u); a.removeAttribute('src'); res(ms); };
        const t = setTimeout(() => done(0), 8000);
        a.preload = 'metadata';
        a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
        a.onerror = () => done(-1);
        a.src = u;
      });
    }

    async function add(fileList) {
      const all = Array.from(fileList || []);
      const picked = all.filter((f) => /^audio\//.test(f.type) || AUDIO_EXT.test(f.name));
      if (!picked.length) { toast('Это не аудиофайлы. Подходят mp3, m4a, wav, flac, ogg', true); return []; }
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast(picked.length > 1 ? 'Загружаю ' + picked.length + ' ' + plural(picked.length, 'файл', 'файла', 'файлов') + '…' : 'Загружаю «' + picked[0].name + '»…');
      const added = [];
      let dup = 0, bad = 0;
      for (const f of picked) {
        if (pl.tracks.some((x) => x.file === f.name && x.size === f.size)) { dup++; continue; }
        try {
          const dur = await durationOf(f);
          if (dur < 0) { bad++; continue; }       // the engine cannot play this file
          const fid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const tags = await readTags(f);
          await dbPut('files', fid, f);
          let art = '';
          const cover = tags.pic && (await coverOf(tags.pic));
          if (cover) { await dbPut('covers', fid, cover); covers[fid] = URL.createObjectURL(cover); art = 'file-art:' + fid; }
          // no tags: "Artist - Title.mp3" is the usual file name
          const base = f.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim(), parts = base.split(/\s+[-–—]\s+/);
          const it = {
            id: 'file:' + fid, url: 'file:' + fid, permalink: '',
            title: tags.title || (parts.length > 1 ? parts.slice(1).join(' - ') : base),
            artist: tags.artist || (parts.length > 1 ? parts[0] : 'Мой файл'),
            art, dur, file: f.name, size: f.size, added: Date.now(),
          };
          pl.tracks.push(it);
          added.push(it);
        } catch (e) { bad++; }
      }
      save();
      const msg = [];
      if (added.length) msg.push('Загружено: ' + tracksWord(added.length));
      if (dup) msg.push(dup + ' уже ' + plural(dup, 'был', 'были', 'были'));
      if (bad) msg.push(bad + ' не ' + plural(bad, 'получился', 'получились', 'получились'));
      toast(msg.join(' · ') || 'Ничего не загружено', !added.length);
      renderCounts();
      if (S.tab === 'library') renderList();
      return added;
    }

    function save() { store.set('files', pl.tracks); }

    // blobs nobody refers to any more (removed from "Мои MP3" and every playlist) go at start-up,
    // so Ctrl+Z still works during the session
    async function boot() {
      try {
        const used = new Set();
        const mark = (it) => { if (isFile(it)) used.add(it.url.slice(5)); };
        pl.tracks.forEach(mark);
        Lib.playlists.forEach((p) => p.tracks.forEach(mark));
        const [fileKeys, coverKeys] = await Promise.all([dbKeys('files'), dbKeys('covers')]);
        for (const k of fileKeys) if (!used.has(k)) await dbDel('files', k);
        for (const k of coverKeys) {
          if (!used.has(k)) { await dbDel('covers', k); continue; }
          const b = await dbGet('covers', k);
          if (b) covers[k] = URL.createObjectURL(b);
        }
        if (coverKeys.length) { renderNow(); if (S.tab === 'library') renderList(); }
      } catch (e) { /* no IndexedDB: uploads will report it */ }
    }

    function active() { return !!audio.getAttribute('src'); }
    function release() {
      want = false;
      audio.pause();
      if (active()) { audio.removeAttribute('src'); audio.load(); }
      if (url) { URL.revokeObjectURL(url); url = ''; }
      cur = null;
    }

    audio.addEventListener('playing', () => {
      if (!want) return;
      S.playing = true;
      S.pos = audio.currentTime * 1000;
      S.posAt = performance.now();
      setLoading(false);
      hostSend({ type: 'state', playing: true });
      vizSync();
      renderState();
    });
    audio.addEventListener('timeupdate', () => {
      if (!want || S.dragging) return;
      S.pos = audio.currentTime * 1000;
      S.posAt = performance.now();
    });
    audio.addEventListener('durationchange', () => {
      if (!want || !isFinite(audio.duration)) return;
      S.dur = Math.round(audio.duration * 1000);
      renderProgress();
    });
    audio.addEventListener('ended', () => {
      if (!want) return;
      S.playing = false;
      hostSend({ type: 'state', playing: false });
      vizSync();
      const n = nextIndex(true);
      if (n < 0) { S.pos = S.dur; renderState(); renderProgress(); return; }
      playIndex(n, true);
    });
    audio.addEventListener('error', () => {
      if (!want || !active()) return;
      release();
      S.playing = false;
      setLoading(false);
      hostSend({ type: 'state', playing: false });
      renderState();
      toast('Этот файл не воспроизводится', true);
    });

    return {
      audio, add, boot, save, active,
      playlist: () => pl,
      get count() { return pl.tracks.length; },
      cover: (fid) => covers[fid] || '',
      // a data url of the cover for Windows media controls; read once, then the card is re-sent
      cardArt(fid) {
        if (coverData[fid] !== undefined) return coverData[fid];
        coverData[fid] = '';
        dbGet('covers', fid).then((b) => {
          if (!b) return;
          const r = new FileReader();
          r.onload = () => { coverData[fid] = r.result; renderNow(); };
          r.readAsDataURL(b);
        }).catch(() => {});
        return '';
      },
      async play(it) {
        const fid = it.url.slice(5);
        if (W) W.pause();
        ++loadSeq;                              // stop a SoundCloud list that is still syncing
        release();
        want = true; cur = fid;
        setLoading(true);
        let blob = null;
        try { blob = await dbGet('files', fid); } catch (e) { /* reported below */ }
        if (!want || cur !== fid) return;
        if (!blob) {
          release();
          S.playing = false;
          setLoading(false);
          renderState();
          toast('Файл «' + it.title + '» не найден: его удалили из «Мои MP3»', true);
          return;
        }
        url = URL.createObjectURL(blob);
        audio.src = url;
        applyVolume();
        audio.play().catch(() => { /* failures arrive as the error event */ });
      },
      pause() {
        if (!want) return;
        audio.pause();
        S.pos = audio.currentTime * 1000;
        S.playing = false;
        hostSend({ type: 'state', playing: false });
        vizSync();
        renderState();
      },
      toggle(it) {
        if (want && cur === it.url.slice(5) && active()) {
          if (audio.paused) audio.play().catch(() => {}); else this.pause();
        } else {
          this.play(it);
        }
      },
      seek(ms) { if (want && active()) audio.currentTime = ms / 1000; },
      stop: release,
    };
  })();

  const filePicker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav' });
  filePicker.onchange = () => { const list = Array.from(filePicker.files); filePicker.value = ''; importFiles(list); };
  const pickFiles = () => filePicker.click();
  // after an upload: show "Мои MP3", and start the first new file when nothing is playing
  async function importFiles(list) {
    const added = await Files.add(list);
    if (!added.length) return;
    S.libView = 'files'; S.libForm = null;
    if (S.tab !== 'library') setTab('library'); else renderList();
    if (!S.playing) openLocal(Files.playlist(), Files.playlist().tracks.indexOf(added[0]));
  }

  // Changes to SoundCloud lists (playlists, likes, artists) kept in Pedro: removed tracks and
  // a custom order per source url. SoundCloud itself is not changed (that needs API keys).
  const itemKey = (it) => String(it.id || it.permalink || it.url);
  const linkKey = (it) => (it.permalink ? cleanUrl(it.permalink).toLowerCase() : '');
  const sameTrack = (a, b) => !!a && !!b && (itemKey(a) === itemKey(b) || (!!linkKey(a) && linkKey(a) === linkKey(b)));
  const isCur = (it) => sameTrack(S.queue[S.index], it);
  const Edits = {
    data: ((d) => { Object.keys(d).forEach((u) => { if (guessKind(u) === 'track') delete d[u]; }); return d; })(store.get('edits', {})),  // { [sourceUrl]: { hidden: [key], order: [key] | null } }
    save() { store.set('edits', this.data); },
    entry(url) { return this.data[url] || (this.data[url] = { hidden: [], order: null, added: [] }); },
    has(url) { const e = this.data[url]; return !!(e && (e.hidden.length || e.order || (e.added && e.added.length))); },
    // SoundCloud does not let anyone change a playlist without signing in, so a track added to
    // it in Pedro is kept here and plays as part of it (at the end, or where it was dragged)
    add(url, it) {
      const e = this.entry(url);
      e.added = e.added || [];
      const key = itemKey(it);
      if (e.hidden.indexOf(key) >= 0) { e.hidden = e.hidden.filter((k) => k !== key); this.save(); return 'ok'; }
      if (e.added.some((x) => sameTrack(x, it))) return 'dup';
      e.added.push({ id: it.id, url: it.url, permalink: it.permalink || '', title: it.title, artist: it.artist, art: it.art, dur: it.dur });
      this.save();
      return 'ok';
    },
    hiddenCount(url) { const e = this.data[url]; return e ? e.hidden.length : 0; },
    isHidden(url, key) { const e = this.data[url]; return !!(e && e.hidden.indexOf(key) >= 0); },
    hide(url, key) { const e = this.entry(url); if (e.hidden.indexOf(key) < 0) e.hidden.push(key); this.save(); },
    unhide(url, key) { const e = this.data[url]; if (e) { e.hidden = e.hidden.filter((k) => k !== key); this.save(); } },
    setOrder(url, keys) { this.entry(url).order = keys; this.save(); },
    unhideAll(url) { const e = this.data[url]; if (e) { e.hidden = []; this.save(); } },
    // the source's tracks without the removed ones, in the saved order (new tracks keep theirs, at the end)
    apply(url, items) {
      const e = this.data[url];
      if (!e) return items;
      if (e.added && e.added.length) items = items.concat(e.added.filter((x) => !items.some((y) => sameTrack(x, y))).map((x) => Object.assign({}, x)));
      const out = items.filter((it) => e.hidden.indexOf(itemKey(it)) < 0);
      if (!e.order) return out;
      const pos = new Map(e.order.map((k, i) => [k, i]));
      return out.map((it, i) => ({ it, w: pos.has(itemKey(it)) ? pos.get(itemKey(it)) : 1e6 + i })).sort((a, b) => a.w - b.w).map((x) => x.it);
    },
  };

  // Listening stats, counted locally: SoundCloud does not hand out play history.
  // Stored per day (ms + plays per track); a play counts after 30 s or half the track.
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const trackKey = (it) => (it && !it.partial && it.title ? it.permalink || it.url || String(it.id) : null);
  const Stats = {
    data: store.get('stats', null) || { days: {}, old: { ms: 0, tracks: {} }, meta: {}, since: dayKey(new Date()) },
    cur: null, dirty: false, savedAt: 0,

    tick(ms) {
      const it = S.queue[S.index], key = trackKey(it);
      if (!key) return;
      if (!this.cur || this.cur.key !== key) this.cur = { key, ms: 0, counted: false };
      this.data.meta[key] = { t: it.title, a: it.artist, art: it.art, u: it.permalink || it.url };
      const dk = dayKey(new Date());
      const day = this.data.days[dk] || (this.data.days[dk] = { ms: 0, tracks: {} });
      const tr = day.tracks[key] || (day.tracks[key] = { ms: 0, p: 0 });
      tr.ms += ms; day.ms += ms; this.cur.ms += ms;
      if (!this.cur.counted && (this.cur.ms >= 30000 || (S.dur > 0 && this.cur.ms >= S.dur * 0.5))) { tr.p++; this.cur.counted = true; }
      this.dirty = true;
      if (Date.now() - this.savedAt > 15000) this.save();
    },

    save() {
      if (!this.dirty) return;
      // days older than ~13 months fold into the all-time bucket to keep storage small
      const cut = dayKey(new Date(Date.now() - 400 * 864e5)), old = this.data.old;
      Object.keys(this.data.days).forEach((k) => {
        if (k >= cut) return;
        const d = this.data.days[k];
        old.ms += d.ms;
        for (const t in d.tracks) {
          const o = old.tracks[t] || (old.tracks[t] = { ms: 0, p: 0 });
          o.ms += d.tracks[t].ms; o.p += d.tracks[t].p;
        }
        delete this.data.days[k];
      });
      store.set('stats', this.data);
      this.dirty = false;
      this.savedAt = Date.now();
    },

    reset() {
      this.data = { days: {}, old: { ms: 0, tracks: {} }, meta: {}, since: dayKey(new Date()) };
      this.cur = null;
      this.dirty = true;
      this.save();
    },

    compute(period) {
      const span = { week: 7, month: 30, year: 365 }[period];
      const from = span ? dayKey(new Date(Date.now() - (span - 1) * 864e5)) : '';
      let ms = 0, plays = 0;
      const per = {};
      const add = (d) => {
        ms += d.ms;
        for (const k in d.tracks) {
          const x = d.tracks[k], p = per[k] || (per[k] = { ms: 0, p: 0 });
          p.ms += x.ms; p.p += x.p; plays += x.p;
        }
      };
      for (const k in this.data.days) if (k >= from) add(this.data.days[k]);
      if (!span) add(this.data.old);
      const tracks = Object.keys(per).map((k) => Object.assign({ k, m: this.data.meta[k] || {} }, per[k]))
        .filter((x) => x.m.t && (x.p > 0 || x.ms >= 10000))
        .sort((a, b) => b.p - a.p || b.ms - a.ms);
      return { ms, plays, unique: tracks.length, top: tracks.slice(0, 5), fav: tracks[0] };
    },
  };
  addEventListener('pagehide', () => Stats.save());
  addEventListener('beforeunload', () => Stats.save());

  // ── recommendations for own playlists ─────────────────────
  // No API keys: every SoundCloud track page carries, for search engines, its "More tracks like
  // this" list and the playlists it appears in, plus the track's metadata (genre, tags, length,
  // plays). Pedro reads those pages and ranks the tracks itself:
  //  1. seeds: the playlist's tracks, weighted by how recently they were added and how often you
  //     really play them (local stats); 2 per artist at most. An empty playlist uses your top.
  //  2. candidates: each seed's similar tracks (higher in its list = closer) and tracks from
  //     people's playlists that contain the seeds;
  //  3. agreement: a track several seeds point to beats one a single seed mentions;
  //  4. a closer look at the best 30: their own similar lists must point back into the playlist
  //     (mutual neighbours), their genre and tags must fit the playlist's, their length too
  //     (no hour-long mixes among songs); 30-second previews are dropped, megahits are discounted
  //     a little, tracks you already play a lot sink;
  //  5. variety: 2 tracks per artist per page. ✕ hides a track for good, an artist hidden twice
  //     sinks, and tracks shown but never taken slowly give way to new ones.
  const SC_ORIGIN = 'https://soundcloud.com';
  const NOT_TRACK = /^\/[^/]+\/(sets|likes|tracks|reposts|albums|popular-tracks|followers|following|comments)$/i;
  function scPath(u) {
    const m = /^(?:https?:\/\/(?:www\.|m\.)?soundcloud\.com)?(\/[^/?#\s"]+\/[^/?#\s"]+)\/?(?:[?#]|$)/i.exec(u || '');
    return m && !NOT_TRACK.test(m[1]) && !/^\/(discover|search|you|stream|upload|pages|charts)\//i.test(m[1]) ? m[1] : null;
  }
  const pathKey = (p) => (p || '').toLowerCase();
  const songKey = (a, t) => (String(a) + '|' + String(t)).toLowerCase().replace(/\(.*?\)|\[.*?\]|\bfeat\..*$|[^\p{L}\p{N}|]+/gu, '');
  // the song behind an upload: "Artist - Song (sped up + reverb)" and "song slowed" are one song
  const VERSION = /\b(sped|speed|slowed|slow|reverb|nightcore|bass\s*boost(ed)?|boosted|tik\s*tok|version|remix|edit|cover|8d|phonk|ultra|super|perfect|[\d.]+x|x[\d.]+|by\s+\S+|up|down|and|feat\.?|ft\.?|speedup|spedup|glitchy|glitch|loop(ed)?|bb|\d{4}|#\S+)\b/g;
  function songCore(t) {
    const parts = String(t || '').toLowerCase().split(/\s[-–—|]\s/);
    const core = (parts[parts.length - 1] || '').replace(/[([{].*?[)\]}]|[([{].*$/g, ' ').replace(VERSION, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
    return core.length >= 3 ? core : String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }
  // the same words in any order: "Рассвет-Конец солнечных дней" = "конец солнечных дней - рассвет"
  const songWords = (t) => [...new Set(String(t || '').toLowerCase().replace(/[([{].*?[)\]}]/g, ' ').replace(VERSION, ' ').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))].sort().join(' ');
  const shortTitle = (t) => { const x = String(t || '').replace(/\s*[([{].*?[)\]}]/g, '').split(/\s[-–—]\s/).pop().trim() || String(t || ''); return x.length > 34 ? x.slice(0, 32) + '…' : x; };

  async function pool(list, n, fn) {
    let at = 0;
    const worker = async () => { while (at < list.length) { const i = at++; try { await fn(list[i], i); } catch (e) { /* one page less */ } } };
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  }

  const Rec = {
    cache: store.get('recCache', {}),      // track path → {t, m: meta, n: [similar], s: [playlists]} or playlist path → {t, n: [tracks]}
    no: new Set(store.get('recNo', [])),   // tracks hidden with ✕
    noArtist: store.get('recNoArtist', {}),// artist → times hidden
    seen: store.get('recSeen', {}),        // track → times shown without being taken
    lists: {},                             // playlist id → {state, pool, page, why, at}
    dirty: false,

    save() {
      if (!this.dirty) return;
      const keys = Object.keys(this.cache);
      if (keys.length > 600) keys.sort((a, b) => this.cache[a].t - this.cache[b].t).slice(0, keys.length - 600).forEach((k) => delete this.cache[k]);
      const seen = Object.keys(this.seen);
      if (seen.length > 3000) seen.slice(0, seen.length - 3000).forEach((k) => delete this.seen[k]);
      store.set('recCache', this.cache);
      store.set('recNo', [...this.no].slice(-3000));
      store.set('recNoArtist', this.noArtist);
      store.set('recSeen', this.seen);
      this.dirty = false;
    },

    // SoundCloud page → {m: the page's own track, lists: [[{path, title, artist}]]}
    parse(html) {
      const out = { m: null, lists: [] };
      const h = /window\.__sc_hydration = (\[[\s\S]*?\]);<\/script>/.exec(html);
      if (h) {
        try {
          const s = (JSON.parse(h[1]).find((x) => x.hydratable === 'sound') || {}).data;
          if (s && s.permalink_url) {
            const tags = [];
            String(s.tag_list || '').replace(/"([^"]+)"|(\S+)/g, (_, a, b) => { tags.push((a || b).toLowerCase()); });
            if (s.genre) tags.push(String(s.genre).toLowerCase());
            out.m = {
              id: s.id, path: scPath(s.permalink_url), t: s.title || '', a: (s.user && s.user.username) || '',
              art: s.artwork_url || (s.user && s.user.avatar_url) || '', d: s.duration || 0,
              tags: [...new Set(tags.flatMap((t) => [t].concat(t.includes(' ') ? t.split(/\s+/) : [])).filter((t) => t.length > 1))].slice(0, 24),
              p: s.playback_count || 0, l: s.likes_count || 0, snip: s.policy === 'SNIP' || s.policy === 'BLOCK',
            };
          }
        } catch (e) { /* page without data */ }
      }
      const re = /<section>\s*<h2>[^<]*<\/h2>([\s\S]*?)<\/section>/g;
      let sec;
      while ((sec = re.exec(html))) {
        const doc = new DOMParser().parseFromString(sec[1], 'text/html');
        out.lists.push([...doc.querySelectorAll('article')].map((a) => {
          const links = a.querySelectorAll('a');
          return links[0] ? { path: links[0].getAttribute('href') || '', title: links[0].textContent.trim(), artist: links[1] ? links[1].textContent.trim() : '' } : null;
        }).filter((x) => x && x.path.startsWith('/')));
      }
      return out;
    },

    async fetchPage(url) {
      const r = await http({ url });
      if (r.status !== 200) throw new Error('page ' + r.status);
      return this.parse(r.body);
    },

    // a track: its metadata and its similar tracks (one request, cached for 3 days)
    async track(path) {
      const k = pathKey(path), c = this.cache[k];
      if (c && c.m !== undefined && Date.now() - c.t < 3 * 864e5) return c;
      const x = await this.fetchPage(SC_ORIGIN + path + '/recommended');
      const v = { t: Date.now(), m: x.m, n: (x.lists[0] || []).filter((y) => scPath(y.path)) };
      this.cache[k] = v; this.dirty = true;
      return v;
    },

    // tracks that share people's playlists with this one (the first two playlists, cached for a week)
    async playlistsWith(path) {
      const k = pathKey(path) + '#sets', c = this.cache[k];
      if (c && Date.now() - c.t < 7 * 864e5) return c.n;
      const sets = ((await this.fetchPage(SC_ORIGIN + path + '/sets')).lists[0] || []).slice(0, 2);
      const n = [];
      for (const s of sets) {
        try {
          const pl = await this.fetchPage(SC_ORIGIN + s.path);
          (pl.lists[0] || []).forEach((y) => { if (scPath(y.path) && pathKey(y.path) !== pathKey(path)) n.push(y); });
        } catch (e) { /* skip that playlist */ }
      }
      this.cache[k] = { t: Date.now(), n }; this.dirty = true;
      return n;
    },

    plays() {
      const out = {};
      const add = (d) => { for (const k in d.tracks) { const p = scPath(k); if (p) out[pathKey(p)] = (out[pathKey(p)] || 0) + d.tracks[k].p; } };
      for (const k in Stats.data.days) add(Stats.data.days[k]);
      add(Stats.data.old);
      return out;
    },

    seeds(p, plays) {
      const n = p.tracks.length;
      let list = p.tracks.map((it, i) => ({ it, path: scPath(it.permalink || it.url), i })).filter((x) => x.path);
      let fromTop = false;
      if (!list.length) {
        // empty playlist: what you listen to most
        fromTop = true;
        list = Object.keys(plays).filter((k) => plays[k] > 0).sort((a, b) => plays[b] - plays[a]).slice(0, 16).map((k, i) => {
          const meta = Object.keys(Stats.data.meta).map((m) => Stats.data.meta[m]).find((m) => pathKey(scPath(m.u)) === k) || {};
          return { it: { title: meta.t || k, artist: meta.a || '' }, path: scPath(meta.u) || k, i: 16 - i };
        });
      }
      list.forEach((x) => { x.w = 1 + (fromTop ? 0.4 : 0.8 * x.i / Math.max(1, n - 1)) + 0.45 * Math.log1p(plays[pathKey(x.path)] || 0); });
      // jitter: each refresh looks from slightly different seeds
      const ranked = list.map((x) => ({ x, r: x.w * (0.75 + Math.random() * 0.5) })).sort((a, b) => b.r - a.r).map((y) => y.x);
      const perArtist = {}, out = [];
      for (const x of ranked) {
        const a = (x.it.artist || '').toLowerCase();
        if ((perArtist[a] || 0) >= 2) continue;
        perArtist[a] = (perArtist[a] || 0) + 1;
        out.push(x);
        if (out.length >= 12) break;
      }
      for (const x of ranked) { if (out.length >= Math.min(12, ranked.length)) break; if (!out.includes(x)) out.push(x); }
      return { seeds: out, fromTop };
    },

    async build(p) {
      const plays = this.plays();
      const { seeds, fromTop } = this.seeds(p, plays);
      if (!seeds.length) return { pool: [], fromTop, none: true };
      const inList = new Set(p.tracks.map((it) => pathKey(scPath(it.permalink || it.url))).filter(Boolean));
      const inSongs = new Set(p.tracks.map((it) => songKey(it.artist, it.title)));
      const inCores = new Set(p.tracks.map((it) => songCore(it.title)).concat(p.tracks.map((it) => songWords(it.title))));
      seeds.forEach((s) => inList.add(pathKey(s.path)));

      // 1. seeds: their similar tracks and their metadata (the playlist's sound)
      await pool(seeds, 4, async (s) => { s.page = await this.track(s.path); });
      const prof = {}, durs = [];
      let profW = 0;
      seeds.forEach((s) => {
        const m = s.page && s.page.m;
        if (!m) return;
        m.tags.forEach((t) => { prof[t] = (prof[t] || 0) + s.w; });
        profW += s.w;
        if (m.d) durs.push(m.d);
      });
      for (const t in prof) prof[t] /= profW || 1;
      durs.sort((a, b) => a - b);
      const medDur = durs.length ? durs[durs.length >> 1] : 0;

      const C = new Map();
      const cand = (y) => {
        const k = pathKey(y.path);
        if (inList.has(k) || this.no.has(k) || inSongs.has(songKey(y.artist, y.title)) || inCores.has(songCore(y.title)) || inCores.has(songWords(y.title))) return null;
        let c = C.get(k);
        if (!c) C.set(k, (c = { k, path: scPath(y.path), title: y.title, artist: y.artist, s: 0, from: new Map(), co: new Set(), mutual: 0, near: 0 }));
        return c;
      };
      seeds.forEach((s) => (s.page ? s.page.n : []).forEach((y, r) => {
        const c = cand(y);
        if (!c) return;
        const v = s.w / (1 + 0.2 * r);
        c.s += v;
        c.from.set(s, Math.max(c.from.get(s) || 0, v));
      }));

      // 2. people's playlists around the three strongest seeds
      const top3 = seeds.slice().sort((a, b) => b.w - a.w).slice(0, 3);
      await pool(top3, 3, async (s) => {
        (await this.playlistsWith(s.path)).forEach((y) => {
          const c = cand(y);
          if (!c || c.co.has(s)) return;
          c.co.add(s);
          c.s += 0.4 * s.w;
        });
      });

      // 3. agreement between seeds
      C.forEach((c) => { c.s *= 1 + 0.55 * (c.from.size + c.co.size - 1); });

      // 4. a closer look at the best 30
      const short = [...C.values()].sort((a, b) => b.s - a.s).slice(0, 30);
      const shortKeys = new Set(short.map((c) => c.k));
      await pool(short, 4, async (c) => { c.page = await this.track(c.path); });
      const out = [];
      short.forEach((c) => {
        const m = c.page && c.page.m;
        let f = 1;
        if (m) {
          if (m.snip) return;                                          // 30-second preview only
          if (medDur && medDur < 10 * 60000 && m.d > 20 * 60000) return; // a long mix among songs
          c.page.n.forEach((y) => {
            const k = pathKey(y.path);
            if (inList.has(k)) c.mutual++;
            else if (shortKeys.has(k)) c.near++;
          });
          f *= 1 + 0.35 * Math.min(c.mutual, 4) + 0.08 * Math.min(c.near, 5);
          if (m.tags.length && profW) {
            const sim = Math.min(1.4, m.tags.reduce((a, t) => a + (prof[t] || 0), 0) / Math.sqrt(m.tags.length));
            f *= 0.7 + 0.45 * sim;
          } else f *= 0.92;
          if (medDur && m.d) { const lr = Math.log(m.d / medDur); f *= 0.55 + 0.45 * Math.exp(-(lr * lr) / 0.72); }
          f /= 1 + 0.07 * Math.max(0, Math.log10(m.p + 1) - 5);          // megahits: a small discount
          if (m.p > 500 && m.p < 300000 && m.l / m.p > 0.025) f *= 1.1;   // loved by the few who found it
          c.title = m.t || c.title; c.artist = m.a || c.artist;
        } else f *= 0.8;
        const heard = plays[c.k] || 0;
        if (heard >= 3) f *= 0.45; else if (heard) f *= 0.8;
        f *= Math.pow(0.5, this.noArtist[(c.artist || '').toLowerCase()] || 0);
        f *= Math.pow(0.8, Math.min(this.seen[c.k] || 0, 4));
        c.score = c.s * f;
        out.push(c);
      });
      // one step further: the strongest picks' own neighbours fill up a small playlist's list
      // (already downloaded, no extra requests)
      if (out.length < 40) {
        out.slice().sort((a, b) => b.score - a.score).slice(0, 10).forEach((c) => (c.page ? c.page.n : []).forEach((y, r) => {
          if (C.has(pathKey(y.path))) return;
          const d = cand(y);
          if (!d) return;
          d.from.set({ it: { title: c.title }, hop: true }, 1);
          d.score = c.score * 0.3 / (1 + 0.2 * r) * Math.pow(0.8, Math.min(this.seen[d.k] || 0, 4)) *
            Math.pow(0.5, this.noArtist[(d.artist || '').toLowerCase()] || 0) * ((plays[d.k] || 0) >= 3 ? 0.45 : 1);
          out.push(d);
        }));
      }
      out.sort((a, b) => b.score - a.score);
      this.save();
      // one upload per song: the best-ranked version stays, other speed-ups and re-uploads go
      const cores = new Set();
      for (let i = 0; i < out.length; i++) {
        const core = songCore(out[i].title), words = songWords(out[i].title);
        if (inCores.has(core) || cores.has(core) || (words && (inCores.has(words) || cores.has(words)))) out.splice(i--, 1);
        else { cores.add(core); if (words) cores.add(words); }
      }

      // 5. variety: pages of 8 with at most 2 tracks of an artist each
      const pageSize = 8, list = [], left = out.slice();
      while (left.length) {
        const page = [], per = {};
        for (let i = 0; i < left.length && page.length < pageSize; ) {
          const a = (left[i].artist || '').toLowerCase();
          if ((per[a] || 0) >= 2) { i++; continue; }
          per[a] = (per[a] || 0) + 1;
          page.push(left.splice(i, 1)[0]);
        }
        if (!page.length) page.push(...left.splice(0, pageSize));
        list.push(...page);
      }
      return { pool: list.map((c) => this.item(c)), fromTop };
    },

    item(c) {
      const m = (c.page && c.page.m) || {};
      const from = [...c.from.entries()].sort((a, b) => b[1] - a[1]), why = from.map((e) => shortTitle(e[0].it.title));
      let reason = why.length
        ? (from[0][0].hop ? 'рядом с «' : 'как «') + why[0] + '»' + (why.length > 1 ? ' и ещё ' + (why.length - 1) : '')
        : 'в плейлистах с «' + shortTitle([...c.co][0].it.title) + '»';
      if (c.mutual >= 2) reason += ' · взаимно';
      return {
        id: m.id || 'sc:' + c.k, title: c.title, artist: c.artist, art: m.art || '', dur: m.d || 0,
        url: SC_ORIGIN + c.path, permalink: SC_ORIGIN + c.path, why: reason, k: c.k, path: c.path, full: !!m.t,
      };
    },

    // the list for a playlist page: built once, refreshed on demand
    get(p) {
      let r = this.lists[p.id];
      if (!r) r = this.lists[p.id] = { state: 'idle', pool: [], page: 0 };
      if (r.state === 'idle' || (r.state === 'ready' && Date.now() - r.at > 30 * 60000)) {
        r.state = 'queued';
        setTimeout(() => this.run(p), 0);
      }
      return r;
    },
    shown(p) {
      const r = this.lists[p.id];
      if (!r || !r.pool.length) return [];
      const have = new Set(p.tracks.map((it) => pathKey(scPath(it.permalink || it.url))));
      r.pool = r.pool.filter((x) => !have.has(x.k) && !this.no.has(x.k));
      const pages = Math.max(1, Math.ceil(r.pool.length / 8));
      r.page %= pages;
      return r.pool.slice(r.page * 8, r.page * 8 + 8);
    },
    async run(p, again) {
      const r = this.lists[p.id] || (this.lists[p.id] = { pool: [], page: 0 });
      if (r.state === 'loading') return;
      if (again) this.shown(p).forEach((x) => { this.seen[x.k] = (this.seen[x.k] || 0) + 1; this.dirty = true; });
      r.state = 'loading';
      redrawRec(p);
      try {
        const x = await this.build(p);
        Object.assign(r, { state: x.none ? 'none' : x.pool.length ? 'ready' : 'empty', pool: x.pool, page: 0, fromTop: x.fromTop, at: Date.now() });
      } catch (e) {
        r.state = 'error';
      }
      redrawRec(p);
    },
    async fill(p, items) {
      const todo = items.filter((x) => !x.full && !x.filling);
      if (!todo.length) return;
      todo.forEach((x) => { x.filling = true; });
      let drop = false;
      await pool(todo, 4, async (x) => {
        const m = (await this.track(x.path)).m;
        x.full = true;
        if (!m) return;
        if (m.snip) { x.snip = true; drop = true; return; }
        Object.assign(x, { id: m.id || x.id, title: m.t || x.title, artist: m.a || x.artist, art: m.art || '', dur: m.d || 0 });
      });
      const r = this.lists[p.id];
      if (drop && r) r.pool = r.pool.filter((x) => !x.snip);
      this.save();
      redrawRec(p);
    },
    more(p) {
      const r = this.lists[p.id];
      if (!r) return;
      this.shown(p).forEach((x) => { this.seen[x.k] = (this.seen[x.k] || 0) + 1; });
      this.dirty = true; this.save();
      r.page++;
      if (r.page * 8 >= r.pool.length) { this.run(p); return; }  // pool used up: look again
      redrawRec(p);
    },
    hide(p, k) {
      const r = this.lists[p.id], it = r && r.pool.find((x) => x.k === k);
      this.no.add(k);
      if (it && it.artist) { const a = it.artist.toLowerCase(); this.noArtist[a] = (this.noArtist[a] || 0) + 1; }
      this.dirty = true; this.save();
      redrawRec(p);
    },
  };
  addEventListener('pagehide', () => Rec.save());

  // the queue gets them too (any SoundCloud playlist, likes, artist): seeded by its tracks
  function queueRecList() {
    if (!S.source || S.source.kind === 'rec' || !S.queue.some((it) => scPath(it.permalink || it.url))) return null;
    return { id: 'q:' + (S.source.url || ''), name: S.source.title || '', tracks: S.queue, queue: true };
  }
  function recView() {
    if (S.tab === 'library' && S.libView) { const p = Lib.get(S.libView); return p && !p.files ? p : null; }
    return S.tab === 'queue' ? queueRecList() : null;
  }
  function redrawRec(p) {
    const v = recView();
    if (!v || v.id !== p.id) return;
    const box = el.list.querySelector('.rec');
    if (box) box.outerHTML = recHTML(p); else renderList();
    markCurrentRow(true);
  }

  // a ready-made list of tracks (own playlist, stats top) plays track by track in the widget
  function playItems(items, i, src) {
    if (!items.length) return;
    ++loadSeq;
    S.source = src;
    S.queueSrc = src.url;
    S.queue = items.map((x) => Object.assign({}, x, { partial: false }));
    S.mode = 'single';
    S.history = [];
    S.pendingSkip = null;
    S.index = -1;
    renderCounts();
    playIndex(clamp(i, 0, items.length - 1));
  }
  function openLocal(p, i) {
    if (!p.tracks.length) { toast('Плейлист пока пуст'); return; }
    playItems(p.tracks, i, { kind: 'local', title: p.name, url: 'local:' + p.id });
  }

  async function playLink(raw) {
    setLoading(true);
    try {
      const src = await resolveSource(raw);
      if (!src) { setLoading(false); toast('Это не похоже на ссылку SoundCloud', true); return; }
      await openSource(src);
    } catch (e) {
      setLoading(false);
      toast(e.message || 'Не удалось открыть ссылку', true);
    }
  }
  const playDemo = () => playLink('https://soundcloud.com/forss/sets/soulhack');

  // ── clipboard ─────────────────────────────────────────────
  async function onClipboard(text, force) {
    const raw = findScUrl(text);
    if (!raw) { if (force) toast('В буфере нет ссылки SoundCloud'); return; }
    if (force) { handleLink(raw); return; }
    const key = cleanUrl(raw);
    if (key === store.get('clipSeen', '') || (S.source && S.source.url === key)) return;
    store.set('clipSeen', key);
    showLinkCard(raw, true);
  }

  // A pasted or typed link. With nothing playing it simply plays; otherwise a card asks what to
  // do, so a single track never wipes the queue: play it now, put it in the queue or a playlist.
  let card = null;                       // {src, item} of the link on the card
  function handleLink(raw) {
    if (!S.queue.length) { hideClip(); playLink(raw); return; }
    showLinkCard(raw, false);
  }
  const cardBtn = (act, icon, label, primary) =>
    '<button class="btn sm' + (primary ? ' primary' : '') + '" data-card="' + act + '"><svg><use href="#' + icon + '"/></svg>' + label + '</button>';
  async function showLinkCard(raw, fromClipboard) {
    const c = card = { src: null, item: null };
    el.clipKind.textContent = fromClipboard ? 'Ссылка из буфера' : 'Ссылка';
    el.clipTitle.textContent = prettyFromUrl(cleanUrl(raw));
    el.clipActs.innerHTML = '<span class="clip-wait">Смотрю ссылку…</span>';
    el.clip.hidden = false;
    let src = null;
    try { src = await resolveSource(raw); } catch (e) { /* below */ }
    if (card !== c) return;
    if (!src) { hideClip(); toast('Не удалось открыть ссылку', true); return; }
    c.src = src;
    el.clipTitle.textContent = src.title + (src.kind === 'track' && src.author ? ' · ' + src.author : '');
    if (src.kind === 'track') {
      el.clipKind.textContent = (fromClipboard ? 'Трек из буфера' : 'Трек');
      c.item = srcTrack(src);
      el.clipActs.innerHTML = cardBtn('now', 'i-play', 'Играть', true) + cardBtn('queue', 'i-list', 'В очередь') + cardBtn('playlist', 'i-plus', 'В плейлист');
      const path = scPath(src.url);
      if (path) {
        Rec.track(path).then((x) => {
          const m = x.m;
          if (m && c.item) Object.assign(c.item, { id: m.id || '', title: m.t || c.item.title, artist: m.a || c.item.artist, art: m.art || c.item.art, dur: m.d || 0, preview: m.snip, lite: false });
        }).catch(() => { /* the widget fills it in on play */ });
      }
    } else {
      el.clipKind.textContent = (KIND[src.kind] || 'Ссылка').toLowerCase().replace(/^./, (x) => x.toUpperCase()) + (fromClipboard ? ' из буфера' : '');
      el.clipActs.innerHTML = cardBtn('open', 'i-play', 'Играть', true) + (Lib.isSaved(src.url) ? '' : cardBtn('save', 'i-plus', 'В библиотеку'));
    }
  }
  const hideClip = () => { el.clip.hidden = true; card = null; };
  el.clip.addEventListener('click', (e) => {
    const b = e.target.closest('[data-card]');
    if (!b || !card || !card.src) return;
    const c = card;
    switch (b.dataset.card) {
      case 'now': hideClip(); playTrackNow(c.item); break;
      case 'queue': hideClip(); queueInsert(c.item, false); break;
      case 'playlist': showAddMenu(b, c.item); break;   // the card goes once the track is added
      case 'open': hideClip(); openSource(c.src); break;
      case 'save': hideClip(); toast(Lib.pin(c.src) ? '«' + c.src.title + '» в библиотеке' : 'Уже есть в библиотеке'); if (S.tab === 'library') renderList(); renderCounts(); break;
      default: break;
    }
  });

  // ── cover hop on hits in the highs (hats, snares, claps) ──
  // Stepped at ~20 fps by its own short loop: a browser animation would run at 60 fps and
  // re-blur both glass panels every frame (that cost ~50% of a core on busy hi-hats).
  const Hop = (() => {
    const POWER = { off: 0, soft: 0.55, strong: 1 };
    const wrap = $('.art-wrap');
    let mode = store.get('beatMode', 'strong'), at = -1e9, pow = 0, raf = 0, last = 0, shown = true;
    function frame(now) {
      raf = 0;
      if (now - last < 48) { raf = requestAnimationFrame(frame); return; }
      last = now;
      const p = (now - at) / 240;
      if (p >= 1 || !shown) { wrap.style.transform = ''; return; }
      const k = (1 - p) * (1 - p);
      wrap.style.transform = 'translateY(' + (-7 * pow * k).toFixed(1) + 'px) scale(' + (1 + 0.025 * pow * k).toFixed(3) + ')';
      raf = requestAnimationFrame(frame);
    }
    return {
      // a frame from the host's tap: level and hit strength (0 = no hit)
      feed(level, hit) {
        const power = POWER[mode];
        if (!hit || !power || !shown || document.hidden) return;
        at = performance.now();
        pow = hit * power;
        if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
      },
      setShown(on) { shown = on; },
      setMode(m) { mode = m; store.set('beatMode', m); vizSync(); },
      get mode() { return mode; },
    };
  })();

  // hits come from the host only while they are wanted: cover hop on and music playing
  let vizOn = false;
  function vizSync() {
    const want = !!host && Hop.mode !== 'off' && S.playing;
    if (want === vizOn) return;
    vizOn = want;
    hostSend({ type: 'viz', on: want });
  }

  // ── rendering ─────────────────────────────────────────────
  let shownArt = null;
  function renderNow() {
    const it = S.queue[S.index];
    if (!it) {
      el.title.textContent = 'Ничего не играет';
      el.artist.textContent = 'Вставь ссылку SoundCloud справа';
      el.scLink.hidden = true;
      el.add.hidden = true;
      el.art.classList.add('empty');
      el.artImg.classList.remove('ok');
      shownArt = null;
      Accent.from('');
      document.title = 'Pedro';
      return;
    }
    el.title.textContent = it.partial ? 'Загружаю…' : it.title;
    if (!it.partial) {
      const card = { title: it.title, artist: it.artist, art: isFile(it) ? (it.art ? Files.cardArt(it.url.slice(5)) : '') : artUrl(it.art, 't500x500') };
      const key = JSON.stringify(card);
      if (key !== renderNow.sent) { renderNow.sent = key; hostSend(Object.assign({ type: 'track' }, card)); }
    }
    el.artist.textContent = it.artist;
    el.scLink.hidden = !it.permalink;
    el.add.hidden = !!it.partial;
    document.title = it.partial ? 'Pedro' : it.title + ' · ' + it.artist + ' — Pedro';
    const big = artUrl(it.art, 't500x500');
    if (big !== shownArt) {
      shownArt = big;
      Accent.from(big);
      el.artImg.classList.remove('ok');
      if (big) {
        el.art.classList.remove('empty');
        el.artImg.onload = () => { if (shownArt === big) el.artImg.classList.add('ok'); };
        el.artImg.onerror = () => { if (shownArt === big) el.art.classList.add('empty'); };
        el.artImg.src = big;
      } else {
        el.art.classList.add('empty');
      }
      el.art.classList.remove('pop'); void el.art.offsetWidth; el.art.classList.add('pop');
    }
  }

  function renderState() {
    el.body.classList.toggle('playing', S.playing);
    el.playIcon.setAttribute('href', S.playing ? '#i-pause' : '#i-play');
    const st = S.loading ? ['ЗАГРУЗКА', ''] : S.playing ? ['ИГРАЕТ', 'play'] : S.queue[S.index] ? ['ПАУЗА', 'pause'] : ['ГОТОВ', ''];
    el.sticker.textContent = st[0];
    el.sticker.className = 'sticker' + (st[1] ? ' ' + st[1] : '');
  }

  const setBar = (bar, p) => bar.style.setProperty('--p', clamp(p || 0, 0, 1).toFixed(4));
  function renderProgress() {
    if (S.dragging) return;
    const pos = currentPos();
    setBar(el.seek, S.dur ? pos / S.dur : 0);
    el.tCur.textContent = fmt(pos);
    el.tDur.textContent = fmt(S.dur);
  }
  function renderVolume() {
    setBar(el.vol, S.muted ? 0 : S.volume / 100);
    el.volIcon.setAttribute('href', S.muted || S.volume === 0 ? '#i-mute' : '#i-vol');
  }
  function renderModes() {
    el.shuffle.classList.toggle('on', S.shuffle);
    el.repeat.classList.toggle('on', S.repeat !== 'off');
    el.repeat.classList.toggle('one', S.repeat === 'one');
  }
  function renderCounts() {
    el.tabs.querySelectorAll('button').forEach((b) => {
      const n = b.dataset.tab === 'queue' ? S.queue.length : b.dataset.tab === 'library' ? Lib.playlists.length + Lib.saved.length : 0;
      const label = { queue: 'Очередь', library: 'Библиотека', profile: 'Профиль' }[b.dataset.tab];
      b.innerHTML = esc(label) + (n ? '<span class="count">' + n + '</span>' : '');
    });
  }

  function thumbHTML(url) {
    return url
      ? '<div class="thumb" style="background-image:url(&quot;' + esc(url) + '&quot;)"></div>'
      : '<div class="thumb none"><svg><use href="#i-disc"/></svg></div>';
  }
  // end: 'add' shows the add-to-playlist button on hover, 'rm' removes from the open own playlist
  function trackRow(it, i, cur, attr, end) {
    const btn = end === 'rm'
      ? '<button class="icon-btn" data-rm title="' + (S.libView === 'files' ? 'Удалить файл' : 'Убрать из плейлиста') + '"><svg><use href="#i-x"/></svg></button>'
      : end === 'rec'
      ? '<button class="icon-btn" data-rec-add title="Добавить в этот плейлист"><svg><use href="#i-plus"/></svg></button><button class="icon-btn" data-rec-no title="Не то: больше не предлагать"><svg><use href="#i-x"/></svg></button>'
      : (it.partial ? '' : '<button class="icon-btn" data-row-add title="В плейлист"><svg><use href="#i-plus"/></svg></button>') +
        (attr === 'data-i' ? '<button class="icon-btn" data-row-del title="' + esc(queueDelLabel()) + ' (Ctrl+Z — вернуть)"><svg><use href="#i-x"/></svg></button>' : '');
    const drag = !it.partial && ['data-i', 'data-pli', 'data-s', 'data-rec', 'data-w'].includes(attr) ? ' draggable="true"' : '';
    return '<div class="row' + (cur ? ' cur' : '') + (it.partial ? ' partial' : '') + '" ' + attr + '="' + i + '"' + drag + '>' +
      '<div class="num"><span class="num-n">' + (i + 1) + '</span><span class="eq"><i></i><i></i><i></i></span></div>' +
      thumbHTML(artUrl(it.art, 'large')) +
      '<div class="rt"><div class="t1">' + esc(it.partial ? '…' : it.title) + '</div>' +
      '<div class="t2">' + (it.preview ? '<b class="tag k-preview">30 СЕК</b>' : '') + '<span>' + esc(it.artist) + '</span>' + (it.why ? '<i class="why">' + esc(it.why) + '</i>' : '') + '</div></div>' +
      '<div class="row-end"><span class="dur">' + (it.dur ? fmt(it.dur) : '') + '</span><span class="row-acts">' + btn + '</span></div></div>';
  }
  const queueDelLabel = () => (sourceKeepsEdits() || sourcePlaylist() ? 'Убрать из «' + S.source.title + '»' : 'Убрать из очереди');
  function emptyHTML(icon, title, text, buttons) {
    return '<div class="empty-state"><div class="es-icon"><svg><use href="#' + icon + '"/></svg></div><h3>' + title + '</h3><p>' + text + '</p>' +
      (buttons ? '<div class="es-row">' + buttons + '</div>' : '') + '</div>';
  }
  function tileRow(attr, tile, icon, title, tag, sub, cur) {
    return '<div class="row lib' + (cur ? ' cur' : '') + '" ' + attr + '>' +
      '<div class="thumb tile t-' + tile + '"><svg><use href="#' + icon + '"/></svg></div>' +
      '<div class="rt"><div class="t1">' + esc(title) + '</div><div class="t2"><b class="tag k-' + tag + '">' + KIND[tag] + '</b><span>' + esc(sub) + '</span></div></div><span></span></div>';
  }

  // ── library tab: playlist tiles, own playlist page, recent sources ──
  const bgStyle = (url) => ' style="background-image:url(&quot;' + esc(url) + '&quot;)"';
  function coverHTML(url, icon) {
    return url ? '<div class="tile-cover"' + bgStyle(url) + '></div>' : '<div class="tile-cover hatch"><svg><use href="#' + (icon || 'i-disc') + '"/></svg></div>';
  }
  function collageHTML(arts) {
    const a = arts.filter(Boolean);
    if (a.length < 4) return coverHTML(a[0] ? artUrl(a[0], 't300x300') : '', 'i-list');
    return '<div class="tile-cover collage">' + a.slice(0, 4).map((u) => '<i' + bgStyle(artUrl(u, 'large')) + '></i>').join('') + '</div>';
  }
  const PLAY_PAUSE = '<svg class="ic-play"><use href="#i-play"/></svg><svg class="ic-pause"><use href="#i-pause"/></svg>';
  function tileHTML(attr, cover, title, sub, cur, extra) {
    return '<div class="tile-card' + (cur ? ' cur' : '') + '" ' + attr + '><div class="tile-box">' + cover +
      '<button class="tile-play" data-tile-play title="Играть / пауза">' + PLAY_PAUSE + '</button></div>' + (extra || '') +
      '<div class="tile-title">' + esc(title) + '</div><div class="tile-sub">' + esc(sub) + '</div></div>';
  }
  const plCover = (p) => (p.cover ? coverHTML(p.cover) : collageHTML(p.tracks.map((x) => x.art)));
  const myProfile = () => S.profile;

  // «Моя волна»: three mixes made from the local listening stats. «Любимое за месяц» is what
  // played most in 30 days, «Давно не слушал» is what you played a lot but not for a month,
  // «Новое для тебя» is recommendations around this month's favourites that you never played.
  const Wave = {
    NAMES: { fav: 'Любимое за месяц', old: 'Давно не слушал', fresh: 'Новое для тебя' },
    ICONS: { fav: 'i-heart', old: 'i-back', fresh: 'i-feed' },
    shown: {},                          // kind → the items on screen (clicks use these)
    fresh: store.get('waveFresh', null), // {day, items} — one new mix a day
    busy: false,
    tally() {
      const month = dayKey(new Date(Date.now() - 29 * 864e5)), out = {};
      const add = (d, day) => {
        for (const k in d.tracks) {
          const x = d.tracks[k], t = out[k] || (out[k] = { k, p: 0, ms: 0, mp: 0, mms: 0, last: '' });
          t.p += x.p; t.ms += x.ms;
          if (day >= month) { t.mp += x.p; t.mms += x.ms; }
          if (day > t.last) t.last = day;
        }
      };
      for (const day in Stats.data.days) add(Stats.data.days[day], day);
      add(Stats.data.old, '');
      return { list: Object.keys(out).map((k) => out[k]), month };
    },
    item(k) {
      const m = Stats.data.meta[k];
      if (!m || !m.t || !m.u) return null;
      if (isFile({ url: m.u })) return Files.playlist().tracks.find((x) => x.url === m.u) || null;  // a deleted file is out
      return { id: '', title: m.t, artist: m.a || '', art: m.art || '', dur: 0, url: m.u, permalink: /^https:\/\/soundcloud\.com\//.test(m.u) ? m.u : '' };
    },
    list(kind) {
      if (kind === 'fresh') return this.fresh && this.fresh.day === dayKey(new Date()) ? this.fresh.items : [];
      const { list, month } = this.tally();
      const pick = kind === 'fav'
        ? list.filter((t) => t.mp > 0 || t.mms >= 60000).sort((a, b) => b.mp - a.mp || b.mms - a.mms)
        : list.filter((t) => t.p >= 2 && t.last < month).sort((a, b) => b.p - a.p || b.ms - a.ms);
      return pick.map((t) => this.item(t.k)).filter(Boolean).slice(0, 50);
    },
    // new for you: the recommendations engine around this month's favourites, nothing already played
    async buildFresh(force) {
      if (this.busy || (!force && this.fresh && this.fresh.day === dayKey(new Date()))) return;
      let seeds = this.list('fav').filter((x) => x.permalink).slice(0, 15);
      if (seeds.length < 3) seeds = Stats.compute('all').top.map((t) => this.item(t.k)).filter((x) => x && x.permalink);
      if (!seeds.length) { this.fresh = { day: dayKey(new Date()), items: [] }; return; }
      this.busy = true;
      redrawWave('fresh');
      try {
        const x = await Rec.build({ id: 'wave-fresh', tracks: seeds });
        const plays = Rec.plays();
        const items = x.pool.filter((it) => !plays[it.k]).slice(0, 40);
        await pool(items.filter((it) => !it.full), 5, async (it) => {
          const m = (await Rec.track(it.path)).m;
          if (m) Object.assign(it, { id: m.id || it.id, title: m.t || it.title, artist: m.a || it.artist, art: m.art || '', dur: m.d || 0, full: true });
        });
        Rec.save();
        this.fresh = { day: dayKey(new Date()), items: items.map((it) => ({ id: it.id, title: it.title, artist: it.artist, art: it.art, dur: it.dur, url: it.url, permalink: it.permalink, why: it.why })) };
        store.set('waveFresh', this.fresh);
      } catch (e) {
        toast('Не получилось собрать подборку, SoundCloud не ответил', true);
      } finally {
        this.busy = false;
        redrawWave('fresh');
      }
    },
    play(kind, i) {
      const items = this.shown[kind] || this.list(kind);
      if (!items.length) { if (kind === 'fresh') this.buildFresh().then(() => { if (this.list('fresh').length) this.play('fresh', i); }); return; }
      playItems(items, i || 0, { kind: 'wave', title: this.NAMES[kind], url: 'wave:' + kind });
    },
  };
  function redrawWave(kind) {
    if (S.tab !== 'library') return;
    if (!S.libView || S.libView === 'wave:' + kind) { const top = el.list.scrollTop; renderList(); el.list.scrollTop = top; markCurrentRow(true); followCur(); }
  }
  function waveHTML() {
    const kinds = ['fav', 'old', 'fresh'], srcUrl = S.source ? S.source.url : '';
    const tiles = kinds.map((k) => {
      const items = Wave.list(k);
      if (k !== 'fresh' && !items.length) return '';
      const cover = items.some((x) => x.art) ? collageHTML(items.map((x) => x.art))
        : '<div class="tile-cover dark"><svg><use href="#' + Wave.ICONS[k] + '"/></svg></div>';
      const sub = k === 'fresh' && !items.length ? (Wave.busy ? 'собираю…' : 'подборка дня') : tracksWord(items.length);
      return tileHTML('data-wave="' + k + '"', cover, Wave.NAMES[k], sub, srcUrl === 'wave:' + k);
    }).filter(Boolean);
    if (!Stats.compute('all').plays) return '';
    return '<div class="sec-head"><span>Моя волна</span><span>по твоей статистике</span></div><div class="tiles">' + tiles.join('') + '</div>';
  }
  function wavePageHTML(kind) {
    const items = Wave.shown[kind] = Wave.list(kind);
    const here = S.source && S.source.url === 'wave:' + kind;
    const cover = items.some((x) => x.art) ? collageHTML(items.map((x) => x.art)) : '<div class="tile-cover dark"><svg><use href="#' + Wave.ICONS[kind] + '"/></svg></div>';
    const about = { fav: 'то, что ты больше всего слушал за 30 дней', old: 'то, что ты слушал часто, но не включал больше месяца', fresh: 'похожее на твоё любимое за месяц, чего ты ещё не слышал' }[kind];
    let h = '<button class="link-btn pl-back" data-act="lib-back"><svg><use href="#i-back"/></svg>Библиотека</button><div class="pl-top"><div class="pl-cover">' + cover + '</div><div class="pl-info">' +
      '<b>' + esc(Wave.NAMES[kind]) + '</b><small>' + esc(items.length ? tracksWord(items.length) + totalOf(items) + ' · ' + about : about) + '</small><div class="pl-actions">' +
      '<button class="btn primary sm src-play' + (here ? ' cur' : '') + '" data-act="wave-play">' + PLAY_PAUSE + '<span class="ic-play">Играть</span><span class="ic-pause">Пауза</span></button>' +
      '<button class="btn sm" data-act="wave-shuffle"><svg><use href="#i-shuffle"/></svg>Вперемешку</button>' +
      (kind === 'fresh' ? '<button class="icon-btn" data-act="wave-refresh" title="Собрать заново"' + (Wave.busy ? ' disabled' : '') + '><svg><use href="#i-repeat"/></svg></button>' : '') +
      '</div></div></div>';
    if (!items.length) {
      if (kind === 'fresh') { if (!Wave.busy) setTimeout(() => Wave.buildFresh(), 0); return h + '<div class="note">Собираю подборку по твоему любимому за месяц…</div>' + [0, 1, 2].map((i) => trackRow({ partial: true }, i, false, 'data-skel')).join(''); }
      return h + '<div class="note">Пока пусто: слушай музыку, и подборка соберётся сама.</div>';
    }
    return h + '<div class="note">Перетащи трек на плейлист внизу, чтобы сохранить его.</div>' + items.map((it, i) => trackRow(it, i, here && isCur(it), 'data-w', 'add')).join('');
  }

  function libraryHTML() {
    if (S.libView && S.libView.startsWith('wave:')) return wavePageHTML(S.libView.slice(5));
    if (S.libView && S.libView.startsWith('src:') && S.libSrc) return sourcePageHTML(S.libSrc);
    if (S.libView && Lib.get(S.libView)) return playlistPageHTML(Lib.get(S.libView));
    S.libView = null;
    const srcUrl = S.source ? S.source.url : '';
    let h = waveHTML() + '<div class="sec-head"><span>Плейлисты</span><span class="sec-actions">' +
      '<button class="chip-btn dark" data-act="lib-create"><svg><use href="#i-plus"/></svg>Создать</button>' +
      '<button class="chip-btn" data-act="files-add" title="Загрузить mp3 с компьютера (Ctrl+O)"><svg><use href="#i-upload"/></svg>MP3</button>' +
      '<button class="chip-btn" data-act="lib-link"><svg><use href="#i-link"/></svg>По ссылке</button></span></div>';
    if (S.libForm) {
      const create = S.libForm === 'create';
      h += '<form class="lib-form" data-form="' + S.libForm + '"><input name="v" placeholder="' + (create ? 'Название плейлиста' : 'Ссылка на плейлист, альбом, артиста или лайки') +
        '" spellcheck="false" autocomplete="off"><button class="btn primary sm">' + (create ? 'Создать' : 'Добавить') + '</button>' +
        '<button class="btn sm" type="button" data-act="lib-form-cancel">Отмена</button></form>';
    }
    const tiles = [];
    const fp = Files.playlist();
    tiles.push(tileHTML('data-local="files"', fp.tracks.some((x) => x.art) ? plCover(fp) : '<div class="tile-cover dark"><svg><use href="#i-upload"/></svg></div>',
      fp.name, fp.tracks.length ? tracksWord(fp.tracks.length) : 'загрузи с компьютера', srcUrl === 'local:files'));
    const me = myProfile();
    if (me && me.url) {
      tiles.push(tileHTML('data-acc="likes"', '<div class="tile-cover dark"><svg><use href="#i-heart"/></svg></div>', 'Мои лайки',
        me.likes ? tracksWord(me.likes) : 'SoundCloud', srcUrl === me.url + '/likes'));
    }
    Lib.playlists.forEach((p) => tiles.push(tileHTML('data-local="' + p.id + '"', plCover(p), p.name,
      'мой · ' + tracksWord(p.tracks.length), srcUrl === 'local:' + p.id)));
    Lib.saved.forEach((s, i) => tiles.push(tileHTML('data-saved="' + i + '"', coverHTML(s.thumb), s.title,
      (KIND[s.kind] || '').toLowerCase() + (s.author && s.kind !== 'likes' ? ' · ' + s.author : ''), srcUrl === s.url,
      '<button class="icon-btn tile-del" data-unpin="' + i + '" title="Убрать из библиотеки"><svg><use href="#i-x"/></svg></button>')));
    h += tiles.length > 1 ? '<div class="tiles">' + tiles.join('') + '</div>'
      : '<div class="tiles">' + tiles.join('') + '</div><div class="note">Создай свой плейлист, добавь плейлист SoundCloud по ссылке или загрузи свои mp3 (можно просто перетащить файлы в окно).</div>';

    h += '<div class="sec-head"><span>Недавнее</span>' + (S.library.length ? '<button class="link-btn" data-act="recent-clear">Очистить</button>' : '') + '</div>';
    if (!S.library.length) {
      h += '<div class="note">Здесь появится всё, что ты включаешь по ссылке. <button class="link-btn" data-act="demo">Демо-плейлист</button></div>';
    } else {
      h += S.library.slice(0, 12).map((src, i) =>
        '<div class="row lib k-' + esc(src.kind) + (srcUrl === src.url ? ' cur' : '') + '" data-lib="' + i + '">' + thumbHTML(src.thumb) +
        '<div class="rt"><div class="t1">' + esc(src.title) + '</div><div class="t2"><b class="tag k-' + esc(src.kind) + '">' + (KIND[src.kind] || '') +
        '</b><span>' + esc(src.kind === 'likes' ? '' : src.author) + '</span></div></div><span>' +
        (src.kind === 'track' ? '<button class="icon-btn del" data-row-add title="В плейлист"><svg><use href="#i-plus"/></svg></button>'
          : Lib.isSaved(src.url) ? '' : '<button class="icon-btn del" data-pin-recent="' + i + '" title="Сохранить в библиотеку"><svg><use href="#i-plus"/></svg></button>') +
        '<button class="icon-btn del" data-del="' + i + '" title="Убрать из недавних"><svg><use href="#i-x"/></svg></button></span></div>').join('');
    }
    return h;
  }

  // a SoundCloud list's page: its tracks are the queue (SoundCloud lists them only through the
  // player), so they show while it is the list playing
  function sourcePageHTML(src) {
    const here = !!S.source && S.source.url === src.url, loaded = here && S.queueSrc === src.url && S.queue.length > 0;
    const sub = [(KIND[src.kind] || '').toLowerCase(), src.kind === 'likes' ? '' : src.author, loaded ? tracksWord(S.queue.length) + totalOf(S.queue) : ''].filter(Boolean).join(' · ');
    let h = '<button class="link-btn pl-back" data-act="lib-back"><svg><use href="#i-back"/></svg>Библиотека</button><div class="pl-top"><div class="pl-cover">' +
      (src.kind === 'likes' ? '<div class="tile-cover dark"><svg><use href="#i-heart"/></svg></div>' : coverHTML(src.thumb)) + '</div><div class="pl-info">' +
      '<b>' + esc(src.title) + '</b><small>' + esc(sub) + '</small><div class="pl-actions">' +
      '<button class="btn primary sm src-play' + (loaded ? ' cur' : '') + '" data-act="src-play">' + PLAY_PAUSE + '<span class="ic-play">Играть</span><span class="ic-pause">Пауза</span></button>' +
      '<button class="btn sm" data-act="src-shuffle"><svg><use href="#i-shuffle"/></svg>Вперемешку</button>' +
      '<button class="icon-btn" data-act="src-open" title="Открыть на SoundCloud"><svg><use href="#i-cloud"/></svg></button>' +
      (src.kind === 'likes' ? '' : Lib.isSaved(src.url)
        ? '<button class="icon-btn" data-act="src-unsave" title="Убрать из библиотеки"><svg><use href="#i-trash"/></svg></button>'
        : '<button class="icon-btn" data-act="src-save" title="Сохранить в библиотеку"><svg><use href="#i-plus"/></svg></button>') +
      '</div></div></div>';
    if (!loaded) {
      return h + (here && S.loading ? '<div class="note">Загружаю треки…</div>' + [0, 1, 2].map((i) => trackRow({ partial: true }, i, false, 'data-skel')).join('')
        : '<div class="note">Нажми «Играть», и здесь появятся треки.</div>');
    }
    return h + queueRowsHTML();
  }
  // Search without API keys: SoundCloud's results page lists 10 tracks in its no-script part;
  // their details (artist, cover, length, 30-second previews) come from the tracks' own pages.
  const decodeHtml = (h) => new DOMParser().parseFromString(h, 'text/html').documentElement.textContent;
  let searchDraw = 0;
  function redrawSearch() {
    clearTimeout(searchDraw);
    searchDraw = setTimeout(() => { if (S.tab === 'search') { const top = el.list.scrollTop; renderList(); el.list.scrollTop = top; markCurrentRow(true); followCur(); } }, 120);
  }
  async function searchTracks(q, more) {
    const st = more && S.search && S.search.q === q ? S.search : (S.search = { q, items: [], offset: 0, seen: new Set(), state: 'loading', more: false });
    st.state = 'loading';
    if (more) redrawSearch();
    else { if (S.tab !== 'search') S.prevTab = S.tab; setTab('search'); }
    let found = [], hits = 0;
    try {
      const r = await http({ url: SC_ORIGIN + '/search/sounds?q=' + encodeURIComponent(q) + (st.offset ? '&offset=' + st.offset : '') });
      if (r.status !== 200) throw new Error('search ' + r.status);
      r.body.replace(/<li><h2><a href="([^"]+)">([\s\S]*?)<\/a><\/h2><\/li>/g, (_, href, title) => {
        hits++;
        const path = scPath(href);
        if (!path || st.seen.has(pathKey(path))) return '';
        st.seen.add(pathKey(path));
        found.push({ id: '', title: decodeHtml(title).trim(), artist: path.split('/')[1], art: '', dur: 0, url: SC_ORIGIN + path, permalink: SC_ORIGIN + path, path, lite: true });
        return '';
      });
    } catch (e) {
      if (S.search === st) { st.state = 'error'; redrawSearch(); }
      return;
    }
    if (S.search !== st) return;
    st.offset += 10;
    st.more = hits >= 10;
    st.items = st.items.concat(found);
    st.state = 'ready';
    redrawSearch();
    await pool(found, 5, async (x) => {
      const m = (await Rec.track(x.path)).m;
      if (m) Object.assign(x, { id: m.id || '', title: m.t || x.title, artist: m.a || x.artist, art: m.art || '', dur: m.d || 0, preview: m.snip, lite: false });
      if (S.search === st) redrawSearch();
    });
    Rec.save();
  }
  function closeSearch() {
    S.search = null;
    setTab(S.prevTab && S.prevTab !== 'search' ? S.prevTab : 'queue');
  }
  function searchHTML() {
    const st = S.search;
    if (!st) return '';
    let h = '<div class="sec-head"><span>Поиск · ' + esc(st.q) + '</span><span class="sec-actions"><button class="chip-btn" data-act="search-close" title="Закрыть поиск (Esc)"><svg><use href="#i-x"/></svg>Закрыть</button></span></div>';
    if (!st.items.length) {
      if (st.state === 'loading') return h + '<div class="note">Ищу на SoundCloud…</div>' + [0, 1, 2, 3].map((i) => trackRow({ partial: true }, i, false, 'data-skel')).join('');
      return h + '<div class="note">' + (st.state === 'error' ? 'SoundCloud не ответил.' : 'Ничего не нашлось.') + ' <button class="link-btn" data-act="websearch">Искать на soundcloud.com</button></div>';
    }
    h += '<div class="note">Клик включает трек, очередь при этом не пропадает. ＋ кладёт трек в плейлист, правый клик: в очередь и другое.</div>';
    h += st.items.map((it, i) => trackRow(it, i, isCur(it), 'data-s', 'add')).join('');
    return h + '<div class="search-foot">' + (st.more ? '<button class="btn sm" data-act="search-more"' + (st.state === 'loading' ? ' disabled>Загружаю…' : '>Ещё результаты') + '</button>' : '') +
      '<button class="link-btn" data-act="websearch">Открыть на soundcloud.com</button></div>';
  }

  function playSrcTrack(src) {
    const it = srcTrack(src);
    if (isCur(it)) togglePlay(); else playTrackNow(it);
  }
  function openSrcPage(src) {
    if (!src) return;
    if (src.kind === 'track') { playSrcTrack(src); return; }
    S.libView = 'src:' + src.url; S.libSrc = src; S.libForm = null;
    const here = S.source && S.source.url === src.url && S.queueSrc === src.url && S.queue.length;
    if (!here) openSource(src, { quiet: true });       // starts it; the library stays on screen
    else if (!S.playing) togglePlay();
    renderList();
    el.list.scrollTop = 0;
    markCurrentRow(true);
  }
  // ▶ on a tile: plays or pauses that list without leaving the grid
  function tilePlay(tile) {
    if (tile.dataset.acc) { openAccountItem(tile.dataset.acc); return; }
    if (tile.dataset.wave) {
      const k = tile.dataset.wave;
      if (S.source && S.source.url === 'wave:' + k && S.queue.length) togglePlay(); else Wave.play(k, 0);
      return;
    }
    if (tile.dataset.local) {
      const p = Lib.get(tile.dataset.local);
      if (!p) return;
      if (S.source && S.source.url === 'local:' + p.id && S.queue.length) togglePlay(); else openLocal(p, 0);
      return;
    }
    const src = Lib.saved[+tile.dataset.saved];
    if (!src) return;
    if (src.kind === 'track') { playSrcTrack(src); return; }
    if (S.source && S.source.url === src.url && S.queueSrc === src.url && S.queue.length) togglePlay(); else openSource(src, { quiet: true });
  }
  // a track on its own (from "Недавнее", search or a link): plays now, the queue stays and goes on after it
  function playTrackNow(it) {
    if (!it) return;
    if (!S.queue.length || S.index < 0) {
      const url = it.permalink || it.url;
      playItems([it], 0, { kind: 'track', title: it.title, author: it.artist, thumb: artUrl(it.art, 't300x300'), url, load: url });
      return;
    }
    const at = S.queue.findIndex((x) => sameTrack(x, it));
    if (at >= 0) { playIndex(at); return; }
    detachQueue();
    S.queue.splice(S.index + 1, 0, Object.assign({}, it, { partial: false }));
    afterQueueEdit();
    playIndex(S.index + 1);
  }
  const srcTrack = (src) => ({ id: '', title: src.title, artist: src.author || '', art: src.thumb || '', dur: 0, url: src.url, permalink: src.url, lite: true });
  function removeFromPlaylist(p, i) {
    const it = p.tracks.splice(i, 1)[0];
    Lib.save();
    // the same track leaves the queue too while this playlist plays (not the one playing now)
    if (it && S.source && S.source.url === 'local:' + p.id) {
      const qi = S.queue.findIndex((x) => sameTrack(x, it));
      if (qi >= 0 && qi !== S.index) { S.queue.splice(qi, 1); if (qi < S.index) S.index--; renderCounts(); }
    }
    renderList();
  }

  function playlistPageHTML(p) {
    const here = S.source && S.source.url === 'local:' + p.id;
    let h = '<button class="link-btn pl-back" data-act="lib-back"><svg><use href="#i-back"/></svg>Библиотека</button><div class="pl-top">' +
      (p.files ? '<div class="pl-cover">' + (p.tracks.some((x) => x.art) ? plCover(p) : '<div class="tile-cover dark"><svg><use href="#i-upload"/></svg></div>') + '</div>'
        : '<div class="pl-cover" data-act="pl-cover" title="Сменить обложку">' + plCover(p) + '</div>') + '<div class="pl-info">';
    h += S.renaming
      ? '<form class="lib-form" data-form="rename" style="margin:0 0 8px"><input name="v" value="' + esc(p.name) + '" spellcheck="false" autocomplete="off"><button class="btn primary sm">OK</button></form>'
      : '<b>' + esc(p.name) + '</b><small>' + (p.tracks.length ? tracksWord(p.tracks.length) + totalOf(p.tracks) : 'пока пусто') + '</small>';
    h += '<div class="pl-actions"><button class="btn primary sm" data-act="pl-play"><svg><use href="#i-play"/></svg>Играть</button>' +
      '<button class="btn sm" data-act="pl-shuffle"><svg><use href="#i-shuffle"/></svg>Вперемешку</button>' +
      (p.files ? '<button class="btn sm" data-act="files-add" title="Ctrl+O"><svg><use href="#i-upload"/></svg>Загрузить</button></div></div></div>'
        : '<button class="icon-btn" data-act="pl-rename" title="Переименовать"><svg><use href="#i-edit"/></svg></button>' +
      (S.confirmDel ? '<button class="icon-btn danger" data-act="pl-delete">Удалить?</button>'
        : '<button class="icon-btn" data-act="pl-delete" title="Удалить плейлист"><svg><use href="#i-trash"/></svg></button>') + '</div></div></div>');
    if (p.files) {
      h += p.tracks.length ? '<div class="note">Перетащи ещё файлы в окно или нажми «Загрузить». Файлы хранятся в Pedro на этом компьютере; ✕ удаляет файл.</div>'
        : '<div class="drop-zone" data-act="files-add"><svg><use href="#i-upload"/></svg><b>Перетащи mp3 сюда</b><span>или нажми, чтобы выбрать файлы. Подходят mp3, m4a, flac, wav, ogg</span></div>';
    } else {
      h += p.tracks.length ? '<div class="note">Порядок меняется перетаскиванием, правый клик открывает меню трека.</div>'
        : '<div class="note">Добавляй треки кнопкой ＋: у обложки, в очереди или в поиске.</div>';
    }
    return h + p.tracks.map((it, i) => trackRow(it, i, here && isCur(it), 'data-pli', 'rm')).join('') + (p.files ? '' : recHTML(p));
  }
  function recHTML(p) {
    const r = Rec.get(p), items = Rec.shown(p), busy = r.state === 'loading' || r.state === 'queued';
    const cur = S.source && S.source.url === 'rec:' + p.id ? S.queue[S.index] : null;
    let h = '<div class="rec' + (busy ? ' busy' : '') + (p.queue ? ' in-queue' : '') + '"><div class="sec-head"><span>Рекомендации</span><span class="sec-actions">' +
      (items.length && !busy ? '<button class="chip-btn" data-act="rec-more" title="Следующие треки"><svg><use href="#i-next"/></svg>Ещё</button>' : '') +
      '<button class="chip-btn" data-act="rec-refresh" title="Подобрать заново"' + (busy ? ' disabled' : '') + '><svg><use href="#i-repeat"/></svg>' + (busy ? 'Подбираю…' : 'Обновить') + '</button></span></div>';
    if (busy && !items.length) {
      h += '<div class="note">Слушаю плейлист и ищу похожее на SoundCloud…</div>' + [0, 1, 2].map((i) => trackRow({ partial: true }, i, false, 'data-skel')).join('');
    } else if (r.state === 'none') {
      h += '<div class="note">Добавь пару треков с SoundCloud, и здесь появится похожая музыка.</div>';
    } else if (!items.length) {
      h += '<div class="note">' + (r.state === 'error' ? 'SoundCloud не ответил.' : 'Ничего нового не нашлось.') + ' Нажми «Обновить».</div>';
    } else {
      h += '<div class="note">' + (r.fromTop ? 'Плейлист пуст, поэтому подбираю по тому, что ты слушаешь чаще всего. ' : '') +
        (p.queue ? 'Похожее на то, что в очереди. Клик включает трек следующим, ＋ ставит в конец очереди, ✕ убирает навсегда.'
          : '＋ добавляет трек сюда, ✕ убирает его навсегда. Чем больше треков в плейлисте, тем точнее подбор.') + '</div>';
      h += items.map((it, i) => trackRow(it, i, !!cur && cur.k === it.k, 'data-rec', 'rec')).join('');
      if (items.some((x) => !x.full)) setTimeout(() => Rec.fill(p, items), 0);
    }
    return h + '</div>';
  }

  // ── profile tab: your SoundCloud profile + listening stats ──
  function accountHTML() {
    const srcUrl = S.source ? S.source.url : '';
    if (S.profile && !S.profileEditing) {
      const p = S.profile;
      let h = '<div class="sec-head"><span>Мой SoundCloud</span><span><button class="link-btn" data-act="profile-edit">Сменить</button></span></div>';
      h += '<div class="acc-me"><div class="avatar"' + bgStyle(p.avatar) + '></div><div><b>' + esc(p.name) + '</b><small>профиль SoundCloud</small></div></div>';
      h += tileRow('data-acc="likes"', 'likes', 'i-heart', 'Мои лайки', 'likes', '', srcUrl === p.url + '/likes');
      h += tileRow('data-acc="tracks"', 'tracks', 'i-user', 'Мои треки', 'artist', '', srcUrl === p.url);
      return h;
    }
    let h = '<div class="acc-cta"><div class="acc-cta-top"><div class="es-icon"><svg><use href="#i-cloud"/></svg></div><div><b>Твой SoundCloud</b>' +
      '<p>Укажи свой профиль: лайки и твои треки будут всегда под рукой.</p></div></div>';
    h += S.profileEditing
      ? '<form class="acc-form" data-form="profile"><input name="p" placeholder="Ссылка на профиль или ник" spellcheck="false" autocomplete="off"><button class="btn primary sm">OK</button><button class="btn sm" type="button" data-act="profile-cancel">Отмена</button></form>'
      : '<div class="es-row"><button class="btn primary sm" data-act="profile-edit">Указать профиль</button></div>';
    return h + '</div>';
  }

  const PERIODS = [['week', 'Неделя'], ['month', 'Месяц'], ['year', 'Год'], ['all', 'Всё время']];
  function profileHTML() {
    const st = (S.lastStats = Stats.compute(S.statsPeriod));
    const since = Stats.data.since ? 'с ' + Stats.data.since.split('-').reverse().join('.') : '';
    let h = accountHTML() + '<div class="sec-head"><span>Статистика</span><span>' + since + (Stats.data.days && Object.keys(Stats.data.days).length ? '<button class="link-btn" data-act="stats-reset">Сбросить</button>' : '') + '</span></div>' +
      '<div class="tabs periods">' + PERIODS.map((p) => '<button data-period="' + p[0] + '"' + (S.statsPeriod === p[0] ? ' class="on"' : '') + '>' + p[1] + '</button>').join('') + '</div>';
    if (!st.ms) {
      return h + '<div class="note">За этот период пока пусто. Pedro считает прослушивания сам, на этом компьютере: включи музыку, и здесь появятся время, любимый трек и топы.</div>';
    }
    h += '<div class="stat-grid"><div class="stat dark"><b>' + fmtListen(st.ms) + '</b><small>время прослушивания</small></div>' +
      '<div class="stat"><b>' + st.unique + '</b><small>' + plural(st.unique, 'трек', 'трека', 'треков') + '</small></div>' +
      '<div class="stat"><b>' + st.plays + '</b><small>' + plural(st.plays, 'прослушивание', 'прослушивания', 'прослушиваний') + '</small></div></div>';
    if (st.fav) {
      h += '<div class="fav" data-top="0">' + thumbHTML(artUrl(st.fav.m.art, 't300x300')) + '<div><small>ЛЮБИМЫЙ ТРЕК</small><b>' + esc(st.fav.m.t) + '</b><span>' +
        esc(st.fav.m.a) + ' · ' + (st.fav.p ? st.fav.p + ' ' + plural(st.fav.p, 'раз', 'раза', 'раз') : fmtListen(st.fav.ms)) + '</span></div></div>';
    }
    h += '<div class="sec-head"><span>Топ треков</span><span>' + st.top.length + '</span></div>' + st.top.map((x, i) =>
      '<div class="row k-top" data-top="' + i + '"><div class="rank">' + (i + 1) + '</div>' + thumbHTML(artUrl(x.m.art, 'large')) +
      '<div class="rt"><div class="t1">' + esc(x.m.t) + '</div><div class="t2"><span>' + esc(x.m.a) + '</span></div></div>' +
      '<div class="dur">' + (x.p ? x.p + '×' : fmtListen(x.ms)) + '</div></div>').join('');
    return h;
  }

  const accSources = {};
  async function openAccountItem(kind, page) {
    const me = myProfile();
    if (!me || !me.url) { toast('Сначала укажи профиль во вкладке «Профиль»'); setTab('profile'); return; }
    const url = kind === 'likes' ? me.url + '/likes' : me.url;
    let src = accSources[url];
    if (!src) {
      try { src = accSources[url] = await resolveSource(url); } catch (e) { toast(e.message || 'Не удалось открыть профиль', true); return; }
      if (!src) return;
    }
    if (page) { openSrcPage(src); return; }
    if (S.source && S.source.url === src.url && S.queueSrc === src.url && S.queue.length) togglePlay(); else openSource(src, { quiet: true });
  }

  function renderList() {
    let html = '';
    if (S.tab === 'queue') {
      if (!S.queue.length) {
        html = emptyHTML('i-cloud', 'Вставь ссылку или загрузи mp3',
          'Трек, плейлист, альбом, профиль артиста или /likes: подходит всё, что открывается на soundcloud.com. Свои mp3 можно просто перетащить в окно.',
          '<button class="btn primary sm" data-act="paste"><svg><use href="#i-clip"/></svg>Из буфера</button><button class="btn sm" data-act="files-add"><svg><use href="#i-upload"/></svg>MP3</button><button class="btn sm" data-act="demo">Демо</button>');
      } else {
        html = queueRowsHTML();
      }
    } else if (S.tab === 'library') {
      html = libraryHTML();
    } else if (S.tab === 'profile') {
      html = profileHTML();
    } else if (S.tab === 'search') {
      html = searchHTML();
    }
    el.list.innerHTML = html;
    renderListHead();
    renderCounts();
    const input = el.list.querySelector('.lib-form input');
    if (input) { input.focus(); input.select(); }
  }

  function queueRowsHTML() {
    const q = queueRecList();
    return S.queue.map((it, i) => trackRow(it, i, i === S.index, 'data-i')).join('') + hiddenNoteHTML() + (q ? recHTML(q) : '');
  }
  function hiddenNoteHTML() {
    const n = sourceKeepsEdits() ? Edits.hiddenCount(S.source.url) : 0;
    return n ? '<div class="note hidden-note">' + tracksWord(n) + ' ты убрал из «' + esc(S.source.title) + '», здесь они не играют. ' +
      '<button class="link-btn" data-act="edits-restore">Вернуть</button></div>' : '';
  }

  function renderListHead() {
    let title = '', meta = '', extra = '';
    if (S.tab === 'queue' && S.queue.length) {
      title = S.source ? S.source.title : '';
      meta = (S.source && KIND[S.source.kind] ? KIND[S.source.kind] + ' · ' : '') + tracksWord(S.queue.length) + totalOf(S.queue);
      if (S.source && S.source.load && S.source.kind !== 'track' && !Lib.isSaved(S.source.url)) {
        extra = '<button class="chip-btn" data-act="save-src" title="Сохранить в библиотеку"><svg><use href="#i-plus"/></svg>В библиотеку</button>';
      }
    }
    el.listHead.innerHTML = title || meta ? '<div class="lh-title">' + esc(title) + '</div><div class="lh-meta">' + esc(meta) + '</div>' + extra : '';
    el.listHead.hidden = !(title || meta);
  }

  function markCurrentRow(stay) {
    const lib = S.tab === 'library' && S.libView && S.source;
    const local = lib && S.source.url === 'local:' + S.libView;
    const rec = lib && S.source.url === 'rec:' + S.libView;
    const search = S.tab === 'search' && S.search;
    const wave = lib && S.libView.startsWith('wave:') && S.source.url === S.libView;
    const attr = showsQueue() ? 'data-i' : local ? 'data-pli' : rec ? 'data-rec' : search ? 'data-s' : wave ? 'data-w' : null;
    el.list.querySelectorAll('.row.cur').forEach((r) => { if (!r.classList.contains('lib')) r.classList.remove('cur'); });
    if (!attr) return;
    let at = S.index;
    if (local) { const p = Lib.get(S.libView); at = p ? p.tracks.findIndex(isCur) : -1; }
    if (search) at = S.search.items.findIndex(isCur);
    if (wave) at = (Wave.shown[S.libView.slice(5)] || []).findIndex(isCur);
    if (rec) { const p = Lib.get(S.libView), it = S.queue[S.index]; at = p && it ? Rec.shown(p).findIndex((x) => x.k === it.k) : -1; }
    const row = el.list.querySelector('[' + attr + '="' + at + '"]');
    if (row) { row.classList.add('cur'); if (!stay) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); followUntil = performance.now() + 1500; } }
  }
  // A track change scrolls smoothly to its row, and the details that arrive a moment later redraw
  // the list, which put back the half-way scroll position and stopped there. Until the scroll
  // is done, a redraw carries it on to the current row.
  let followUntil = 0;
  el.list.addEventListener('wheel', () => { followUntil = 0; }, { passive: true });   // the user scrolls: let them
  function followCur() {
    if (performance.now() > followUntil) return;
    const row = el.list.querySelector('.row.cur:not(.lib)');
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setTab(tab) {
    S.tab = tab;
    el.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'profile') Stats.save();
    renderList();
    el.list.scrollTop = 0;
    markCurrentRow(tab !== 'queue');
  }

  // ── popover menu: add-to-playlist and right-click actions ──
  let menuItem = null, menuActions = [];
  // pos: an element (menu opens under it) or {x, y} from a right-click
  function placeMenu(pos) {
    el.menu.hidden = false;
    const mw = el.menu.offsetWidth, mh = el.menu.offsetHeight;
    let x, y;
    if (pos.nodeType) {
      const r = pos.getBoundingClientRect();
      x = r.right - mw;
      y = r.bottom + 6 + mh > innerHeight - 8 ? r.top - mh - 6 : r.bottom + 6;
    } else {
      x = pos.x;
      y = pos.y + mh > innerHeight - 8 ? pos.y - mh : pos.y;
    }
    el.menu.style.left = clamp(x, 8, innerWidth - mw - 8) + 'px';
    el.menu.style.top = clamp(y, 8, innerHeight - mh - 8) + 'px';
  }
  // items: {label, icon, run, danger} buttons, or {input, value, run} for an inline text field
  function showMenu(pos, title, items) {
    menuActions = items;
    el.menu.innerHTML = (title ? '<h4>' + esc(title) + '</h4>' : '') + items.map((it, i) => (it.input
      ? '<form data-mi="' + i + '"><input name="v" value="' + esc(it.value || '') + '" placeholder="' + esc(it.input) + '" spellcheck="false" autocomplete="off"><button class="btn primary sm">OK</button></form>'
      : '<button class="menu-item' + (it.danger ? ' danger' : '') + '" data-mi="' + i + '"><span>' +
        (it.icon ? '<svg><use href="#' + it.icon + '"/></svg>' : '') + esc(it.label) + '</span></button>')).join('');
    placeMenu(pos);
    const input = el.menu.querySelector('input');
    if (input && items.length === 1) { input.focus(); input.select(); }
  }
  function showAddMenu(pos, it) {
    if (!it || it.partial) { toast('Трек ещё загружается'); return; }
    menuItem = it;
    menuActions = [];
    el.menu.innerHTML = '<h4>Добавить в плейлист</h4>' +
      Lib.playlists.map((p) => '<button class="menu-item" data-to="' + p.id + '"><span>' + esc(p.name) + '</span><small>' + p.tracks.length + '</small></button>').join('') +
      scLists().map((x, i) => '<button class="menu-item" data-to-sc="' + i + '" title="SoundCloud не даёт менять плейлисты без входа: трек добавится в него внутри Pedro"><span>' + esc(x.title) + '</span><small>SoundCloud</small></button>').join('') +
      '<form data-form="menu-new"><input name="v" placeholder="Новый плейлист" spellcheck="false" autocomplete="off"><button class="btn primary sm" title="Создать и добавить"><svg><use href="#i-plus"/></svg></button></form>';
    placeMenu(pos);
    if (!Lib.playlists.length && !scLists().length) el.menu.querySelector('input').focus();
  }
  const scLists = () => Lib.saved.filter((x) => x.kind === 'playlist');
  function addToSoundCloudList(src) {
    const it = menuItem;
    hideMenu();
    if (!src || !it) return;
    if (card && card.item === it) hideClip();
    const here = S.source && S.source.url === src.url && S.queueSrc === src.url;
    const res = here && S.queue.some((x) => sameTrack(x, it)) ? 'dup' : Edits.add(src.url, it);
    toast(res === 'ok' ? 'Добавлено в «' + src.title + '» (в Pedro, на самом SoundCloud плейлист не меняется)' : 'Уже есть в «' + src.title + '»');
    if (res === 'ok' && here) {
      detachQueue();
      S.queue.push(Object.assign({}, it, { partial: false }));
      afterQueueEdit();
    }
  }
  const hideMenu = () => { el.menu.hidden = true; menuItem = null; };
  function addToPlaylist(p) {
    const it = menuItem;
    hideMenu();
    if (!p || !it) return;
    const res = Lib.add(p, it);
    if (card && card.item === it) hideClip();
    toast(res === 'ok' ? 'Добавлено в «' + p.name + '»' : res === 'dup' ? 'Уже есть в «' + p.name + '»' : 'Этот трек нельзя добавить', res === 'bad');
    if (S.tab === 'library') renderList();
    renderCounts();
  }
  el.menu.addEventListener('click', (e) => {
    const to = e.target.closest('[data-to]');
    if (to) { addToPlaylist(Lib.get(to.dataset.to)); return; }
    const toSc = e.target.closest('[data-to-sc]');
    if (toSc) { addToSoundCloudList(scLists()[+toSc.dataset.toSc]); return; }
    const b = e.target.closest('button[data-mi]');
    if (b) { const a = menuActions[+b.dataset.mi]; hideMenu(); a.run(); }
  });
  el.menu.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.mi != null) { const a = menuActions[+f.dataset.mi], v = f.elements.v.value; hideMenu(); a.run(v); }
    else addToPlaylist(Lib.create(f.elements.v.value));
  });
  document.addEventListener('mousedown', (e) => { if (!el.menu.hidden && !e.target.closest('#menu')) hideMenu(); }, true);
  el.add.onclick = () => showAddMenu(el.add, S.queue[S.index]);

  const copyText = (text) => navigator.clipboard.writeText(text).then(() => toast('Ссылка скопирована'), () => toast('Не удалось скопировать', true));
  const confirmMenu = (pos, question, label, run) =>
    showMenu(pos, question, [{ label, icon: 'i-trash', danger: true, run }, { label: 'Отмена', icon: 'i-back', run: () => {} }]);

  // ── editing the queue ─────────────────────────────────────
  // A list the widget holds (playlist, likes) becomes a plain track list once edited:
  // from then on every track is loaded on its own, in our order. Removals and the order of a
  // SoundCloud source are remembered (Edits); in an own playlist they change the playlist itself.
  function detachQueue() {
    if (S.mode === 'list') {
      S.mode = 'single';
      if (S.pendingSkip != null) S.needLoad = true; // the widget sits on another track than ours
      S.pendingSkip = null;
    }
    S.history = [];
  }
  const sourceIsSoundCloud = () => !!(S.source && S.source.load && S.source.url);
  const sourceKeepsEdits = () => sourceIsSoundCloud() && S.source.kind !== 'track';
  const sourcePlaylist = () => (S.source && S.source.kind === 'local' ? Lib.get(S.source.url.slice(6)) : null);
  function afterQueueEdit() {
    refreshQueueView();
    renderCounts();
    renderListHead();
    if (sourceIsSoundCloud()) store.set('last', { source: S.source, index: Math.max(0, S.index), key: S.queue[S.index] ? itemKey(S.queue[S.index]) : '' });
  }
  function rememberOrder() {
    if (sourceKeepsEdits()) {
      // removed tracks keep their slot in the saved order, so "Вернуть" puts them back in place
      const keys = S.queue.map(itemKey), inQueue = new Set(keys);
      const prev = (Edits.data[S.source.url] && Edits.data[S.source.url].order) || Array.from(S.known || []);
      prev.forEach((k, i) => { if (!inQueue.has(k)) keys.splice(Math.min(i, keys.length), 0, k); });
      Edits.setOrder(S.source.url, keys);
      return;
    }
    const p = sourcePlaylist();
    if (!p) return;
    const pos = new Map(S.queue.map((x, i) => [itemKey(x), i]));
    const at = (x) => (pos.has(itemKey(x)) ? pos.get(itemKey(x)) : 1e6);
    p.tracks.sort((a, b) => at(a) - at(b));
    Lib.save();
  }

  // Ctrl+Z brings back the last removed tracks
  const undoStack = [];
  function undoRemove() {
    const u = undoStack.pop();
    if (!u) { toast('Нечего возвращать'); return; }
    if (u.kind === 'local') {
      const p = Lib.get(u.sourceUrl.slice(6));
      if (p && !p.tracks.some((x) => itemKey(x) === itemKey(u.item))) { p.tracks.splice(Math.min(u.index, p.tracks.length), 0, u.item); Lib.save(); }
    } else if (u.sourceUrl) {
      Edits.unhide(u.sourceUrl, itemKey(u.item));
    }
    if (S.source && S.source.url === u.sourceUrl) {
      const at = Math.min(u.index, S.queue.length);
      S.queue.splice(at, 0, u.item);
      if (at <= S.index) S.index++;
      if (S.index < 0) S.index = 0;
      afterQueueEdit();
    } else if (S.tab === 'library') renderList();
    toast('«' + u.item.title + '» вернулся');
  }
  function queueInsert(it, next) {
    const copy = Object.assign({}, it, { partial: false });
    if (!S.queue.length) { playItems([copy], 0, { kind: 'track', title: it.title, url: '' }); return; }
    detachQueue();
    S.queue.splice(next ? S.index + 1 : S.queue.length, 0, copy);
    afterQueueEdit();
    toast(next ? 'Сыграет следующим' : 'Добавлено в конец очереди');
  }
  function queueMove(from, to) {
    if (from === to) return;
    detachQueue();
    const cur = S.queue[S.index];
    S.queue.splice(to, 0, S.queue.splice(from, 1)[0]);
    S.index = S.queue.indexOf(cur);
    rememberOrder();
    afterQueueEdit();
  }
  function queueRemove(i) {
    const item = S.queue[i];
    if (!item) return;
    detachQueue();
    const wasCur = i === S.index;
    // remember it: hidden from this SoundCloud list, or out of the own playlist for good
    const p = sourcePlaylist(), sc = sourceKeepsEdits();
    if (sc) Edits.hide(S.source.url, itemKey(item));
    if (p) { p.tracks = p.tracks.filter((x) => itemKey(x) !== itemKey(item)); Lib.save(); }
    undoStack.push({ sourceUrl: S.source ? S.source.url : '', kind: S.source ? S.source.kind : '', item, index: i });
    if (undoStack.length > 30) undoStack.shift();
    toast(sc || p ? 'Убрано из «' + S.source.title + '». Ctrl+Z — вернуть' : 'Убрано из очереди. Ctrl+Z — вернуть');
    S.queue.splice(i, 1);
    if (i < S.index) S.index--;
    if (wasCur) {
      if (!S.queue.length) { if (W) W.pause(); S.index = -1; renderNow(); renderState(); }
      else if (S.playing) playIndex(Math.min(i, S.queue.length - 1), false, true);
      else { setCurrent(Math.min(i, S.queue.length - 1), true); S.needLoad = true; renderState(); }
    }
    afterQueueEdit();
  }

  // ── right-click menus ─────────────────────────────────────
  function trackMenu(pos, it, ctx) {
    if (!it || it.partial) return;
    const items = [];
    if (ctx.play) items.push({ label: 'Играть', icon: 'i-play', run: ctx.play });
    if (ctx.qi != null) {
      if (ctx.qi !== S.index) items.push({ label: 'Играть следующим', icon: 'i-next', run: () => queueMove(ctx.qi, ctx.qi < S.index ? S.index : S.index + 1) });
    } else {
      items.push({ label: 'Играть следующим', icon: 'i-next', run: () => queueInsert(it, true) });
      items.push({ label: 'В конец очереди', icon: 'i-list', run: () => queueInsert(it, false) });
    }
    items.push({ label: 'В плейлист…', icon: 'i-plus', run: () => showAddMenu(pos, it) });
    if (ctx.qi != null) {
      const keeps = sourceKeepsEdits() || !!sourcePlaylist();
      items.push({ label: keeps ? 'Удалить из «' + S.source.title + '»' : 'Убрать из очереди', icon: keeps ? 'i-trash' : 'i-x', danger: keeps, run: () => queueRemove(ctx.qi) });
    }
    if (ctx.pli != null) items.push({ label: 'Убрать из плейлиста', icon: 'i-x', run: () => removeFromPlaylist(Lib.get(S.libView), ctx.pli) });
    if (it.permalink) {
      items.push({ label: 'Открыть на SoundCloud', icon: 'i-cloud', run: () => openExternal(it.permalink) });
      items.push({ label: 'Скопировать ссылку', icon: 'i-link', run: () => copyText(it.permalink) });
    }
    showMenu(pos, it.title, items);
  }

  function tileMenu(pos, tile) {
    if (tile.dataset.local === 'files') {
      const p = Files.playlist();
      showMenu(pos, p.name, [
        p.tracks.length ? { label: 'Играть', icon: 'i-play', run: () => openLocal(p, 0) } : null,
        { label: 'Открыть', icon: 'i-list', run: () => { S.libView = 'files'; renderList(); } },
        { label: 'Загрузить файлы…', icon: 'i-upload', run: pickFiles },
      ].filter(Boolean));
      return;
    }
    if (tile.dataset.local) {
      const p = Lib.get(tile.dataset.local);
      if (!p) return;
      showMenu(pos, p.name, [
        { label: 'Играть', icon: 'i-play', run: () => openLocal(p, 0) },
        { label: 'Открыть', icon: 'i-list', run: () => { S.libView = p.id; renderList(); } },
        { input: 'Название', value: p.name, run: (v) => { if (v.trim()) { p.name = v.trim(); Lib.save(); renderList(); } } },
        { label: 'Сменить обложку', icon: 'i-edit', run: () => pickCover(p) },
        p.cover ? { label: 'Обложка из треков', icon: 'i-disc', run: () => { delete p.cover; Lib.save(); renderList(); } } : null,
        { label: 'Удалить плейлист', icon: 'i-trash', danger: true, run: () => confirmMenu(pos, 'Удалить «' + p.name + '»?', 'Удалить', () => deletePlaylist(p)) },
      ].filter(Boolean));
    } else if (tile.dataset.saved != null) {
      const i = +tile.dataset.saved, s = Lib.saved[i];
      showMenu(pos, s.title, [
        { label: 'Играть', icon: 'i-play', run: () => (s.kind === 'track' ? playSrcTrack(s) : openSource(s, { quiet: true })) },
        s.kind === 'track' ? { label: 'В плейлист…', icon: 'i-plus', run: () => showAddMenu(pos, srcTrack(s)) } : null,
        { input: 'Название', value: s.title, run: (v) => { if (v.trim()) { s.title = v.trim(); Lib.save(); renderList(); } } },
        { label: 'Открыть на SoundCloud', icon: 'i-cloud', run: () => openExternal(s.url) },
        { label: 'Скопировать ссылку', icon: 'i-link', run: () => copyText(s.url) },
        { label: 'Убрать из библиотеки', icon: 'i-x', danger: true, run: () => { Lib.saved.splice(i, 1); Lib.save(); renderList(); } },
      ].filter(Boolean));
    }
  }

  function deletePlaylist(p) {
    Lib.playlists = Lib.playlists.filter((x) => x !== p);
    Lib.save();
    if (S.libView === p.id) S.libView = null;
    toast('Плейлист «' + p.name + '» удалён');
    renderList();
  }

  // own playlist cover from a picture on disk, cropped to a 320px square and kept as JPEG
  const coverInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
  let coverFor = null;
  function pickCover(p) { if (!p) return; coverFor = p; coverInput.value = ''; coverInput.click(); }
  coverInput.onchange = () => {
    const f = coverInput.files[0], p = coverFor;
    if (!f || !p) return;
    const url = URL.createObjectURL(f), img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'), N = 320, k = Math.max(N / img.width, N / img.height);
      c.width = c.height = N;
      c.getContext('2d').drawImage(img, (N - img.width * k) / 2, (N - img.height * k) / 2, img.width * k, img.height * k);
      p.cover = c.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(url);
      Lib.save();
      renderList();
      toast('Обложка обновлена');
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Не получилось открыть картинку', true); };
    img.src = url;
  };

  el.list.addEventListener('contextmenu', (e) => {
    const pos = { x: e.clientX, y: e.clientY };
    const tile = e.target.closest('.tile-card');
    if (tile) { e.preventDefault(); tileMenu(pos, tile); return; }
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.lib != null) {
      const i = +row.dataset.lib, src = S.library[i];
      showMenu(pos, src.title, [
        { label: 'Играть', icon: 'i-play', run: () => openSrcPage(src) },
        src.kind === 'track' ? { label: 'В плейлист…', icon: 'i-plus', run: () => showAddMenu(pos, srcTrack(src)) }
          : Lib.isSaved(src.url) ? null : { label: 'Сохранить в библиотеку', icon: 'i-plus', run: () => { Lib.pin(src); renderList(); toast('Сохранено'); } },
        { label: 'Скопировать ссылку', icon: 'i-link', run: () => copyText(src.url) },
        { label: 'Убрать из недавних', icon: 'i-x', danger: true, run: () => removeFromLibrary(i) },
      ].filter(Boolean));
      return;
    }
    trackMenu(pos, rowItem(row), {
      qi: row.dataset.i != null ? +row.dataset.i : null,
      pli: row.dataset.pli != null ? +row.dataset.pli : null,
      play: () => row.click(),
    });
  });
  el.art.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu({ x: e.clientX, y: e.clientY }, S.queue[S.index], { qi: S.index }); });

  // ── drag to reorder: queue rows and rows of an own playlist ──
  let dragFrom = null, dragItem = null;
  const dropMarks = () => el.list.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
  const rowPos = (row) => +(row.dataset.i != null ? row.dataset.i : row.dataset.pli);
  el.list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row[draggable]');
    if (!row) return;
    // queue and own-playlist rows also reorder; any track can be dropped on a playlist
    const reorder = row.dataset.i != null || row.dataset.pli != null;
    dragFrom = reorder ? rowPos(row) : null;
    dragItem = rowItem(row);
    e.dataTransfer.effectAllowed = reorder ? 'copyMove' : 'copy';
    e.dataTransfer.setData('text/plain', dragItem ? dragItem.title : '');
    row.classList.add('dragging');
    if (dragItem) Dock.show();
  });
  el.list.addEventListener('dragover', (e) => {
    const row = e.target.closest('.row[draggable]');
    if (dragFrom == null || !row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    el.list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.list.addEventListener('drop', (e) => {
    const row = e.target.closest('.row[draggable]');
    if (dragFrom == null || !row) return;
    e.preventDefault();
    const from = dragFrom;
    let to = rowPos(row) + (row.classList.contains('drop-after') ? 1 : 0);
    if (to > from) to--;
    dragFrom = null;
    dropMarks();
    if (row.dataset.i != null) { queueMove(from, to); return; }
    const p = Lib.get(S.libView);
    if (!p || from === to) return;
    p.tracks.splice(to, 0, p.tracks.splice(from, 1)[0]);
    Lib.save();
    renderList();
  });
  el.list.addEventListener('dragend', () => { dragFrom = null; dragItem = null; dropMarks(); Dock.hide(); });

  // While a track is dragged, a strip of playlists appears at the bottom of the list panel
  // (the library tiles are drop targets too). Own playlists get the track; saved SoundCloud
  // playlists get it inside Pedro; "Новый" makes a playlist with it.
  function dropTarget(node) {
    const chip = node.closest && node.closest('[data-dock]');
    if (chip) {
      const v = chip.dataset.dock;
      if (v === 'new') return { node: chip, run: (it) => { menuItem = it; addToPlaylist(Lib.create('')); } };
      if (v.startsWith('sc:')) { const src = scLists()[+v.slice(3)]; return src && { node: chip, run: (it) => { menuItem = it; addToSoundCloudList(src); } }; }
      const p = Lib.get(v.slice(6));
      return p && { node: chip, run: (it) => { menuItem = it; addToPlaylist(p); } };
    }
    const tile = node.closest && node.closest('.tile-card');
    if (!tile) return null;
    if (tile.dataset.local && tile.dataset.local !== 'files') {
      const p = Lib.get(tile.dataset.local);
      return p && { node: tile, run: (it) => { menuItem = it; addToPlaylist(p); } };
    }
    const src = tile.dataset.saved != null && Lib.saved[+tile.dataset.saved];
    return src && src.kind === 'playlist' ? { node: tile, run: (it) => { menuItem = it; addToSoundCloudList(src); } } : null;
  }
  const Dock = (() => {
    const box = document.createElement('div');
    box.className = 'dock';
    box.hidden = true;
    $('#side').appendChild(box);
    const mark = (n) => document.querySelectorAll('.drop-on').forEach((x) => { if (x !== n) x.classList.remove('drop-on'); });
    function over(e) {
      const t = dragItem && dropTarget(e.target);
      mark(t ? t.node : null);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      t.node.classList.add('drop-on');
    }
    function drop(e) {
      const t = dragItem && dropTarget(e.target);
      if (!t) return;
      e.preventDefault();
      const it = dragItem;
      dragFrom = null; dragItem = null;
      dropMarks(); Dock.hide();
      t.run(it);
    }
    box.addEventListener('dragover', over);
    box.addEventListener('drop', drop);
    el.list.addEventListener('dragover', (e) => { if (dragItem && e.target.closest('.tile-card')) over(e); });
    el.list.addEventListener('drop', (e) => { if (dragItem && e.target.closest('.tile-card')) drop(e); });
    return {
      show() {
        const chips = Lib.playlists.map((p) => '<button class="dock-chip" data-dock="local:' + p.id + '">' + esc(p.name) + '</button>')
          .concat(scLists().map((x, i) => '<button class="dock-chip" data-dock="sc:' + i + '">' + esc(x.title) + '<small>SC</small></button>'))
          .concat('<button class="dock-chip new" data-dock="new"><svg><use href="#i-plus"/></svg>Новый</button>');
        box.innerHTML = '<div class="dock-title">Перетащи в плейлист</div><div class="dock-list">' + chips.join('') + '</div>';
        box.hidden = false;
      },
      hide() { box.hidden = true; mark(null); },
    };
  })();

  // audio files dragged in from Explorer: anywhere on the window
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  let dropDepth = 0;
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dropDepth++; el.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dropDepth <= 0) { dropDepth = 0; el.body.classList.remove('dropping'); } });
  document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth = 0;
    el.body.classList.remove('dropping');
    importFiles(e.dataTransfer.files);
  });

  // ── settings ──────────────────────────────────────────────
  const Prefs = { theme: store.get('theme', 'light'), onTop: store.get('onTop', false), tray: store.get('tray', true), bgAnim: store.get('bgAnim', true) };
  // animated background: one 15 fps clock for all shapes (see style.css); it stops while the
  // window is minimized or in the tray, and keeps its time so nothing jumps on return
  const BgAnim = (() => {
    const bg = document.querySelector('.bg'), pluses = [...bg.querySelectorAll('.sh-plus')];
    let on = false, shown = true, timer = 0, t = 0, last = 0;
    function frame() {
      const now = performance.now();
      t += Math.min(0.2, (now - last) / 1000);
      last = now;
      bg.style.setProperty('--t', t.toFixed(3));
      bg.style.setProperty('--g', ((t * 4.4) % 44).toFixed(2) + 'px');
      pluses.forEach((p, i) => p.style.setProperty('--q', String(Math.floor(t / 3 + i * 0.75))));
    }
    function sync() {
      const run = on && shown;
      if (run && !timer) { last = performance.now(); timer = setInterval(frame, 1000 / 15); }
      if (!run && timer) { clearInterval(timer); timer = 0; }
      if (!on) { t = 0; bg.style.removeProperty('--t'); bg.style.removeProperty('--g'); pluses.forEach((p) => p.style.removeProperty('--q')); }
    }
    return { set(v) { on = v; sync(); }, setShown(v) { shown = v; sync(); } };
  })();
  BgAnim.set(Prefs.bgAnim);
  const prefValue = (k) => String({ theme: Prefs.theme, beat: Hop.mode }[k]);
  function renderPrefs() {
    el.settings.querySelectorAll('[data-pref]').forEach((b) => b.classList.toggle('on', prefValue(b.dataset.pref) === b.dataset.val));
    $('#onTop').checked = Prefs.onTop;
    $('#trayMode').checked = Prefs.tray;
    $('#bgAnim').checked = Prefs.bgAnim;
    $('#accentMode').checked = Accent.on;
  }
  el.settings.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref]');
    if (!b) return;
    const v = b.dataset.val;
    if (b.dataset.pref === 'theme') {
      Prefs.theme = v;
      store.set('theme', v);
      document.documentElement.classList.toggle('dark', v === 'dark');
      hostSend({ type: 'theme', dark: v === 'dark' });   // the launch splash follows the theme
      Accent.apply();
    }
    if (b.dataset.pref === 'beat') Hop.setMode(v);
    renderPrefs();
  });
  $('#trayMode').onchange = (e) => {
    Prefs.tray = e.target.checked;
    store.set('tray', Prefs.tray);
    hostSend({ type: 'win', action: Prefs.tray ? 'tray-on' : 'tray-off' });
  };
  $('#accentMode').onchange = (e) => Accent.set(e.target.checked);
  $('#bgAnim').onchange = (e) => {
    Prefs.bgAnim = e.target.checked;
    store.set('bgAnim', Prefs.bgAnim);
    BgAnim.set(Prefs.bgAnim);
  };
  $('#onTop').onchange = (e) => {
    Prefs.onTop = e.target.checked;
    store.set('onTop', Prefs.onTop);
    hostSend({ type: 'win', action: Prefs.onTop ? 'pin-on' : 'pin-off' });
  };
  function openSettings() {
    renderPrefs();
    el.settings.hidden = false;
  }
  const closeSettings = () => { el.settings.hidden = true; };
  $('#setDone').onclick = closeSettings;
  el.settings.addEventListener('mousedown', (e) => { if (e.target === el.settings) closeSettings(); });

  // ── window chrome (frameless host) ────────────────────────
  function setMini(on) {
    if (el.body.classList.contains('mini') === on) return;
    if (!host) { el.body.classList.toggle('mini', on); return; }
    el.body.classList.add('switching');
    setTimeout(() => hostSend({ type: 'win', action: on ? 'mini' : 'full' }), 110);
    setTimeout(() => el.body.classList.remove('switching'), 900);
  }
  function applyMode(on) {
    el.body.classList.toggle('mini', on);
    requestAnimationFrame(() => requestAnimationFrame(() => el.body.classList.remove('switching')));
  }
  $('#btnMini').onclick = () => setMini(true);
  $('#btnExpand').onclick = () => setMini(false);
  $('#btnMin').onclick = () => hostSend({ type: 'win', action: 'minimize' });
  $('#btnClose').onclick = () => (host ? hostSend({ type: 'win', action: 'close' }) : window.close());
  $('#btnSettings').onclick = openSettings;

  document.addEventListener('mousedown', (e) => {
    if (!host || e.button !== 0) return;
    if (e.target.closest('button, a, input, .bar, .side, .modal, .clip, .menu')) return;
    e.preventDefault();
    hostSend({ type: 'win', action: 'drag' });
  });
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

  // ── controls ──────────────────────────────────────────────
  el.play.onclick = togglePlay;
  $('#btnNext').onclick = next;
  $('#btnPrev').onclick = prev;
  el.shuffle.onclick = toggleShuffle;
  el.repeat.onclick = cycleRepeat;
  el.mute.onclick = toggleMute;
  el.scLink.onclick = () => { const it = S.queue[S.index]; if (it && it.permalink) openExternal(it.permalink); };

  function bindBar(bar, onMove, onCommit) {
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('drag');
      const at = (ev) => { const r = bar.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1); };
      let p = at(e);
      onMove(p);
      const move = (ev) => { p = at(ev); onMove(p); };
      const up = () => {
        bar.classList.remove('drag');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        if (onCommit) onCommit(p);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }
  bindBar(el.seek, (p) => {
    if (!S.dur) return;
    S.dragging = true;
    el.seek.style.setProperty('--p', p);
    el.tCur.textContent = fmt(p * S.dur);
  }, (p) => {
    if (!S.dragging) return;
    S.dragging = false;
    seekTo(p * S.dur);
  });
  bindBar(el.vol, (p) => setVolume(p * 100));
  const wheelVol = (e) => { e.preventDefault(); setVolume(S.volume + (e.deltaY < 0 ? 5 : -5)); };
  el.vol.addEventListener('wheel', wheelVol, { passive: false });
  el.mute.addEventListener('wheel', wheelVol, { passive: false });

  el.omni.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.q.value.trim();
    if (!text) return;
    if (findScUrl(text)) { el.q.value = ''; el.q.blur(); handleLink(text); return; }
    if (/^https?:\/\//i.test(text)) { toast('Нужна ссылка именно с soundcloud.com', true); return; }
    S.lastQuery = text;
    el.q.blur();
    searchTracks(text);
  });
  el.q.addEventListener('paste', () => setTimeout(() => {
    const u = findScUrl(el.q.value);
    if (u && el.q.value.trim() === u) el.omni.requestSubmit();
  }, 0));
  document.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('input')) return;
    const t = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (findScUrl(t)) { e.preventDefault(); handleLink(t); }
  });

  el.tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });

  const actions = {
    demo: playDemo,
    paste: () => (host ? hostSend({ type: 'clip-get' }) : navigator.clipboard.readText().then((t) => onClipboard(t, true)).catch(() => toast('Нет доступа к буферу', true))),
    settings: openSettings,
    websearch: () => openExternal('https://soundcloud.com/search' + (S.lastQuery ? '?q=' + encodeURIComponent(S.lastQuery) : '')),
    'profile-edit': () => {
      S.profileEditing = true;
      renderList();
      const input = el.list.querySelector('[data-form="profile"] input');
      if (input) { input.value = S.profile ? S.profile.url : ''; input.focus(); }
    },
    'profile-cancel': () => { S.profileEditing = false; renderList(); },
    'lib-create': () => { S.libForm = S.libForm === 'create' ? null : 'create'; renderList(); },
    'lib-link': () => { S.libForm = S.libForm === 'link' ? null : 'link'; renderList(); },
    'lib-form-cancel': () => { S.libForm = null; renderList(); },
    'lib-back': () => { S.libView = null; S.renaming = false; S.confirmDel = false; renderList(); },
    'search-close': closeSearch,
    'search-more': () => { if (S.search && S.search.state !== 'loading') searchTracks(S.search.q, true); },
    'wave-play': () => {
      const k = S.libView.slice(5);
      if (S.source && S.source.url === 'wave:' + k && S.queue.length) togglePlay(); else Wave.play(k, 0);
    },
    'wave-shuffle': () => {
      const k = S.libView.slice(5), n = (Wave.shown[k] || []).length;
      if (!S.shuffle) { S.shuffle = true; store.set('shuffle', true); renderModes(); }
      Wave.play(k, n ? Math.floor(Math.random() * n) : 0);
    },
    'wave-refresh': () => Wave.buildFresh(true),
    'src-play': () => {
      const src = S.libSrc;
      if (!src) return;
      if (S.source && S.source.url === src.url && S.queueSrc === src.url && S.queue.length) togglePlay(); else openSource(src, { quiet: true });
    },
    'src-shuffle': () => {
      const src = S.libSrc;
      if (!src) return;
      if (!S.shuffle) { S.shuffle = true; store.set('shuffle', true); renderModes(); }
      if (S.source && S.source.url === src.url && S.queueSrc === src.url && S.queue.length) playIndex(Math.floor(Math.random() * S.queue.length));
      else openSource(src, { quiet: true });
    },
    'src-open': () => { if (S.libSrc) openExternal(S.libSrc.url.replace(/\/favorites$/, '')); },
    'src-save': () => { if (S.libSrc && Lib.pin(S.libSrc)) toast('Сохранено в библиотеку'); renderList(); renderCounts(); },
    'src-unsave': () => {
      if (!S.libSrc) return;
      Lib.saved = Lib.saved.filter((x) => x.url !== S.libSrc.url);
      Lib.save(); renderList(); renderCounts();
      toast('Убрано из библиотеки');
    },
    'rec-more': () => { const p = recView(); if (p) Rec.more(p); },
    'rec-refresh': () => { const p = recView(); if (p) Rec.run(p, true); },
    'pl-play': () => { const p = Lib.get(S.libView); if (p) openLocal(p, 0); },
    'pl-shuffle': () => {
      const p = Lib.get(S.libView);
      if (!p || !p.tracks.length) return;
      if (!S.shuffle) { S.shuffle = true; store.set('shuffle', true); renderModes(); }
      openLocal(p, Math.floor(Math.random() * p.tracks.length));
    },
    'pl-rename': () => { S.renaming = true; renderList(); },
    'pl-delete': () => {
      const p = Lib.get(S.libView);
      if (!p) return;
      if (!S.confirmDel) {
        S.confirmDel = true; renderList();
        setTimeout(() => { if (S.confirmDel) { S.confirmDel = false; if (S.tab === 'library') renderList(); } }, 3000);
        return;
      }
      S.confirmDel = false;
      deletePlaylist(p);
    },
    'pl-cover': () => pickCover(Lib.get(S.libView)),
    'files-add': pickFiles,
    'edits-restore': () => {
      const src = S.source, cur = S.queue[S.index], n = Edits.hiddenCount(src.url);
      Edits.unhideAll(src.url);
      const have = new Map(S.queue.map((x) => [itemKey(x), x]));
      const all = (S.allItems || []).map((x) => have.get(itemKey(x)) || x);
      S.queue.forEach((x) => { if (!all.includes(x)) all.push(x); });
      detachQueue();
      S.queue = Edits.apply(src.url, all);
      S.index = cur ? Math.max(0, S.queue.indexOf(cur)) : 0;
      afterQueueEdit();
      Info.fill();
      toast('Вернул ' + tracksWord(n));
    },
    'stats-reset': () => {
      const b = el.list.querySelector('[data-act="stats-reset"]');
      confirmMenu(b || { x: 300, y: 200 }, 'Стереть всю статистику?', 'Стереть', () => { Stats.reset(); renderList(); toast('Статистика сброшена'); });
    },
    'recent-clear': () => { S.library = []; store.set('library', []); renderList(); },
    'save-src': () => { if (Lib.pin(S.source)) toast('Сохранено в библиотеку'); renderListHead(); renderCounts(); },
  };

  async function submitLibForm(kind, value) {
    value = value.trim();
    if (kind === 'create') {
      const p = Lib.create(value);
      S.libForm = null; S.libView = p.id;
      renderList();
      toast('Плейлист «' + p.name + '» создан');
    } else if (kind === 'link') {
      if (!findScUrl(value)) { toast('Нужна ссылка с soundcloud.com', true); return; }
      try {
        const src = await resolveSource(value);
        if (!src) throw new Error('Не удалось открыть ссылку');
        toast(Lib.pin(src) ? '«' + src.title + '» в библиотеке' : 'Уже есть в библиотеке');
        S.libForm = null;
        if (S.tab === 'library') renderList();
      } catch (e) { toast(e.message || 'Не удалось открыть ссылку', true); }
    } else if (kind === 'rename') {
      const p = Lib.get(S.libView);
      if (p && value) { p.name = value; Lib.save(); }
      S.renaming = false;
      renderList();
    }
  }
  el.list.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'profile') saveProfile(form.elements.p.value);
    else submitLibForm(form.dataset.form, form.elements.v.value);
  });
  el.listHead.addEventListener('click', (e) => { const act = e.target.closest('[data-act]'); if (act) actions[act.dataset.act](); });

  // the item a list row stands for (queue or an own playlist)
  function rowItem(row) {
    if (row.dataset.i != null) return S.queue[+row.dataset.i];
    if (row.dataset.rec != null) { const rp = recView(); return rp ? Rec.shown(rp)[+row.dataset.rec] : null; }
    if (row.dataset.s != null) return S.search ? S.search.items[+row.dataset.s] : null;
    if (row.dataset.w != null) { const k = (S.libView || '').slice(5); return (Wave.shown[k] || [])[+row.dataset.w] || null; }
    if (row.dataset.lib != null) { const src = S.library[+row.dataset.lib]; return src && src.kind === 'track' ? srcTrack(src) : null; }
    const p = row.dataset.pli != null && Lib.get(S.libView);
    return p ? p.tracks[+row.dataset.pli] : null;
  }

  el.list.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-row-del]');
    if (delBtn) { e.stopPropagation(); queueRemove(+delBtn.closest('.row').dataset.i); return; }
    const addBtn = e.target.closest('[data-row-add]');
    if (addBtn) { e.stopPropagation(); showAddMenu(addBtn, rowItem(addBtn.closest('.row'))); return; }
    const recAdd = e.target.closest('[data-rec-add]'), recNo = e.target.closest('[data-rec-no]');
    if (recAdd || recNo) {
      e.stopPropagation();
      const p = recView(), it = rowItem((recAdd || recNo).closest('.row'));
      if (!p || !it) return;
      if (recNo) { Rec.hide(p, it.k); return; }
      if (p.queue) { queueInsert(it, false); return; }
      const res = Lib.add(p, it);
      toast(res === 'ok' ? 'Добавлено в «' + p.name + '»' : 'Уже есть в «' + p.name + '»');
      renderList(); renderCounts();
      return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const p = Lib.get(S.libView);
      if (p) removeFromPlaylist(p, +rm.closest('.row').dataset.pli);
      return;
    }
    const unpin = e.target.closest('[data-unpin]');
    if (unpin) { Lib.saved.splice(+unpin.dataset.unpin, 1); Lib.save(); renderList(); return; }
    const pinRecent = e.target.closest('[data-pin-recent]');
    if (pinRecent) { if (Lib.pin(S.library[+pinRecent.dataset.pinRecent])) toast('Сохранено в библиотеку'); renderList(); return; }
    const per = e.target.closest('[data-period]');
    if (per) { S.statsPeriod = per.dataset.period; store.set('statsPeriod', S.statsPeriod); renderList(); return; }
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); removeFromLibrary(+del.dataset.del); return; }
    const act = e.target.closest('[data-act]');
    if (act) { actions[act.dataset.act](); return; }
    const top = e.target.closest('[data-top]');
    if (top && S.lastStats) {
      const items = S.lastStats.top.map((x) => ({ id: x.k, title: x.m.t, artist: x.m.a, art: x.m.art, dur: 0, url: x.m.u, permalink: /^https:\/\/soundcloud\.com\//.test(x.m.u) ? x.m.u : '' }));
      playItems(items, +top.dataset.top, { kind: 'top', title: 'Мой топ', url: 'top' });
      return;
    }
    const tilePlayBtn = e.target.closest('[data-tile-play]');
    if (tilePlayBtn) { tilePlay(tilePlayBtn.closest('.tile-card')); return; }
    const tile = e.target.closest('.tile-card');
    if (tile) {
      if (tile.dataset.wave) { S.libView = 'wave:' + tile.dataset.wave; S.libForm = null; renderList(); el.list.scrollTop = 0; markCurrentRow(true); }
      else if (tile.dataset.local) { S.libView = tile.dataset.local; S.libForm = null; renderList(); el.list.scrollTop = 0; markCurrentRow(true); }
      else if (tile.dataset.saved != null) openSrcPage(Lib.saved[+tile.dataset.saved]);
      else if (tile.dataset.acc) openAccountItem(tile.dataset.acc, true);
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.dataset.rec != null) {
      const p = recView(), items = p ? Rec.shown(p) : [], it = items[+row.dataset.rec], cur = S.queue[S.index];
      if (!it) return;
      if (p.queue) {
        // straight after the current track, and on
        queueInsert(it, true);
        playIndex(S.index + 1);
      } else if (S.source && S.source.url === 'rec:' + p.id && cur && cur.k === it.k) togglePlay();
      else playItems(items, +row.dataset.rec, { kind: 'rec', title: 'Рекомендации · ' + p.name, url: 'rec:' + p.id });
    } else if (row.dataset.pli != null) {
      const p = Lib.get(S.libView), i = +row.dataset.pli;
      if (S.source && S.source.url === 'local:' + p.id && isCur(p.tracks[i])) togglePlay(); else openLocal(p, i);
    } else if (row.dataset.acc != null) {
      openAccountItem(row.dataset.acc);
    } else if (row.dataset.w != null) {
      const k = S.libView.slice(5), it = rowItem(row);
      if (S.source && S.source.url === 'wave:' + k && isCur(it)) togglePlay(); else Wave.play(k, +row.dataset.w);
    } else if (row.dataset.s != null) {
      const it = rowItem(row);
      if (isCur(it)) togglePlay(); else playTrackNow(it);
    } else if (row.dataset.lib != null) {
      const src = S.library[+row.dataset.lib];
      openSrcPage(src);
    } else if (row.dataset.i != null) {
      const i = +row.dataset.i;
      if (i === S.index && S.pendingSkip == null) togglePlay(); else playIndex(i);
    }
  });

  $('#clipClose').onclick = hideClip;

  document.addEventListener('keydown', (e) => {
    if (!el.menu.hidden && e.key === 'Escape') { hideMenu(); return; }
    if (!el.settings.hidden) { if (e.key === 'Escape') closeSettings(); return; }
    if (e.target.closest && e.target.closest('input')) {
      if (e.key === 'Escape') { el.q.value = ''; el.q.blur(); }
      return;
    }
    if ((e.ctrlKey && e.code === 'KeyF') || e.key === '/') { e.preventDefault(); el.q.focus(); return; }
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); undoRemove(); return; }
    if (e.ctrlKey && e.code === 'KeyO') { e.preventDefault(); pickFiles(); return; }
    switch (e.code) {
      case 'Space': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); if (e.ctrlKey) next(); else seekBy(10000); break;
      case 'ArrowLeft': e.preventDefault(); if (e.ctrlKey) prev(); else seekBy(-10000); break;
      case 'ArrowUp': e.preventDefault(); setVolume(S.volume + 5); break;
      case 'ArrowDown': e.preventDefault(); setVolume(S.volume - 5); break;
      case 'KeyM': toggleMute(); break;
      case 'KeyS': toggleShuffle(); break;
      case 'KeyR': cycleRepeat(); break;
      case 'Escape': if (S.tab === 'search') closeSearch(); else if (!el.clip.hidden) hideClip(); break;
      default: break;
    }
  });

  // 4 fps ticker while playing: polls the widget position twice a second (its own progress
  // events arrive ~40 times a second) and steps the equalizer. Nothing animates per frame,
  // so the blurred glass panels are not recomposited 60 times a second.
  let tick = 0, lastTick = performance.now();
  setInterval(() => {
    const now = performance.now(), dt = Math.min(1000, now - lastTick);
    lastTick = now;
    if (!S.playing) return;
    Stats.tick(dt);
    if (W && !offWidget() && ++tick % 2 === 0) {
      W.getPosition((p) => { if (S.playing && !S.dragging && typeof p === 'number') { S.pos = p; S.posAt = performance.now(); } });
    }
    renderProgress();
    const bars = el.list.querySelectorAll('.row.cur .eq i');
    bars.forEach((b) => { b.style.transform = 'scaleY(' + (0.25 + Math.random() * 0.75).toFixed(2) + ')'; });
  }, 250);

  // ── boot ──────────────────────────────────────────────────
  renderNow();
  renderState();
  renderVolume();
  renderModes();
  renderList();
  bootWidget(0);
  Files.boot();
  if (Prefs.onTop) hostSend({ type: 'win', action: 'pin-on' });
  hostSend({ type: 'theme', dark: Prefs.theme === 'dark' });
  hostSend({ type: 'win', action: Prefs.tray ? 'tray-on' : 'tray-off' });
  // leftovers of removed features: API keys, sign-in tokens, the dot background
  ['creds', 'token', 'auth', 'pkce', 'account', 'dotStep', 'dotMotion', 'bgBlur', 'liveBg', 'waveSpeed']
    .forEach((k) => { try { localStorage.removeItem('pedro.' + k); } catch (e) { /* storage unavailable */ } });
  window.__pedro = { S, Lib, Stats, Files, Rec, openSource, playLink, renderList, setTab };
})();
