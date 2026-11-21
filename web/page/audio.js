// Sound for the game (docs/web.md, crates/horizon-client/src/audio/web.rs).
//
// The game mixes its own sound (every source, its panning and its limiter);
// this file is the speaker. A timer asks the game for the next samples a
// little ahead of the clock and schedules them on an AudioContext, one small
// buffer after the other. The lead is short (a block breaks, you hear it) and
// grows a step whenever a long frame made the output run dry.
//
// A browser opens sound only after a click or a key: until then the context
// waits, and the first one starts it. A hidden tab is silent.
//
// Music and records are decoded by the browser, off the game's one thread
// (`decode`), and handed back as mono samples.

import { state } from './std.js';

const FRAMES = 1024;             // one scheduled buffer
const LEAD_MIN = 0.07;           // seconds mixed ahead of the clock
const LEAD_MAX = 0.3;
const TICK = 10;                 // milliseconds between timer runs

let exports = null;
let context = null;
let nextFrame = 0;               // the context frame the next buffer starts at
let lead = LEAD_MIN;
const mixed = new Float32Array(FRAMES * 2);
const stats = { buffers: 0, dry: 0, peak: 0, decoded: 0, failed: 0, state: 'off' };

function tick() {
  if (!exports) return;
  exports.horizon_audio_pump();
  if (!context || context.state !== 'running') return;
  const rate = context.sampleRate;
  const now = context.currentTime;
  if (nextFrame / rate < now + 0.004) {
    // Behind the clock: a long frame, or the output just (re)started.
    if (nextFrame) {
      stats.dry += 1;
      lead = Math.min(LEAD_MAX, lead + 0.03);
    }
    nextFrame = Math.ceil((now + 0.02) * rate);
  }
  while (nextFrame / rate < now + lead) {
    exports.horizon_audio_mix(mixed, rate);
    const buffer = context.createBuffer(2, FRAMES, rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let peak = 0;
    for (let i = 0; i < FRAMES; i++) {
      const l = mixed[2 * i];
      left[i] = l;
      right[i] = mixed[2 * i + 1];
      if (l > peak) peak = l; else if (-l > peak) peak = -l;
    }
    if (peak > stats.peak) stats.peak = peak;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(nextFrame / rate);
    nextFrame += FRAMES;
    stats.buffers += 1;
  }
}

function open() {
  if (context) return true;
  const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContext) return false;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
  } catch (e) {
    console.warn('Horizon: no sound output', e);
    return false;
  }
  const resume = () => {
    if (context.state === 'suspended' && !document.hidden) context.resume().catch(() => {});
  };
  for (const type of ['pointerdown', 'keydown', 'touchend']) {
    addEventListener(type, resume, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) context.suspend().catch(() => {});
    else resume();
  });
  context.addEventListener('statechange', () => {
    stats.state = context.state;
    nextFrame = 0;
  });
  stats.state = context.state;
  resume();
  return true;
}

// Mono samples of an Ogg file, by the browser's decoder.
async function decodeMono(data) {
  const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
  if (decoded.numberOfChannels === 1) return [decoded.getChannelData(0), decoded.sampleRate];
  // A one-channel render mixes the channels down, off this thread too.
  const down = new OfflineAudioContext(1, decoded.length, decoded.sampleRate);
  const source = down.createBufferSource();
  source.buffer = decoded;
  source.connect(down.destination);
  source.start();
  return [(await down.startRendering()).getChannelData(0), decoded.sampleRate];
}

globalThis.horizonAudio = {
  // The game opens its output; whether there is one.
  start: () => open(),
  // The game hands a music file over; the answer is `horizon_audio_decoded`.
  decode(job, bytes, done) {
    if (!exports || typeof OfflineAudioContext !== 'function') return false;
    // Copied out: the bytes are in the game's memory, which may move.
    const data = bytes.slice().buffer;
    decodeMono(data).then(([samples, rate]) => {
      stats.decoded += 1;
      done?.();
      exports.horizon_audio_decoded(job, samples, rate);
    }, (e) => {
      stats.failed += 1;
      console.warn('Horizon: the browser could not decode a sound, the game will', e);
      exports.horizon_audio_decoded(job, new Float32Array(0), 0);
    });
    return true;
  },
  // The same for a file of the game's own that the page still holds
  // (boot.js): it never enters the game's memory. 1: decoding; 0: the file is
  // on its way, ask again; -1: not the page's, read it yourself.
  decodeFile(job, path) {
    const file = state.files.get(path);
    if (typeof file?.peek !== 'function') return -1;
    const bytes = file.peek();
    if (!bytes) return 0;
    return this.decode(job, bytes, file.done) ? 1 : -1;
  },
  stats,
};

/// boot.js, once the game's module is up.
export function startAudio(gameExports) {
  exports = gameExports;
  setInterval(tick, TICK);
}
