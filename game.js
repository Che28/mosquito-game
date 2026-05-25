/* ============================================================
   今晚你跑不掉 — 主程式
   依設計文件 v1.0 實作
   ============================================================ */

'use strict';

// ============================================================
// 工具函式
// ============================================================
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const lerp = (a, b, t) => a + (b - a) * t;
const TWO_PI = Math.PI * 2;

// ============================================================
// 音效合成系統 (Web Audio API)
// ============================================================
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buzzNodes = new Map(); // mosquito id -> {osc, gain, panner}
    this.muted = false;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // 嘗試載入真實蚊子音檔；失敗就 fallback 到合成
  async loadMosquitoSample(url = 'sounds/mosquito.mp3') {
    if (!this.ctx) this.init();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('mosquito sample not found');
      const arrayBuffer = await res.arrayBuffer();
      this.mosquitoBuffer = await this.ctx.decodeAudioData(arrayBuffer);
      console.log('[sound] Real mosquito sample loaded');
    } catch (e) {
      this.mosquitoBuffer = null;
      console.log('[sound] No mosquito.mp3 found, using synthesized whine');
    }
  }

  // 蚊子嗡嗡聲 — 若有 mosquito.mp3 用真實音檔，否則合成
  startBuzz(id, baseFreq = 620) {
    if (!this.ctx) return;
    this.stopBuzz(id);
    if (this.mosquitoBuffer) return this.startBuzzSample(id, baseFreq);

    const t0 = this.ctx.currentTime;

    // === 三層諧波（精簡，避免太厚）===
    // 真實蚊子：基頻主導，2 倍諧波伴隨，高諧波微弱
    const h1 = this.ctx.createOscillator();
    const h2 = this.ctx.createOscillator();
    const h3 = this.ctx.createOscillator();
    h1.type = 'sine'; h2.type = 'sine'; h3.type = 'sine';
    h1.frequency.value = baseFreq;
    h2.frequency.value = baseFreq * 2;
    h3.frequency.value = baseFreq * 3;

    // 蚊子真實頻譜：基頻最強（thin whine 感）
    const g1 = this.ctx.createGain(); g1.gain.value = 1.0;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.45;
    const g3 = this.ctx.createGain(); g3.gain.value = 0.12;

    // === Vibrato FM（5Hz 微幅頻率擺動，蚊子聲音不會死定在一個頻率）===
    const vibLFO = this.ctx.createOscillator();
    vibLFO.type = 'sine';
    vibLFO.frequency.value = 5;
    const vibDepth = this.ctx.createGain();
    vibDepth.gain.value = baseFreq * 0.018; // 1.8% vibrato 較明顯但自然
    vibLFO.connect(vibDepth);
    vibDepth.connect(h1.frequency);
    vibDepth.connect(h2.frequency);
    vibDepth.connect(h3.frequency);

    // === 微弱 AM（4-7Hz 緩慢音量起伏，不是 25Hz 蜜蜂式震顫）===
    const amLFO = this.ctx.createOscillator();
    amLFO.type = 'sine';
    amLFO.frequency.value = 4.5;
    const amDepth = this.ctx.createGain();
    amDepth.gain.value = 0.08; // 大幅減小，從 0.35 → 0.08
    const amGain = this.ctx.createGain();
    amGain.gain.value = 0.92; // 中心音量幾乎滿，AM 只貢獻 ±0.08
    amLFO.connect(amDepth);
    amDepth.connect(amGain.gain);

    // === 帶通（中心 = 基頻，銳利 Q，模擬蚊子「鼻腔」共振）===
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseFreq;
    bp.Q.value = 3.5; // 從 1.2 提高到 3.5，更銳利的 whine

    // === 高通切掉低頻（保持「細」的感覺）===
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400; // 從 300 提到 400，更乾淨

    const volGain = this.ctx.createGain();
    volGain.gain.value = 0;

    const panner = this.ctx.createStereoPanner();

    // === 接線 ===
    h1.connect(g1); h2.connect(g2); h3.connect(g3);
    [g1, g2, g3].forEach(g => g.connect(bp));
    bp.connect(hp);
    hp.connect(amGain);
    amGain.connect(volGain);
    volGain.connect(panner);
    panner.connect(this.master);

    h1.start(t0); h2.start(t0); h3.start(t0);
    vibLFO.start(t0); amLFO.start(t0);

    this.buzzNodes.set(id, {
      oscs: [h1, h2, h3],
      lfos: [amLFO, vibLFO],
      gain: volGain,
      panner,
      bp,
      vibDepth,
      baseFreq,
    });
  }

  updateBuzz(id, { volume = 0.2, pan = 0, freqMul = 1, lfoRate = 4.5 } = {}) {
    const n = this.buzzNodes.get(id);
    if (!n) return;
    const t = this.ctx.currentTime;
    n.gain.gain.linearRampToValueAtTime(volume, t + 0.08);
    n.panner.pan.linearRampToValueAtTime(clamp(pan, -1, 1), t + 0.12);
    if (n.isSample) {
      // 用音檔時調整 playbackRate 改變音調（不影響音色太多）
      n.sample.playbackRate.linearRampToValueAtTime(freqMul, t + 0.12);
      return;
    }
    const f = n.baseFreq * freqMul;
    n.oscs[0].frequency.linearRampToValueAtTime(f, t + 0.12);
    n.oscs[1].frequency.linearRampToValueAtTime(f * 2, t + 0.12);
    n.oscs[2].frequency.linearRampToValueAtTime(f * 3, t + 0.12);
    n.bp.frequency.linearRampToValueAtTime(f, t + 0.12);
    n.lfos[0].frequency.linearRampToValueAtTime(lfoRate, t + 0.1);
    n.vibDepth.gain.linearRampToValueAtTime(f * 0.018, t + 0.12);
  }

  // 用真實音檔的 buzz 啟動
  startBuzzSample(id, baseFreq) {
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.mosquitoBuffer;
    src.loop = true;
    // 每隻蚊子用 baseFreq / 620 當 playbackRate（小蚊子高音、大蚊子低音）
    src.playbackRate.value = (baseFreq / 620);
    src.detune.value = rand(-50, 50); // ±50 cents 微差異避免聽起來一模一樣
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const panner = this.ctx.createStereoPanner();
    src.connect(gain).connect(panner).connect(this.master);
    // 從隨機位置開始播放，避免多隻蚊子同步循環
    const offset = rand(0, this.mosquitoBuffer.duration);
    src.start(t0, offset);
    this.buzzNodes.set(id, { sample: src, gain, panner, baseFreq, isSample: true });
  }

  stopBuzz(id) {
    const n = this.buzzNodes.get(id);
    if (!n) return;
    const t = this.ctx.currentTime;
    n.gain.gain.cancelScheduledValues(t);
    n.gain.gain.linearRampToValueAtTime(0, t + 0.05);
    setTimeout(() => {
      try {
        if (n.isSample) {
          n.sample.stop();
        } else {
          n.oscs.forEach(o => o.stop());
          n.lfos.forEach(o => o.stop());
        }
      } catch (e) {}
    }, 100);
    this.buzzNodes.delete(id);
  }

  stopAllBuzz() {
    for (const id of Array.from(this.buzzNodes.keys())) this.stopBuzz(id);
  }

  // === 環境底噪 ===
  startAmbient(level) {
    if (!this.ctx) return;
    this.stopAmbient();
    const t0 = this.ctx.currentTime;
    this.ambient = { nodes: [] };

    const addNode = (n) => this.ambient.nodes.push(n);

    if (level === 1) {
      // 客廳：冷氣 low hum 60Hz + 微微 TV 雜訊
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 200;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.05;
      osc.connect(lp).connect(gain).connect(this.master);
      osc.start(t0);
      addNode(osc); addNode(gain);
      // TV 高頻 hiss
      const noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
      const noise = this.ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;
      const noiseHP = this.ctx.createBiquadFilter();
      noiseHP.type = 'highpass'; noiseHP.frequency.value = 4000;
      const noiseGain = this.ctx.createGain();
      noiseGain.gain.value = 0.012;
      noise.connect(noiseHP).connect(noiseGain).connect(this.master);
      noise.start(t0);
      addNode(noise); addNode(noiseGain);
    } else if (level === 2) {
      // 臥室夜晚：蟲鳴 + 風扇咔嗒 + 遠處狗吠（偶爾）
      // 蟲鳴：高頻間歇 chirp
      const cricketGain = this.ctx.createGain();
      cricketGain.gain.value = 0.04;
      cricketGain.connect(this.master);
      addNode(cricketGain);
      // 用 setInterval 模擬間歇蟲叫（記得 stop 時清掉）
      this.ambient.cricketInterval = setInterval(() => {
        if (!this.ctx) return;
        const cT = this.ctx.currentTime;
        const cOsc = this.ctx.createOscillator();
        cOsc.type = 'sine';
        cOsc.frequency.value = 3600 + rand(-100, 100);
        const cG = this.ctx.createGain();
        cG.gain.setValueAtTime(0, cT);
        cG.gain.linearRampToValueAtTime(0.15, cT + 0.02);
        cG.gain.exponentialRampToValueAtTime(0.001, cT + 0.08);
        cOsc.connect(cG).connect(cricketGain);
        cOsc.start(cT);
        cOsc.stop(cT + 0.1);
      }, 250 + rand(0, 200));
      // 風扇低頻
      const fan = this.ctx.createOscillator();
      fan.type = 'sine'; fan.frequency.value = 50;
      const fanLFO = this.ctx.createOscillator();
      fanLFO.type = 'sine'; fanLFO.frequency.value = 8;
      const fanLFODepth = this.ctx.createGain();
      fanLFODepth.gain.value = 4;
      fanLFO.connect(fanLFODepth);
      fanLFODepth.connect(fan.frequency);
      const fanGain = this.ctx.createGain();
      fanGain.gain.value = 0.04;
      fan.connect(fanGain).connect(this.master);
      fan.start(t0); fanLFO.start(t0);
      addNode(fan); addNode(fanLFO); addNode(fanGain);
    } else if (level === 3) {
      // 戶外：鳥叫 + 風聲 + 樹葉
      const windNoise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const wd = windNoise.getChannelData(0);
      for (let i = 0; i < wd.length; i++) wd[i] = (Math.random() * 2 - 1);
      const wind = this.ctx.createBufferSource();
      wind.buffer = windNoise; wind.loop = true;
      const windFilter = this.ctx.createBiquadFilter();
      windFilter.type = 'bandpass'; windFilter.frequency.value = 600; windFilter.Q.value = 0.4;
      const windGain = this.ctx.createGain();
      windGain.gain.value = 0;
      // 風的起伏 LFO
      const windLFO = this.ctx.createOscillator();
      windLFO.type = 'sine'; windLFO.frequency.value = 0.3;
      const windLFODepth = this.ctx.createGain();
      windLFODepth.gain.value = 0.045;
      windLFO.connect(windLFODepth);
      windLFODepth.connect(windGain.gain);
      windGain.gain.value = 0.05;
      wind.connect(windFilter).connect(windGain).connect(this.master);
      wind.start(t0); windLFO.start(t0);
      addNode(wind); addNode(windLFO); addNode(windGain);
      // 鳥叫（間歇）
      this.ambient.birdInterval = setInterval(() => {
        if (!this.ctx) return;
        const cT = this.ctx.currentTime;
        for (let i = 0; i < 3; i++) {
          const bOsc = this.ctx.createOscillator();
          bOsc.type = 'sine';
          const startF = rand(2000, 3000);
          bOsc.frequency.setValueAtTime(startF, cT + i * 0.08);
          bOsc.frequency.linearRampToValueAtTime(startF * rand(1.2, 1.6), cT + i * 0.08 + 0.06);
          const bG = this.ctx.createGain();
          bG.gain.setValueAtTime(0, cT + i * 0.08);
          bG.gain.linearRampToValueAtTime(0.15, cT + i * 0.08 + 0.01);
          bG.gain.exponentialRampToValueAtTime(0.001, cT + i * 0.08 + 0.08);
          bOsc.connect(bG).connect(this.master);
          bOsc.start(cT + i * 0.08);
          bOsc.stop(cT + i * 0.08 + 0.1);
        }
      }, 3000 + rand(0, 4000));
    } else if (level === 4) {
      // Boss：陰森低頻 drone
      const drone = this.ctx.createOscillator();
      drone.type = 'sawtooth'; drone.frequency.value = 55;
      const drone2 = this.ctx.createOscillator();
      drone2.type = 'sawtooth'; drone2.frequency.value = 82.5;
      const droneLP = this.ctx.createBiquadFilter();
      droneLP.type = 'lowpass'; droneLP.frequency.value = 180; droneLP.Q.value = 5;
      const droneGain = this.ctx.createGain();
      droneGain.gain.value = 0.08;
      drone.connect(droneLP); drone2.connect(droneLP);
      droneLP.connect(droneGain).connect(this.master);
      drone.start(t0); drone2.start(t0);
      addNode(drone); addNode(drone2); addNode(droneGain);
    }
  }

  stopAmbient() {
    if (!this.ambient) return;
    if (this.ambient.cricketInterval) clearInterval(this.ambient.cricketInterval);
    if (this.ambient.birdInterval) clearInterval(this.ambient.birdInterval);
    for (const n of this.ambient.nodes) {
      try {
        if (n.gain) {
          const t = this.ctx.currentTime;
          n.gain.cancelScheduledValues(t);
          n.gain.linearRampToValueAtTime(0, t + 0.1);
        }
        if (n.stop) {
          setTimeout(() => { try { n.stop(); } catch (e) {} }, 150);
        }
      } catch (e) {}
    }
    this.ambient = null;
  }

  // === 心跳緊張音樂（包包累積時越來越強）===
  startHeartbeat() {
    if (!this.ctx || this.heartbeat) return;
    this.heartbeat = { gain: this.ctx.createGain(), interval: null };
    this.heartbeat.gain.gain.value = 0;
    this.heartbeat.gain.connect(this.master);
    let beatT = 0;
    this.heartbeat.interval = setInterval(() => {
      if (!this.ctx || !this.heartbeat) return;
      const cT = this.ctx.currentTime;
      // lub-dub
      const beat = (offset, vol) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(80, cT + offset);
        osc.frequency.exponentialRampToValueAtTime(35, cT + offset + 0.15);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, cT + offset);
        g.gain.linearRampToValueAtTime(vol, cT + offset + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, cT + offset + 0.18);
        osc.connect(g).connect(this.heartbeat.gain);
        osc.start(cT + offset);
        osc.stop(cT + offset + 0.22);
      };
      beat(0, 1);
      beat(0.18, 0.7);
    }, 800); // 預設 BPM 75，會在 updateHeartbeat 中調整
  }

  updateHeartbeat(bumpCount) {
    if (!this.heartbeat) {
      if (bumpCount >= 3) this.startHeartbeat();
      else return;
    }
    if (!this.ctx) return;
    // bumpCount 3-7 → 音量 0.1-0.6，BPM 75-130
    if (bumpCount < 3) {
      this.heartbeat.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
      return;
    }
    const t = clamp((bumpCount - 3) / 4, 0, 1);
    const vol = lerp(0.15, 0.6, t);
    const bpm = lerp(75, 140, t);
    const interval = 60000 / bpm;
    this.heartbeat.gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.3);
    // 重設 interval
    if (this.heartbeat.currentBPM !== bpm) {
      this.heartbeat.currentBPM = bpm;
      clearInterval(this.heartbeat.interval);
      this.heartbeat.interval = setInterval(() => {
        if (!this.ctx || !this.heartbeat) return;
        const cT = this.ctx.currentTime;
        const beat = (offset, vol) => {
          const osc = this.ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(80, cT + offset);
          osc.frequency.exponentialRampToValueAtTime(35, cT + offset + 0.15);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0, cT + offset);
          g.gain.linearRampToValueAtTime(vol, cT + offset + 0.01);
          g.gain.exponentialRampToValueAtTime(0.001, cT + offset + 0.18);
          osc.connect(g).connect(this.heartbeat.gain);
          osc.start(cT + offset);
          osc.stop(cT + offset + 0.22);
        };
        beat(0, 1);
        beat(0.18, 0.7);
      }, interval);
    }
  }

  stopHeartbeat() {
    if (!this.heartbeat) return;
    if (this.heartbeat.interval) clearInterval(this.heartbeat.interval);
    if (this.ctx) {
      this.heartbeat.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.3);
    }
    this.heartbeat = null;
  }

  // 飛走音調急升（蚊子緊張時頻率拉高）
  playFleeUp(id) {
    const n = this.buzzNodes.get(id);
    if (!n) return;
    const t = this.ctx.currentTime;
    if (n.isSample) {
      // 音檔：用 playbackRate 拉高音調 + 衰減
      const currentRate = n.sample.playbackRate.value;
      n.sample.playbackRate.cancelScheduledValues(t);
      n.sample.playbackRate.linearRampToValueAtTime(currentRate * 1.8, t + 0.3);
      n.gain.gain.cancelScheduledValues(t);
      n.gain.gain.linearRampToValueAtTime(0.45, t + 0.05);
      n.gain.gain.linearRampToValueAtTime(0, t + 0.6);
      setTimeout(() => this.stopBuzz(id), 700);
      return;
    }
    // 合成：所有諧波同步往上 1.8x
    n.oscs.forEach((o, i) => {
      const mul = i + 1;
      o.frequency.cancelScheduledValues(t);
      o.frequency.linearRampToValueAtTime(n.baseFreq * mul * 1.8, t + 0.3);
    });
    n.bp.frequency.linearRampToValueAtTime(n.baseFreq * 1.8, t + 0.3);
    n.gain.gain.cancelScheduledValues(t);
    n.gain.gain.linearRampToValueAtTime(0.45, t + 0.05);
    n.gain.gain.linearRampToValueAtTime(0, t + 0.6);
    setTimeout(() => this.stopBuzz(id), 700);
  }

  // 短促音效
  playBlip(freq, duration, type = 'sine', vol = 0.3) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain).connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + duration + 0.05);
  }

  // 徒手命中：「啪」 — 模擬真實巴掌：超短全頻 attack + 中頻肉聲 body + 高頻 crack tail
  playHandHit() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;

    // Layer 1: 全頻瞬發 attack (掌心拍到皮膚的瞬間)
    {
      const bufferSize = this.ctx.sampleRate * 0.015;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(1.0, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.02);
      src.connect(gain).connect(this.master);
      src.start(t0);
    }

    // Layer 2: 中低頻肉聲 body (300-700Hz, 「啪」的主體)
    {
      const bufferSize = this.ctx.sampleRate * 0.1;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const t = i / this.ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 35);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 450;
      filter.Q.value = 0.9;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.9;
      src.connect(filter).connect(gain).connect(this.master);
      src.start(t0);
    }

    // Layer 3: 高頻 crack tail (>3kHz, 清脆尾巴)
    {
      const bufferSize = this.ctx.sampleRate * 0.04;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const t = i / this.ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 90);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 3000;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(filter).connect(gain).connect(this.master);
      src.start(t0);
    }
  }

  // 徒手打空：悶悶空氣聲
  playMiss() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.15;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  // 徒手揮擊（出手瞬間的「咻」聲，命中或失敗都播）
  playHandSwing() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.18;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.6;
    const t0 = this.ctx.currentTime;
    filter.frequency.setValueAtTime(350, t0);
    filter.frequency.linearRampToValueAtTime(1000, t0 + 0.09);
    filter.frequency.linearRampToValueAtTime(400, t0 + 0.18);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  // 打蚊拍揮擊（更銳利的咻聲）
  playSwatterSwing() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.22;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.8;
    const t0 = this.ctx.currentTime;
    filter.frequency.setValueAtTime(500, t0);
    filter.frequency.linearRampToValueAtTime(1800, t0 + 0.07);
    filter.frequency.linearRampToValueAtTime(600, t0 + 0.22);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.55, t0 + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  // 拍命中：清脆拍聲＋網格震動回響
  playSwatterHit() {
    this.playHandHit();
    // 網格震動回響
    setTimeout(() => this.playBlip(220, 0.18, 'square', 0.25), 25);
    setTimeout(() => this.playBlip(140, 0.14, 'square', 0.2), 70);
    setTimeout(() => this.playBlip(95, 0.1, 'sine', 0.15), 130);
  }

  // 拍打空：破風聲
  playSwooshMiss() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 0.2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 3;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.4, this.ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  // 電蚊拍命中：電弧嗶嗶
  playZap() {
    if (!this.ctx) return;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.playBlip(2400 + rand(-200, 200), 0.04, 'square', 0.25), i * 40);
    }
    setTimeout(() => this.playBlip(80, 0.2, 'sawtooth', 0.15), 50);
  }

  // 血爆爆炸聲，根據誇張等級（不再內含 playHandHit，避免雙重觸發）
  playSplat(level = 0) {
    if (!this.ctx) return;
    const baseDuration = 0.2 + level * 0.15;
    const baseVol = 0.4 + level * 0.15;
    setTimeout(() => {
      const bufferSize = this.ctx.sampleRate * baseDuration;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        const t = i / this.ctx.sampleRate;
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 8) * baseVol;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 200 + level * 100;
      src.connect(filter).connect(this.master);
      src.start();
    }, 50);
    if (level >= 2) {
      setTimeout(() => this.playBlip(60, 0.4, 'sawtooth', 0.4), 100);
    }
    if (level >= 3) {
      setTimeout(() => this.playBlip(40, 0.6, 'sine', 0.5), 150);
    }
  }

  // 角色悶哼（被叮）
  playOuch() {
    this.playBlip(220, 0.25, 'sine', 0.18);
  }

  // 角色歡呼（依等級）
  playCheer(level = 0) {
    if (!this.ctx) return;
    const freqs = [
      [440, 660],
      [440, 660, 880],
      [330, 440, 660, 880, 1100],
      [220, 330, 440, 660, 880, 1100, 1320]
    ][clamp(level, 0, 3)];
    freqs.forEach((f, i) => setTimeout(() => this.playBlip(f, 0.2, 'triangle', 0.2), i * 80));
  }
}

