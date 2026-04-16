// =============================================================================
// Section 1: CONFIG
// =============================================================================
const CONFIG = {
  FIXATION_MS:       500,
  RESPONSE_TIMEOUT:  3000,
  FEEDBACK_MS:       800,
  ITI_MIN:           500,
  ITI_MAX:           1000,
  ANTICIPATORY_MS:   150,
  TRIALS_PER_BLOCK:  40,
  PRACTICE_TRIALS:   5,
  MAX_STREAK:        3,
  KEY_FACE:          'f',
  KEY_NOFACE:        'j',
  BLOCK_TYPES: [
    { id: 'SH', instruction: 'speed',    base_rate: 'high', face_ratio: 0.75 },
    { id: 'SL', instruction: 'speed',    base_rate: 'low',  face_ratio: 0.25 },
    { id: 'AH', instruction: 'accuracy', base_rate: 'high', face_ratio: 0.75 },
    { id: 'AL', instruction: 'accuracy', base_rate: 'low',  face_ratio: 0.25 },
  ],
};

// =============================================================================
// Section 2: STATE
// =============================================================================
const STATE = {
  participantId:   null,
  sessionSeed:     null,
  sessionStart:    null,
  bfiResponses:    [],
  bfiScore:        null,
  blockOrder:      [],
  stimuli:         [],       // loaded from manifest
  preloadedImages: {},       // id -> HTMLImageElement
  currentBlock:    0,        // index into blockOrder
  currentTrial:    0,        // index within block
  globalTrialNum:  0,
  trials:          [],       // all recorded trial data
  phase:           'IDLE',   // IDLE | FIXATION | STIMULUS | ITI
  trialStartTime:  null,
  rafHandle:       null,
  currentTrialDef: null,
  isFullscreen:    false,
  fullscreenSupported: true,
  timingFallback:  false,
  isPractice:      false,
  practiceTrials:  [],
  practiceIndex:   0,
  blockSequences:  [],       // pre-built sequences per block
};

// =============================================================================
// Section 3: PRNG  (Mulberry32)
// =============================================================================
function makePRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng; // initialized in INIT section

function seededShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomIntRange(min, max) {
  // inclusive both ends
  return Math.floor(rng() * (max - min + 1)) + min;
}

// =============================================================================
// Section 4: STIMULI
// =============================================================================
async function loadManifest() {
  const res = await fetch('stimuli/manifest.json');
  STATE.stimuli = await res.json();
}

function preloadImages(stimuli) {
  return new Promise((resolve) => {
    let pending = stimuli.length;
    if (pending === 0) { resolve(); return; }
    stimuli.forEach((s) => {
      const img = new Image();
      img.onload  = () => { if (--pending === 0) resolve(); };
      img.onerror = () => { if (--pending === 0) resolve(); };
      img.src = s.src;
      STATE.preloadedImages[s.id] = img;
    });
  });
}

// =============================================================================
// Section 5: SCREEN MANAGER
// =============================================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const target = document.getElementById(id);
  if (target) target.classList.add('active');

  const trialScreens = ['screen-trial'];
  const isTrialCtx   = trialScreens.includes(id);
  document.body.className = isTrialCtx ? 'ctx-trial' : 'ctx-instruction';
}

// =============================================================================
// Section 6: PARTICIPANT ID
// =============================================================================
function generateParticipantId() {
  const ts   = Date.now();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix  = '';
  for (let i = 0; i < 3; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `P_${ts}_${suffix}`;
}

// =============================================================================
// Section 7: BFI
// =============================================================================
const BFI_ITEMS = [
  { text: 'Is outgoing, sociable.',          reversed: false },
  { text: 'Is sometimes shy, introverted.',  reversed: true  },
  { text: 'Is talkative.',                   reversed: false },
  { text: 'Tends to be quiet.',              reversed: true  },
  { text: 'Has an assertive personality.',   reversed: false },
  { text: 'Tends to be reserved.',           reversed: true  },
];

function renderBFIForm() {
  const container = document.getElementById('bfi-items-container');
  container.innerHTML = '';
  BFI_ITEMS.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'bfi-item';
    div.innerHTML = `
      <p class="item-text">${i + 1}. I see myself as someone who... <em>${item.text}</em></p>
      <div class="likert-grid">
        ${[1,2,3,4,5].map((v) => `
          <span>
            <input type="radio" name="bfi_${i}" id="bfi_${i}_${v}" value="${v}" required />
            <label for="bfi_${i}_${v}">${v}</label>
          </span>`).join('')}
      </div>`;
    container.appendChild(div);
  });
}

