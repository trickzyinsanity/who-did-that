// Game-show sound effects, synthesized with Web Audio so there are no files to load.
(() => {
  'use strict';

  const KEY = 'wdt-muted';
  let muted = false;
  try {
    muted = localStorage.getItem(KEY) === '1';
  } catch {}

  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, { type = 'sine', dur = 0.15, vol = 0.2, at = 0, to = null, attack = 0.006 } = {}) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise({ dur = 0.1, vol = 0.2, at = 0, freq = 1500, q = 0.8, type = 'bandpass' } = {}) {
    const c = audio();
    if (!c) return;
    if (!noiseBuffer) {
      noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + at;
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();
    src.buffer = noiseBuffer;
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t0, Math.random() * 0.4);
    src.stop(t0 + dur + 0.02);
  }

  const sound = (fn) => (...args) => {
    if (muted) return;
    try {
      fn(...args);
    } catch {}
  };

  const SFX = {
    click: sound(() => tone(720, { type: 'triangle', dur: 0.05, vol: 0.1 })),
    lock: sound(() => {
      tone(523, { type: 'triangle', dur: 0.09, vol: 0.16 });
      tone(784, { type: 'triangle', dur: 0.18, vol: 0.16, at: 0.07 });
    }),
    join: sound(() => tone(380, { type: 'sine', dur: 0.14, vol: 0.18, to: 920 })),
    tick: sound((urgent) => {
      tone(urgent ? 1320 : 990, { type: 'square', dur: 0.035, vol: urgent ? 0.08 : 0.05 });
      noise({ dur: 0.02, vol: 0.06, freq: 4200 });
    }),
    whoosh: sound(() => {
      noise({ dur: 0.45, vol: 0.16, freq: 900, q: 0.6 });
      tone(180, { type: 'sine', dur: 0.4, vol: 0.1, to: 540 });
    }),
    start: sound(() => {
      [392, 523, 659, 784].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.2, vol: 0.14, at: i * 0.08 }));
    }),
    drumroll: sound((ms = 2000) => {
      const total = ms / 1000;
      for (let t = 0; t < total; t += 0.045) {
        noise({ dur: 0.06, vol: 0.04 + 0.22 * (t / total), at: t, freq: 2300, q: 0.7 });
      }
    }),
    stamp: sound(() => {
      tone(130, { type: 'sine', dur: 0.32, vol: 0.5, to: 45 });
      noise({ dur: 0.14, vol: 0.35, freq: 900, q: 0.5, type: 'lowpass' });
    }),
    win: sound(() => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.32, vol: 0.16, at: i * 0.09 }));
      tone(1568, { type: 'sine', dur: 0.7, vol: 0.07, at: 0.38 });
    }),
    lose: sound(() => {
      tone(330, { type: 'sawtooth', dur: 0.3, vol: 0.1, to: 300 });
      tone(262, { type: 'sawtooth', dur: 0.6, vol: 0.1, at: 0.32, to: 196 });
    }),
    fanfare: sound(() => {
      const notes = [523, 523, 523, 659, 784, 659, 784, 1047];
      notes.forEach((f, i) => tone(f, { type: 'triangle', dur: 0.22, vol: 0.15, at: i * 0.11 }));
      tone(262, { type: 'sine', dur: 1.2, vol: 0.12, at: 0.33 });
    }),
    get muted() {
      return muted;
    },
    set muted(value) {
      muted = !!value;
      try {
        localStorage.setItem(KEY, muted ? '1' : '0');
      } catch {}
      if (!muted) audio();
    },
  };

  // Browsers only allow audio after the first tap or key press.
  const unlock = () => {
    if (!muted) audio();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  window.SFX = SFX;
})();