const sound = new SoundEngine();

// ============================================================
// 蚊子類別
// ============================================================
let mosquitoIdCounter = 0;

class Mosquito {
  constructor(x, y, opts = {}) {
    this.id = ++mosquitoIdCounter;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;

    // 飛行
    this.targetX = x;
    this.targetY = y;
    this.flyTimer = 0;
    this.flyDuration = rand(0.5, 1.1);
    this.baseSpeed = opts.baseSpeed || 180;
    // 多 octave noise 種子（只保留兩個低頻層，去掉造成抖動的高頻層）
    this.noisePhases = [
      { f: rand(0.6, 0.9), p: rand(0, TWO_PI) },
      { f: rand(1.8, 2.6), p: rand(0, TWO_PI) },
    ];
    this.noiseT = 0;
    // dart 系統：少且弱，模擬偶發小斜衝
    this.dartCooldown = rand(2.5, 5.0);
    this.dartTimer = 0;
    this.dartVX = 0;
    this.dartVY = 0;
    // 飛行速度動態變化（加速 / 減速）
    this.speedMul = 1;

    // 狀態
    this.state = 'flying'; // flying / landing / biting / fleeing
    this.stateTimer = 0;
    this.landingTimer = 0;
    this.landingDuration = rand(0.8, 1.3);
    this.bitingTimer = 0;
    this.bitingDuration = rand(1.8, 4.0);
    this.fleeTimer = 0;

    // 警戒
    this.alert = 0;
    this.shakeAmount = 0;

    // 體型 (依被叮咬次數成長)
    this.scale = opts.scale || 0.6;
    this.targetScale = this.scale;
    // 關卡層級的叮咬時長倍率
    this.biteDurMul = opts.biteDurMul || 1.0;

    // 視覺
    this.facing = rand(0, TWO_PI);
    this.flapPhase = rand(0, TWO_PI);

    // Boss 標記
    this.isBoss = !!opts.isBoss;
    if (this.isBoss) {
      this.baseSpeed *= 1.6;
      this.bitingDuration = rand(0.9, 1.6);
      this.landingDuration = rand(0.6, 1.0);
    }

    // 飛走方向
    this.fleeAngle = 0;
    this.fleeSpeed = 0;
    this.afterImages = [];

    // 叮咬位置 (相對於角色)
    this.bitePosition = null;
  }

  pickNewTarget(canvasW, canvasH) {
    // 蚊子在畫面中隨機路徑飛行，飛一下下就會想再停下來
    const margin = 60;
    this.targetX = rand(margin, canvasW - margin);
    this.targetY = rand(margin, canvasH * 0.7);
    this.flyTimer = 0;
    this.flyDuration = rand(0.5, 1.2);
  }

  // 決定降落點：只停在角色身上叮咬
  decideToLand(ctx) {
    const character = ctx && ctx.character;
    if (!character || !character.biteSpots.length) return false;
    const spot = character.biteSpots[randInt(0, character.biteSpots.length - 1)];
    this.bitingDuration = rand(1.5, 3.5) * (this.isBoss ? 0.45 : 1) * this.biteDurMul;
    this.bitePosition = { x: spot.x, y: spot.y, type: 'bite' };
    this.targetX = spot.x;
    this.targetY = spot.y;
    return true;
  }

  // 體型成長（被叮咬一次後）
  grow() {
    this.targetScale = Math.min(this.targetScale * 1.2, 2.4);
    this.baseSpeed *= 0.92;
    this.bitingDuration *= 1.1;
  }

  // 飛走
  flee(reason = 'natural') {
    if (this.state === 'fleeing') return;
    this.state = 'fleeing';
    this.fleeTimer = 0;
    this.fleeAngle = rand(0, TWO_PI);
    this.fleeSpeed = 450;
    this.alert = 0;
    sound.playFleeUp(this.id);
    return reason;
  }

  update(dt, ctx) {
    const { canvasW, canvasH, character, mouse, tool, toolMoveSpeed, game } = ctx;

    // 漸進縮放
    this.scale = lerp(this.scale, this.targetScale, dt * 5);

    this.flapPhase += dt * 30;

    switch (this.state) {
      case 'flying': this.updateFlying(dt, ctx); break;
      case 'landing': this.updateLanding(dt, ctx); break;
      case 'biting': this.updateBiting(dt, ctx); break;
      case 'fleeing': this.updateFleeing(dt, ctx); break;
    }

    // 立體聲嗡嗡聲（依距離 character 變化音量；依 x 位置分聲道）
    if (this.state !== 'fleeing') {
      const d = character ? dist(this.x, this.y, character.x, character.y) : 0;
      const maxD = Math.hypot(canvasW, canvasH);
      let vol = clamp(1 - d / (maxD * 0.6), 0.05, 0.5);
      let freqMul = 1;
      let lfoRate = 20;
      if (this.state === 'landing') { freqMul = 0.85; lfoRate = 12; vol *= 0.7; }
      if (this.state === 'biting') { vol = 0.02; }
      // 體型越大音調越低
      freqMul *= 1 / (0.6 + 0.4 * this.scale);
      const pan = clamp((this.x / canvasW) * 2 - 1, -1, 1);
      sound.updateBuzz(this.id, { volume: vol, pan, freqMul, lfoRate });
    }
  }

  updateFlying(dt, ctx) {
    const { canvasW, canvasH, character, tool, toolMoveSpeed, mouse } = ctx;

    this.flyTimer += dt;
    this.noiseT += dt;
    this.dartTimer += dt;

    if (this.flyTimer >= this.flyDuration) {
      // 提高降落機率：80% 機率停下來咬
      if (Math.random() < 0.8) {
        if (this.decideToLand(ctx)) {
          this.state = 'landing';
          this.landingTimer = 0;
          this.landingDuration = rand(0.8, 1.3);
          return;
        }
      }
      this.pickNewTarget(canvasW, canvasH);
    }

    // 朝向目標飛行
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const d = Math.hypot(dx, dy);

    // 速度動態：加速→巡航→減速接近目標
    // flyTimer 進度：0-0.3 加速、0.3-0.7 巡航、0.7+ 接近目標減速
    const progress = clamp(this.flyTimer / this.flyDuration, 0, 1);
    let targetSpeedMul;
    if (progress < 0.25) targetSpeedMul = lerp(0.4, 1.0, progress / 0.25);
    else if (progress < 0.75) targetSpeedMul = 1.0 + Math.sin(this.noiseT * 4) * 0.15;
    else targetSpeedMul = lerp(1.0, 0.5, (progress - 0.75) / 0.25);
    this.speedMul = lerp(this.speedMul, targetSpeedMul, dt * 4);
    let speed = this.baseSpeed * this.speedMul;

    // 電蚊拍：玩家「快速」移動時才干擾路徑（門檻更高、推力減半）
    if (tool && tool.kind === 'electric' && toolMoveSpeed > 250) {
      const tdx = this.x - mouse.x;
      const tdy = this.y - mouse.y;
      const td = Math.hypot(tdx, tdy);
      if (td < 160) {
        const push = (1 - td / 160) * 100;
        this.x += (tdx / (td || 1)) * push * dt;
        this.y += (tdy / (td || 1)) * push * dt;
      }
    }

    if (d > 5) {
      this.x += (dx / d) * speed * dt;
      this.y += (dy / d) * speed * dt;
    } else {
      this.pickNewTarget(canvasW, canvasH);
    }

    // 兩層 octave 擺動：低頻寬幅 + 中頻細紋（移除原本的高頻抖動層）
    let wx = 0, wy = 0;
    for (const n of this.noisePhases) {
      wx += Math.sin(this.noiseT * n.f + n.p);
      wy += Math.cos(this.noiseT * n.f * 1.2 + n.p * 0.7);
    }
    const wiggleAmp = 22;
    this.x += wx * wiggleAmp * dt * 0.6;
    this.y += wy * wiggleAmp * dt * 0.55;

    // Dart 系統：少且弱（2.5-5 秒一次，速度減半，衰減更慢更平滑）
    if (this.dartTimer >= this.dartCooldown && this.dartVX === 0) {
      const ang = rand(0, TWO_PI);
      const power = rand(80, 160);
      this.dartVX = Math.cos(ang) * power;
      this.dartVY = Math.sin(ang) * power * 0.7;
      this.dartTimer = 0;
      this.dartCooldown = rand(2.5, 5.0);
    }
    if (this.dartVX !== 0 || this.dartVY !== 0) {
      this.x += this.dartVX * dt;
      this.y += this.dartVY * dt;
      const decay = Math.exp(-dt * 3.5); // 從 6 → 3.5，更平滑
      this.dartVX *= decay;
      this.dartVY *= decay;
      if (Math.abs(this.dartVX) < 3 && Math.abs(this.dartVY) < 3) {
        this.dartVX = 0; this.dartVY = 0;
      }
    }

    // 確保不出界
    this.x = clamp(this.x, 30, canvasW - 30);
    this.y = clamp(this.y, 30, canvasH - 30);

    // facing
    this.facing = Math.atan2(dy + wy * 5, dx + wx * 5);
  }

