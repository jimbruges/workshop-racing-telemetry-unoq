// SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
//
// SPDX-License-Identifier: MPL-2.0

const classesRoot  = document.getElementById('classes');
const wheelGroup   = document.getElementById('wheel-group');
const wheelSvg     = document.getElementById('wheel-svg');
const wheelAngleEl = document.getElementById('wheel-angle');
const flashBg      = document.getElementById('gear-flash-bg');
const svgShiftText = document.getElementById('svg-shift-text');
const svgGearNum   = document.getElementById('svg-gear-num');
const stateCard    = document.getElementById('state-card');
const stateIcon    = document.getElementById('state-icon');
const stateName    = document.getElementById('state-name');
const dirLeft      = document.getElementById('dir-left');
const dirRight     = document.getElementById('dir-right');
const revLights    = document.querySelectorAll('.rev-light');
const btnAEl = document.getElementById('btn-a');
const btnBEl = document.getElementById('btn-b');
const btnCEl = document.getElementById('btn-c');
const calibrateZeroBtn = document.getElementById('calibrate-zero-btn');
const calResetBtn = document.getElementById('cal-reset-btn');
const angleOffsetInput = document.getElementById('angle-offset-input');
const angleInvertInput = document.getElementById('angle-invert-input');
const angleCalNote = document.getElementById('angle-calibration-note');
const telemetryCanvas = document.getElementById('plot') || document.getElementById('telemetry-canvas');
let errorContainer;

// ── Rev / gear simulation state ───────────────────────────────────────────
let gear        = 1;
const MAX_GEAR   = 6;
let rpm          = 900;
let rpmPct       = 0;
const IDLE_RPM    = 900;
const REDLINE_RPM = 9000;
const RPM_ACCEL_PCT_BY_GEAR = [0, 0.70, 0.30, 0.22, 0.17, 0.13, 0.065];
const RPM_DECEL_PCT = 0.30;
const RPM_ENGINE_OFF_DECEL_PCT = 0.30;
let atRedline     = false;
let flashOn       = false;
let lastFlashTs   = 0;
let lastRevTs     = performance.now();
let lastUpshiftTs = -Infinity;
let isMuted       = false;
let engineOn      = false;
let acceleratorHeld = false;
let pixelsConnected = false;
const REV_SEGMENTS = 8;

const gearNumEl  = document.getElementById('gear-num');
const DEFAULT_ANGLE_CALIBRATION = {
  // Current hardware install is offset by about -21° when level.
  offsetDeg: 21,
  invert: true,
};
const ANGLE_CALIBRATION_STORAGE_KEY = 'f1-wheel-angle-calibration-v1';

// ── Engine audio ──────────────────────────────────────────────────────────
class EngineAudio {
  constructor() {
    this._started  = false;
    this._blipEnd  = 0;
    this.ctx       = null;
    this.osc1      = null;
    this.osc2      = null;
    this.osc3      = null;
    this.filter    = null;
    this.masterGain = null;
    this.muted     = false;
  }

  start() {
    if (this._started) return;
    try {
      this.ctx  = new (window.AudioContext || window.webkitAudioContext)();
      this.osc1 = this.ctx.createOscillator(); this.osc1.type = 'sawtooth';
      this.osc2 = this.ctx.createOscillator(); this.osc2.type = 'sawtooth';
      this.osc3 = this.ctx.createOscillator(); this.osc3.type = 'square';

      const g1 = this.ctx.createGain(); g1.gain.value = 0.50;
      const g2 = this.ctx.createGain(); g2.gain.value = 0.30;
      const g3 = this.ctx.createGain(); g3.gain.value = 0.15;
      this.osc1.connect(g1); this.osc2.connect(g2); this.osc3.connect(g3);

      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass'; this.filter.Q.value = 2;
      g1.connect(this.filter); g2.connect(this.filter); g3.connect(this.filter);

      const shaper = this.ctx.createWaveShaper();
      shaper.curve = EngineAudio._dist(80); shaper.oversample = '4x';
      this.filter.connect(shaper);

      this.masterGain = this.ctx.createGain(); this.masterGain.gain.value = 0;
      shaper.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this.osc1.start(); this.osc2.start(); this.osc3.start();
      this._started = true;
    } catch(e) { console.warn('EngineAudio init failed:', e); }
  }

  static _dist(amount) {
    const n = 256, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      c[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
    }
    return c;
  }

