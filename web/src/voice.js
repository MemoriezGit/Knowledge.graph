import { api } from './api.js';

/**
 * Speech out and speech in.
 *
 * Two output paths:
 *  - "server": OpenAI TTS. Real audio, so amplitude comes from a WebAudio
 *    analyser and the 3D core genuinely pulses to the voice.
 *  - "browser": Web Speech API. No audio graph to tap, so amplitude is
 *    synthesised from word-boundary events — close enough to read as speech.
 *
 * Text arrives as a stream, so we buffer and flush on sentence boundaries;
 * speaking half a clause at a time sounds broken.
 */
export class Voice {
  constructor({ onAmplitude = () => {}, onStateChange = () => {} } = {}) {
    this.onAmplitude = onAmplitude;
    this.onStateChange = onStateChange;
    this.mode = 'browser';
    this.enabled = true;
    this.buffer = '';
    this.queue = [];
    this.speaking = false;
    this.audioCtx = null;
    this.analyser = null;
    this.currentAudio = null;
    this.currentUtterance = null;
    this.rafId = null;
    this.decay = 0;
    this.rate = 1.02;
    this.pitch = 1.0;
    this.browserVoice = null;

    if ('speechSynthesis' in window) {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return;
        // Prefer a natural-sounding English voice when the platform offers one.
        this.browserVoice =
          voices.find((v) => /en/i.test(v.lang) && /natural|neural|premium|enhanced/i.test(v.name)) ||
          voices.find((v) => /en-US|en-GB/i.test(v.lang)) ||
          voices.find((v) => /^en/i.test(v.lang)) ||
          voices[0];
      };
      pick();
      window.speechSynthesis.onvoiceschanged = pick;
    }
  }

  setMode(mode) {
    this.mode = mode === 'server' ? 'server' : 'browser';
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }

  /** Must be called from a user gesture for the analyser path to work. */
  unlockAudio() {
    if (this.audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.audioCtx = new Ctx();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.75;
    this.analyser.connect(this.audioCtx.destination);
  }

  /** Feed streaming text; complete sentences are spoken as they land. */
  feed(delta) {
    if (!this.enabled) return;
    this.buffer += delta;
    let match;
    // Flush at sentence-ending punctuation followed by whitespace, or a newline.
    while ((match = this.buffer.match(/^([\s\S]*?[.!?…](?=\s)|[\s\S]*?\n)/))) {
      const chunk = match[1];
      this.buffer = this.buffer.slice(chunk.length);
      this._enqueue(chunk);
    }
    // Don't let a long unpunctuated run sit silent forever.
    if (this.buffer.length > 220) {
      const cut = this.buffer.lastIndexOf(' ', 200);
      if (cut > 60) {
        this._enqueue(this.buffer.slice(0, cut));
        this.buffer = this.buffer.slice(cut);
      }
    }
  }

  flush() {
    if (this.buffer.trim()) this._enqueue(this.buffer);
    this.buffer = '';
  }

  speak(text) {
    this._enqueue(text);
  }

  _enqueue(raw) {
    const text = cleanForSpeech(raw);
    if (!text) return;
    this.queue.push(text);
    if (!this.speaking) this._drain();
  }

  async _drain() {
    if (this.speaking) return;
    const next = this.queue.shift();
    if (!next) {
      this._setSpeaking(false);
      return;
    }
    this._setSpeaking(true);
    try {
      if (this.mode === 'server') await this._speakServer(next);
      else await this._speakBrowser(next);
    } catch (err) {
      console.warn('[voice]', err.message);
      // A failed premium call shouldn't leave the user in silence.
      if (this.mode === 'server') {
        this.mode = 'browser';
        try {
          await this._speakBrowser(next);
        } catch {
          /* give up on this chunk */
        }
      }
    }
    this.speaking = false;
    if (this.queue.length) this._drain();
    else this._setSpeaking(false);
  }

  _setSpeaking(on) {
    if (on) {
      this.speaking = true;
      this.onStateChange('speaking');
    } else {
      this.speaking = false;
      this.onAmplitude(0);
      this.onStateChange('idle');
    }
  }

  async _speakServer(text) {
    const blob = await api.tts(text);
    this.unlockAudio();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    this.currentAudio = audio;

    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      const source = this.audioCtx.createMediaElementSource(audio);
      source.connect(this.analyser);
      this._trackAmplitude();
    }

    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error('audio playback failed'));
      audio.play().catch(reject);
    }).finally(() => {
      URL.revokeObjectURL(url);
      this.currentAudio = null;
      cancelAnimationFrame(this.rafId);
      this.onAmplitude(0);
    });
  }

  _trackAmplitude() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.currentAudio) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      this.onAmplitude(Math.min(1, rms * 3.2));
      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  _speakBrowser(text) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      if (this.browserVoice) utter.voice = this.browserVoice;
      utter.rate = this.rate;
      utter.pitch = this.pitch;
      this.currentUtterance = utter;

      // No audio graph to analyse here — approximate amplitude by kicking a
      // decaying envelope on every word boundary.
      const decayTick = () => {
        if (!this.currentUtterance) return;
        this.decay = Math.max(0, this.decay - 0.045);
        this.onAmplitude(this.decay);
        this.rafId = requestAnimationFrame(decayTick);
      };
      decayTick();

      utter.onboundary = () => {
        this.decay = 0.55 + Math.random() * 0.4;
      };
      const finish = () => {
        this.currentUtterance = null;
        cancelAnimationFrame(this.rafId);
        this.onAmplitude(0);
        resolve();
      };
      utter.onend = finish;
      utter.onerror = finish;

      window.speechSynthesis.speak(utter);
    });
  }

  cancel() {
    this.queue = [];
    this.buffer = '';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.currentUtterance = null;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    cancelAnimationFrame(this.rafId);
    this._setSpeaking(false);
  }
}

/** TTS reads markup literally, so strip it before speaking. */
export function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Microphone → text, using the browser's built-in recogniser. */
export class Ears {
  constructor({ onResult = () => {}, onInterim = () => {}, onStateChange = () => {} } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.listening = false;
    this.onStateChange = onStateChange;
    if (!this.supported) return;

    this.recognition = new SR();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language || 'en-US';

    this.recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += chunk;
        else interim += chunk;
      }
      if (interim) onInterim(interim);
      if (final.trim()) onResult(final.trim());
    };
    this.recognition.onend = () => {
      this.listening = false;
      this.onStateChange(false);
    };
    this.recognition.onerror = () => {
      this.listening = false;
      this.onStateChange(false);
    };
  }

  start() {
    if (!this.supported || this.listening) return;
    try {
      this.recognition.start();
      this.listening = true;
      this.onStateChange(true);
    } catch {
      /* start() throws if already running — harmless */
    }
  }

  stop() {
    if (!this.supported || !this.listening) return;
    this.recognition.stop();
  }

  toggle() {
    this.listening ? this.stop() : this.start();
  }
}