  updateLanding(dt, ctx) {
    this.landingTimer += dt;
    // 飛行速度逐漸減慢
    const t = this.landingTimer / this.landingDuration;
    const slowdown = 1 - t * 0.8;

    if (!this.bitePosition) this.decideToLand(ctx);

    if (this.bitePosition) {
      const dx = this.bitePosition.x - this.x;
      const dy = this.bitePosition.y - this.y;
      const d = Math.hypot(dx, dy);
      const speed = this.baseSpeed * slowdown;
      if (d > 2) {
        this.x += (dx / d) * speed * dt;
        this.y += (dy / d) * speed * dt;
      }
    }

    if (this.landingTimer >= this.landingDuration) {
      this.state = 'biting';
      this.bitingTimer = 0;
      this.alert = 0;
      if (this.bitePosition) {
        this.x = this.bitePosition.x;
        this.y = this.bitePosition.y;
      }
      // 只有真正咬到人才悶哼
      if (this.bitePosition && this.bitePosition.type === 'bite') {
        sound.playOuch();
      }
    }
  }

  updateBiting(dt, ctx) {
    const { tool, toolMoveSpeed, mouse, game } = ctx;
    this.bitingTimer += dt;

    const isRest = this.bitePosition && this.bitePosition.type === 'rest';
    // 取得關卡層級的警戒/飛走倍率
    const levelCfg = game && LEVELS[game.level] ? LEVELS[game.level] : {};
    const alertMul = levelCfg.alertMul || 1.0;
    const randFleeMul = levelCfg.randFleeMul || 1.0;

    // 偶爾微微抖動翅膀
    if (this.bitingTimer > 1 && Math.random() < 0.005) {
      this.shakeAmount = 0.6;
    }
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2);

    // 預判威脅：只在「極快+極近」時直接飛走，給警戒條一些累積空間
    if (tool && mouse.x !== null && mouse.y !== null) {
      const d = dist(this.x, this.y, mouse.x, mouse.y);
      const peakSpeed = Math.max(toolMoveSpeed, game ? game.recentMaxSpeed : 0);
      const dangerSpeed = 700 / tool.alertGain; // 提高門檻，alert 先有機會累積
      const dangerDist = 130;
      if (peakSpeed > dangerSpeed && d < dangerDist) {
        this.flee('alerted');
        return;
      }
    }

    // 警戒系統（積極版：靜止靠近就會明顯累積）
    let alertGain = 0;
    let alertDecay = 15 / alertMul; // 警戒倍率影響衰減（低警戒關 = 衰減快）
    if (tool && mouse.x !== null && mouse.y !== null) {
      const d = dist(this.x, this.y, mouse.x, mouse.y);
      const proximityFactor = clamp(1 - d / 320, 0, 1);
      const speedFactor = Math.max(0.3, toolMoveSpeed / 380);
      const toolFactor = tool.alertGain;
      const restMul = isRest ? 1.2 : 1;
      alertGain = proximityFactor * speedFactor * toolFactor * 280 * restMul * alertMul;
    }
    this.alert += (alertGain - alertDecay) * dt;
    this.alert = clamp(this.alert, 0, 100);

    // 視覺：60-90 抖動，90-100 加劇
    if (this.alert >= 90) this.shakeAmount = Math.max(this.shakeAmount, 1.5);
    else if (this.alert >= 60) this.shakeAmount = Math.max(this.shakeAmount, 0.6);

    // 警戒值達 100 → 飛走
    if (this.alert >= 100) {
      this.flee('alerted');
      return;
    }

    // 隨機警覺：rest ~11%/s、bite ~9%/s（依關卡 randFleeMul 縮放）
    const randFlee = (isRest ? 0.11 : 0.09) * randFleeMul;
    if (Math.random() < randFlee * dt) {
      this.flee('random');
      return;
    }

    // 自然結束
    if (this.bitingTimer >= this.bitingDuration) {
      if (!isRest) {
        // 咬到人 → 加包包、長大
        if (game && game.character) game.character.addBump(this.bitePosition);
        this.grow();
      }
      this.flee('natural');
    }
  }

  updateFleeing(dt, ctx) {
    this.fleeTimer += dt;
    // 留下殘影
    if (this.fleeTimer < 0.5 && this.fleeTimer * 30 % 1 < 0.3) {
      this.afterImages.push({ x: this.x, y: this.y, scale: this.scale, life: 0.3 });
    }
    for (const img of this.afterImages) img.life -= dt;
    this.afterImages = this.afterImages.filter(img => img.life > 0);

    // 加速飛離
    const speedT = clamp(this.fleeTimer / 0.3, 0, 1);
    const speed = this.fleeSpeed * (0.5 + speedT);
    this.x += Math.cos(this.fleeAngle) * speed * dt;
    this.y += Math.sin(this.fleeAngle) * speed * dt;

    // 飛離後重新進入飛行
    const { canvasW, canvasH } = ctx;
    if (this.fleeTimer > 0.8) {
      // 重新出現在某邊緣
      const side = randInt(0, 3);
      if (side === 0) { this.x = rand(0, canvasW); this.y = -30; }
      else if (side === 1) { this.x = canvasW + 30; this.y = rand(0, canvasH * 0.7); }
      else if (side === 2) { this.x = rand(0, canvasW); this.y = canvasH * 0.7 + 30; }
      else { this.x = -30; this.y = rand(0, canvasH * 0.7); }
      this.state = 'flying';
      this.fleeTimer = 0;
      this.bitePosition = null;
      this.pickNewTarget(canvasW, canvasH);
      sound.startBuzz(this.id, (620 / (0.7 + 0.3 * this.scale)) * rand(0.88, 1.12));
    }
  }

  // 判斷工具是否能在此瞬間命中
  // 回傳 { hit: bool, probability: number }
  attemptHit(tool, mouseX, mouseY, swipeDir, toolSpeed = 0) {
    if (this.state !== 'biting' && tool.kind !== 'electric') return { hit: false, probability: 0, distance: Infinity };

    const d = dist(this.x, this.y, mouseX, mouseY);
    const baseRadius = 30 * this.scale;
    let prob = 0;

    if (tool.kind === 'hand') {
      // 再降難度：極近 75-85%, 近 38-46%, 中 15%, 遠 0%
      if (d < baseRadius * 1.8) prob = rand(0.75, 0.85);
      else if (d < baseRadius * 3.0) prob = rand(0.38, 0.46);
      else if (d < baseRadius * 4.5) prob = 0.15;
      else prob = 0;
      if (toolSpeed > 550) {
        const penalty = clamp(1 - (toolSpeed - 550) / 950, 0.30, 1);
        prob *= penalty;
      }
    } else if (tool.kind === 'swatter') {
      // 再降難度：極近 87-93%, 近 65-75%, 中 42-50%, 遠 18%
      let baseProb = 0;
      if (d < baseRadius * 1.9) baseProb = rand(0.87, 0.93);
      else if (d < baseRadius * 3.4) baseProb = rand(0.65, 0.75);
      else if (d < baseRadius * 5.2) baseProb = rand(0.42, 0.50);
      else if (d < baseRadius * 7.2) baseProb = 0.18;
      else baseProb = 0;

      // 長條判定：揮擊方向需朝向蚊子（更寬容）
      if (swipeDir) {
        const swipeAng = Math.atan2(swipeDir.y, swipeDir.x);
        const toMosqAng = Math.atan2(this.y - mouseY, this.x - mouseX);
        let angDiff = Math.abs(swipeAng - toMosqAng);
        if (angDiff > Math.PI) angDiff = TWO_PI - angDiff;
        // 偏離超過 70 度才大幅降低，地板提高至 0.35
        const dirFactor = clamp(1 - (angDiff / (Math.PI / 2.5)) * 0.6, 0.35, 1);
        baseProb *= dirFactor;
      }
      prob = baseProb;
    } else if (tool.kind === 'electric') {
      // 電蚊拍：蚊子接觸拍面位置即命中（不需要主動揮擊）
      if (d < baseRadius * 1.2 + 35) prob = 1;
      else prob = 0;
    }

    const roll = Math.random();
    return { hit: roll < prob, probability: prob, distance: d };
  }

  // 渲染
  draw(ctx) {
    const s = this.scale;

    // 殘影
    for (const img of this.afterImages) {
      ctx.save();
      ctx.globalAlpha = img.life * 0.6;
      ctx.translate(img.x, img.y);
      ctx.scale(img.scale, img.scale);
      this.drawBody(ctx, false);
      ctx.restore();
    }

    if (this.state === 'fleeing' && this.fleeTimer > 0.6) return;

    ctx.save();
    ctx.translate(this.x, this.y);

    // 抖動
    if (this.shakeAmount > 0) {
      ctx.translate(rand(-this.shakeAmount, this.shakeAmount) * 3, rand(-this.shakeAmount, this.shakeAmount) * 3);
    }

    ctx.scale(s, s);

    // 警覺驚嘆號
    if (this.state === 'fleeing' && this.fleeTimer < 0.3) {
      ctx.save();
      ctx.fillStyle = '#ff3030';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('!', 0, -28);
      ctx.restore();
    }

    this.drawBody(ctx, this.state === 'fleeing');
    ctx.restore();
  }

  drawBody(ctx, isFleeing) {
    // ===== 翅膀（細長透明、向後拖、震動模糊）=====
    ctx.save();
    const flap = Math.sin(this.flapPhase) * 0.4 + 0.65;
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#d8d4d0';
    // 兩片狹長翅膀，斜向後上方
    ctx.beginPath();
    ctx.ellipse(-6, -4, 3.5 * flap, 13, -0.4, 0, TWO_PI);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(6, -4, 3.5 * flap, 13, 0.4, 0, TWO_PI);
    ctx.fill();
    // 翅脈
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#6a6260';
    ctx.lineWidth = 0.35;
    for (let s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(s * 3, -10);
      ctx.lineTo(s * 8, 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * 5, -8);
      ctx.lineTo(s * 9, 2);
      ctx.stroke();
    }
    ctx.restore();

    // ===== 細長身體：頭 — 胸 — 腹（蚊子標誌性瘦長分段）=====
    // 腹部：細長，深棕色帶微微漸層（不再是黃黑條紋）
    const abdomenGrad = ctx.createLinearGradient(0, -2, 0, 16);
    abdomenGrad.addColorStop(0, '#4a3024');
    abdomenGrad.addColorStop(0.5, '#3a2418');
    abdomenGrad.addColorStop(1, '#241008');
    ctx.fillStyle = abdomenGrad;
    ctx.beginPath();
    ctx.ellipse(0, 6, 3.2, 11, 0, 0, TWO_PI);
    ctx.fill();
    // 腹部分節（細微的暗色環，不是黃條紋）
    ctx.strokeStyle = 'rgba(20,10,5,0.45)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 4; i++) {
      const y = -1 + i * 3.5;
      const w = 3.2 - Math.abs(i - 1.5) * 0.3;
      ctx.beginPath();
      ctx.ellipse(0, y, w, 0.5, 0, 0, TWO_PI);
      ctx.stroke();
    }

    // 胸部：略寬，深褐色（翅膀連接點）
    ctx.fillStyle = '#2a1810';
    ctx.beginPath();
    ctx.ellipse(0, -7, 4.5, 4.5, 0, 0, TWO_PI);
    ctx.fill();
    // 胸部高光
    ctx.fillStyle = 'rgba(140,100,80,0.3)';
    ctx.beginPath();
    ctx.ellipse(-1.2, -8, 1.5, 1.5, 0, 0, TWO_PI);
    ctx.fill();

    // 頭部：小球
    ctx.fillStyle = '#1a0a06';
    ctx.beginPath();
    ctx.arc(0, -13, 3.5, 0, TWO_PI);
    ctx.fill();

    // ===== 觸鬚（細長羽狀，向上後翹）=====
    ctx.strokeStyle = '#0a0604';
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-1.5, -15.5);
    ctx.quadraticCurveTo(-3.5, -19, -6, -21);
    ctx.moveTo(1.5, -15.5);
    ctx.quadraticCurveTo(3.5, -19, 6, -21);
    ctx.stroke();

    // ===== 眼睛（小、稍暗）=====
    const eyeFlee = isFleeing && this.fleeTimer < 0.3;
    const eyeSize = eyeFlee ? 2.2 : 1.5;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(-1.8, -13, eyeSize, 0, TWO_PI);
    ctx.arc(1.8, -13, eyeSize, 0, TWO_PI);
    ctx.fill();
    // 複眼質感（深紅紫色）
    ctx.fillStyle = eyeFlee ? '#cc3030' : '#5a1818';
    ctx.beginPath();
    ctx.arc(-1.8, -13, eyeSize * 0.65, 0, TWO_PI);
    ctx.arc(1.8, -13, eyeSize * 0.65, 0, TWO_PI);
    ctx.fill();
    // 反光
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(-2.2, -13.5, eyeSize * 0.25, 0, TWO_PI);
    ctx.arc(1.4, -13.5, eyeSize * 0.25, 0, TWO_PI);
    ctx.fill();

    // ===== 標誌性長刺針（proboscis，蚊子最辨識特徵）=====
    // 細長、向前向下延伸超出頭部
    ctx.strokeStyle = '#0a0604';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 1);
    ctx.stroke();
    // 針的延伸（更細，伸出身體外）
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(0, 5);
    ctx.stroke();
    // 唇瓣（口器底部稍寬）
    ctx.fillStyle = '#0a0604';
    ctx.beginPath();
    ctx.ellipse(0, -9, 1, 1.5, 0, 0, TWO_PI);
    ctx.fill();

    // ===== 六隻細長腳（蚊子腳特別長，超過身體長度，明顯下垂）=====
    ctx.strokeStyle = '#0a0604';
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    // 三對腳從胸部不同位置伸出
    const legConfigs = [
      // attachY, midOutMul, midDownMul, footOutMul, footDownMul
      { ay: -9, mox: 0.5, moy: 0.3, fox: 0.85, foy: 1.2 },  // 前腳：向前外
      { ay: -7, mox: 0.7, moy: 0.4, fox: 1.2, foy: 1.4 },   // 中腳：向側
      { ay: -5, mox: 0.55, moy: 0.5, fox: 1.0, foy: 1.8 },  // 後腳：向後下
    ];
    const legLen = 13;
    for (const cfg of legConfigs) {
      for (let s = -1; s <= 1; s += 2) {
        const midX = s * legLen * cfg.mox;
        const midY = cfg.ay + legLen * cfg.moy;
        const footX = s * legLen * cfg.fox * 1.3;
        const footY = cfg.ay + legLen * cfg.foy;
        // 兩段腿（大腿 + 小腿）
        ctx.beginPath();
        ctx.moveTo(s * 2, cfg.ay);
        ctx.lineTo(midX, midY);
        ctx.lineTo(footX, footY);
        ctx.stroke();
        // 腳尖
        ctx.fillStyle = '#0a0604';
        ctx.beginPath();
        ctx.arc(footX, footY, 0.6, 0, TWO_PI);
        ctx.fill();
      }
    }
  }
}