function scoreBFI(responses) {
  const recoded = responses.map((r, i) =>
    BFI_ITEMS[i].reversed ? (6 - r) : r
  );
  return recoded.reduce((a, b) => a + b, 0) / recoded.length;
}

// =============================================================================
// Section 8: SEQUENCER
// =============================================================================
function buildBlockTrialSequence(blockDef) {
  const total = CONFIG.TRIALS_PER_BLOCK;

  const faceStimuli = seededShuffle(
    STATE.stimuli.filter(s => s.type === 'face')
  );

  const nonfaceStimuli = seededShuffle(
    STATE.stimuli.filter(s => s.type === 'nonface')
  );

  const faceCount = Math.round(total * blockDef.face_ratio);
  const nonfaceCount = total - faceCount;

  const sequence = [
    ...faceStimuli.slice(0, faceCount),
    ...nonfaceStimuli.slice(0, nonfaceCount),
  ];

  return seededShuffle(sequence);
}

function antiStreak(arr, maxStreak) {
  const a = arr.slice();
  for (let i = 0; i < a.length; i++) {
    if (i < maxStreak) continue;
    // check if last maxStreak items are all same type
    let streakType = a[i - 1].type;
    let streak = 1;
    for (let k = i - 2; k >= i - maxStreak; k--) {
      if (a[k].type === streakType) streak++;
      else break;
    }
    if (streak >= maxStreak && a[i].type === streakType) {
      // find nearest j > i with different type
      for (let j = i + 1; j < a.length; j++) {
        if (a[j].type !== streakType) {
          [a[i], a[j]] = [a[j], a[i]];
          break;
        }
      }
    }
  }
  return a;
}

function buildPracticeSequence() {
  // 3 face, 2 nonface (approximately 50/50 with 5 trials)
  const faceStimuli    = STATE.stimuli.filter((s) => s.type === 'face');
  const nonfaceStimuli = STATE.stimuli.filter((s) => s.type === 'nonface');
  const seq = [
    faceStimuli[0], faceStimuli[1], faceStimuli[2],
    nonfaceStimuli[0], nonfaceStimuli[1],
  ];
  return seededShuffle(seq);
}

// =============================================================================
// Section 9: TRIAL ENGINE
// =============================================================================
const trialImg = document.getElementById('stimulus-img');
const fixationEl = document.getElementById('fixation');

function startTrial(stimDef, onComplete) {
  STATE.phase = 'FIXATION';
  STATE.currentTrialDef = stimDef;

  // Pre-load the image object into the <img> element
  const preloaded = STATE.preloadedImages[stimDef.id];
  if (preloaded) {
    trialImg.src = preloaded.src;
  } else {
    trialImg.src = stimDef.src;
  }

  trialImg.style.display = 'none';
  fixationEl.style.display = 'block';

  let phaseStart = nowMs();

  function loop(ts) {
    const elapsed = nowMs() - phaseStart;

    if (STATE.phase === 'FIXATION') {
      if (elapsed >= CONFIG.FIXATION_MS) {
        // Switch to stimulus
        fixationEl.style.display = 'none';
        trialImg.style.display = 'block';
        STATE.phase = 'STIMULUS';
        STATE.trialStartTime = nowMs();
        phaseStart = STATE.trialStartTime;
      }
    } else if (STATE.phase === 'STIMULUS') {
      if (elapsed >= CONFIG.RESPONSE_TIMEOUT) {
        // Timeout
        trialImg.style.display = 'none';
        STATE.phase = 'IDLE';
        cancelAnimationFrame(STATE.rafHandle);
        onComplete(null); // null = timeout
        return;
      }
    } else {
      return;
    }
    STATE.rafHandle = requestAnimationFrame(loop);
  }

  STATE.rafHandle = requestAnimationFrame(loop);
}