  update(rpm, state) {
    if (!this._started || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t   = this.ctx.currentTime;
    const hz  = (rpm / 60) * 5;  // F1 V10: 5 cylinder firings per revolution
    const filt = 200 + (rpm / REDLINE_RPM) * 3200;
    this.filter.frequency.setTargetAtTime(filt, t, 0.08);
    if (t < this._blipEnd) return;            // let blip play out
    this.osc1.frequency.setTargetAtTime(hz,        t, 0.05);
    this.osc2.frequency.setTargetAtTime(hz * 2.01, t, 0.05);
    this.osc3.frequency.setTargetAtTime(hz * 0.50, t, 0.05);
    const vol = this.muted ? 0 : (rpm > 1500 ? 0.22 + (rpm / REDLINE_RPM) * 0.08 : 0.05);
    this.masterGain.gain.setTargetAtTime(vol, t, 0.08);
  }

  gearBlip(prevRpm) {
    if (!this._started || this.muted) return;
    const t  = this.ctx.currentTime;
    const hz = (prevRpm / 60) * 5;
    this.osc1.frequency.cancelScheduledValues(t);
    this.osc1.frequency.setValueAtTime(hz * 1.06, t);
    this.osc1.frequency.linearRampToValueAtTime(hz * 0.50, t + 0.20);
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setValueAtTime(0.40, t);
    this.masterGain.gain.linearRampToValueAtTime(0.15, t + 0.22);
    this._blipEnd = t + 0.25;
  }

  setMuted(m) {
    this.muted = m;
    if (this._started && this.ctx)
      this.masterGain.gain.setTargetAtTime(m ? 0 : 0.2, this.ctx.currentTime, 0.1);
  }
}

const engineAudio = new EngineAudio();
// Start audio context on first user interaction (browser autoplay policy)
document.addEventListener('click', () => engineAudio.start(), { once: true });

let currentState    = 'idle';
let currentAngleDeg = 0;
let lastRawAngleDeg = 0;
let angleCalibration = { ...DEFAULT_ANGLE_CALIBRATION };

// ── On-wheel acceleration graph state ─────────────────────────────────────
const ACCEL_HISTORY_LEN = 32;
const GRAPH_X0 = 134;
const GRAPH_Y0 = 172;
const GRAPH_W  = 108;
const GRAPH_H  = 28;
const GRAPH_HALF_H = GRAPH_H / 2;
const accelHistory = {
  x: new Array(ACCEL_HISTORY_LEN).fill(0),
  y: new Array(ACCEL_HISTORY_LEN).fill(0),
  z: new Array(ACCEL_HISTORY_LEN).fill(0),
};
const TELEMETRY_HISTORY_LEN = 150;
const telemetryHistory = {
  x: new Array(TELEMETRY_HISTORY_LEN).fill(0),
  y: new Array(TELEMETRY_HISTORY_LEN).fill(0),
  z: new Array(TELEMETRY_HISTORY_LEN).fill(0),
  revs: new Array(TELEMETRY_HISTORY_LEN).fill(0),
};
let latestAccel = { x: 0, y: 0, z: 0 };

// ── WebUI connection ──────────────────────────────────────────────────────

const ui = new WebUI({
  path: '/socket.io',
  transports: ['polling', 'websocket'],
  autoConnect: true,
});

ui.on_connect(() => {
  if (errorContainer) {
    errorContainer.style.display = 'none';
    errorContainer.textContent   = '';
  }
});

ui.on_disconnect(() => {
  errorContainer = document.getElementById('error-container');
  if (errorContainer) {
    errorContainer.textContent   = 'Connection to the board lost. Please check the connection.';
    errorContainer.style.display = 'block';
  }
});

ui.on_message('movement',      data => setValues(data));
ui.on_message('sample',        s    => updateWheel(s));
ui.on_message('engine_toggle', data => {
  const prevEngineOn = engineOn;
  engineOn = data.on;
  if (engineOn) {
    rpmPct = Math.max(rpmPct, 0.0);
    rpm = IDLE_RPM + (rpmPct * (REDLINE_RPM - IDLE_RPM));
    engineAudio.start();
    engineAudio.setMuted(isMuted);
  } else {
    rpm = 0;
    engineAudio.setMuted(true);
  }
  updateEngineIndicator();
  if (engineOn !== prevEngineOn) {
    flashButton(btnAEl, 300);
  }
  if (!engineOn) {
    if (btnCEl) btnCEl.classList.remove('active');
    if (btnBEl) btnBEl.classList.remove('active');
  }
});
ui.on_message('button_c_state', data => {
  acceleratorHeld = data.held;
  if (btnCEl) btnCEl.classList.toggle('active', data.held);
});
ui.on_message('button_b_downshift', data => {
  const prevGear = gear;
  const nextGear = Number.parseInt(data?.gear, 10);
  if (Number.isFinite(nextGear)) {
    gear = Math.max(1, Math.min(MAX_GEAR, nextGear));
    updateGearDisplay();
  }
  if (gear !== prevGear) {
    if (engineOn) rpmPct = Math.max(rpmPct, 0.55);
    flashButton(btnBEl, 700);
  }
});
ui.on_message('pixels_connected_state', data => {
  pixelsConnected = !!data?.connected;
});
ui.on_message('angle_calibration_state', data => {
  applyCalibrationState(data, { persist: true, rerenderWheel: true });
});

// ── Wheel update (driven by raw accelerometer samples) ────────────────────

function updateWheel(s) {
  latestAccel = {
    x: Number.isFinite(s?.x) ? s.x : 0,
    y: Number.isFinite(s?.y) ? s.y : 0,
    z: Number.isFinite(s?.z) ? s.z : 0,
  };

  // X accel in g → steering angle; clamp ±1 g → ±90°
  const clampedX  = Math.max(-1, Math.min(1, latestAccel.x));
  const signedX = angleCalibration.invert ? -clampedX : clampedX;
  lastRawAngleDeg = signedX * 90;
  currentAngleDeg = lastRawAngleDeg + angleCalibration.offsetDeg;

  // Rotate the SVG wheel group around its centre (190, 125) matching new viewBox
  wheelGroup.setAttribute('transform', `rotate(${currentAngleDeg.toFixed(1)},190,125)`);
  wheelAngleEl.textContent = `${Math.round(currentAngleDeg)}°`;

  // Highlight direction arrows
  if (currentAngleDeg < -8) {
    dirLeft.classList.add('active');
    dirRight.classList.remove('active');
  } else if (currentAngleDeg > 8) {
    dirLeft.classList.remove('active');
    dirRight.classList.add('active');
  } else {
    dirLeft.classList.remove('active');
    dirRight.classList.remove('active');
  }
  // Rev lights are driven by the RPM loop, not steering angle
  updateAccelGraph(latestAccel);
}

function flashButton(el, durationMs) {
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), durationMs);
}