// ============================================================
// 角色類別
// ============================================================
class Character {
  constructor(canvasW, canvasH) {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    this.x = canvasW / 2;
    this.y = canvasH * 0.62;
    this.bumps = [];
    this.expression = 0; // 0-5 對應不同表情
    this.lastVoiceTime = 0;
    this.cheerTimer = 0;
    this.cheerLevel = 0;
    this.victoryAnim = 0;
    // 生理動畫
    this.breathT = rand(0, TWO_PI);
    this.blinkTimer = rand(2, 5);
    this.blinkAmount = 0; // 0=睜開、1=閉眼
    this.eyeTargetX = 0;  // 眼珠看向（local 座標）
    this.eyeTargetY = 0;
    this.eyeX = 0;
    this.eyeY = 0;
    this.reflexShake = 0; // 被叮咬瞬間反射
    this.autoSwatTimer = rand(3, 6);
    this.autoSwatActive = 0;
    this.scratchTimer = rand(4, 8);
    this.scratchBump = null;
    this.scratchAmount = 0;
    // 可被叮咬的點（手臂、腿、臉頰、肩膀）
    this.biteSpots = this.computeBiteSpots();
  }

  computeBiteSpots() {
    const spots = [];
    // 臉頰 左右
    spots.push({ x: this.x - 35, y: this.y - 130, name: 'cheek-l' });
    spots.push({ x: this.x + 35, y: this.y - 130, name: 'cheek-r' });
    // 額頭
    spots.push({ x: this.x, y: this.y - 160, name: 'forehead' });
    // 脖子
    spots.push({ x: this.x - 15, y: this.y - 90, name: 'neck' });
    // 手臂
    spots.push({ x: this.x - 75, y: this.y - 30, name: 'arm-l' });
    spots.push({ x: this.x + 75, y: this.y - 30, name: 'arm-r' });
    spots.push({ x: this.x - 90, y: this.y + 20, name: 'arm-l2' });
    spots.push({ x: this.x + 90, y: this.y + 20, name: 'arm-r2' });
    // 大腿
    spots.push({ x: this.x - 30, y: this.y + 90, name: 'leg-l' });
    spots.push({ x: this.x + 30, y: this.y + 90, name: 'leg-r' });
    // 小腿
    spots.push({ x: this.x - 35, y: this.y + 140, name: 'shin-l' });
    spots.push({ x: this.x + 35, y: this.y + 140, name: 'shin-r' });
    return spots;
  }

  addBump(pos) {
    if (!pos) return;
    if (pos.type === 'rest') return; // 防護：休息不算包包
    this.bumps.push({
      x: pos.x,
      y: pos.y,
      scale: 0,
      targetScale: rand(0.9, 1.2),
      bornT: 0 // 新生時間，用於顏色漸變
    });
    sound.playOuch();
    this.reflexShake = 1.0; // 被叮反射抖動
    this.updateExpression();
  }

  updateExpression() {
    const n = this.bumps.length;
    if (n === 0) this.expression = 0;
    else if (n <= 2) this.expression = 1;
    else if (n <= 4) this.expression = 2;
    else if (n <= 6) this.expression = 3;
    else if (n === 7) this.expression = 4;
    else this.expression = 5;
  }

  cheer(level) {
    this.cheerTimer = 0.8;
    this.cheerLevel = level;
    setTimeout(() => sound.playCheer(level), 500); // 0.5 秒靜默後歡呼
  }

  update(dt, mosquitoes) {
    if (this.cheerTimer > 0) this.cheerTimer -= dt;
    for (const b of this.bumps) {
      b.scale = lerp(b.scale, b.targetScale, dt * 8);
      b.bornT += dt;
    }

    // 呼吸
    this.breathT += dt;

    // 眨眼
    this.blinkTimer -= dt;
    if (this.blinkAmount > 0) {
      this.blinkAmount -= dt * 12; // 快速張開
      if (this.blinkAmount < 0) this.blinkAmount = 0;
    }
    if (this.blinkTimer <= 0) {
      this.blinkAmount = 1;
      // 焦慮時更頻繁眨眼
      this.blinkTimer = this.expression >= 3 ? rand(1.2, 2.5) : rand(2.5, 5);
    }

    // 眼珠追蹤最近的蚊子
    let nearest = null;
    let nearestD = Infinity;
    if (mosquitoes) {
      for (const m of mosquitoes) {
        if (m.state === 'fleeing') continue;
        const d = (m.x - this.x) ** 2 + (m.y - (this.y - 130)) ** 2;
        if (d < nearestD) { nearestD = d; nearest = m; }
      }
    }
    if (nearest) {
      // 計算相對頭部位置的方向 (頭部在 y-130 相對 character.y)
      const dx = nearest.x - this.x;
      const dy = nearest.y - (this.y - 130);
      const d = Math.hypot(dx, dy);
      const maxOffset = 1.5;
      this.eyeTargetX = (dx / (d || 1)) * maxOffset;
      this.eyeTargetY = clamp((dy / (d || 1)) * maxOffset, -1.2, 1.5);
    } else {
      this.eyeTargetX = 0;
      this.eyeTargetY = 0;
    }
    this.eyeX = lerp(this.eyeX, this.eyeTargetX, dt * 6);
    this.eyeY = lerp(this.eyeY, this.eyeTargetY, dt * 6);

    // 反射抖動衰減
    this.reflexShake = Math.max(0, this.reflexShake - dt * 4);

    // 自主拍打（5+ 包包時偶爾自己亂揮）
    if (this.expression >= 3) {
      this.autoSwatTimer -= dt;
      if (this.autoSwatTimer <= 0) {
        this.autoSwatActive = 0.4;
        this.autoSwatTimer = rand(2.5, 5);
        sound.playBlip(280 + rand(-40, 40), 0.12, 'triangle', 0.18);
      }
    }
    if (this.autoSwatActive > 0) this.autoSwatActive -= dt;

    // 抓癢動畫（包包 >= 2 時偶爾去抓最舊的包）
    if (this.bumps.length >= 2) {
      this.scratchTimer -= dt;
      if (this.scratchTimer <= 0 && !this.scratchBump) {
        this.scratchBump = this.bumps[randInt(0, this.bumps.length - 1)];
        this.scratchAmount = 0;
        this.scratchTimer = rand(5, 10);
      }
    }
    if (this.scratchBump) {
      this.scratchAmount += dt * 4;
      if (this.scratchAmount > Math.PI * 2) {
        this.scratchBump = null;
        this.scratchAmount = 0;
      }
    }

    // 被叮咬時偶爾發聲
    this.lastVoiceTime += dt;
    if (this.expression >= 2 && this.lastVoiceTime > rand(4, 8)) {
      this.lastVoiceTime = 0;
      sound.playBlip(180 + this.expression * 30, 0.2, 'triangle', 0.12);
    }
  }

  draw(ctx) {
    // 身體（簡筆人物）
    const cheer = this.cheerTimer > 0 ? Math.sin(this.cheerTimer * 12) * 4 : 0;
    // 呼吸：肩部位置微微上下 (1.5px)
    const breathe = Math.sin(this.breathT * 1.2) * 1.5;
    // 反射抖動
    const reflex = this.reflexShake > 0 ? rand(-1, 1) * this.reflexShake * 3 : 0;
    ctx.save();
    ctx.translate(this.x + reflex, this.y + cheer + breathe + reflex * 0.5);

    // 腿
    ctx.fillStyle = '#3a5878';
    ctx.fillRect(-40, 60, 30, 100);
    ctx.fillRect(10, 60, 30, 100);
    // 腳
    ctx.fillStyle = '#2a3848';
    ctx.beginPath();
    ctx.ellipse(-25, 165, 20, 8, 0, 0, TWO_PI);
    ctx.ellipse(25, 165, 20, 8, 0, 0, TWO_PI);
    ctx.fill();

    // 身體（上衣）
    ctx.fillStyle = '#e8c878';
    ctx.beginPath();
    ctx.moveTo(-60, -60);
    ctx.lineTo(60, -60);
    ctx.lineTo(55, 70);
    ctx.lineTo(-55, 70);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#a88a48';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 手臂
    ctx.fillStyle = '#f4d4a8';
    let armSwing = 0;
    if (this.cheerTimer > 0) armSwing = -0.4;
    else if (this.expression >= 3) armSwing = Math.sin(Date.now() * 0.008) * 0.2;
    // 自主揮手（亂揮）
    const autoSwat = this.autoSwatActive > 0 ? Math.sin((0.4 - this.autoSwatActive) * 20) * 1.2 : 0;
    // 左
    ctx.save();
    ctx.translate(-60, -50);
    ctx.rotate(0.3 + armSwing + autoSwat * 0.5);
    ctx.fillRect(-15, 0, 30, 90);
    ctx.beginPath();
    ctx.arc(0, 90, 16, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
    // 右（如果在抓癢，右手伸向那個包）
    ctx.save();
    if (this.scratchBump) {
      // 抓癢動畫：右手伸到包包位置
      const localX = this.scratchBump.x - this.x;
      const localY = this.scratchBump.y - this.y;
      const ang = Math.atan2(localY + 50, localX - 60);
      const scratch = Math.sin(this.scratchAmount * 4) * 0.15;
      ctx.translate(60, -50);
      ctx.rotate(ang - Math.PI / 2 + scratch);
    } else {
      ctx.translate(60, -50);
      ctx.rotate(-0.3 - armSwing - autoSwat);
    }
    ctx.fillRect(-15, 0, 30, 90);
    ctx.beginPath();
    ctx.arc(0, 90, 16, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    // 脖子
    ctx.fillStyle = '#f4d4a8';
    ctx.fillRect(-12, -85, 24, 30);

    // 頭
    ctx.fillStyle = '#f4d4a8';
    ctx.beginPath();
    ctx.arc(0, -130, 48, 0, TWO_PI);
    ctx.fill();
    ctx.strokeStyle = '#a07848';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 頭髮
    ctx.fillStyle = '#3a2818';
    ctx.beginPath();
    ctx.arc(0, -145, 50, Math.PI + 0.3, TWO_PI - 0.3);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-25, -130, 18, 25, -0.3, 0, TWO_PI);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(25, -130, 18, 25, 0.3, 0, TWO_PI);
    ctx.fill();

    // 表情
    this.drawFace(ctx);

    ctx.restore();

    // 包包（畫在絕對位置）— 升級版：紅暈 + 顏色漸變 + 抓癢時放大
    for (const b of this.bumps) {
      const isScratched = this.scratchBump === b;
      const scratchPulse = isScratched ? 1 + Math.sin(this.scratchAmount * 4) * 0.15 : 1;
      // 新生包包（< 1.5 秒）顏色較淡
      const ageT = clamp(b.bornT / 1.5, 0, 1);
      ctx.save();
      ctx.translate(b.x, b.y + cheer);
      ctx.scale(b.scale * scratchPulse, b.scale * scratchPulse);

      // 外層紅暈 (halo)
      const haloGrad = ctx.createRadialGradient(0, 0, 4, 0, 0, 20);
      haloGrad.addColorStop(0, `rgba(255,80,60,${0.4 * ageT})`);
      haloGrad.addColorStop(0.5, `rgba(255,80,60,${0.15 * ageT})`);
      haloGrad.addColorStop(1, 'rgba(255,80,60,0)');
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(0, 0, 20, 0, TWO_PI);
      ctx.fill();

      // 主包包：依新鮮度漸變 (淡粉 → 飽和紅)
      const innerColor = ageT < 0.5
        ? `rgb(${255}, ${168 - ageT * 100}, ${168 - ageT * 100})`
        : '#ff5050';
      const midColor = ageT < 0.5
        ? `rgb(${230}, ${120 - ageT * 100}, ${120 - ageT * 100})`
        : '#dd2828';
      const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 10);
      grad.addColorStop(0, '#ffaaaa');
      grad.addColorStop(0.4, innerColor);
      grad.addColorStop(1, midColor);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, TWO_PI);
      ctx.fill();

      // 中央發炎亮點（成熟包包）
      if (ageT > 0.8) {
        ctx.fillStyle = '#ff8080';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, TWO_PI);
        ctx.fill();
      }