function handleTrialKeypress(key, onComplete) {
  if (STATE.phase !== 'STIMULUS') return false;

  const rt_ms = nowMs() - STATE.trialStartTime;
  cancelAnimationFrame(STATE.rafHandle);
  trialImg.style.display = 'none';
  STATE.phase = 'IDLE';

  let response = null;
  if (key === CONFIG.KEY_FACE)   response = 1;
  if (key === CONFIG.KEY_NOFACE) response = 0;
  if (response === null) return false;

  onComplete(response, rt_ms);
  return true;
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  STATE.timingFallback = true;
  return Date.now();
}

// =============================================================================
// Section 10: FEEDBACK
// =============================================================================
const feedbackEl = document.getElementById('feedback-overlay');

const FeedbackController = {
  show(outcome) {
    // outcome: 'correct' | 'incorrect' | 'timeout'
    feedbackEl.className = 'feedback-overlay';
    feedbackEl.style.display = 'flex';
    if (outcome === 'correct')   { feedbackEl.textContent = 'Correct'; feedbackEl.classList.add('feedback-correct'); }
    if (outcome === 'incorrect') { feedbackEl.textContent = 'Incorrect'; feedbackEl.classList.add('feedback-incorrect'); }
    if (outcome === 'timeout')   { feedbackEl.textContent = 'Too slow!'; feedbackEl.classList.add('feedback-timeout'); }

    return new Promise((resolve) => {
      setTimeout(() => {
        feedbackEl.style.display = 'none';
        resolve();
      }, CONFIG.FEEDBACK_MS);
    });
  },
};

// =============================================================================
// Section 11: BLOCK INSTRUCTIONS
// =============================================================================
function showBlockInstructions(blockDef, blockNumber, totalBlocks) {
  return new Promise((resolve) => {
    document.getElementById('block-instr-title').textContent = `Block ${blockNumber} of ${totalBlocks}`;

    const badgeEl = document.getElementById('block-instr-emphasis');
    badgeEl.textContent = blockDef.instruction.toUpperCase();
    badgeEl.className = `block-badge badge-${blockDef.instruction}`;

    const instrText = blockDef.instruction === 'speed'
      ? 'Respond as <strong>quickly</strong> as possible — speed matters more than accuracy in this block.'
      : 'Respond as <strong>accurately</strong> as possible — accuracy matters more than speed in this block.';

    document.getElementById('block-instr-body').innerHTML = `
      <p>${instrText}</p>
      <p>Press <strong>F</strong> for Face &nbsp;|&nbsp; <strong>J</strong> for No Face.</p>
      <p>No feedback will be shown during this block.</p>`;

    document.getElementById('block-instr-counter').textContent =
      `${CONFIG.TRIALS_PER_BLOCK} trials in this block.`;

    showScreen('screen-block-instructions');

    const btn = document.getElementById('btn-block-start');
    const handler = () => {
      btn.removeEventListener('click', handler);
      requestFullscreen();
      resolve();
    };
    btn.addEventListener('click', handler);
  });
}

