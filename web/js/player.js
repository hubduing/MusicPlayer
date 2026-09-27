/* ============================================================================
   Плеер: очередь, перемешивание, повтор, визуализатор, Media Session,
   выравнивание громкости и восстановление позиции.
   ========================================================================= */
import { api, mediaUrl } from './api.js';
import { clamp } from './util.js';

const REPEAT_MODES = ['off', 'all', 'one'];

export class Player {
  constructor({ audio, canvas } = {}) {
    this.audio = audio;
    this.canvas = canvas;
    this.ctx2d = canvas?.getContext('2d') || null;

    this.queue = [];
    this.origin = [];
    this.index = -1;
    this.context = { type: 'library', id: null, name: 'Библиотека' };
    this.shuffle = false;
    this.repeat = 'off';
    this.normalize = false;
    this.showViz = true;
    this.seekStep = 5;

    this.playing = false;
    this.duration = 0;
    this.currentTime = 0;
    this.buffered = 0;
    this.failed = new Set();

    /** Заученная громкость трека (для выравнивания). */
    this.gains = new Map();
    this._listeners = new Map();
    this._playToken = 0;
    this._warm = null;
    this._vizFrame = null;
    this._lastTimeUpdate = 0;
    this._saveTimer = null;

    this._initAudio();
    this._initMediaSession();
    this._startViz();
  }