function applyRuntimeConfig(cfg) {
  if (!cfg) return;

  const offsetCandidate = Number.parseFloat(cfg.angle_offset_deg);
  if (Number.isFinite(offsetCandidate)) {
    angleCalibration.offsetDeg = Math.max(-180, Math.min(180, offsetCandidate));
  }

  if (typeof cfg.angle_invert === 'boolean') {
    angleCalibration.invert = cfg.angle_invert;
  }

  if (typeof cfg.engine_on === 'boolean') {
    engineOn = cfg.engine_on;
    updateEngineIndicator();
  }

  if (typeof cfg.button_c_held === 'boolean') {
    acceleratorHeld = cfg.button_c_held;
    if (btnCEl) btnCEl.classList.toggle('active', acceleratorHeld);
  }

  const gearCandidate = Number.parseInt(cfg.gear, 10);
  if (Number.isFinite(gearCandidate)) {
    gear = Math.max(1, Math.min(MAX_GEAR, gearCandidate));
    updateGearDisplay();
  }

  renderCalibrationUi();
}

function applyCalibrationState(payload, { persist = false, rerenderWheel = false } = {}) {
  if (!payload || typeof payload !== 'object') return;

  const next = { ...angleCalibration };
  const offsetCandidate = Number.parseFloat(payload.offsetDeg);
  if (Number.isFinite(offsetCandidate)) {
    next.offsetDeg = Math.max(-180, Math.min(180, offsetCandidate));
  }

  if (typeof payload.invert === 'boolean') {
    next.invert = payload.invert;
  }

  angleCalibration = next;
  renderCalibrationUi();
  if (persist) persistLocalCalibration();

  if (rerenderWheel) {
    currentAngleDeg = lastRawAngleDeg + angleCalibration.offsetDeg;
    wheelGroup.setAttribute('transform', `rotate(${currentAngleDeg.toFixed(1)},190,125)`);
    wheelAngleEl.textContent = `${Math.round(currentAngleDeg)}°`;
  }
}