// =============================================================================
// Section 12: DATA COLLECTOR
// =============================================================================
const DataCollector = {
  buildRecord(stimDef, response, rt_ms, blockDef, trialIndex, globalTrialNum, phase) {
    const is_correct   = response === null ? null : (
      (response === 1 && stimDef.type === 'face') ||
      (response === 0 && stimDef.type === 'nonface')
    );
    const is_anticipatory = rt_ms !== null && rt_ms < CONFIG.ANTICIPATORY_MS;
    const status = response === null ? 'timeout' : 'responded';
    const rt_sec = rt_ms !== null ? parseFloat((rt_ms / 1000).toFixed(4)) : null;

    return {
      subj_idx:        STATE.participantId,
      rt:              rt_sec,
      rt_ms:           rt_ms !== null ? parseFloat(rt_ms.toFixed(2)) : null,
      response:        response,
      is_correct:      is_correct,
      is_anticipatory: is_anticipatory,
      status:          status,
      block_id:        blockDef ? blockDef.id : 'practice',
      block_number:    STATE.currentBlock + 1,
      instruction:     blockDef ? blockDef.instruction : 'practice',
      base_rate:       blockDef ? blockDef.base_rate : 'na',
      face_ratio:      blockDef ? blockDef.face_ratio : null,
      trial_type:      stimDef.type,
      stimulus_id:     stimDef.id,
      facelikeness:    stimDef.facelikeness !== undefined ? stimDef.facelikeness : null,
      trial_index:     trialIndex,
      global_trial_num: globalTrialNum,
      phase:           phase,
    };
  },
};

// =============================================================================
// Section 13: DATA EXPORT
// =============================================================================
function buildExportJSON() {
  return {
    header: {
      participant_id:    STATE.participantId,
      session_seed:      STATE.sessionSeed,
      session_start:     STATE.sessionStart,
      bfi_extraversion:  STATE.bfiScore,
      bfi_responses:     STATE.bfiResponses,
      block_order:       STATE.blockOrder,
      fullscreen_supported: STATE.fullscreenSupported,
      timing_fallback:   STATE.timingFallback,
      hddm_note:         "rt is in seconds. Exclude status='timeout' before HDDM fitting.",
    },
    trials: STATE.trials,
  };
}

const CSV_COLS = [
  'subj_idx','rt','rt_ms','response','is_correct','is_anticipatory','status',
  'block_id','block_number','instruction','base_rate','face_ratio',
  'trial_type','stimulus_id','facelikeness',
  'trial_index','global_trial_num','phase',
];