  // ------------------------------------------------------------ события

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this._listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (err) {
        console.error('[player]', event, err);
      }
    }
  }

  get current() {
    return this.queue[this.index] || null;
  }

  get state() {
    return {
      current: this.current,
      index: this.index,
      playing: this.playing,
      queue: this.queue,
      shuffle: this.shuffle,
      repeat: this.repeat,
      normalize: this.normalize,
      volume: this.audio.volume,
      muted: this.audio.muted,
      currentTime: this.currentTime,
      duration: this.duration || this.current?.duration || 0,
      buffered: this.buffered,
      context: this.context
    };
  }

  // ------------------------------------------------------------ аудиограф

  _initAudio() {
    const audio = this.audio;
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';

    audio.addEventListener('play', () => {
      this.playing = true;
      this.emit('state');
      this._updateMediaSession();
    });
    audio.addEventListener('pause', () => {
      this.playing = false;
      this.emit('state');
      this._updateMediaSession();
    });
    audio.addEventListener('loadedmetadata', () => {
      this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (this._pendingSeek > 0 && this.duration) {
        const target = clamp(this._pendingSeek, 0, Math.max(0, this.duration - 1));
        this._pendingSeek = 0;
        try {
          audio.currentTime = target;
        } catch {
          /* ignore */
        }
      }
      this.emit('state');
      this._updateMediaSession();
    });
    audio.addEventListener('durationchange', () => {
      this.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.emit('state');
    });
    audio.addEventListener('timeupdate', () => {
      this.currentTime = audio.currentTime;
      this._measure();
      const now = performance.now();
      if (now - this._lastTimeUpdate > 90) {
        this._lastTimeUpdate = now;
        this.emit('time', { time: audio.currentTime, duration: this.duration });
        this._updatePositionState();
        this._scheduleSavePosition();
      }
    });
    audio.addEventListener('progress', () => {
      try {
        this.buffered = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
      } catch {
        this.buffered = 0;
      }
      this.emit('buffered', { buffered: this.buffered });
    });
    audio.addEventListener('ended', () => this._handleEnded());
    audio.addEventListener('error', () => this._handleError());
    audio.addEventListener('waiting', () => this.emit('waiting', true));
    audio.addEventListener('playing', () => {
      this.emit('waiting', false);
      this.emit('state');
    });
    audio.addEventListener('volumechange', () => this.emit('state'));
  }

  /** Аудиограф нужен и для визуализатора, и для мягкого выравнивания громкости. */
  _ensureGraph() {
    if (this._graph) return this._graph;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const source = ctx.createMediaElementSource(this.audio);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      this._graph = { ctx, source, gain, analyser, freq: new Uint8Array(analyser.frequencyBinCount), wave: new Uint8Array(analyser.fftSize) };
    } catch (err) {
      console.warn('[player] Web Audio недоступен, визуализатор отключён', err);
      this._graph = null;
    }
    return this._graph;
  }

  _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (fn) => () => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    };
    ms.setActionHandler('play', safe(() => this.play()));
    ms.setActionHandler('pause', safe(() => this.pause()));
    ms.setActionHandler('nexttrack', safe(() => this.next(true)));
    ms.setActionHandler('previoustrack', safe(() => this.prev()));
    ms.setActionHandler('seekbackward', safe((d) => this.seekBy(-(d?.seekOffset || this.seekStep))));
    ms.setActionHandler('seekforward', safe((d) => this.seekBy(d?.seekOffset || this.seekStep)));
    ms.setActionHandler('seekto', safe((d) => {
      if (typeof d?.seekTime === 'number') this.seek(d.seekTime);
    }));
    ms.setActionHandler('stop', safe(() => this.pause()));
  }

  _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = this.current;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || track.name,
        artist: track.artist || 'Неизвестный исполнитель',
        album: track.album || '',
        artwork: [{ src: `/art?id=${encodeURIComponent(track.id)}`, sizes: '512x512', type: 'image/jpeg' }]
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {
      /* ignore */
    }
  }

  _updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!this.duration || !Number.isFinite(this.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: this.duration,
        playbackRate: this.audio.playbackRate || 1,
        position: clamp(this.audio.currentTime, 0, this.duration)
      });
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ очередь

  setQueue(tracks, startIndex = 0, context = null) {
    this.origin = [...tracks];
    this.queue = [...tracks];
    if (context) this.context = context;
    if (this.shuffle) this._shuffleFrom(startIndex);
    this.index = this.queue.length ? clamp(startIndex, 0, this.queue.length - 1) : -1;
    this.emit('queue');
    return this.queue.length;
  }

  playTracks(tracks, startIndex = 0, context = null) {
    if (!tracks.length) return;
    this.setQueue(tracks, startIndex, context);
    return this.playIndex(this.index);
  }

  /** Перемешивание «с сохранением текущего трека на месте». */
  _shuffleFrom(currentIndex) {
    const currentTrack = this.queue[currentIndex];
    const rest = this.queue.filter((_, i) => i !== currentIndex);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const head = currentTrack ? [currentTrack, ...rest] : rest;
    this.queue = head;
    this.index = currentTrack ? 0 : -1;
  }

  setShuffle(on) {
    this.shuffle = !!on;
    const currentTrack = this.current;
    if (this.shuffle) {
      const idx = Math.max(0, this.index);
      this._shuffleFrom(idx);
      if (this.index >= 0) this.emit('queue');
      else this.emit('state');
    } else {
      // Возвращаем исходный порядок, сохраняя текущий трек активным.
      this.queue = [...this.origin];
      this.index = currentTrack ? this.queue.findIndex((t) => t.id === currentTrack.id) : -1;
      if (this.index < 0) this.index = this.queue.length ? 0 : -1;
      this.emit('queue');
    }
    this.emit('state');
    return this.shuffle;
  }

  setRepeat(mode) {
    this.repeat = REPEAT_MODES.includes(mode) ? mode : 'off';
    this.emit('state');
    return this.repeat;
  }

  cycleRepeat() {
    const next = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    return this.setRepeat(next);
  }

  addToQueue(tracks, { next = false, context = null } = {}) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const fresh = list.filter((t) => t && !this.queue.some((q) => q.id === t.id));
    if (!fresh.length) return 0;
    if (next && this.index >= 0) this.queue.splice(this.index + 1, 0, ...fresh);
    else this.queue.push(...fresh);
    this.origin = [...this.queue];
    if (!this.queue.length || this.index < 0) this.index = 0;
    if (context) this.context = context;
    this.emit('queue');
    return fresh.length;
  }

  removeFromQueue(index) {
    if (index < 0 || index >= this.queue.length) return;
    const wasCurrent = index === this.index;
    this.queue.splice(index, 1);
    this.origin = this.origin.filter((t) => this.queue.some((q) => q.id === t.id));
    if (wasCurrent) {
      if (this.queue.length) {
        this.index = clamp(index, 0, this.queue.length - 1);
        this.playIndex(this.index);
      } else {
        this.stop();
      }
    } else if (index < this.index) {
      this.index -= 1;
    }
    this.emit('queue');
  }

  moveInQueue(from, to) {
    if (from === to || from < 0 || from >= this.queue.length) return;
    const currentTrack = this.current;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(clamp(to, 0, this.queue.length), 0, item);
    this.index = currentTrack ? this.queue.findIndex((t) => t.id === currentTrack.id) : -1;
    this.emit('queue');
  }

  clearQueue({ keepCurrent = true } = {}) {
    if (keepCurrent && this.current) {
      this.queue = [this.current];
      this.origin = [this.current];
      this.index = 0;
    } else {
      this.stop();
      this.queue = [];
      this.origin = [];
      this.index = -1;
    }
    this.emit('queue');
  }

  // ------------------------------------------------------------ воспроизведение

  async playIndex(index, { autoplay = true, position = 0 } = {}) {
    if (index < 0 || index >= this.queue.length) return false;
    const track = this.queue[index];
    this.index = index;
    this.failed.delete(track.id);

    const token = ++this._playToken;
    this.currentTime = 0;
    this.duration = track.duration || 0;
    this._pendingSeek = clamp(Number(position) || 0, 0, 24 * 3600);

    if (!track.playable) {
      this.emit('unsupported', track);
      this.emit('state');
      if (autoplay) setTimeout(() => this.next(true), 900);
      return false;
    }

    this.audio.src = mediaUrl(track);
    this.audio.load();
    this._applyGain(track);

    this.emit('track', track);
    this.emit('state');
    this._updateMediaSession();
    this._warmNext();

    if (!autoplay) return true;

    try {
      const graph = this._ensureGraph();
      if (graph?.ctx.state === 'suspended') await graph.ctx.resume();
      await this.audio.play();
      if (token !== this._playToken) return true;
      this.playing = true;
      return true;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('[player] не удалось запустить воспроизведение', err);
        this.emit('blocked', err);
      }
      return false;
    }
  }

  /** Предзагрузка следующего трека — переключение почти без паузы. */
  _warmNext() {
    const nextTrack = this.queue[this.index + 1];
    if (!nextTrack || !nextTrack.playable) return;
    try {
      this._warm = new Audio();
      this._warm.preload = 'auto';
      this._warm.src = mediaUrl(nextTrack);
      this._warm.load();
    } catch {
      this._warm = null;
    }
  }

  async play() {
    if (!this.queue.length) return false;
    if (this.index < 0) return this.playIndex(0);
    if (this.audio.src) {
      try {
        const graph = this._ensureGraph();
        if (graph?.ctx.state === 'suspended') await graph.ctx.resume();
        await this.audio.play();
        return true;
      } catch (err) {
        this.emit('blocked', err);
        return false;
      }
    }
    return this.playIndex(this.index);
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.audio.paused) return this.play();
    this.pause();
    return Promise.resolve(false);
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.index = -1;
    this.currentTime = 0;
    this.duration = 0;
    this.playing = false;
    this.emit('state');
    this.emit('queue');
  }

  next(automatic = false) {
    if (!this.queue.length) return false;
    if (automatic && this.repeat === 'one') {
      this.seek(0);
      return this.play();
    }
    if (this.index < this.queue.length - 1) return this.playIndex(this.index + 1);
    if (this.repeat === 'all' || !automatic) {
      if (this.shuffle) {
        this._shuffleFrom(-1);
        this.index = 0;
      }
      return this.playIndex(0);
    }
    this.pause();
    this.emit('finished');
    return false;
  }

  prev() {
    if (!this.queue.length) return false;
    // Как в плеерах: сначала «в начало трека», потом предыдущий.
    if (this.audio.currentTime > 4 && this.index >= 0) {
      this.seek(0);
      return true;
    }
    if (this.index > 0) return this.playIndex(this.index - 1);
    if (this.repeat === 'all' && this.queue.length) return this.playIndex(this.queue.length - 1);
    this.seek(0);
    return true;
  }

  _handleEnded() {
    this.emit('ended', this.current);
    this._savePosition(true);
    this.next(true);
  }

  _handleError() {
    const track = this.current;
    if (!track) return;
    this.failed.add(track.id);
    this.emit('error', { track, error: this.audio.error });
    if (this.queue.length > 1 && this.failed.size < this.queue.length) {
      setTimeout(() => this.next(true), 700);
    } else {
      this.pause();
    }
  }

  // ------------------------------------------------------------ время и звук

  seek(seconds) {
    if (!Number.isFinite(seconds)) return;
    const duration = this.duration || this.current?.duration || 0;
    this.audio.currentTime = clamp(seconds, 0, duration ? duration - 0.05 : seconds);
    this.currentTime = this.audio.currentTime;
    this.emit('time', { time: this.currentTime, duration });
  }

  seekRatio(ratio) {
    const duration = this.duration || this.current?.duration || 0;
    if (!duration) return;
    this.seek(ratio * duration);
  }

  seekBy(delta) {
    this.seek((this.audio.currentTime || 0) + delta);
  }

  setVolume(value) {
    const volume = clamp(value, 0, 1);
    this.audio.volume = volume;
    this.audio.muted = volume === 0 ? this.audio.muted : false;
    return volume;
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    return this.audio.muted;
  }

  setNormalize(on) {
    this.normalize = !!on;
    this._applyGain(this.current);
    this.emit('state');
    return this.normalize;
  }

  setSeekStep(seconds) {
    this.seekStep = clamp(Number(seconds) || 5, 1, 60);
    return this.seekStep;
  }

  _applyGain(track) {
    const graph = this._ensureGraph();
    if (!graph) return;
    const known = track ? this.gains.get(track.id) : null;
    const target = this.normalize ? (known ?? 1) : 1;
    try {
      graph.gain.gain.setTargetAtTime(target, graph.ctx.currentTime, 0.08);
    } catch {
      /* ignore */
    }
  }

  /** Мягкое выравнивание: подтягиваем громкость к целевому уровню RMS. */
  _measure() {
    if (!this.normalize || !this.playing) return;
    const graph = this._graph;
    if (!graph) return;
    graph.analyser.getByteTimeDomainData(graph.wave);
    let sum = 0;
    for (let i = 0; i < graph.wave.length; i += 4) {
      const v = (graph.wave[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (graph.wave.length / 4));
    if (rms < 0.004) return;
    const track = this.current;
    const target = 0.11;
    const current = track ? (this.gains.get(track.id) ?? 1) : 1;
    const desired = clamp(current * (target / rms), 0.35, 2);
    const next = current + (desired - current) * 0.02;
    if (track) this.gains.set(track.id, next);
    try {
      graph.gain.gain.setTargetAtTime(next, graph.ctx.currentTime, 0.2);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ визуализатор

  setVisualizer(on) {
    this.showViz = !!on;
    if (this.canvas) this.canvas.style.display = this.showViz ? '' : 'none';
    return this.showViz;
  }

  _startViz() {
    if (!this.ctx2d) return;
    const draw = (ts) => {
      this._vizFrame = requestAnimationFrame(draw);
      const { width, height } = this.canvas;
      const ctx = this.ctx2d;
      ctx.clearRect(0, 0, width, height);

      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue('--accent').trim() || '#ff6a2b';
      const accent2 = style.getPropertyValue('--accent-2').trim() || '#ffb35c';
      const line = style.getPropertyValue('--line').trim() || '#333';

      const graph = this._graph;
      const bars = 42;
      const gap = 2;
      const barWidth = (width - gap * (bars - 1)) / bars;

      if (!graph || !this.playing) {
        // Спокойная «дыхательная» линия в простое
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const phase = ts / 1400;
        for (let x = 0; x <= width; x += 4) {
          const y = height / 2 + Math.sin(x / 26 + phase) * (height / 7);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        return;
      }

      graph.analyser.getByteFrequencyData(graph.freq);
      const nyquistBins = graph.freq.length;
      const gradient = ctx.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, accent);
      gradient.addColorStop(1, accent2);
      ctx.fillStyle = gradient;
      for (let i = 0; i < bars; i += 1) {
        // Логарифмическая шкала звучит естественнее линейной
        const lo = Math.floor(Math.pow(i / bars, 1.7) * nyquistBins * 0.72);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * nyquistBins * 0.72));
        let sum = 0;
        for (let k = lo; k < hi; k += 1) sum += graph.freq[k];
        const value = sum / (hi - lo) / 255;
        const h = Math.max(2, Math.pow(value, 1.25) * height);
        const x = i * (barWidth + gap);
        ctx.beginPath();
        const r = Math.min(2, barWidth / 2);
        ctx.roundRect ? ctx.roundRect(x, height - h, barWidth, h, r) : ctx.rect(x, height - h, barWidth, h);
        ctx.fill();
      }
    };
    this._vizFrame = requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------ позиция

  _scheduleSavePosition() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._savePosition(false);
    }, 5000);
  }

  _savePosition(includeId) {
    const track = this.current;
    if (!track) return;
    api.settings({
      lastPlayedId: track.id,
      lastPlayedPosition: includeId ? 0 : Math.round(this.audio.currentTime || 0)
    }).catch(() => {});
  }

  /** Восстанавливает последний трек (на паузе) после перезапуска плеера. */
  async restore(tracks, settings) {
    if (!settings?.lastPlayedId) return false;
    const track = tracks.find((t) => t.id === settings.lastPlayedId);
    if (!track) return false;
    this.queue = [track];
    this.origin = [track];
    this.index = 0;
    this.emit('queue');
    await this.playIndex(0, { autoplay: false, position: Number(settings.lastPlayedPosition) || 0 });
    return true;
  }

  get pendingSeek() {
    return this._pendingSeek || 0;
  }
}

export { REPEAT_MODES };