      // 高光
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath();
      ctx.arc(-2, -3, 2, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  drawFace(ctx) {
    const ex = this.expression;
    const blink = this.blinkAmount;

    // 眼睛
    ctx.fillStyle = '#1a0a08';
    if (this.cheerTimer > 0) {
      // ^ ^ 開心
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1a0a08';
      ctx.beginPath();
      ctx.moveTo(-22, -130); ctx.lineTo(-15, -136); ctx.lineTo(-8, -130);
      ctx.moveTo(8, -130); ctx.lineTo(15, -136); ctx.lineTo(22, -130);
      ctx.stroke();
    } else if (ex >= 5) {
      // X X 崩潰
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1a0a08';
      [[-15, -130], [15, -130]].forEach(([x, y]) => {
        ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
      });
    } else if (ex >= 4) {
      // > < 痛苦
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#1a0a08';
      ctx.beginPath();
      ctx.moveTo(-22, -135); ctx.lineTo(-8, -128); ctx.lineTo(-22, -122);
      ctx.moveTo(22, -135); ctx.lineTo(8, -128); ctx.lineTo(22, -122);
      ctx.stroke();
    } else {
      // 正常眼睛（含眨眼 + 眼珠追蹤）
      const eyeR = ex >= 3 ? 2 : 3;
      const closedness = blink; // 0=睜開 1=閉
      if (closedness < 0.9) {
        // 眼白底
        ctx.save();
        const eyeH = (1 - closedness) * (eyeR + 1);
        // 左眼眼白
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.ellipse(-15, -130, eyeR + 1, eyeH, 0, 0, TWO_PI);
        ctx.fill();
        // 左眼瞳孔（追蹤）
        ctx.fillStyle = '#1a0a08';
        ctx.beginPath();
        ctx.arc(-15 + this.eyeX, -130 + this.eyeY, eyeR * 0.7, 0, TWO_PI);
        ctx.fill();
        // 右眼眼白
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.ellipse(15, -130, eyeR + 1, eyeH, 0, 0, TWO_PI);
        ctx.fill();
        // 右眼瞳孔
        ctx.fillStyle = '#1a0a08';
        ctx.beginPath();
        ctx.arc(15 + this.eyeX, -130 + this.eyeY, eyeR * 0.7, 0, TWO_PI);
        ctx.fill();
        ctx.restore();
      }
      // 眨眼的上眼皮線
      if (closedness > 0.1) {
        ctx.strokeStyle = '#3a2818';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(-18, -130); ctx.lineTo(-12, -130);
        ctx.moveTo(12, -130); ctx.lineTo(18, -130);
        ctx.stroke();
      }
      // 眉毛（蹙眉）
      if (ex >= 1) {
        ctx.strokeStyle = '#3a2818';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const tilt = ex * 0.15;
        ctx.moveTo(-22, -140 + tilt * 4);
        ctx.lineTo(-8, -142 - tilt * 4);
        ctx.moveTo(8, -142 - tilt * 4);
        ctx.lineTo(22, -140 + tilt * 4);
        ctx.stroke();
      }
    }

    // 嘴巴
    ctx.strokeStyle = '#1a0a08';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (this.cheerTimer > 0) {
      // 大笑
      ctx.arc(0, -110, 14, 0.2, Math.PI - 0.2);
      ctx.stroke();
      ctx.fillStyle = '#aa3030';
      ctx.fill();
    } else if (ex === 0) {
      // 平
      ctx.moveTo(-8, -112); ctx.lineTo(8, -112);
    } else if (ex === 1) {
      // 微皺
      ctx.moveTo(-10, -110); ctx.quadraticCurveTo(0, -114, 10, -110);
    } else if (ex === 2) {
      // 不悅
      ctx.moveTo(-10, -108); ctx.quadraticCurveTo(0, -114, 10, -108);
    } else if (ex === 3) {
      // 抿嘴
      ctx.moveTo(-12, -108); ctx.quadraticCurveTo(0, -100, 12, -108);
    } else if (ex === 4) {
      // 大張哀嚎
      ctx.fillStyle = '#3a1010';
      ctx.ellipse(0, -106, 10, 12, 0, 0, TWO_PI);
      ctx.fill(); ctx.stroke();
    } else {
      // 崩潰張嘴
      ctx.fillStyle = '#3a1010';
      ctx.ellipse(0, -104, 14, 16, 0, 0, TWO_PI);
      ctx.fill(); ctx.stroke();
    }
    ctx.stroke();

    // 汗滴（煩躁時）
    if (ex >= 2 && this.cheerTimer === 0) {
      ctx.fillStyle = '#88c8ff';
      const sway = Math.sin(Date.now() * 0.005) * 2;
      ctx.beginPath();
      ctx.ellipse(35 + sway, -140, 4, 6, 0, 0, TWO_PI);
      ctx.fill();
    }
  }
}

// ============================================================
// 工具定義
// ============================================================
const TOOLS = {
  hand: {
    kind: 'hand',
    name: '徒手',
    icon: '🖐',
    alertGain: 1.0,    // 警戒累積倍率（高）
    rangeHint: 'close', // 視覺輔助
  },
  swatter: {
    kind: 'swatter',
    name: '打蚊拍',
    icon: '🪰',
    alertGain: 0.55,
    rangeHint: 'mid',
  },
  electric: {
    kind: 'electric',
    name: '電蚊拍',
    icon: '⚡',
    alertGain: 1.4,    // 玩家移動時極敏感
    rangeHint: 'place',
  }
};

// ============================================================
// 場景配置（關卡）
// ============================================================
const LEVELS = {
  1: {
    name: '教學關 ‧ 客廳',
    bgGradient: ['#f6c98a', '#e8a868', '#c78848'],
    floorColor: '#7a4a28',
    ambient: 'light',
    mosquitoCount: 1,
    timeLimit: 120,
    tools: ['hand', 'swatter', 'electric'],
    // 教學關難度修正
    speedMul: 0.75,       // 蚊子飛得更慢
    biteDurMul: 1.25,     // 停留時間延長 25%
    alertMul: 0.7,        // 警戒累積更慢
    randFleeMul: 0.5,     // 隨機飛走機率減半
    tutorialHints: [
      { time: 0, text: '🔊 戴耳機聽蚊子方向 ── 等蚊子「停下」才打得到' },
      { time: 5, text: '🖐 徒手：靠近蚊子 → 快速向下點擊' },
      { time: 13, text: '🪰 打蚊拍：朝蚊子「快速滑動游標」→ 點擊' },
      { time: 22, text: '⚡ 電蚊拍：點下放置 → 游標靜止 → 等蚊子撞上來' },
      { time: 32, text: '右上「警戒」條 ── 太快靠近會嚇跑蚊子' }
    ]
  },
  2: {
    name: '臥室夜晚',
    bgGradient: ['#1a1a3a', '#0a0a20', '#000010'],
    floorColor: '#1a1228',
    ambient: 'dark',
    mosquitoCount: 5,
    timeLimit: 140,
    tools: ['hand', 'swatter', 'electric'],
    speedMul: 1.0,
    biteDurMul: 1.0,
    alertMul: 1.0,
    randFleeMul: 1.0,
    tutorialHints: [
      { time: 0, text: '🌙 暗房 5 隻 ── 全靠耳機聽方向' }
    ]
  },
  3: {
    name: '夏日戶外',
    bgGradient: ['#7ed4f0', '#a8e8a0', '#6ec068'],
    floorColor: '#4a8038',
    ambient: 'light',
    mosquitoCount: 10,
    timeLimit: 180,
    tools: ['hand', 'swatter', 'electric'],
    speedMul: 1.05,
    biteDurMul: 0.95,
    alertMul: 0.9,
    randFleeMul: 0.9,
    tutorialHints: [
      { time: 0, text: '☀️ 蚊群暴擊！打掉一隻聲音就少一層' }
    ]
  },
  4: {
    name: 'Boss ‧ 蚊王降臨',
    bgGradient: ['#3a1a3a', '#2a0a3a', '#1a0030'],
    floorColor: '#2a0848',
    ambient: 'dark',
    mosquitoCount: 1,
    timeLimit: 120,
    boss: true,
    tools: ['hand', 'swatter', 'electric'],
    speedMul: 1.0,        // Boss 速度已內建 1.6x，不再加倍
    biteDurMul: 1.0,
    alertMul: 1.1,        // Boss 警覺度更高
    randFleeMul: 1.1,
    tutorialHints: [
      { time: 0, text: '👹 蚊王降臨！速度極快、停留極短' },
      { time: 5, text: '⚡ 電蚊拍最有效 ── 攔截牠的飛行路徑' },
      { time: 15, text: '🪰 拍子備用 ── 蚊王停下的瞬間立刻揮' },
      { time: 30, text: '🩸 每次牠咬到你會變更大、更慢、更好打 ── 但 8 包就輸了' }
    ]
  }
};

// ============================================================
// 主遊戲類別
// ============================================================
class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;

    // 狀態
    this.state = 'idle';
    this.level = 1;
    this.toolKind = 'hand';
    this.tool = null;
    this.timeLeft = 0;
    this.elapsed = 0;
    this.unlocked = { 1: true, 2: true, 3: true, 4: true };

    // 場上實體
    this.mosquitoes = [];
    this.character = null;
    this.bloodSplats = [];
    this.particles = [];
    this.hitTexts = []; // 卡通命中字
    this.shakeT = 0;
    this.shakeIntensity = 0;
    this.freezeT = 0;
    this.slowMo = 1.0;
    this.invertT = 0;
    // 相機
    this.camZoom = 1;
    this.camTargetZoom = 1;
    this.camX = 0;
    this.camY = 0;
    this.camTargetX = 0;
    this.camTargetY = 0;

    // 輸入
    this.mouse = { x: null, y: null, prevX: null, prevY: null, down: false };
    this.toolMoveSpeed = 0;
    this.recentMaxSpeed = 0; // 最近 ~300ms 內的峰值速度（捕捉「剛剛的快速移動」）
    this.swipeHistory = []; // [{x, y, t}]
    this.lastSwipeDir = null;

    // 電蚊拍位置
    this.electricPlaced = null;
    this.lastMoveTime = 0;

    // 計時器（音效冷卻）
    this.lastVoiceTime = 0;

    // 提示
    this.activeHint = null;
    this.shownHints = new Set();