function trialsToCSV(trials) {
  const header = CSV_COLS.join(',');
  const rows   = trials.map((t) =>
    CSV_COLS.map((col) => {
      const v = t[col];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

async function saveToVercel(exportData) {
  try {
    const res = await fetch('/api/save-data', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(exportData),
    });
    const result = await res.json();
    return result.success ? result.url : null;
  } catch (err) {
    console.warn('Vercel save failed; local download available.', err);
    return null;
  }
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// =============================================================================
// Section 14: EVENT HANDLERS
// =============================================================================
let trialKeyHandler = null;

function setTrialKeyHandler(fn) {
  if (trialKeyHandler) {
    document.removeEventListener('keydown', trialKeyHandler);
  }
  trialKeyHandler = fn ? (e) => {
    if (e.repeat) return;
    fn(e);
  } : null;
  if (trialKeyHandler) {
    document.addEventListener('keydown', trialKeyHandler);
  }
}

function removeTrialKeyHandler() {
  setTrialKeyHandler(null);
}

// Fullscreen change handler
document.addEventListener('fullscreenchange',     handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('mozfullscreenchange',  handleFullscreenChange);

function handleFullscreenChange() {
  const inFs = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement
  );
  STATE.isFullscreen = inFs;

  if (!inFs && STATE.phase === 'STIMULUS') {
    // Pause trial
    cancelAnimationFrame(STATE.rafHandle);
    STATE.phase = 'IDLE';
    trialImg.style.display = 'none';
    fixationEl.style.display = 'none';
    document.getElementById('fullscreen-overlay').style.display = 'flex';
  }
}

document.getElementById('btn-reenter-fs').addEventListener('click', () => {
  requestFullscreen();
  document.getElementById('fullscreen-overlay').style.display = 'none';
  // Re-start current trial from scratch (trial marked interrupted — handled by abort)
  FlowController.resumeAfterFullscreenExit();
});

function requestFullscreen() {
  try {
    const el = document.documentElement;
    if      (el.requestFullscreen)       el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.mozRequestFullScreen)    el.mozRequestFullScreen();
    else STATE.fullscreenSupported = false;
  } catch (e) {
    STATE.fullscreenSupported = false;
  }
}

// =============================================================================
// Section 15: INIT  &  FlowController
// =============================================================================
const FlowController = {
  _fullscreenResolve: null,

  resumeAfterFullscreenExit() {
    // Replay the current trial
    if (this._currentBlockResolve) {
      this._replayTrial();
    }
  },
  _currentBlockResolve: null,
  _replayTrial: null,

  async run() {
    // --- Consent ---
    await this.waitForConsent();

    // --- Eligibility ---
    const eligible = await this.runEligibility();
    if (!eligible) { showScreen('screen-terminated'); return; }

    // --- Touch check ---
    if (navigator.maxTouchPoints > 0) {
      document.getElementById('touch-warning').style.display = 'block';
    }

    // --- Participant ID ---
    STATE.participantId = generateParticipantId();
    STATE.sessionSeed   = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    STATE.sessionStart  = new Date().toISOString();
    rng = makePRNG(STATE.sessionSeed);

    document.getElementById('pid-display').textContent = STATE.participantId;
    showScreen('screen-participant-id');
    await this.waitForBtn('btn-pid-continue');

    // --- BFI ---
    renderBFIForm();
    showScreen('screen-bfi');
    const bfiData = await this.runBFI();
    STATE.bfiResponses = bfiData;
    STATE.bfiScore     = scoreBFI(bfiData);

    // --- Task instructions ---
    showScreen('screen-task-instructions');
    await this.waitForBtn('btn-task-instr-continue');

    // --- Load stimuli ---
    await loadManifest();
    await preloadImages(STATE.stimuli);

    // --- Block order (randomized) ---
    STATE.blockOrder = seededShuffle(CONFIG.BLOCK_TYPES.map((b) => b.id));

    // --- Pre-build trial sequences ---
    STATE.blockSequences = STATE.blockOrder.map((bid) => {
      const bDef = CONFIG.BLOCK_TYPES.find((b) => b.id === bid);
      return buildBlockTrialSequence(bDef);
    });

    // --- Practice ---
    showScreen('screen-practice-instructions');
    await this.waitForBtn('btn-practice-start');
    requestFullscreen();
    await this.runPractice();

    // --- Main blocks ---
    for (let b = 0; b < STATE.blockOrder.length; b++) {
      STATE.currentBlock = b;
      const blockId  = STATE.blockOrder[b];
      const blockDef = CONFIG.BLOCK_TYPES.find((bd) => bd.id === blockId);
      const sequence = STATE.blockSequences[b];

      showScreen('screen-block-instructions');
      await showBlockInstructions(blockDef, b + 1, STATE.blockOrder.length);
      showScreen('screen-trial');

      await this.runBlock(blockDef, sequence);
    }

    // --- End screen ---
    await this.runEnd();
  },

  waitForBtn(id) {
    return new Promise((resolve) => {
      const btn = document.getElementById(id);
      const handler = () => { btn.removeEventListener('click', handler); resolve(); };
      btn.addEventListener('click', handler);
    });
  },

  waitForConsent() {
    return new Promise((resolve) => {
      document.getElementById('btn-consent-agree').addEventListener('click', () => {
        showScreen('screen-eligibility');
        resolve();
      });
      document.getElementById('btn-consent-decline').addEventListener('click', () => {
        showScreen('screen-terminated');
      });
    });
  },

  runEligibility() {
    return new Promise((resolve) => {
      document.getElementById('form-eligibility').addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        const allYes = ['e1','e2','e3','e4'].every((k) => data.get(k) === 'yes');
        resolve(allYes);
      });
    });
  },

  runBFI() {
    return new Promise((resolve) => {
      document.getElementById('form-bfi').addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new FormData(e.target);
        const responses = BFI_ITEMS.map((_, i) => parseInt(data.get(`bfi_${i}`), 10));
        resolve(responses);
      });
    });
  },

  async runPractice() {
    STATE.isPractice = true;
    const practiceSeq = buildPracticeSequence();
    showScreen('screen-trial');
    document.getElementById('trial-progress').textContent = '';

    for (let i = 0; i < practiceSeq.length; i++) {
      const stim = practiceSeq[i];
      document.getElementById('trial-progress').textContent =
        `Practice ${i + 1} / ${practiceSeq.length}`;

      const result = await this.runSingleTrial(stim);
      const { response, rt_ms } = result;

      // Feedback
      let outcome;
      if (response === null) {
        outcome = 'timeout';
      } else {
        const correct =
          (response === 1 && stim.type === 'face') ||
          (response === 0 && stim.type === 'nonface');
        outcome = correct ? 'correct' : 'incorrect';
      }
      await FeedbackController.show(outcome);
      await this.iti();
    }
    STATE.isPractice = false;
  },

  async runBlock(blockDef, sequence) {
    STATE.globalTrialNum = STATE.globalTrialNum; // continued from previous
    for (let i = 0; i < sequence.length; i++) {
      STATE.currentTrial = i;
      const stim = sequence[i];

      document.getElementById('trial-progress').textContent =
        `Block ${STATE.currentBlock + 1} / ${STATE.blockOrder.length}  —  Trial ${i + 1} / ${sequence.length}`;

      const result = await this.runSingleTrial(stim);
      STATE.globalTrialNum++;

      const record = DataCollector.buildRecord(
        stim,
        result.response,
        result.rt_ms,
        blockDef,
        i,
        STATE.globalTrialNum,
        'main'
      );
      STATE.trials.push(record);
      await this.iti();
    }
  },

  runSingleTrial(stim) {
    return new Promise((resolve) => {
      this._replayTrial = () => resolve(this.runSingleTrial(stim));
      this._currentBlockResolve = resolve;

      startTrial(stim, (responseOrNull) => {
        // Called on timeout
        removeTrialKeyHandler();
        this._currentBlockResolve = null;
        resolve({ response: null, rt_ms: null });
      });

      setTrialKeyHandler((e) => {
        const key = e.key.toLowerCase();
        if (key !== CONFIG.KEY_FACE && key !== CONFIG.KEY_NOFACE) return;
        const accepted = handleTrialKeypress(key, (response, rt_ms) => {
          removeTrialKeyHandler();
          this._currentBlockResolve = null;
          resolve({ response, rt_ms });
        });
      });
    });
  },

  iti() {
    const ms = randomIntRange(CONFIG.ITI_MIN, CONFIG.ITI_MAX);
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  async runEnd() {
    showScreen('screen-end');
    document.getElementById('end-pid').textContent = STATE.participantId;

    const exportData = buildExportJSON();

    // Show pending status
    const saveStatus = document.getElementById('save-status');
    saveStatus.className = 'save-status save-pending';
    saveStatus.textContent = 'Saving data to server…';

    const url = await saveToVercel(exportData);
    if (url) {
      saveStatus.className = 'save-status save-ok';
      saveStatus.innerHTML = `Data saved to server. <a href="${url}" target="_blank">View</a>`;
    } else {
      saveStatus.className = 'save-status save-err';
      saveStatus.textContent = 'Server save failed. Please use the download buttons below.';
    }

    // Download buttons
    document.getElementById('btn-download-json').addEventListener('click', () => {
      downloadFile(
        `${STATE.participantId}_data.json`,
        JSON.stringify(exportData, null, 2),
        'application/json'
      );
    });
    document.getElementById('btn-download-csv').addEventListener('click', () => {
      downloadFile(
        `${STATE.participantId}_trials.csv`,
        trialsToCSV(STATE.trials),
        'text/csv'
      );
    });
  },
};

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  showScreen('screen-consent');
  FlowController.run().catch((err) => {
    console.error('Experiment flow error:', err);
  });
});
