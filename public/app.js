/* global io, SFX, FX, I18N */
(() => {
  'use strict';

  const AVATARS = ['🦊', '🐸', '🐼', '🦄', '🐙', '👽', '🤡', '🤠', '🦖', '🐷', '🐵', '🦁', '🐧', '👻', '🤖', '🐔'];
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const appEl = document.getElementById('app');
  const topbarEl = document.getElementById('topbar');
  const bannerEl = document.getElementById('banner');
  const toastEl = document.getElementById('toast');

  // ---------- storage (any access can throw in private windows) ----------

  const attempt = (fn, fallback = null) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const store = (area) => ({
    get: (k) => attempt(() => window[area].getItem(k)),
    set: (k, v) => attempt(() => window[area].setItem(k, v)),
    del: (k) => attempt(() => window[area].removeItem(k)),
  });
  const local = store('localStorage');
  const tab = store('sessionStorage');

  const SEAT = 'wdt-seat';
  const readSeat = (area) => {
    const seat = attempt(() => JSON.parse(area.get(SEAT)));
    return seat && seat.code && seat.playerId && seat.token ? seat : null;
  };
  const saveSeat = (seat) => {
    const raw = JSON.stringify(seat);
    local.set(SEAT, raw);
    tab.set(SEAT, raw);
  };
  const clearSeat = () => {
    local.del(SEAT);
    tab.del(SEAT);
  };

  const loadProfile = () => attempt(() => JSON.parse(local.get('wdt-profile')), null) || {};
  const saveProfile = (profile) => local.set('wdt-profile', JSON.stringify(profile));

  function urlRoom() {
    const code = new URLSearchParams(location.search).get('room');
    return code ? code.trim().toUpperCase().slice(0, 8) : null;
  }
  function setUrlRoom(code) {
    const url = code ? `${location.pathname}?room=${encodeURIComponent(code)}` : location.pathname;
    attempt(() => history.replaceState(null, '', url));
  }

  // ---------- language ----------

  let lang = local.get('wdt-lang') || ((navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en');
  if (!I18N[lang]) lang = 'en';
  document.documentElement.lang = lang;

  function t(key, vars) {
    let s = I18N[lang][key] ?? I18N.en[key] ?? key;
    // French puts a narrow no-break space before ? ! : ;
    if (lang === 'fr') s = s.replace(/ ([?!:;])/g, ' $1');
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
    return s;
  }
  const tn = (key, n) => t(n === 1 || (lang === 'fr' && n === 0) ? `${key}_one` : `${key}_other`, { n });
  const errorText = (code) => (I18N[lang][`err_${code}`] || I18N.en[`err_${code}`] ? t(`err_${code}`) : t('err_generic'));

  // ---------- tiny DOM helper ----------

  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'class') el.classList.add(...String(v).split(' ').filter(Boolean));
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let toastTimer;
  function toast(message, tone = 'info') {
    toastEl.textContent = message;
    toastEl.dataset.tone = tone;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 3400);
  }
  const fail = (res) => toast(errorText(res?.error), 'error');

  function banner(message) {
    bannerEl.textContent = message || '';
    bannerEl.hidden = !message;
  }

  // ---------- connection ----------

  const socket = io();
  let S = null; // latest state from the server, or null when not in a game
  let offRoom = 'home'; // which screen to show when S is null: home | loading | replaced
  let offset = 0; // server clock minus this device's clock
  let current = null; // the mounted screen
  const played = new Set(); // verdict animations already shown, so redraws don't replay them
  let draft = { game: 0, text: '' };

  const now = () => Date.now() + offset;
  const player = (id) => S?.players.find((p) => p.id === id) || null;
  const isHost = () => !!S && S.hostId === S.you;
  const hostName = () => player(S?.hostId)?.name || '…';

  function send(event, payload) {
    return new Promise((resolve) => {
      if (!socket.connected) return resolve({ ok: false, error: 'offline' });
      socket.timeout(8000).emit(event, payload ?? {}, (err, res) => {
        resolve(err || !res ? { ok: false, error: 'generic' } : res);
      });
    });
  }

  async function act(event, payload) {
    const res = await send(event, payload);
    if (!res.ok) fail(res);
    return res;
  }

  function leaveRoomLocally(message) {
    clearSeat();
    setUrlRoom(null);
    S = null;
    offRoom = 'home';
    render();
    if (message) toast(message);
  }

  function resume(takeoverAllowed) {
    const fromTab = readSeat(tab);
    const seat = fromTab || readSeat(local);
    const code = urlRoom();
    if (!seat || (code && code !== seat.code)) {
      offRoom = 'home';
      render();
      return;
    }
    send('room:resume', { ...seat, takeover: takeoverAllowed || !!fromTab }).then((res) => {
      if (res.ok) {
        saveSeat(seat);
        setUrlRoom(seat.code);
        return;
      }
      if (res.error === 'in_use') {
        offRoom = 'replaced';
        render();
        return;
      }
      if (res.error === 'offline') return; // the next connect event retries
      const wasHere = !!S || offRoom === 'loading';
      leaveRoomLocally(wasHere ? t('gameGone') : null);
    });
  }

  socket.on('connect', () => {
    banner(null);
    resume(false);
  });
  socket.on('disconnect', () => {
    if (S) banner(t('reconnecting'));
  });
  socket.on('connect_error', () => {
    if (S || offRoom === 'loading') banner(t('reconnecting'));
  });
  socket.on('state', (state) => {
    offset = state.serverNow - Date.now();
    const prev = S;
    S = state;
    react(prev, state);
    render();
  });
  socket.on('kicked', () => leaveRoomLocally(t('kicked')));
  socket.on('replaced', () => {
    tab.del(SEAT);
    S = null;
    offRoom = 'replaced';
    render();
  });

  function react(prev, next) {
    if (!prev) return;
    if (prev.phase !== next.phase) {
      if (next.phase === 'writing' || next.phase === 'reveal') SFX.start();
      else if (next.phase === 'voting') SFX.whoosh();
    }
    if (next.phase === 'lobby' && next.players.length > prev.players.length) SFX.join();
    if (prev.hostId !== next.hostId && next.hostId === next.you) toast(t('youAreHost'));
  }

  // ---------- rendering ----------

  function screenKey() {
    if (!S) return offRoom;
    const g = S.game ? S.game.no : 0;
    switch (S.phase) {
      case 'writing':
        return `writing:${g}`;
      case 'voting':
        return `voting:${g}:${S.round.index}`;
      case 'verdict':
        return `verdict:${g}:${S.round.index}`;
      case 'reveal':
        return `reveal:${g}`;
      default:
        return 'lobby';
    }
  }

  const SCREENS = {
    home: HomeScreen,
    loading: LoadingScreen,
    replaced: ReplacedScreen,
    lobby: LobbyScreen,
    writing: WritingScreen,
    voting: VotingScreen,
    verdict: VerdictScreen,
    reveal: RevealScreen,
  };

  function render(force = false) {
    const key = screenKey();
    if (force || !current || current.key !== key) {
      current?.destroy?.();
      const screen = SCREENS[key.split(':')[0]](S);
      screen.key = key;
      appEl.replaceChildren(screen.el);
      appEl.className = screen.wide ? 'is-wide' : '';
      const fresh = !current || current.key !== key;
      current = screen;
      if (fresh) window.scrollTo(0, 0);
    } else {
      current.update?.(S);
    }
    renderTopbar();
  }

  function frame() {
    current?.tick?.();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- top bar ----------

  const ICONS = {
    soundOn:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    soundOff:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9.5l5 5M22 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="19" cy="12" r="2.2" fill="currentColor"/></svg>',
  };
  const icon = (name) => {
    const span = h('span.icon');
    span.innerHTML = ICONS[name];
    return span;
  };

  let topbarSig = '';
  function renderTopbar() {
    const sig = [lang, SFX.muted, !!S, S?.code, isHost(), S?.phase === 'lobby'].join('|');
    if (sig === topbarSig) return;
    topbarSig = sig;

    const langGroup = h(
      'div.lang',
      { role: 'group', 'aria-label': t('language') },
      ['en', 'fr'].map((code) =>
        h(
          'button.lang-btn',
          {
            type: 'button',
            'aria-pressed': String(code === lang),
            lang: code,
            onclick: () => {
              if (code === lang) return;
              lang = code;
              local.set('wdt-lang', code);
              document.documentElement.lang = code;
              SFX.click();
              render(true);
            },
          },
          code.toUpperCase(),
        ),
      ),
    );

    const soundBtn = h(
      'button.icon-btn',
      {
        type: 'button',
        'aria-label': SFX.muted ? t('soundOff') : t('soundOn'),
        title: SFX.muted ? t('soundOff') : t('soundOn'),
        onclick: () => {
          SFX.muted = !SFX.muted;
          SFX.click();
          renderTopbar();
        },
      },
      icon(SFX.muted ? 'soundOff' : 'soundOn'),
    );

    let menu = null;
    if (S) {
      const items = [
        h('button.menu-item', {
          type: 'button',
          text: t('leave'),
          onclick: async () => {
            menu.open = false;
            if (!window.confirm(t('leaveConfirm'))) return;
            await send('room:leave');
            leaveRoomLocally();
          },
        }),
      ];
      if (isHost() && S.phase !== 'lobby') {
        items.unshift(
          h('button.menu-item', {
            type: 'button',
            text: t('endGame'),
            onclick: () => {
              menu.open = false;
              if (window.confirm(t('endConfirm'))) act('game:end');
            },
          }),
        );
      }
      menu = h(
        'details.menu',
        null,
        h('summary.icon-btn', { 'aria-label': t('menu'), title: t('menu') }, icon('menu')),
        h('div.menu-list', null, items),
      );
    }

    const parts = [
      S ? h('span.brand', { text: 'Who did that?' }) : h('span'),
      h('span.spacer'),
      S && h('span.code-chip', { 'aria-label': `${t('gameCode')}: ${S.code}`, text: S.code }),
      langGroup,
      soundBtn,
      menu,
    ];
    topbarEl.replaceChildren(...parts.filter(Boolean));
  }

  document.addEventListener('click', (e) => {
    const menu = topbarEl.querySelector('.menu[open]');
    if (menu && !menu.contains(e.target)) menu.open = false;
  });

  // ---------- shared pieces ----------

  function caseCard(text, tabText, { compact = false, extra = null } = {}) {
    return h(
      `article.case${compact ? '.case--compact' : ''}`,
      null,
      tabText && h('span.case-tab', { text: tabText }),
      extra,
      h('p.case-text', { text }),
    );
  }

  function suspectEl(p, { no, onPick, tags = [], onKick } = {}) {
    const inner = [
      no != null && h('span.suspect-no', { 'aria-hidden': 'true', text: String(no) }),
      h('span.suspect-face', { 'aria-hidden': 'true', text: p.avatar }),
      h('span.suspect-plate', { text: p.name }),
      h('span.suspect-meta', null, tags.map((tag) => h('span.tag', { text: tag }))),
    ];
    const el = onPick
      ? h('button.suspect', { type: 'button', 'aria-pressed': 'false', onclick: () => onPick(p.id) }, inner)
      : h('div.suspect', { role: 'listitem' }, inner);
    if (!p.connected) el.classList.add('is-offline');
    if (onKick) {
      el.append(
        h('button.kick', {
          type: 'button',
          'aria-label': t('kick', { name: p.name }),
          title: t('kick', { name: p.name }),
          text: '×',
          onclick: onKick,
        }),
      );
    }
    return el;
  }

  // A police lineup: suspects standing in front of a height chart.
  function Lineup(people, { onPick = null, label = '', tagsFor = null, kickFor = null } = {}) {
    const ruler = h(
      'div.ruler',
      { 'aria-hidden': 'true' },
      Array.from({ length: 21 }, (_, i) => h('span', { text: String(200 - i * 10) })),
    );
    const grid = h('div.lineup-grid', onPick ? { role: 'group', 'aria-label': label } : { role: 'list', 'aria-label': label });
    const items = new Map();
    people.forEach((p, i) => {
      const el = suspectEl(p, { no: i + 1, onPick, tags: tagsFor ? tagsFor(p) : [], onKick: kickFor ? kickFor(p) : null });
      items.set(p.id, el);
      grid.append(el);
    });
    const el = h('div.lineup', null, ruler, grid);
    return {
      el,
      items,
      pick(id) {
        el.classList.toggle('has-pick', !!id);
        for (const [pid, item] of items) {
          const on = pid === id;
          item.classList.toggle('is-picked', on);
          if (item.tagName === 'BUTTON') item.setAttribute('aria-pressed', String(on));
        }
      },
      disable(flag) {
        for (const item of items.values()) if (item.tagName === 'BUTTON') item.disabled = flag;
      },
      meta(id, text) {
        const slot = items.get(id)?.querySelector('.suspect-meta');
        if (slot) slot.textContent = text;
      },
    };
  }

  function timerRing(totalMs) {
    const R = 28;
    const C = 2 * Math.PI * R;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(svgNS, 'circle');
    const fill = document.createElementNS(svgNS, 'circle');
    for (const c of [track, fill]) {
      c.setAttribute('cx', '32');
      c.setAttribute('cy', '32');
      c.setAttribute('r', String(R));
    }
    track.setAttribute('class', 'timer-track');
    fill.setAttribute('class', 'timer-fill');
    fill.setAttribute('stroke-dasharray', String(C));
    svg.append(track, fill);
    const num = h('span.timer-num');
    const el = h('div.timer', { role: 'timer' }, svg, num);
    return {
      el,
      set(remainingMs) {
        const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
        fill.setAttribute('stroke-dashoffset', String(C * (1 - frac)));
        num.textContent = String(Math.ceil(remainingMs / 1000));
      },
    };
  }

  function dock(...children) {
    return h('div.dock', null, h('div.dock-inner', null, children));
  }

  const waitingLine = (text) => h('p.waiting', null, h('span.pulse-dot', { 'aria-hidden': 'true' }), h('span', { text }));

  // ---------- screens ----------

  function LoadingScreen() {
    return { el: h('section.screen.loading', null, waitingLine(t('loading'))) };
  }

  function ReplacedScreen() {
    return {
      el: h(
        'section.screen.replaced',
        null,
        h('h2.screen-title', { text: t('replacedTitle') }),
        h('p.lede', { text: t('replacedBody') }),
        h('div.stack', null,
          h('button.btn.btn-primary', {
            type: 'button',
            text: t('playHere'),
            onclick: () => {
              offRoom = 'loading';
              render();
              resume(true);
            },
          }),
          h('button.btn.btn-ghost', {
            type: 'button',
            text: t('joinAsNew'),
            onclick: () => {
              const seat = readSeat(local);
              clearSeat();
              if (seat) setUrlRoom(seat.code);
              offRoom = 'home';
              render();
            },
          }),
        ),
      ),
    };
  }

  function HomeScreen() {
    const code = urlRoom();
    const profile = loadProfile();
    let avatar = AVATARS.includes(profile.avatar) ? profile.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
    let busy = false;

    const nameInput = h('input.field', {
      id: 'player-name',
      type: 'text',
      maxlength: '16',
      autocomplete: 'nickname',
      autocapitalize: 'words',
      spellcheck: 'false',
      placeholder: t('namePh'),
      value: profile.name || '',
      enterkeyhint: 'go',
    });
    const remember = () => saveProfile({ name: nameInput.value.trim(), avatar });
    nameInput.addEventListener('input', remember);

    const faces = h(
      'div.faces',
      { role: 'group', 'aria-label': t('pickFace') },
      AVATARS.map((a) =>
        h('button.face', {
          type: 'button',
          'aria-pressed': String(a === avatar),
          'aria-label': a,
          text: a,
          onclick: (e) => {
            avatar = a;
            for (const b of faces.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            SFX.click();
            remember();
          },
        }),
      ),
    );

    const codeInput = h('input.field.field--code', {
      type: 'text',
      maxlength: '4',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'ABCD',
      'aria-label': t('codeLabel'),
      enterkeyhint: 'go',
    });
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
    });

    const buttons = [];
    const btn = (cls, text, kind) => {
      const b = h(`button.btn.${cls}`, { type: kind === 'submit' ? 'submit' : 'button', text });
      buttons.push(b);
      return b;
    };

    async function go(kind) {
      if (busy) return;
      const name = nameInput.value.trim();
      if (!name) {
        toast(t('err_name_required'), 'error');
        nameInput.focus();
        return;
      }
      const roomCode = kind === 'join' ? (code || codeInput.value).trim().toUpperCase() : null;
      if (kind === 'join' && !roomCode) {
        toast(t('err_code_required'), 'error');
        codeInput.focus();
        return;
      }
      busy = true;
      buttons.forEach((b) => (b.disabled = true));
      remember();
      SFX.click();
      const res = await send(kind === 'join' ? 'room:join' : 'room:create', { name, avatar, code: roomCode });
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
      if (!res.ok) return fail(res);
      saveSeat({ code: res.code, playerId: res.playerId, token: res.token });
      setUrlRoom(res.code);
    }

    let actions;
    if (code) {
      const joinBtn = btn('btn-primary.btn-block', t('joinGame'), 'submit');
      const other = h('button.link-btn', {
        type: 'button',
        text: t('createInstead'),
        onclick: () => {
          setUrlRoom(null);
          render(true);
        },
      });
      actions = h('div.home-actions', null, h('p.invite-note', { text: t('joinTitle', { code }) }), joinBtn, other);
    } else {
      const createBtn = btn('btn-primary.btn-block', t('createGame'), 'submit');
      const joinBtn = btn('btn-ghost', t('join'));
      joinBtn.addEventListener('click', () => go('join'));
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go('join');
        }
      });
      actions = h(
        'div.home-actions',
        null,
        createBtn,
        h('div.join-row', null, h('label.join-label', { text: t('haveCode') }), h('div.join-inputs', null, codeInput, joinBtn)),
      );
    }

    const form = h(
      'form.home-form',
      {
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          go(code ? 'join' : 'create');
        },
      },
      h('label.field-label', { for: 'player-name', text: t('yourName') }),
      nameInput,
      h('p.field-label', { id: 'faces-label', text: t('pickFace') }),
      faces,
      actions,
    );

    const words = ['Who', 'did', 'that?'];
    const hero = h(
      'h1.hero',
      { 'aria-label': 'Who did that?' },
      words.map((w, i) =>
        h(
          'span.hero-line',
          { 'aria-hidden': 'true', style: `--i:${i}` },
          h('span.hero-word', { text: w }),
          h('span.hero-mark', { text: String(200 - i * 20) }),
        ),
      ),
    );

    const el = h(
      'section.screen.home',
      null,
      hero,
      h('p.lede.home-lede', null, t('heroTagline'), ' ', h('strong', { text: t('heroRule') })),
      form,
    );
    return { el };
  }

  function LobbyScreen(st) {
    const link = h('input.link-input', { readonly: true, 'aria-label': t('invite') });
    const copyBtn = h('button.btn.btn-ghost.btn-small', { type: 'button', text: t('copy'), onclick: copyLink });
    const shareBtn = navigator.share
      ? h('button.btn.btn-ghost.btn-small', {
          type: 'button',
          text: t('share'),
          onclick: () => navigator.share({ title: 'Who did that?', text: t('shareText'), url: link.value }).catch(() => {}),
        })
      : null;
    const localNote = h('p.note');
    const listTitle = h('h2.section-title');
    const listSlot = h('div');
    const dockSlot = h('div.slot');

    async function copyLink() {
      const ok = await navigator.clipboard?.writeText(link.value).then(() => true, () => false);
      if (!ok) {
        link.select();
        attempt(() => document.execCommand('copy'));
      }
      SFX.click();
      toast(t('copied'));
    }
    link.addEventListener('focus', () => link.select());

    const el = h(
      'section.screen.lobby',
      null,
      h('div.code-block', null,
        h('p.code-label', { text: t('gameCode') }),
        h('p.room-code', { text: st.code }),
      ),
      h('div.invite', null,
        h('p.invite-label', { text: t('invite') }),
        h('div.invite-row', null, link, copyBtn, shareBtn),
        localNote,
      ),
      listTitle,
      listSlot,
      h('section.steps', null,
        h('h2.section-title', { text: t('stepsTitle') }),
        h('ol.steps-list', null, ['step1', 'step2', 'step3'].map((k) => h('li', { text: t(k) }))),
      ),
      dockSlot,
    );

    function update(st) {
      link.value = `${st.publicUrl || location.origin}/?room=${st.code}`;
      const localOnly = !st.publicUrl && LOCAL_HOSTS.has(location.hostname);
      localNote.hidden = !localOnly;
      localNote.textContent = localOnly ? t('localOnly') : '';

      listTitle.textContent = t('suspects', { n: st.players.length });
      const host = isHost();
      const lineup = Lineup(st.players, {
        label: t('suspects', { n: st.players.length }),
        tagsFor: (p) =>
          [p.id === st.you && t('tagYou'), p.id === st.hostId && t('tagHost'), !p.connected && t('tagOffline')].filter(Boolean),
        kickFor: (p) => (host && p.id !== st.you ? () => act('player:kick', { playerId: p.id }) : null),
      });
      listSlot.replaceChildren(lineup.el);

      const online = st.players.filter((p) => p.connected).length;
      const enough = online >= st.rules.minPlayers;
      if (host) {
        dockSlot.replaceChildren(
          dock(
            !enough && h('p.dock-note', { text: t('needPlayers', { n: st.rules.minPlayers }) }),
            h('button.btn.btn-primary.btn-block', {
              type: 'button',
              disabled: !enough,
              text: t('start'),
              onclick: () => {
                SFX.click();
                act('game:start');
              },
            }),
          ),
        );
      } else {
        dockSlot.replaceChildren(dock(waitingLine(t('waitStart', { name: hostName() }))));
      }
    }
    update(st);
    return { el, update };
  }

  function WritingScreen(st) {
    const gameNo = st.game.no;
    if (draft.game !== gameNo) draft = { game: gameNo, text: '' };
    const max = st.rules.maxText;

    const ta = h('textarea.case-input', {
      maxlength: String(max),
      rows: '6',
      placeholder: t('writePh'),
      'aria-label': t('writeTitle'),
    });
    ta.value = draft.text;
    const counter = h('span.counter', { 'aria-hidden': 'true' });
    const syncCounter = () => {
      counter.textContent = `${ta.value.length} / ${max}`;
      counter.classList.toggle('is-near', ta.value.length > max - 30);
    };
    ta.addEventListener('input', () => {
      draft.text = ta.value;
      syncCounter();
    });
    syncCounter();

    let busy = false;
    const lockBtn = h('button.btn.btn-primary.btn-block', {
      type: 'button',
      text: t('lockIn'),
      onclick: async () => {
        if (busy) return;
        const text = ta.value.trim();
        if (!text) {
          toast(t('err_text_required'), 'error');
          ta.focus();
          return;
        }
        busy = true;
        const res = await act('anecdote:submit', { text });
        busy = false;
        if (res.ok) SFX.lock();
      },
    });

    const editor = h(
      'div.editor',
      null,
      h('div.case.case--input', null, h('span.case-tab', { text: t('yourAnecdote') }), ta, counter),
      lockBtn,
    );

    const lockedText = h('p.case-text');
    const locked = h(
      'div.locked',
      null,
      h('article.case', null, h('span.case-tab', { text: t('yourAnecdote') }), lockedText, h('span.ink-stamp', { text: t('lockedIn') })),
      h('button.btn.btn-ghost', {
        type: 'button',
        text: t('edit'),
        onclick: async () => {
          const mine = S?.writing?.mine || '';
          const res = await act('anecdote:retract');
          if (res.ok) {
            draft.text = mine;
            ta.value = mine;
            syncCounter();
            requestAnimationFrame(() => ta.focus());
          }
        },
      }),
    );

    const watching = h('p.notice', { text: t('watching') });
    const progressLabel = h('p.progress-label');
    const progressFaces = h('div.progress-faces');
    const dockSlot = h('div.slot');

    const el = h(
      'section.screen.writing',
      null,
      h('h2.screen-title', { text: t('writeTitle') }),
      h('p.lede', { text: t('writeHint') }),
      watching,
      editor,
      locked,
      h('div.progress', null, progressLabel, progressFaces),
      dockSlot,
    );

    let wasEditing = null;
    function update(st) {
      const inGame = st.game.participants.includes(st.you);
      const mine = st.writing.mine;
      const editing = inGame && mine == null;
      watching.hidden = inGame;
      editor.hidden = !editing;
      locked.hidden = !inGame || editing;
      if (mine != null) lockedText.textContent = mine;
      if (editing && wasEditing === null) requestAnimationFrame(() => ta.focus({ preventScroll: true }));
      wasEditing = editing;

      const ready = st.writing.ready;
      const people = st.game.participants.map(player).filter(Boolean);
      progressLabel.textContent = t('ready', { x: ready.length, y: people.length });
      progressFaces.replaceChildren(
        ...people.map((p) =>
          h(
            'span.mini',
            { class: ready.includes(p.id) ? 'is-done' : '', title: p.name },
            h('span.mini-face', { 'aria-hidden': 'true', text: p.avatar }),
            h('span.mini-name', { text: p.name }),
          ),
        ),
      );

      const canForce = isHost() && ready.length >= st.rules.minAnecdotes && ready.length < people.length;
      dockSlot.replaceChildren(
        canForce
          ? dock(
              h('button.btn.btn-ghost.btn-block', {
                type: 'button',
                text: t('forceVote', { n: ready.length }),
                onclick: () => act('game:forceVote'),
              }),
            )
          : '',
      );
    }
    update(st);
    return { el, update };
  }

  function VotingScreen(st) {
    let r = st.round;
    const voteMs = st.rules.voteMs;
    const inGame = st.game.participants.includes(st.you);
    const people = st.game.participants.filter((id) => id !== st.you).map(player).filter(Boolean);
    let myVote = r.myVote;
    let lastSecond = null;
    let closed = false;

    const ring = timerRing(voteMs);
    const lineup = Lineup(people, { onPick: inGame ? choose : null, label: t('whoDid') });
    if (!inGame) lineup.el.classList.add('is-readonly');
    const progress = h('p.progress-label', { 'aria-live': 'polite' });

    function choose(id) {
      if (closed) return;
      myVote = id;
      lineup.pick(id);
      SFX.lock();
      send('vote', { suspectId: id }).then((res) => {
        if (!res.ok && res.error !== 'wrong_phase') fail(res);
      });
    }

    const el = h(
      'section.screen.voting',
      null,
      caseCard(r.text, t('caseOf', { n: r.index + 1, total: r.total }), { extra: ring.el }),
      h('h2.ask', { text: t('whoDid') }),
      h('p.lede.ask-hint', { text: inGame ? t('tapHint') : t('spectatorHint') }),
      lineup.el,
      progress,
    );

    function update(st) {
      r = st.round;
      if (r.myVote && r.myVote !== myVote) myVote = r.myVote;
      lineup.pick(myVote);
      const voted = r.voted.filter((id) => r.voters.includes(id)).length;
      const all = r.voters.length > 0 && voted >= r.voters.length;
      if (!closed) progress.textContent = all ? t('allVoted') : t('votedCount', { x: voted, y: r.voters.length });
    }

    function tick() {
      const remaining = Math.max(0, r.deadline - now());
      ring.set(remaining);
      const second = Math.ceil(remaining / 1000);
      if (second !== lastSecond) {
        lastSecond = second;
        const urgent = second <= 10;
        ring.el.classList.toggle('is-urgent', urgent);
        ring.el.setAttribute('aria-label', `${second}`);
        if (urgent && second > 0) SFX.tick(second <= 5);
      }
      if (remaining <= 0 && !closed) {
        closed = true;
        lineup.disable(true);
        progress.textContent = t('timeUp');
      }
    }

    update(st);
    tick();
    return { el, update, tick, wide: true };
  }

  function VerdictScreen(st) {
    const r = st.round;
    const key = `${st.game.no}:${r.index}`;
    const people = st.game.participants.map(player).filter(Boolean);
    const lineup = Lineup(people, { label: t('accuses') });
    const isLast = r.index + 1 >= r.total;

    const label = h('p.verdict-label');
    const face = h('span.verdict-face', { 'aria-hidden': 'true' });
    const name = h('span.verdict-name');
    const count = h('p.verdict-count');
    const head = h('div.verdict', { 'aria-live': 'polite' }, label, h('p.verdict-who', null, face, name), count);
    const dockSlot = h('div.slot');

    const el = h(
      'section.screen.verdict-screen',
      null,
      caseCard(r.text, t('caseOf', { n: r.index + 1, total: r.total }), { compact: true }),
      head,
      lineup.el,
      dockSlot,
    );

    let alive = true;

    function land() {
      el.classList.remove('is-suspense');
      for (const p of people) lineup.meta(p.id, r.tally[p.id] ? tn('votes', r.tally[p.id]) : '');
      if (!r.accusedId) {
        label.textContent = t('noVotes');
        face.textContent = '';
        name.textContent = '';
        count.textContent = '';
        lineup.pick(null);
        return;
      }
      const accused = player(r.accusedId);
      label.textContent = t('accuses');
      face.textContent = accused?.avatar || '';
      name.textContent = accused?.name || '?';
      count.textContent = [tn('votes', r.tally[r.accusedId] || 0), r.tieIds.length ? t('tiePicked') : '']
        .filter(Boolean)
        .join('. ');
      lineup.pick(r.accusedId);
      head.classList.add('is-landed');
    }

    async function play() {
      el.classList.add('is-suspense');
      const tie = r.tieIds.length > 1;
      label.textContent = tie ? t('tieDraw') : t('accuses');
      name.textContent = '?';
      const pool = tie ? r.tieIds : people.map((p) => p.id);
      SFX.drumroll(tie ? 2600 : 1900);
      if (tie) {
        let delay = 70;
        let i = 0;
        let spent = 0;
        while (spent < 2300) {
          lineup.pick(pool[i++ % pool.length]);
          await wait(delay);
          if (!alive) return;
          spent += delay;
          delay *= 1.13;
        }
      } else {
        const sweep = [...pool, ...pool.slice(0, -1).reverse()];
        const step = Math.max(70, Math.min(180, 1700 / sweep.length));
        for (const id of sweep) {
          lineup.pick(id);
          await wait(step);
          if (!alive) return;
        }
      }
      land();
      SFX.stamp();
    }

    function update(st) {
      if (isHost()) {
        dockSlot.replaceChildren(
          dock(
            h('button.btn.btn-primary.btn-block', {
              type: 'button',
              text: isLast ? t('toReveal') : t('nextCase'),
              onclick: () => {
                SFX.click();
                act('game:next');
              },
            }),
          ),
        );
      } else {
        dockSlot.replaceChildren(dock(waitingLine(t('waitHost', { name: hostName() }))));
      }
    }

    update(st);
    if (!r.accusedId || played.has(key) || reduceMotion.matches) {
      played.add(key);
      land();
      if (!r.accusedId && !played.has(`${key}:sfx`)) SFX.lose();
      played.add(`${key}:sfx`);
    } else {
      played.add(key);
      play();
    }
    return { el, update, wide: true, destroy: () => (alive = false) };
  }

  function rankFor(found, total) {
    if (!total || found === 0) return t('rank0');
    const ratio = found / total;
    if (ratio >= 1) return t('rank4');
    if (ratio >= 0.7) return t('rank3');
    if (ratio >= 0.4) return t('rank2');
    return t('rank1');
  }

  function RevealScreen(st) {
    const total = st.reveal.cases.length;
    let shown = st.reveal.revealed; // already-revealed cases appear without animation
    let cooling = false;

    const tally = h('p.reveal-tally', { 'aria-live': 'polite' });
    const summary = h('div.summary', { hidden: true });
    const dockSlot = h('div.slot');

    const rows = st.reveal.cases.map((c, i) => {
      const accused = c.accusedId ? player(c.accusedId) : null;
      const stamp = h('span.stamp', { 'aria-hidden': 'true' });
      const line = h('p.reveal-line');
      const card = h(
        'article.case.case--reveal.is-sealed',
        null,
        h('span.case-tab', { text: t('caseOf', { n: i + 1, total }) }),
        h('p.case-text', { text: c.text }),
        h(
          'p.reveal-accused',
          null,
          h('span.reveal-accused-label', { text: t('accusedLabel') }),
          accused
            ? [h('span.mini-face', { 'aria-hidden': 'true', text: accused.avatar }), h('strong', { text: accused.name })]
            : h('strong', { text: t('nobody') }),
        ),
        line,
        stamp,
      );
      return { card, stamp, line, accused };
    });

    function paint(i, c, animate) {
      const row = rows[i];
      row.card.classList.toggle('is-sealed', !c.revealed);
      if (!c.revealed) {
        row.stamp.textContent = t('sealed');
        row.line.textContent = '';
        return;
      }
      row.card.classList.add(c.correct ? 'is-right' : 'is-wrong');
      row.stamp.textContent = c.correct ? t('stampRight') : t('stampWrong');
      row.line.textContent = c.correct ? t('rightLine', { name: row.accused?.name || '' }) : t('wrongLine');
      if (!animate) return;
      row.card.classList.add('is-slam');
      row.card.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      setTimeout(() => SFX.stamp(), 120);
      setTimeout(() => {
        if (c.correct) {
          SFX.win();
          FX.fromElement(row.stamp, 90);
        } else {
          SFX.lose();
        }
      }, 380);
    }

    const el = h(
      'section.screen.reveal',
      null,
      h('h2.screen-title.reveal-title', { text: t('revealTitle') }),
      h('p.lede', { text: t('revealSub') }),
      tally,
      h('div.reveal-list', null, rows.map((r) => r.card)),
      summary,
      dockSlot,
    );

    function update(st) {
      const cases = st.reveal.cases;
      cases.forEach((c, i) => paint(i, c, c.revealed && i >= shown));
      const newlyDone = st.reveal.revealed === total && shown < total;
      shown = st.reveal.revealed;

      const found = cases.filter((c) => c.revealed && c.correct).length;
      const done = st.reveal.revealed === total;
      tally.textContent = done ? '' : t('foundSoFar', { x: found });
      tally.hidden = done;

      summary.hidden = !done;
      if (done) {
        summary.replaceChildren(
          h('p.summary-score', null, h('span', { text: String(found) }), h('span.summary-of', { text: ` / ${total}` })),
          h('p.summary-line', { text: t('finalScore', { x: found, y: total }) }),
          h('p.summary-rank', { text: rankFor(found, total) }),
        );
        if (newlyDone) {
          setTimeout(() => {
            summary.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
            if (found === total) {
              SFX.fanfare();
              FX.burst(window.innerWidth / 2, window.innerHeight / 2, 220, 1.4);
            }
          }, 1400);
        }
      }

      if (isHost()) {
        dockSlot.replaceChildren(
          dock(
            done
              ? h('button.btn.btn-primary.btn-block', {
                  type: 'button',
                  text: t('playAgain'),
                  onclick: () => {
                    SFX.click();
                    act('game:again');
                  },
                })
              : h('button.btn.btn-primary.btn-block', {
                  type: 'button',
                  text: t('revealNext'),
                  disabled: cooling,
                  onclick: async () => {
                    if (cooling) return;
                    cooling = true;
                    await act('reveal:next');
                    setTimeout(() => {
                      cooling = false;
                      if (current?.update) current.update(S);
                    }, 900);
                  },
                }),
          ),
        );
      } else {
        dockSlot.replaceChildren(dock(waitingLine(done ? t('waitAgain', { name: hostName() }) : t('waitHost', { name: hostName() }))));
      }
    }

    update(st);
    return { el, update };
  }

  // ---------- boot ----------

  const startSeat = readSeat(tab) || readSeat(local);
  const startCode = urlRoom();
  offRoom = startSeat && (!startCode || startCode === startSeat.code) ? 'loading' : 'home';
  render();
})();