    // 暫停
    this.paused = false;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
    this.bindUI();

    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.loop(t));

    // 全部關卡開放（不再需要解鎖進度）
    this.refreshLevelLocks();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.W = w;
    this.H = h;
    if (this.character) {
      this.character.canvasW = w;
      this.character.canvasH = h;
      this.character.x = w / 2;
      this.character.y = h * 0.62;
      this.character.biteSpots = this.character.computeBiteSpots();
    }
    this.restSpots = this.computeRestSpots();
  }

  // 環境中可休息的點：牆壁、天花板、地板邊緣、家具
  computeRestSpots() {
    const spots = [];
    const W = this.W, H = this.H;
    // 天花板 / 上牆
    for (let i = 0; i < 8; i++) {
      spots.push({ x: rand(40, W - 40), y: rand(35, 90) });
    }
    // 左右牆
    for (let i = 0; i < 5; i++) {
      spots.push({ x: rand(15, 60), y: rand(100, H * 0.55) });
      spots.push({ x: rand(W - 60, W - 15), y: rand(100, H * 0.55) });
    }
    // 地板（避開角色腳邊更遠一點，避免視覺誤判）
    const charX = W / 2;
    for (let i = 0; i < 4; i++) {
      let x;
      if (Math.random() < 0.5) x = rand(20, charX - 220);
      else x = rand(charX + 220, W - 20);
      // 只放比較低的位置，遠離角色腿部
      spots.push({ x, y: rand(H * 0.85, H - 25) });
    }
    return spots;
  }

  bindInput() {
    const canvas = this.canvas;
    // ----- 滑鼠：點擊瞬間判定揮擊 -----
    canvas.addEventListener('mousemove', e => this.handlePointerMove(e.clientX, e.clientY));
    canvas.addEventListener('mousedown', e => {
      e.preventDefault();
      sound.init(); sound.resume();
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - rect.left;
      this.mouse.y = e.clientY - rect.top;
      this.mouse.down = true;
      if (this.state !== 'playing') return;
      if (this.tool && this.tool.kind === 'electric') {
        this.electricPlaced = { x: this.mouse.x, y: this.mouse.y };
        sound.playBlip(300, 0.05, 'square', 0.15);
        return;
      }
      this.attemptSwing();
    });
    canvas.addEventListener('mouseup', () => { this.mouse.down = false; });
    canvas.addEventListener('mouseleave', () => { this.mouse.x = null; this.mouse.y = null; });

    // ----- 觸控：touchend 判定揮擊，並使用滑動歷史 -----
    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      sound.init(); sound.resume();
      const t = e.touches[0];
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = t.clientX - rect.left;
      this.mouse.y = t.clientY - rect.top;
      this.mouse.down = true;
      this.swipeHistory = [{ x: this.mouse.x, y: this.mouse.y, t: performance.now() }];
      // 電蚊拍：點下即放置
      if (this.state === 'playing' && this.tool && this.tool.kind === 'electric') {
        this.electricPlaced = { x: this.mouse.x, y: this.mouse.y };
        sound.playBlip(300, 0.05, 'square', 0.15);
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0];
      this.handlePointerMove(t.clientX, t.clientY);
    }, { passive: false });
    canvas.addEventListener('touchend', e => {
      e.preventDefault();
      this.mouse.down = false;
      if (this.state !== 'playing') return;
      if (this.tool && this.tool.kind !== 'electric') {
        this.attemptSwing();
      }
    }, { passive: false });
  }

  // 載入真實蚊子音檔（在第一次用戶互動後嘗試）
  tryLoadMosquitoSample() {
    if (this._sampleLoadAttempted) return;
    this._sampleLoadAttempted = true;
    sound.init();
    sound.loadMosquitoSample('sounds/mosquito.mp3');
  }

  handlePointerMove(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const px = x - rect.left;
    const py = y - rect.top;
    const now = performance.now();
    if (this.mouse.x !== null) {
      const dx = px - this.mouse.x;
      const dy = py - this.mouse.y;
      let instSpeed = 0;
      // 用實際時間差計算瞬時速度（更準確）
      if (this.swipeHistory.length > 0) {
        const last = this.swipeHistory[this.swipeHistory.length - 1];
        const realDt = (now - last.t) / 1000;
        if (realDt > 0) instSpeed = Math.hypot(dx, dy) / realDt;
      }
      this.toolMoveSpeed = lerp(this.toolMoveSpeed, instSpeed, 0.4);
      // 記錄最近峰值速度
      if (instSpeed > this.recentMaxSpeed) this.recentMaxSpeed = instSpeed;
    }
    this.mouse.prevX = this.mouse.x;
    this.mouse.prevY = this.mouse.y;
    this.mouse.x = px;
    this.mouse.y = py;

    // 紀錄滑動歷史用於判斷揮擊方向
    this.swipeHistory.push({ x: px, y: py, t: now });
    while (this.swipeHistory.length > 12) this.swipeHistory.shift();

    this.lastMoveTime = now;
  }

  // 計算最近 ~180ms 的滑動方向 & 速度
  computeSwipe() {
    const now = performance.now();
    const recent = this.swipeHistory.filter(s => now - s.t < 180);
    if (recent.length < 2) return null;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return null;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const speed = Math.hypot(dx, dy) / dt;
    if (speed < 140) return null; // 揮擊速度門檻：200 → 140，更寬容
    return { x: dx, y: dy, speed };
  }

  attemptSwing() {
    // 出手瞬間先播揮擊聲（不管之後有沒有命中）
    if (this.tool.kind === 'hand') sound.playHandSwing();
    else if (this.tool.kind === 'swatter') sound.playSwatterSwing();

    const swipe = this.computeSwipe();
    const noSwipe = !swipe;
    // 拍：沒有方向揮擊就完全不會命中（但仍會嚇飛蚊子）
    const skipHitCheck = noSwipe && this.tool.kind === 'swatter';

    let hitTarget = null;
    let bestProb = 0;

    if (!skipHitCheck) {
      // 揮擊前先檢查：最近剛剛快速移動過 + 接近叮咬中的蚊子 → 蚊子瞬間飛走
      // recentMaxSpeed 衰減慢，能捕捉「橫掃過去後立刻點擊」的情境
      const peakSpeed = Math.max(this.toolMoveSpeed, this.recentMaxSpeed);
      for (const m of this.mosquitoes) {
        if (m.state !== 'biting') continue;
        const d = dist(m.x, m.y, this.mouse.x, this.mouse.y);
        const dangerSpeed = 700 / this.tool.alertGain;
        if (peakSpeed > dangerSpeed && d < 130) {
          m.flee('alerted');
        }
      }

      for (const m of this.mosquitoes) {
        const r = m.attemptHit(this.tool, this.mouse.x, this.mouse.y, swipe, peakSpeed);
        if (r.hit && r.probability > bestProb) {
          hitTarget = m;
          bestProb = r.probability;
        }
      }
    }

    if (hitTarget) {
      this.killMosquito(hitTarget);
      return;
    }

    // 任何揮擊動作（即使速度不足或沒打中），附近的蚊子都會察覺：
    // 1) 叮咬中的：直接嚇飛
    // 2) 準備降落的：中斷降落，飛走
    // 3) 飛行中且很近的：警覺，繞開
    const handScareR = 130;
    const swatterScareR = 180;
    const scareR = this.tool.kind === 'swatter' ? swatterScareR : handScareR;
    let scared = false;
    for (const m of this.mosquitoes) {
      const d = dist(m.x, m.y, this.mouse.x, this.mouse.y);
      const effR = scareR * (0.7 + m.scale * 0.3);
      if (d > effR) continue;
      if (m.state === 'biting' || m.state === 'landing') {
        m.flee('alerted');
        scared = true;
      } else if (m.state === 'flying' && d < effR * 0.6) {
        // 飛行中的近距離揮擊：警覺，立即改變方向
        const ang = Math.atan2(m.y - this.mouse.y, m.x - this.mouse.x);
        m.targetX = clamp(m.x + Math.cos(ang) * 200, 40, this.W - 40);
        m.targetY = clamp(m.y + Math.sin(ang) * 200, 40, this.H * 0.7);
        m.flyTimer = 0;
      }
    }

    // 失手追加一聲悶聲（讓「打空」的失敗感更明確）
    if (this.tool.kind === 'hand') setTimeout(() => sound.playMiss(), 80);
  }

  killMosquito(m) {
    // 演出等級依據蚊子體型
    const s = m.scale;
    let level = 0;
    if (s >= 2.2) level = 3;
    else if (s >= 1.7) level = 2;
    else if (s >= 1.3) level = 1;
    else level = 0;

    // Freeze frame
    this.freezeT = 0.2;

    // 慢動作
    const slowMoDuration = [0.0, 0.3, 0.5, 0.8][level];
    if (slowMoDuration > 0) {
      this.slowMo = 0.25;
      setTimeout(() => { this.slowMo = 1.0; }, slowMoDuration * 1000);
    }

    // 相機 zoom in 到擊殺點
    const zoomLevel = [1.15, 1.22, 1.3, 1.4][level];
    this.camTargetZoom = zoomLevel;
    this.camTargetX = m.x;
    this.camTargetY = m.y;
    // 慢動作結束後拉回
    const zoomBackDelay = Math.max(0.4, slowMoDuration) * 1000;
    setTimeout(() => {
      this.camTargetZoom = 1;
      this.camTargetX = this.W / 2;
      this.camTargetY = this.H / 2;
    }, zoomBackDelay);

    // 螢幕震動
    if (level >= 2) this.shakeIntensity = level === 3 ? 1.5 : 0.8;

    // 黑白反色閃爍
    if (level >= 3) this.invertT = 0.15;

    // 血爆粒子
    this.spawnBlood(m.x, m.y, level, s);

    // 卡通命中字
    this.spawnHitText(m.x, m.y, level);

    // 音效
    if (this.tool.kind === 'electric') sound.playZap();
    else if (this.tool.kind === 'swatter') sound.playSwatterHit();
    else sound.playHandHit();
    sound.playSplat(level);

    // 0.5 秒靜默 → 角色歡呼
    setTimeout(() => {
      if (this.character) this.character.cheer(level);
    }, 500);

    // 移除蚊子
    sound.stopBuzz(m.id);
    this.mosquitoes = this.mosquitoes.filter(x => x.id !== m.id);

    // 勝利檢查 — 延遲到演出結束才切換狀態，讓血爆、慢動作、歡呼全部播完
    if (this.mosquitoes.length === 0 && !this.winning) {
      this.winning = true;
      // 依照剛剛擊殺的演出等級決定等待時間：等慢動作 + 角色歡呼結束
      const performanceDelay = [1.2, 1.5, 1.8, 2.2][level] * 1000;
      setTimeout(() => this.win(), performanceDelay);
    }
  }

  spawnHitText(x, y, level) {
    const choices = [
      ['啪!', '中!'],
      ['啪!!', '砰!', '中!'],
      ['爽!', '砰!!', '殺!'],
      ['爆!!', 'BOOM!!', 'KILL!']
    ][level];
    const text = choices[randInt(0, choices.length - 1)];
    const sizeBase = [38, 52, 70, 96][level];
    const colorMain = ['#ffe44a', '#ff8a3a', '#ff4040', '#ff1818'][level];
    const colorStroke = ['#a04000', '#8a2010', '#601010', '#400606'][level];
    this.hitTexts.push({
      x, y,
      text,
      size: 0,
      targetSize: sizeBase,
      rotation: rand(-0.25, 0.25),
      life: 0,
      maxLife: 0.9 + level * 0.15,
      colorMain,
      colorStroke,
      vy: -60 - level * 20
    });
  }

  spawnBlood(x, y, level, scale) {
    const count = [12, 30, 60, 120][level];
    const speedMul = [1, 1.5, 2.2, 3.0][level];
    for (let i = 0; i < count; i++) {
      const ang = rand(0, TWO_PI);
      const speed = rand(100, 600) * speedMul;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        size: rand(3, 10) * scale,
        life: rand(0.6, 1.5),
        maxLife: 1.5,
        color: ['#ff2020', '#cc1010', '#ff4040', '#dd0808'][randInt(0, 3)]
      });
    }

    // 永久血跡：不規則 splat shape + 偶爾的線狀拖痕
    const splatCount = 5 + level * 8;
    for (let i = 0; i < splatCount; i++) {
      const ang = rand(0, TWO_PI);
      const dist = rand(20, 80 + level * 80);
      const px = x + Math.cos(ang) * dist;
      const py = y + Math.sin(ang) * dist;
      // 生成不規則 splat shape（多個半徑差異的弧線）
      const pointCount = randInt(6, 10);
      const baseR = rand(4, 12) * scale * (1 + level * 0.3);
      const points = [];
      for (let p = 0; p < pointCount; p++) {
        const pa = (p / pointCount) * TWO_PI;
        const pr = baseR * rand(0.6, 1.4);
        points.push({ x: Math.cos(pa) * pr, y: Math.sin(pa) * pr });
      }
      this.bloodSplats.push({
        x: px, y: py,
        points,
        color: ['#cc1818', '#a01010', '#bb1818', '#d82020'][randInt(0, 3)],
        // 部分大血滴會留向下拖痕
        dripLen: (level >= 2 && Math.random() < 0.3) ? rand(20, 60) : 0,
        dripW: baseR * rand(0.3, 0.6)
      });
    }
    // 飛濺的小衛星血滴
    for (let i = 0; i < 4 + level * 6; i++) {
      const ang = rand(0, TWO_PI);
      const dist = rand(40, 150 + level * 100);
      this.bloodSplats.push({
        x: x + Math.cos(ang) * dist,
        y: y + Math.sin(ang) * dist,
        points: null,
        miniR: rand(1.5, 4),
        color: ['#cc1818', '#a01010', '#bb1818'][randInt(0, 2)]
      });
    }
  }

  startLevel(levelNum, toolKind) {
    const cfg = LEVELS[levelNum];
    if (!cfg) return;
    this.level = levelNum;
    this.toolKind = toolKind;
    this.tool = TOOLS[toolKind];
    this.timeLeft = cfg.timeLimit;
    this.elapsed = 0;

    this.mosquitoes = [];
    this.bloodSplats = [];
    this.particles = [];
    this.hitTexts = [];
    this.electricPlaced = null;
    this.shownHints.clear();
    this.activeHint = null;
    this.winning = false;
    this.shakeIntensity = 0;
    this.invertT = 0;
    this.freezeT = 0;
    this.slowMo = 1.0;
    this.camZoom = 1; this.camTargetZoom = 1;
    this.camX = this.W / 2; this.camY = this.H / 2;
    this.camTargetX = this.W / 2; this.camTargetY = this.H / 2;
    // 重置場景物件快取（每關不同）
    this._dust = null;
    this._pollens = null;
    this._evilSplats = null;

    this.character = new Character(this.W, this.H);
    this.restSpots = this.computeRestSpots();

    // 套用 per-level 平衡參數
    const speedMul = cfg.speedMul || 1.0;
    const biteDurMul = cfg.biteDurMul || 1.0;
    for (let i = 0; i < cfg.mosquitoCount; i++) {
      const m = new Mosquito(rand(50, this.W - 50), rand(30, this.H * 0.4), {
        isBoss: cfg.boss,
        scale: cfg.boss ? 1.0 : 0.6,
        baseSpeed: (cfg.boss ? 260 : (200 - i * 10)) * speedMul,
        biteDurMul: biteDurMul
      });
      m.pickNewTarget(this.W, this.H);
      this.mosquitoes.push(m);
      sound.init();
      sound.resume();
      sound.startBuzz(m.id, (620 / (0.7 + 0.3 * m.scale)) * rand(0.88, 1.12));
    }

    this.state = 'playing';
    this.paused = false;
    this.showScreen('screen-game');
    this.updateHUD();
    // 啟動環境音
    sound.startAmbient(levelNum);
    sound.stopHeartbeat();
  }

  win() {
    this.state = 'won';
    sound.stopAllBuzz();
    sound.stopAmbient();
    sound.stopHeartbeat();
    // 解鎖下一關
    if (this.level < 4) this.unlocked[this.level + 1] = true;
    try { localStorage.setItem('mosquito-unlocked', JSON.stringify(this.unlocked)); } catch (e) {}
    this.refreshLevelLocks();

    const bumpCount = this.character ? this.character.bumps.length : 0;
    document.getElementById('win-stats').innerHTML = `
      關卡：${LEVELS[this.level].name}<br/>
      被叮咬：${bumpCount} 個包<br/>
      用時：${Math.round(this.elapsed)} 秒<br/>
      ${this.level < 4 ? '已解鎖下一關！' : '你打敗了蚊王！'}
    `;
    document.getElementById('btn-next').style.display = (this.level < 4) ? 'block' : 'none';
    this.showOverlay('screen-win');
  }

  lose() {
    this.state = 'lost';
    sound.stopAllBuzz();
    sound.stopAmbient();
    sound.stopHeartbeat();
    // 角色崩潰音效
    sound.playBlip(120, 1.2, 'sawtooth', 0.3);
    setTimeout(() => this.showOverlay('screen-lose'), 1000);
  }

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  showOverlay(id) {
    document.getElementById(id).classList.add('active');
  }

  hideOverlay(id) {
    document.getElementById(id).classList.remove('active');
  }

  refreshLevelLocks() {
    document.querySelectorAll('.level-card').forEach(card => {
      const lv = parseInt(card.dataset.level);
      if (this.unlocked[lv]) card.classList.remove('locked');
      else card.classList.add('locked');
    });
  }

  // ----- UI 綁定 -----
  bindUI() {
    document.getElementById('btn-start').addEventListener('click', () => {
      sound.init();
      sound.resume();
      this.tryLoadMosquitoSample();
      this.showScreen('screen-levels');
    });
    document.getElementById('btn-back-title').addEventListener('click', () => this.showScreen('screen-title'));
    document.getElementById('btn-back-levels').addEventListener('click', () => this.showScreen('screen-levels'));

    document.querySelectorAll('.level-card').forEach(card => {
      card.addEventListener('click', () => {
        const lv = parseInt(card.dataset.level);
        if (!this.unlocked[lv]) {
          sound.playBlip(150, 0.1, 'square', 0.15);
          return;
        }
        this.pendingLevel = lv;
        this.refreshToolCards();
        this.showScreen('screen-tools');
      });
    });

    document.querySelectorAll('.tool-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.classList.contains('locked')) return;
        document.querySelectorAll('.tool-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedTool = card.dataset.tool;
        document.getElementById('btn-start-level').disabled = false;
      });
    });

    document.getElementById('btn-start-level').addEventListener('click', () => {
      if (!this.selectedTool || !this.pendingLevel) return;
      this.startLevel(this.pendingLevel, this.selectedTool);
    });

    document.getElementById('btn-pause').addEventListener('click', () => this.pause());
    document.getElementById('btn-resume').addEventListener('click', () => this.resume());
    document.getElementById('btn-quit').addEventListener('click', () => {
      this.hideOverlay('screen-pause');
      sound.stopAllBuzz();
      sound.stopAmbient();
      sound.stopHeartbeat();
      this.state = 'idle';
      this.showScreen('screen-title');
    });
    document.getElementById('btn-replay').addEventListener('click', () => {
      this.hideOverlay('screen-win');
      this.startLevel(this.level, this.toolKind);
    });
    document.getElementById('btn-next').addEventListener('click', () => {
      this.hideOverlay('screen-win');
      if (this.level < 4 && this.unlocked[this.level + 1]) {
        this.pendingLevel = this.level + 1;
        this.refreshToolCards();
        this.showScreen('screen-tools');
      }
    });
    document.getElementById('btn-menu').addEventListener('click', () => {
      this.hideOverlay('screen-win');
      this.showScreen('screen-title');
    });
    document.getElementById('btn-retry').addEventListener('click', () => {
      this.hideOverlay('screen-lose');
      this.startLevel(this.level, this.toolKind);
    });
    document.getElementById('btn-menu2').addEventListener('click', () => {
      this.hideOverlay('screen-lose');
      this.showScreen('screen-title');
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.state === 'playing') {
        if (this.paused) this.resume(); else this.pause();
      }
    });
  }

  refreshToolCards() {
    const cfg = LEVELS[this.pendingLevel];
    const allowed = new Set(cfg.tools);
    document.querySelectorAll('.tool-card').forEach(card => {
      const t = card.dataset.tool;
      card.classList.remove('selected');
      if (allowed.has(t)) card.classList.remove('locked');
      else card.classList.add('locked');
    });
    this.selectedTool = null;
    document.getElementById('btn-start-level').disabled = true;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.paused = true;
    this.showOverlay('screen-pause');
    sound.stopAllBuzz();
  }

  resume() {
    this.paused = false;
    this.hideOverlay('screen-pause');
    // 重啟 buzz
    for (const m of this.mosquitoes) {
      sound.startBuzz(m.id, (620 / (0.7 + 0.3 * m.scale)) * rand(0.88, 1.12));
    }
  }

  updateHUD() {
    const bumpsEl = document.querySelector('#bumps-count span');
    const timerEl = document.querySelector('#timer span');
    const toolEl = document.getElementById('tool-indicator');
    if (this.character) bumpsEl.textContent = this.character.bumps.length;
    timerEl.textContent = Math.max(0, Math.ceil(this.timeLeft));
    if (this.tool) toolEl.textContent = this.tool.icon + ' ' + this.tool.name;

    // 警戒條：取所有 biting 蚊子最高警戒值
    let maxAlert = 0;
    for (const m of this.mosquitoes) {
      if (m.state === 'biting') maxAlert = Math.max(maxAlert, m.alert);
    }
    const fill = document.querySelector('.alert-fill');
    fill.style.width = maxAlert + '%';
  }

  // ----- 主循環 -----
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const realDt = Math.min(0.05, (t - this.lastFrame) / 1000);
    this.lastFrame = t;

    if (this.state !== 'playing' || this.paused) return;

    const dt = realDt * this.slowMo;

    // freeze frame 期間不更新邏輯
    if (this.freezeT > 0) {
      this.freezeT -= realDt;
      this.render(dt);
      return;
    }

    this.update(dt, realDt);
    this.render(dt);
  }

  update(dt, realDt) {
    this.elapsed += realDt;
    this.timeLeft -= realDt;

    // 工具速度自然衰減
    this.toolMoveSpeed = lerp(this.toolMoveSpeed, 0, dt * 8);
    // recentMaxSpeed 衰減較慢，保留「剛剛快速移動過」的痕跡 ~300ms
    this.recentMaxSpeed = Math.max(0, this.recentMaxSpeed - 3500 * realDt);

    // 教學提示
    const cfg = LEVELS[this.level];
    if (cfg.tutorialHints) {
      for (const hint of cfg.tutorialHints) {
        if (this.elapsed >= hint.time && !this.shownHints.has(hint.text)) {
          this.shownHints.add(hint.text);
          this.showHint(hint.text);
        }
      }
    }

    // 蚊子更新
    const ctx = {
      canvasW: this.W,
      canvasH: this.H,
      character: this.character,
      mouse: this.mouse,
      tool: this.tool,
      toolMoveSpeed: this.toolMoveSpeed,
      game: this
    };
    for (const m of this.mosquitoes) m.update(dt, ctx);

    // 電蚊拍：碰觸蚊子即命中
    if (this.tool && this.tool.kind === 'electric' && this.electricPlaced) {
      // 玩家若移動，電蚊拍位置跟隨；靜止時保持
      const movedRecently = performance.now() - this.lastMoveTime < 80; // 200 → 80ms，更快通電
      if (this.mouse.x !== null) {
        this.electricPlaced.x = this.mouse.x;
        this.electricPlaced.y = this.mouse.y;
      }
      if (!movedRecently) {
        // 靜止時偵測碰撞（任何狀態都能打）
        for (const m of this.mosquitoes) {
          const d = dist(m.x, m.y, this.electricPlaced.x, this.electricPlaced.y);
          // 半徑放大：65 + 35×scale，scale 0.6 → 86px（從 55 → 86）
          if (d < 65 + 35 * m.scale) {
            this.killMosquito(m);
            break;
          }
        }
      }
    }

    if (this.character) {
      this.character.update(dt, this.mosquitoes);
      sound.updateHeartbeat(this.character.bumps.length);
    }

    // 粒子
    for (const p of this.particles) {
      p.vy += 1400 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= realDt;
    }
    this.particles = this.particles.filter(p => p.life > 0);

    // 卡通命中字動畫
    for (const t of this.hitTexts) {
      t.life += realDt;
      t.size = lerp(t.size, t.targetSize, realDt * 18);
      t.y += t.vy * realDt;
      t.vy += 80 * realDt;
    }
    this.hitTexts = this.hitTexts.filter(t => t.life < t.maxLife);

    // 相機平滑插值（無視 slow-mo，用 realDt）
    this.camZoom = lerp(this.camZoom, this.camTargetZoom, realDt * 6);
    this.camX = lerp(this.camX, this.camTargetX, realDt * 8);
    this.camY = lerp(this.camY, this.camTargetY, realDt * 8);

    // 螢幕震動衰減
    if (this.shakeIntensity > 0) this.shakeIntensity -= dt * 4;
    if (this.shakeIntensity < 0) this.shakeIntensity = 0;
    if (this.invertT > 0) this.invertT -= realDt;

    // 敗條件（演出期間不檢查）
    if (!this.winning) {
      if (this.character && this.character.bumps.length >= 8) {
        this.lose();
        return;
      }
      if (this.timeLeft <= 0) {
        this.lose();
        return;
      }
    }

    this.updateHUD();
  }

  showHint(text) {
    const el = document.getElementById('tutorial-hint');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  // ----- 渲染 -----
  render(dt) {
    const ctx = this.ctx;
    const cfg = LEVELS[this.level];

    // 螢幕震動
    ctx.save();
    if (this.shakeIntensity > 0) {
      ctx.translate(rand(-1, 1) * this.shakeIntensity * 12, rand(-1, 1) * this.shakeIntensity * 12);
    }

    // 相機 zoom（圍繞 camX/camY 縮放）
    ctx.save();
    ctx.translate(this.W / 2, this.H / 2);
    ctx.scale(this.camZoom, this.camZoom);
    ctx.translate(-this.camX, -this.camY);

    // 背景
    this.drawBackground(cfg);

    // 永久血跡（不規則 shape + 拖痕 + 小衛星滴）
    for (const s of this.bloodSplats) {
      ctx.fillStyle = s.color;
      if (s.points) {
        // 主血斑：不規則多邊形
        ctx.beginPath();
        ctx.moveTo(s.x + s.points[0].x, s.y + s.points[0].y);
        for (let i = 1; i < s.points.length; i++) {
          // 用 quadraticCurveTo 讓邊緣更有機
          const prev = s.points[i - 1];
          const cur = s.points[i];
          const cx = s.x + (prev.x + cur.x) / 2 * 1.1;
          const cy = s.y + (prev.y + cur.y) / 2 * 1.1;
          ctx.quadraticCurveTo(cx, cy, s.x + cur.x, s.y + cur.y);
        }
        ctx.closePath();
        ctx.fill();
        // 拖痕（向下流）
        if (s.dripLen > 0) {
          ctx.fillRect(s.x - s.dripW / 2, s.y, s.dripW, s.dripLen);
          ctx.beginPath();
          ctx.arc(s.x, s.y + s.dripLen, s.dripW * 0.7, 0, TWO_PI);
          ctx.fill();
        }
      } else if (s.miniR) {
        // 小衛星血滴
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.miniR, 0, TWO_PI);
        ctx.fill();
      }
    }

    // 角色
    if (this.character) this.character.draw(ctx);

    // 電蚊拍預覽
    if (this.tool && this.tool.kind === 'electric' && this.electricPlaced) {
      this.drawElectricRacket(this.electricPlaced.x, this.electricPlaced.y, performance.now() - this.lastMoveTime > 200);
    }

    // 蚊子
    for (const m of this.mosquitoes) m.draw(ctx);

    // 粒子
    for (const p of this.particles) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, TWO_PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 卡通命中字（在 zoom 內，跟著場景縮放）
    for (const t of this.hitTexts) {
      const lifeT = t.life / t.maxLife;
      const alpha = lifeT < 0.7 ? 1 : (1 - lifeT) / 0.3;
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.translate(t.x, t.y);
      ctx.rotate(t.rotation);
      ctx.font = `900 ${t.size}px "PingFang TC", "Microsoft JhengHei", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(3, t.size * 0.12);
      ctx.strokeStyle = t.colorStroke;
      ctx.strokeText(t.text, 0, 0);
      ctx.fillStyle = t.colorMain;
      ctx.fillText(t.text, 0, 0);
      // 高光
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `900 ${t.size * 0.9}px "PingFang TC", sans-serif`;
      ctx.fillText(t.text, -t.size * 0.04, -t.size * 0.06);
      ctx.restore();
    }

    // 結束 camera zoom
    ctx.restore();

    // 工具游標（不受 zoom 影響）
    this.drawToolCursor();

    // 反色閃爍
    if (this.invertT > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.invertT * 4})`;
      ctx.globalCompositeOperation = 'difference';
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();

    // freeze frame 白閃
    if (this.freezeT > 0.1) {
      ctx.fillStyle = `rgba(255,255,255,${(this.freezeT - 0.1) * 5})`;
      ctx.fillRect(0, 0, this.W, this.H);
    }
  }

  drawBackground(cfg) {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, cfg.bgGradient[0]);
    grad.addColorStop(0.6, cfg.bgGradient[1]);
    grad.addColorStop(1, cfg.bgGradient[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.W, this.H);

    // 地板
    ctx.fillStyle = cfg.floorColor;
    ctx.fillRect(0, this.H * 0.78, this.W, this.H * 0.22);

    if (this.level === 1) this.drawLivingRoom();
    else if (this.level === 2) this.drawBedroom();
    else if (this.level === 3) this.drawOutdoor();
    else if (this.level === 4) this.drawBossLair();
  }

  drawLivingRoom() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const t = performance.now() / 1000;

    // 牆面 / 地板分界線
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, H * 0.78 - 2, W, 3);

    // 沙發（左）
    ctx.fillStyle = '#6a4028';
    ctx.fillRect(W * 0.02, H * 0.62, W * 0.18, H * 0.18);
    // 沙發坐墊
    ctx.fillStyle = '#8a5538';
    ctx.fillRect(W * 0.03, H * 0.65, W * 0.16, H * 0.08);
    // 沙發靠墊
    ctx.fillStyle = '#a06848';
    ctx.beginPath();
    ctx.roundRect(W * 0.04, H * 0.6, 35, 30, 6);
    ctx.fill();

    // 邊几（右）+ 檯燈
    const tableX = W * 0.82;
    ctx.fillStyle = '#5a3820';
    ctx.fillRect(tableX, H * 0.66, W * 0.13, H * 0.14);
    // 燈座
    ctx.fillStyle = '#3a2418';
    ctx.fillRect(tableX + W * 0.05, H * 0.5, W * 0.03, H * 0.16);
    // 燈罩
    ctx.fillStyle = '#f0d088';
    ctx.beginPath();
    ctx.moveTo(tableX + W * 0.03, H * 0.5);
    ctx.lineTo(tableX + W * 0.10, H * 0.5);
    ctx.lineTo(tableX + W * 0.085, H * 0.42);
    ctx.lineTo(tableX + W * 0.045, H * 0.42);
    ctx.closePath();
    ctx.fill();
    // 燈光暖暈
    const lampX = tableX + W * 0.065;
    const lampY = H * 0.5;
    const lampGrad = ctx.createRadialGradient(lampX, lampY, 30, lampX, lampY, 220);
    lampGrad.addColorStop(0, 'rgba(255,220,140,0.35)');
    lampGrad.addColorStop(0.5, 'rgba(255,200,120,0.12)');
    lampGrad.addColorStop(1, 'rgba(255,180,80,0)');
    ctx.fillStyle = lampGrad;
    ctx.beginPath();
    ctx.arc(lampX, lampY, 220, 0, TWO_PI);
    ctx.fill();

    // 電視（背景左中）
    const tvX = W * 0.32;
    const tvY = H * 0.28;
    const tvW = W * 0.22;
    const tvH = H * 0.20;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(tvX, tvY, tvW, tvH);
    // 螢幕（藍光閃爍）
    const tvFlicker = 0.5 + Math.sin(t * 4) * 0.2 + Math.sin(t * 11) * 0.1;
    ctx.fillStyle = `rgba(100,140,${180 + tvFlicker * 40},${0.6 + tvFlicker * 0.2})`;
    ctx.fillRect(tvX + 8, tvY + 8, tvW - 16, tvH - 16);
    // 電視冷光打到牆上
    const tvGlow = ctx.createRadialGradient(tvX + tvW / 2, tvY + tvH / 2, 30, tvX + tvW / 2, tvY + tvH / 2, 300);
    tvGlow.addColorStop(0, `rgba(120,160,220,${0.25 + tvFlicker * 0.1})`);
    tvGlow.addColorStop(1, 'rgba(120,160,220,0)');
    ctx.fillStyle = tvGlow;
    ctx.fillRect(tvX - 100, tvY - 50, tvW + 200, tvH + 200);
    // TV stand
    ctx.fillStyle = '#3a2418';
    ctx.fillRect(tvX - 10, tvY + tvH, tvW + 20, 8);

    // 牆上時鐘
    const clockX = W * 0.2;
    const clockY = H * 0.18;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(clockX, clockY, 28, 0, TWO_PI);
    ctx.fill();
    ctx.strokeStyle = '#3a2818';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 指針
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(clockX, clockY);
    ctx.lineTo(clockX + Math.cos(t * 0.05) * 18, clockY + Math.sin(t * 0.05) * 18);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(clockX, clockY);
    ctx.lineTo(clockX, clockY - 14);
    ctx.stroke();

    // 地毯
    ctx.fillStyle = 'rgba(120,40,30,0.4)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.85, W * 0.4, H * 0.06, 0, 0, TWO_PI);
    ctx.fill();

    // 塵埃粒子
    this.drawDustMotes(0.08);
  }

  drawBedroom() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const t = performance.now() / 1000;

    // 整體暗化（疊一層深色蒙版，只有特定區域亮）
    ctx.fillStyle = 'rgba(0,0,5,0.45)';
    ctx.fillRect(0, 0, W, H);

    // 窗戶 + 月光
    const winX = W * 0.78;
    const winY = H * 0.1;
    const winW = W * 0.18;
    const winH = H * 0.28;
    // 窗框
    ctx.fillStyle = '#1a1828';
    ctx.fillRect(winX - 8, winY - 8, winW + 16, winH + 16);
    // 窗玻璃（深藍夜空）
    const winSky = ctx.createLinearGradient(winX, winY, winX, winY + winH);
    winSky.addColorStop(0, '#0a1538');
    winSky.addColorStop(1, '#1a2858');
    ctx.fillStyle = winSky;
    ctx.fillRect(winX, winY, winW, winH);
    // 月亮
    ctx.fillStyle = '#fff8d0';
    ctx.beginPath();
    ctx.arc(winX + winW * 0.65, winY + winH * 0.3, 22, 0, TWO_PI);
    ctx.fill();
    // 月暈
    const moonGlow = ctx.createRadialGradient(winX + winW * 0.65, winY + winH * 0.3, 20,
      winX + winW * 0.65, winY + winH * 0.3, 80);
    moonGlow.addColorStop(0, 'rgba(255,248,208,0.5)');
    moonGlow.addColorStop(1, 'rgba(255,248,208,0)');
    ctx.fillStyle = moonGlow;
    ctx.fillRect(winX - 20, winY - 20, winW + 40, winH + 40);
    // 窗格
    ctx.strokeStyle = '#1a1828';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(winX + winW / 2, winY);
    ctx.lineTo(winX + winW / 2, winY + winH);
    ctx.moveTo(winX, winY + winH / 2);
    ctx.lineTo(winX + winW, winY + winH / 2);
    ctx.stroke();
    // 星星
    ctx.fillStyle = 'rgba(255,255,220,0.9)';
    for (let i = 0; i < 8; i++) {
      const sx = winX + (i * 37 + 13) % winW;
      const sy = winY + (i * 53 + 19) % winH;
      ctx.beginPath();
      ctx.arc(sx, sy, rand(0.5, 1.3), 0, TWO_PI);
      ctx.fill();
    }

    // 月光從窗戶投射到地上（亮光斜照）
    const moonShaft = ctx.createLinearGradient(winX + winW * 0.3, winY + winH, winX - 200, H);
    moonShaft.addColorStop(0, 'rgba(180,200,240,0.18)');
    moonShaft.addColorStop(1, 'rgba(180,200,240,0)');
    ctx.fillStyle = moonShaft;
    ctx.beginPath();
    ctx.moveTo(winX, winY + winH);
    ctx.lineTo(winX + winW, winY + winH);
    ctx.lineTo(winX + winW - 80, H);
    ctx.lineTo(winX - 300, H);
    ctx.closePath();
    ctx.fill();

    // 床（左下）
    ctx.fillStyle = '#3a2840';
    ctx.fillRect(W * 0.02, H * 0.62, W * 0.28, H * 0.2);
    // 床墊
    ctx.fillStyle = '#5a4860';
    ctx.fillRect(W * 0.025, H * 0.65, W * 0.27, H * 0.08);
    // 棉被堆
    ctx.fillStyle = '#7a6878';
    ctx.beginPath();
    ctx.ellipse(W * 0.18, H * 0.69, 50, 18, -0.1, 0, TWO_PI);
    ctx.fill();
    // 枕頭
    ctx.fillStyle = '#a09098';
    ctx.beginPath();
    ctx.roundRect(W * 0.025, H * 0.65, 60, 22, 6);
    ctx.fill();

    // 床頭櫃 + 床頭燈（暖色微光）
    const nlX = W * 0.32;
    ctx.fillStyle = '#2a1828';
    ctx.fillRect(nlX, H * 0.7, 50, 80);
    // 燈
    ctx.fillStyle = '#ffc060';
    ctx.beginPath();
    ctx.arc(nlX + 25, H * 0.66, 10, 0, TWO_PI);
    ctx.fill();
    // 燈暖暈
    const nlGrad = ctx.createRadialGradient(nlX + 25, H * 0.66, 5, nlX + 25, H * 0.66, 120);
    nlGrad.addColorStop(0, 'rgba(255,180,80,0.5)');
    nlGrad.addColorStop(0.5, 'rgba(255,160,60,0.15)');
    nlGrad.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.fillStyle = nlGrad;
    ctx.beginPath();
    ctx.arc(nlX + 25, H * 0.66, 120, 0, TWO_PI);
    ctx.fill();

    // 蚊帳輪廓（頂端兩條垂下的紗線）
    ctx.strokeStyle = 'rgba(180,200,240,0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const x = W * 0.4 + i * 30;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.quadraticCurveTo(x + Math.sin(t + i) * 8, H * 0.3, x, H * 0.5);
      ctx.stroke();
    }

    // 漂浮塵埃（月光中可見）
    this.drawDustMotes(0.15, 'rgba(220,220,255,');
  }

  drawOutdoor() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const t = performance.now() / 1000;

    // 太陽
    const sunX = W * 0.85;
    const sunY = H * 0.15;
    ctx.fillStyle = '#fff6c0';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 35, 0, TWO_PI);
    ctx.fill();
    // 太陽光暈
    const sunGlow = ctx.createRadialGradient(sunX, sunY, 30, sunX, sunY, 150);
    sunGlow.addColorStop(0, 'rgba(255,240,180,0.5)');
    sunGlow.addColorStop(1, 'rgba(255,240,180,0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 150, 0, TWO_PI);
    ctx.fill();

    // 雲 (慢慢飄)
    const cloudOffset = (t * 8) % (W + 200);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    const drawCloud = (cx, cy, sz) => {
      ctx.beginPath();
      ctx.arc(cx, cy, sz, 0, TWO_PI);
      ctx.arc(cx + sz * 0.8, cy, sz * 0.85, 0, TWO_PI);
      ctx.arc(cx - sz * 0.8, cy, sz * 0.7, 0, TWO_PI);
      ctx.arc(cx + sz * 0.3, cy - sz * 0.6, sz * 0.7, 0, TWO_PI);
      ctx.fill();
    };
    drawCloud(((W * 0.15 + cloudOffset) % (W + 200)) - 100, H * 0.12, 22);
    drawCloud(((W * 0.55 + cloudOffset * 0.7) % (W + 200)) - 100, H * 0.2, 28);
    drawCloud(((W * 0.85 + cloudOffset * 0.85) % (W + 200)) - 100, H * 0.08, 18);

    // 遠山
    ctx.fillStyle = 'rgba(80,140,100,0.6)';
    ctx.beginPath();
    ctx.moveTo(0, H * 0.55);
    ctx.lineTo(W * 0.2, H * 0.42);
    ctx.lineTo(W * 0.4, H * 0.5);
    ctx.lineTo(W * 0.55, H * 0.4);
    ctx.lineTo(W * 0.75, H * 0.48);
    ctx.lineTo(W, H * 0.45);
    ctx.lineTo(W, H * 0.55);
    ctx.closePath();
    ctx.fill();

    // 大樹（左）
    ctx.fillStyle = '#4a3018';
    ctx.fillRect(W * 0.05, H * 0.45, 25, H * 0.4);
    const treeSway = Math.sin(t * 0.8) * 4;
    // 樹冠
    ctx.fillStyle = '#4a8038';
    ctx.beginPath();
    ctx.ellipse(W * 0.08 + treeSway, H * 0.42, 80, 90, 0, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#5a9048';
    ctx.beginPath();
    ctx.ellipse(W * 0.05 + treeSway, H * 0.35, 60, 60, 0, 0, TWO_PI);
    ctx.fill();

    // 小灌木（右）
    ctx.fillStyle = '#3a7028';
    ctx.beginPath();
    ctx.ellipse(W * 0.92, H * 0.7, 50, 35, 0, 0, TWO_PI);
    ctx.fill();
    ctx.fillStyle = '#4a8038';
    ctx.beginPath();
    ctx.ellipse(W * 0.95, H * 0.68, 30, 25, 0, 0, TWO_PI);
    ctx.fill();

    // 草地紋理
    ctx.strokeStyle = '#2a5018';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < W; i += 12) {
      const gx = i + (i * 37 % 8);
      const gy = H * 0.78 + (i % 15) + 3;
      const sw = Math.sin(t * 1.5 + i * 0.1) * 2;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + sw, gy - 5, gx + sw, gy - 10);
      ctx.stroke();
    }

    // 飄花瓣 / 蒲公英種子
    if (!this._pollens) {
      this._pollens = [];
      for (let i = 0; i < 12; i++) {
        this._pollens.push({
          x: rand(0, W), y: rand(0, H * 0.6),
          vx: rand(20, 50), vy: rand(-5, 5),
          phase: rand(0, TWO_PI)
        });
      }
    }
    ctx.fillStyle = 'rgba(255,255,240,0.7)';
    for (const p of this._pollens) {
      p.x += p.vx * 0.016;
      p.y += Math.sin(t * 1.5 + p.phase) * 0.5;
      if (p.x > W + 10) { p.x = -10; p.y = rand(0, H * 0.6); }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, TWO_PI);
      ctx.fill();
    }
  }

  drawBossLair() {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const t = performance.now() / 1000;

    // 整體暗化
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);

    // 詭異紫光（脈動）
    const pulse = 0.5 + Math.sin(t * 1.5) * 0.2;
    const evilGlow = ctx.createRadialGradient(W / 2, H * 0.3, 30, W / 2, H * 0.3, W * 0.9);
    evilGlow.addColorStop(0, `rgba(200,80,200,${0.5 * pulse})`);
    evilGlow.addColorStop(0.4, `rgba(120,40,160,${0.25 * pulse})`);
    evilGlow.addColorStop(1, 'rgba(40,0,60,0)');
    ctx.fillStyle = evilGlow;
    ctx.fillRect(0, 0, W, H);

    // 地上的舊血漬（蔓延感）
    if (!this._evilSplats) {
      this._evilSplats = [];
      for (let i = 0; i < 12; i++) {
        this._evilSplats.push({
          x: rand(0, W), y: rand(H * 0.78, H - 30),
          r: rand(20, 60), points: this.makeSplatPoints(rand(8, 14), rand(20, 60))
        });
      }
    }
    ctx.fillStyle = 'rgba(80,10,20,0.7)';
    for (const s of this._evilSplats) {
      ctx.beginPath();
      ctx.moveTo(s.x + s.points[0].x, s.y + s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        const prev = s.points[i - 1];
        const cur = s.points[i];
        ctx.quadraticCurveTo(s.x + (prev.x + cur.x) / 2 * 1.1, s.y + (prev.y + cur.y) / 2 * 1.1,
          s.x + cur.x, s.y + cur.y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // 飄浮的塵粒（陰森）
    this.drawDustMotes(0.12, 'rgba(200,140,200,');

    // 邊緣 vignette
    const vig = ctx.createRadialGradient(W / 2, H / 2, W * 0.35, W / 2, H / 2, W * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  // 工具：產生不規則 splat 形狀的點集
  makeSplatPoints(count, baseR) {
    const points = [];
    for (let p = 0; p < count; p++) {
      const pa = (p / count) * TWO_PI;
      const pr = baseR * rand(0.6, 1.4);
      points.push({ x: Math.cos(pa) * pr, y: Math.sin(pa) * pr });
    }
    return points;
  }

  // 通用塵埃粒子（共用於多個場景）
  drawDustMotes(amount, colorPrefix = 'rgba(255,240,200,') {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    const t = performance.now() / 1000;
    if (!this._dust) {
      this._dust = [];
      for (let i = 0; i < 30; i++) {
        this._dust.push({
          x: rand(0, W), y: rand(0, H * 0.7),
          r: rand(0.5, 1.8),
          phase: rand(0, TWO_PI),
          vy: rand(5, 15)
        });
      }
    }
    for (const d of this._dust) {
      d.y += d.vy * 0.012;
      d.x += Math.sin(t + d.phase) * 0.3;
      if (d.y > H * 0.78) { d.y = -5; d.x = rand(0, W); }
      const alpha = (0.3 + Math.sin(t * 2 + d.phase) * 0.2) * amount * 5;
      ctx.fillStyle = colorPrefix + clamp(alpha, 0, 1) + ')';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TWO_PI);
      ctx.fill();
    }
  }

  drawElectricRacket(x, y, active) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);

    // 通電有效範圍（半透明電場圈）
    if (active) {
      const pulse = 0.5 + Math.sin(performance.now() / 100) * 0.2;
      const r = 95; // ≈ 65 + 35×scale(0.85 avg)，視覺範圍
      const rangeGrad = ctx.createRadialGradient(0, 0, 30, 0, 0, r);
      rangeGrad.addColorStop(0, `rgba(120,220,255,${0.18 * pulse})`);
      rangeGrad.addColorStop(0.6, `rgba(120,220,255,${0.08 * pulse})`);
      rangeGrad.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.fillStyle = rangeGrad;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TWO_PI);
      ctx.fill();
      // 範圍外環（虛線）
      ctx.strokeStyle = `rgba(180,240,255,${0.45 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 拍面
    ctx.fillStyle = 'rgba(80,200,255,0.15)';
    ctx.strokeStyle = active ? '#88f0ff' : '#48a0c8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, 50, 35, 0, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();

    // 電網線
    ctx.strokeStyle = active ? 'rgba(180,240,255,0.8)' : 'rgba(120,180,200,0.4)';
    ctx.lineWidth = 1;
    for (let i = -45; i <= 45; i += 6) {
      ctx.beginPath();
      ctx.moveTo(i, -Math.sqrt(Math.max(0, 35 * 35 - (i / 50 * 35) * (i / 50 * 35) * (35 / 50) * (35 / 50)) * 0.8));
      ctx.lineTo(i, Math.sqrt(Math.max(0, 35 * 35 - (i / 50 * 35) * (i / 50 * 35) * (35 / 50) * (35 / 50)) * 0.8));
      ctx.stroke();
    }

    // 把手
    ctx.fillStyle = '#cc4040';
    ctx.fillRect(-6, 35, 12, 40);

    // 電弧（active 時）
    if (active) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = rand(0.3, 0.8);
        ctx.beginPath();
        const sx = rand(-40, 40);
        const sy = rand(-25, 25);
        ctx.moveTo(sx, sy);
        for (let j = 0; j < 5; j++) {
          ctx.lineTo(sx + rand(-10, 10) * j, sy + rand(-10, 10) * j);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  drawToolCursor() {
    if (this.mouse.x === null) return;
    const ctx = this.ctx;
    if (this.tool.kind === 'hand') {
      // 距離最近的蚊子 -> 接近極近距離時手稍微放大半透明
      let minDist = Infinity;
      for (const m of this.mosquitoes) {
        if (m.state === 'biting') {
          minDist = Math.min(minDist, dist(m.x, m.y, this.mouse.x, this.mouse.y));
        }
      }
      const closeFactor = clamp(1 - minDist / 100, 0, 1);
      const scale = 0.7 + closeFactor * 0.9; // 縮小，最大 1.6
      const alpha = 1 - closeFactor * 0.4;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(this.mouse.x, this.mouse.y);
      ctx.scale(scale, scale);
      // 簡筆手掌
      ctx.fillStyle = '#f4d4a8';
      ctx.strokeStyle = '#a07848';
      ctx.lineWidth = 2;
      ctx.beginPath();
      // 掌心
      ctx.ellipse(0, 4, 14, 17, 0, 0, TWO_PI);
      ctx.fill(); ctx.stroke();
      // 手指
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        const fx = -9 + i * 6;
        ctx.ellipse(fx, -14, 3, 11, 0, 0, TWO_PI);
        ctx.fill(); ctx.stroke();
      }
      // 拇指
      ctx.beginPath();
      ctx.ellipse(-14, 0, 4, 8, -0.6, 0, TWO_PI);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    } else if (this.tool.kind === 'swatter') {
      ctx.save();
      ctx.translate(this.mouse.x, this.mouse.y);
      // 拍面
      ctx.fillStyle = 'rgba(60,60,60,0.4)';
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, 45, 30, 0, 0, TWO_PI);
      ctx.fill();
      ctx.stroke();
      // 網格
      ctx.strokeStyle = 'rgba(40,40,40,0.6)';
      ctx.lineWidth = 1;
      for (let i = -40; i <= 40; i += 5) {
        ctx.beginPath();
        const h = Math.sqrt(Math.max(0, 30 * 30 * (1 - (i / 45) * (i / 45))));
        ctx.moveTo(i, -h);
        ctx.lineTo(i, h);
        ctx.stroke();
      }
      for (let j = -25; j <= 25; j += 5) {
        ctx.beginPath();
        const w = Math.sqrt(Math.max(0, 45 * 45 * (1 - (j / 30) * (j / 30))));
        ctx.moveTo(-w, j); ctx.lineTo(w, j); ctx.stroke();
      }
      // 把手
      ctx.fillStyle = '#8b4513';
      ctx.fillRect(-5, 30, 10, 50);
      ctx.restore();
    }
    // 電蚊拍游標就跟著放置位置，不需另外畫
  }
}

// ============================================================
// 啟動
// ============================================================
window.addEventListener('load', () => {
  const game = new Game();
  window.game = game; // for debug
});