function loadLocalCalibration() {
  try {
    const raw = localStorage.getItem(ANGLE_CALIBRATION_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const next = {};
    if (Number.isFinite(data.offsetDeg)) {
      next.offsetDeg = Math.max(-180, Math.min(180, Number(data.offsetDeg)));
    }
    if (typeof data.invert === 'boolean') {
      next.invert = data.invert;
    }
    return next;
  } catch {
    return null;
  }
}

function persistLocalCalibration() {
  try {
    localStorage.setItem(ANGLE_CALIBRATION_STORAGE_KEY, JSON.stringify({
      offsetDeg: angleCalibration.offsetDeg,
      invert: angleCalibration.invert,
    }));
  } catch {
    // Ignore storage errors.
  }
}

function publishCalibration() {
  ui.send_message('angle_calibration', {
    offsetDeg: angleCalibration.offsetDeg,
    invert: angleCalibration.invert,
  });
}

function renderCalibrationUi() {
  if (angleOffsetInput) angleOffsetInput.value = String(Math.round(angleCalibration.offsetDeg));
  if (angleInvertInput) angleInvertInput.checked = !!angleCalibration.invert;
  if (angleCalNote) {
    const sign = angleCalibration.offsetDeg >= 0 ? '+' : '';
    angleCalNote.textContent = `Using offset ${sign}${Math.round(angleCalibration.offsetDeg)}°, invert ${angleCalibration.invert ? 'on' : 'off'}`;
  }
}

function initSettingsUi() {
  const local = loadLocalCalibration();
  if (local) {
    angleCalibration = { ...angleCalibration, ...local };
  }
  renderCalibrationUi();

  if (calibrateZeroBtn) {
    calibrateZeroBtn.addEventListener('click', () => {
      angleCalibration.offsetDeg = Math.max(-180, Math.min(180, -lastRawAngleDeg));
      persistLocalCalibration();
      renderCalibrationUi();
      publishCalibration();
    });
  }

  if (angleOffsetInput) {
    angleOffsetInput.addEventListener('change', () => {
      const val = Number.parseFloat(angleOffsetInput.value);
      if (!Number.isFinite(val)) {
        renderCalibrationUi();
        return;
      }
      angleCalibration.offsetDeg = Math.max(-180, Math.min(180, val));
      persistLocalCalibration();
      renderCalibrationUi();
      publishCalibration();
    });
  }

  if (angleInvertInput) {
    angleInvertInput.addEventListener('change', () => {
      angleCalibration.invert = !!angleInvertInput.checked;
      persistLocalCalibration();
      renderCalibrationUi();
      publishCalibration();
    });
  }

  if (calResetBtn) {
    calResetBtn.addEventListener('click', () => {
      angleCalibration = { ...DEFAULT_ANGLE_CALIBRATION };
      localStorage.removeItem(ANGLE_CALIBRATION_STORAGE_KEY);
      persistLocalCalibration();
      renderCalibrationUi();
      publishCalibration();
    });
  }
}

function initVirtualButtons() {
  if (btnAEl) {
    btnAEl.addEventListener('click', () => {
      ui.send_message('ui_button_a_press', {});
    });
  }

  if (btnBEl) {
    btnBEl.addEventListener('click', () => {
      ui.send_message('ui_button_b_press', {});
    });
  }

  if (btnCEl) {
    btnCEl.addEventListener('click', () => {
      const nextHeld = !acceleratorHeld;
      // Optimistic UI update; authoritative state is pushed back from the board.
      acceleratorHeld = nextHeld;
      btnCEl.classList.toggle('active', nextHeld);
      ui.send_message('ui_button_c_set', { held: nextHeld });
    });
  }
}

// ── Rev lights (RPM-driven) ───────────────────────────────────────────────

function getRevPct() {
  return Math.max(0, Math.min(1, rpmPct));
}

function updateRevLights() {
  const numLit = Math.round(getRevPct() * REV_SEGMENTS);
  revLights.forEach((light, i) => {
    light.className = 'rev-light';
    if (atRedline) {
      if (flashOn) light.classList.add('red');
    } else if (i < numLit) {
      if      (i < 3) light.classList.add('green');
      else if (i < 6) light.classList.add('yellow');
      else            light.classList.add('red');
    }
  });
}

function pushTelemetrySample() {
  const x = Math.max(-1, Math.min(1, latestAccel.x || 0));
  const y = Math.max(-1, Math.min(1, latestAccel.y || 0));
  const z = Math.max(-1, Math.min(1, latestAccel.z || 0));
  const rev = getRevPct();

  telemetryHistory.x.push(x); telemetryHistory.x.shift();
  telemetryHistory.y.push(y); telemetryHistory.y.shift();
  telemetryHistory.z.push(z); telemetryHistory.z.shift();
  telemetryHistory.revs.push(rev); telemetryHistory.revs.shift();
}

function drawTelemetryPlot() {
  if (!telemetryCanvas) return;
  const ctx = telemetryCanvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = telemetryCanvas.clientWidth || 640;
  const cssH = telemetryCanvas.clientHeight || 200;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (telemetryCanvas.width !== targetW || telemetryCanvas.height !== targetH) {
    telemetryCanvas.width = targetW;
    telemetryCanvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.strokeStyle = '#f0f0f0';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let i = 0; i <= 8; i++) {
    const y = 10 + i * ((cssH - 20) / 8);
    ctx.moveTo(40, y);
    ctx.lineTo(cssW, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#666';
  ctx.font = '11px Arial';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 8; i++) {
    const y = 10 + i * ((cssH - 20) / 8);
    const value = (2.0 - i * 0.5).toFixed(1);
    ctx.fillText(value, 35, y);
  }

  const step = (cssW - 40) / (TELEMETRY_HISTORY_LEN - 1);
  const drawSeries = (arr, color, toY, width = 1.0) => {
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) {
      const x = 40 + (i * step);
      const y = toY(arr[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  drawSeries(telemetryHistory.x, '#0068C9', v => (cssH / 2) - (Math.max(-2, Math.min(2, v)) * ((cssH - 20) / 4)));
  drawSeries(telemetryHistory.y, '#FF9900', v => (cssH / 2) - (Math.max(-2, Math.min(2, v)) * ((cssH - 20) / 4)));
  drawSeries(telemetryHistory.z, '#FF2B2B', v => (cssH / 2) - (Math.max(-2, Math.min(2, v)) * ((cssH - 20) / 4)));
  drawSeries(telemetryHistory.revs, '#16A588', v => cssH - 10 - (Math.max(0, Math.min(1, v)) * (cssH - 20)), 1.2);
}

// ── LED matrix mirror ───────────────────────────────────────────────────
// 104-element flat arrays (8 rows × 13 cols), grayscale values 0–7
const LF_IDLE       = [0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,7,7,7,7,7,0,0,0,0, 0,0,0,7,0,0,0,0,0,7,0,0,0, 0,0,0,7,0,0,7,0,0,7,0,0,0, 0,0,0,7,0,0,7,0,0,7,0,0,0, 0,0,0,7,0,0,0,0,0,7,0,0,0, 0,0,0,0,7,7,7,7,7,0,0,0,0, 0,0,0,0,0,0,7,0,0,0,0,0,0];
const LF_ENGINE_OFF = LF_IDLE.map(v => v ? 1 : 0);
const LF_STEER_L    = [0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,7,0,0,7,0,0,7,0,0,0,0, 0,7,0,0,7,0,0,7,0,0,0,0,0, 0,7,0,0,7,0,0,7,0,0,0,0,0, 0,0,7,0,0,7,0,0,7,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0];
const LF_STEER_R    = [0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,7,0,0,7,0,0,7,0,0, 0,0,0,0,0,7,0,0,7,0,0,7,0, 0,0,0,0,0,7,0,0,7,0,0,7,0, 0,0,0,0,7,0,0,7,0,0,7,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0];
const LF_ARROW      = [0,0,0,0,0,0,7,0,0,0,0,0,0, 0,0,0,0,0,7,7,7,0,0,0,0,0, 0,0,0,0,7,7,7,7,7,0,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,7,0,0,0,0,0,0, 0,0,0,0,0,0,7,0,0,0,0,0,0, 0,0,0,0,0,0,7,0,0,0,0,0,0, 0,0,0,0,0,0,7,0,0,0,0,0,0];
const LF_GEARS = [
  [0,0,0,0,0,7,0,0,0,0,0,0,0, 0,0,0,0,7,7,0,0,0,0,0,0,0, 0,0,0,0,0,7,0,0,0,0,0,0,0, 0,0,0,0,0,7,0,0,0,0,0,0,0, 0,0,0,0,0,7,0,0,0,0,0,0,0, 0,0,0,0,0,7,0,0,0,0,0,0,0, 0,0,0,7,7,7,7,7,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 1
  [0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 2
  [0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 3
  [0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,7,7,0,0,0,7,7,0,0,0, 0,0,0,7,7,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 4
  [0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,0,0,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 5
  [0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,0,0,0,0,0,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,7,7,0,0,0,7,7,0,0,0, 0,0,0,7,7,0,0,0,7,7,0,0,0, 0,0,0,7,7,7,7,7,7,7,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0], // 6
];

const LED_ROWS = 8;
const LED_COLS = 13;
const CAR_SPR_W = 13;
const CAR_SPR_H = 8;
const EXHAUST_PUFFS = 4;
const EXHAUST_SPACING_X = 3;
const EXHAUST_BACK_X = 2;
const EXHAUST_Y = 5;
const EXHAUST_TRAIL_X = EXHAUST_BACK_X + (EXHAUST_PUFFS - 1) * EXHAUST_SPACING_X;

const CAR_SPRITE = [
  0,0,0,0,7,7,7,7,0,0,0,0,0,
  0,0,0,7,0,5,0,0,7,0,0,0,0,
  0,0,7,0,0,5,0,0,0,7,0,0,0,
  0,7,7,5,5,5,5,5,5,7,7,6,0,
  7,7,5,5,5,5,5,5,5,5,7,7,7,
  7,7,5,0,0,7,7,7,0,0,5,7,7,
  0,0,7,3,7,0,0,0,7,3,7,0,0,
  0,0,0,7,0,0,0,0,0,7,0,0,0,
];

let ledCarX = 0;
let ledCarTick = 0;
let ledCarLastMoveTs = 0;
const CAR_SCROLL_INTERVAL_MS_BY_GEAR = [0, 260, 210, 170, 130, 90, 60];

function dimFrameInPlace(frame, value = 2) {
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    if (!v) continue;
    frame[i] = Math.max(1, Math.min(7, Math.min(v, value)));
  }
}

const ledCells = [];

function initLedMatrix() {
  const ns = 'http://www.w3.org/2000/svg';
  const g  = document.getElementById('led-matrix');
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 13; j++) {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x',      132 + j * 9);
      r.setAttribute('y',      114 + i * 7);
      r.setAttribute('width',  8);
      r.setAttribute('height', 6);
      r.setAttribute('rx',     1);
      g.appendChild(r);
      ledCells.push(r);
    }
  }
}

function ledSetPixel(frame, x, y, value = 7) {
  if (x < 0 || x >= LED_COLS || y < 0 || y >= LED_ROWS) return;
  frame[(y * LED_COLS) + x] = Math.max(0, Math.min(7, value));
}

function drawLedSprite(frame, sprite, w, h, x0, y0) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = sprite[(y * w) + x];
      if (v) ledSetPixel(frame, x0 + x, y0 + y, v);
    }
  }
}

function drawLedRacecar(frame, tailX, topY, tick, animate = true) {
  drawLedSprite(frame, CAR_SPRITE, CAR_SPR_W, CAR_SPR_H, tailX, topY);
  const hub = animate && (tick & 1) ? 3 : 0;
  ledSetPixel(frame, tailX + 3, topY + 6, hub);
  ledSetPixel(frame, tailX + 9, topY + 6, hub);
  ledSetPixel(frame, tailX + 12, topY + 4, animate ? ((tick & 1) ? 7 : 5) : 2);
}

function drawLedExhaust(frame, tailX, topY, phase) {
  const puffX = tailX - EXHAUST_BACK_X;
  const puffY = topY + EXHAUST_Y;
  const p = phase % 4;
  let baseB = 6;
  if (p === 0) baseB = 5;
  else if (p === 1) baseB = 6;
  else if (p === 2) baseB = 7;
  else baseB = 4;

  const bright = (delta) => Math.max(1, Math.min(7, baseB - delta));

  for (let i = 0; i < EXHAUST_PUFFS; i++) {
    const x = puffX - (i * EXHAUST_SPACING_X);
    const falloff = i * 2;

    const level = (v) => Math.max(1, Math.min(7, v - falloff));
    const pix = (dx, dy, v) => ledSetPixel(frame, x + dx, puffY + dy, level(v));

    if (i === 0) {
      pix(0, 0, baseB);
      pix(-1, 0, bright(1));
      pix(-1, -1, bright(2));
      pix(-2, 0, bright(3));
    } else if (i === 1) {
      pix(0, 0, bright(1));
      pix(-1, 0, bright(3));
    } else if (i === 2) {
      pix(0, 0, bright(3));
      if (p === 2) pix(0, -1, bright(5));
    } else {
      pix(0, 0, bright(5));
    }
  }
}

function buildIdleCarFrame(ts, { accelerating = false, smokeOn = true, engineOnState = true } = {}) {
  const frame = new Array(104).fill(0);
  const isAccelerating = !!accelerating;
  const stepMs = CAR_SCROLL_INTERVAL_MS_BY_GEAR[Math.max(1, Math.min(6, gear))];

  if (!isAccelerating) {
    ledCarX = 0;
  } else if ((ts - ledCarLastMoveTs) >= stepMs) {
    ledCarLastMoveTs = ts;
    ledCarX += 1;
    if (ledCarX > LED_COLS + EXHAUST_TRAIL_X) ledCarX = -CAR_SPR_W;
  }

  drawLedRacecar(frame, ledCarX, 0, ledCarTick, engineOnState);
  if (smokeOn) {
    drawLedExhaust(frame, ledCarX, 0, ledCarTick);
  }
  if (engineOnState) ledCarTick += 1;
  if (!engineOnState) dimFrameInPlace(frame, 2);

  return frame;
}

function currentLedFrame(ts) {
  if (!engineOn) return buildIdleCarFrame(ts, { accelerating: false, smokeOn: false, engineOnState: false });
  if (ts - lastUpshiftTs < 1500) return LF_GEARS[Math.min(gear - 1, 5)];
  if (atRedline) return flashOn ? LF_ARROW : buildIdleCarFrame(ts, { accelerating: acceleratorHeld, smokeOn: true, engineOnState: true });
  if (currentState === 'steering') {
    if (currentAngleDeg < -8) return LF_STEER_L;
    if (currentAngleDeg >  8) return LF_STEER_R;
    return buildIdleCarFrame(ts, { accelerating: acceleratorHeld, smokeOn: true, engineOnState: true });
  }
  return buildIdleCarFrame(ts, { accelerating: acceleratorHeld, smokeOn: true, engineOnState: true });
}

function renderLedMatrix(frame) {
  frame.forEach((v, i) => {
    ledCells[i].setAttribute('fill', v > 0 ? `rgba(80,160,255,${(v/7).toFixed(2)})` : '#060a0c');
  });

  if (pixelsConnected) {
    return;
  }

  // Additive top-row bar: tint lit segments without erasing base row pixels.
  const lit = Math.max(0, Math.min(REV_SEGMENTS, Math.round(getRevPct() * REV_SEGMENTS)));
  for (let seg = 0; seg < REV_SEGMENTS; seg++) {
    if (seg >= lit) continue;
    const alpha = 0.35 + (0.55 * ((seg + 1) / REV_SEGMENTS));
    const start = Math.floor((seg * 13) / REV_SEGMENTS);
    const endExclusive = Math.floor(((seg + 1) * 13) / REV_SEGMENTS);
    for (let col = start; col < endExclusive; col++) {
      const cell = ledCells[col];
      if (!cell) continue;
      cell.setAttribute('fill', `rgba(240,165,0,${alpha.toFixed(2)})`);
    }
  }
}

function toGraphY(g) {
  const clamped = Math.max(-1, Math.min(1, g));
  return GRAPH_Y0 + GRAPH_HALF_H - clamped * (GRAPH_HALF_H - 1);
}

function buildGraphPoints(axisValues) {
  const step = GRAPH_W / (ACCEL_HISTORY_LEN - 1);
  const pts = [];
  for (let i = 0; i < axisValues.length; i++) {
    const x = GRAPH_X0 + i * step;
    const y = toGraphY(axisValues[i]);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

function pushAccelSample(s) {
  const next = {
    x: Math.max(-1, Math.min(1, s.x || 0)),
    y: Math.max(-1, Math.min(1, s.y || 0)),
    z: Math.max(-1, Math.min(1, s.z || 0)),
  };

  accelHistory.x.push(next.x); accelHistory.x.shift();
  accelHistory.y.push(next.y); accelHistory.y.shift();
  accelHistory.z.push(next.z); accelHistory.z.shift();
}

function updateAccelGraph(s) {
  pushAccelSample(s);

  const lineX = document.getElementById('accel-line-x');
  const lineY = document.getElementById('accel-line-y');
  const lineZ = document.getElementById('accel-line-z');
  if (!lineX || !lineY || !lineZ) return;

  lineX.setAttribute('points', buildGraphPoints(accelHistory.x));
  lineY.setAttribute('points', buildGraphPoints(accelHistory.y));
  lineZ.setAttribute('points', buildGraphPoints(accelHistory.z));
}

function updateGearDisplay() { gearNumEl.textContent = gear; svgGearNum.textContent = gear; }

function doGearUp() {
  if (gear >= MAX_GEAR) return false;
  const prevRpm = rpm;
  gear++;
  if (engineOn) rpmPct = 0.40;
  lastUpshiftTs = performance.now();
  updateGearDisplay();
  if (engineOn) engineAudio.gearBlip(prevRpm);
  return true;
}

function updateEngineIndicator() {
  const badge = document.getElementById('engine-badge');
  badge.textContent = engineOn ? 'ON' : 'OFF';
  badge.className   = engineOn ? 'engine-badge engine-on' : 'engine-badge engine-off';
}

// ── Classification update ─────────────────────────────────────────────────

const STATE_CFG = {
  idle:       { icon: '💤', label: 'IDLE',        cls: 'state-idle'       },
  steering:   { icon: '🏎️', label: 'STEERING',    cls: 'state-steering'   },
  gearchange: { icon: '⚡', label: 'GEAR SHIFT!', cls: 'state-gearchange' },
};

function setValues(data) {
  let topClass = 'idle';
  let topConf  = -1;
  for (const [k, v] of Object.entries(data)) {
    if (v > topConf) { topConf = v; topClass = k; }
  }

  if (topClass !== currentState) {
    currentState = topClass;
    applyState(topClass);
  }

  renderClasses(data);
}

function applyState(state) {
  const cfg = STATE_CFG[state] || { icon: '❓', label: state.toUpperCase(), cls: 'state-idle' };

  stateIcon.textContent = cfg.icon;
  stateName.textContent = cfg.label;
  stateCard.className   = `state-card ${cfg.cls}`;

  // Swap CSS class on SVG for per-state animations
  wheelSvg.className = `steering-wheel ${state}`;

  if (state === 'gearchange') triggerGearAnimation();
}

function triggerGearAnimation() {
  if (!doGearUp()) return;

  // Full-screen red flash
  flashBg.classList.remove('flash');
  void flashBg.offsetWidth;
  flashBg.classList.add('flash');

  // Shift indicator on wheel top crossbar
  svgShiftText.style.transition = '';
  svgShiftText.style.opacity    = '1';
  setTimeout(() => {
    svgShiftText.style.transition = 'opacity 0.5s ease';
    svgShiftText.style.opacity    = '0';
  }, 600);
}

// ── Confidence bars ───────────────────────────────────────────────────────

const ORDER = ['steering', 'gearchange', 'idle'];
const ICONS  = { steering: '🏎️', gearchange: '⚡', idle: '💤' };
const NAMES  = { steering: 'Steering', gearchange: 'Gear Shift', idle: 'Idle' };

function renderClasses(data) {
  let maxKey = null, maxVal = -1;
  for (const [k, v] of Object.entries(data)) {
    if (v > maxVal) { maxVal = v; maxKey = k; }
  }

  classesRoot.innerHTML = '';
  ORDER.forEach(key => {
    const pct     = ((data[key] || 0) * 100).toFixed(1);
    const isMax   = key === maxKey;
    const row     = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="movement-header">
        <div class="label"><span class="emoji">${ICONS[key]}</span> ${NAMES[key]}</div>
        <div class="${isMax ? 'value primary' : 'value secondary'}">${pct}%</div>
      </div>
      <div class="progress-bar">
        <div class="${isMax ? 'progress-fill primary' : 'progress-fill secondary'}" style="width:${pct}%"></div>
      </div>`;
    classesRoot.appendChild(row);
  });
}

// ── Initial state fetch ───────────────────────────────────────────────────

fetch('/config')
  .then(r => r.json())
  .then(cfg => {
    applyRuntimeConfig(cfg);
    applyCalibrationState({ offsetDeg: cfg.angle_offset_deg, invert: cfg.angle_invert }, { persist: true, rerenderWheel: true });
  })
  .catch(() => {});

fetch('/detection')
  .then(r => r.json())
  .then(d => setValues(d))
  .catch(() => {});

// ── Rev RAF loop ──────────────────────────────────────────────────────────

(function startRevLoop() {
  function loop(ts) {
    const dt = Math.min((ts - lastRevTs) / 1000, 0.1);
    lastRevTs = ts;

    if (!engineOn) {
      rpmPct = Math.max(0, rpmPct - (RPM_ENGINE_OFF_DECEL_PCT * dt));
    } else if (acceleratorHeld) {
      rpmPct = Math.min(1, rpmPct + (RPM_ACCEL_PCT_BY_GEAR[gear] * dt));
    } else {
      rpmPct = Math.max(0, rpmPct - (RPM_DECEL_PCT * dt));
      if (rpmPct < 0.15 && gear > 1 && (ts - lastUpshiftTs) > 1500) {
        gear = Math.max(1, gear - 1);
        rpmPct = 0.55;
        updateGearDisplay();
      }
    }

    rpm = engineOn ? (IDLE_RPM + (rpmPct * (REDLINE_RPM - IDLE_RPM))) : 0;

    atRedline = rpmPct >= 0.92;
    if (atRedline && ts - lastFlashTs > 120) { flashOn = !flashOn; lastFlashTs = ts; }
    else if (!atRedline) flashOn = false;

    updateRevLights();
    renderLedMatrix(currentLedFrame(ts));
    pushTelemetrySample();
    drawTelemetryPlot();
    engineAudio.update(rpm, currentState);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}());

// ── Mute button ───────────────────────────────────────────────────────────

initLedMatrix();
updateAccelGraph({ x: 0, y: 0, z: 0 });
drawTelemetryPlot();
initSettingsUi();
initVirtualButtons();

document.getElementById('mute-btn').addEventListener('click', () => {
  engineAudio.start();          // ensure context exists (also handles autoplay policy)
  isMuted = !isMuted;
  engineAudio.setMuted(isMuted);
  document.getElementById('mute-btn').textContent = isMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
});
