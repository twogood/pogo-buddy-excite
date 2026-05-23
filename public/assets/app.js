'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const INTERACTION_TYPES = {
  feed:     { label: 'Feed',               ep: 2, cooldownMin: 30 },
  play:     { label: 'Play',               ep: 2, cooldownMin: 30 },
  snapshot: { label: 'Snapshot',           ep: 2, cooldownMin: 30 },
  battle:   { label: 'Battle',             ep: 2, cooldownMin: 30 },
  walk:     { label: 'Walk heart',         ep: 2, cooldownMin: 30 },
  newplace: { label: 'New place',          ep: 2, cooldownMin: 30 },
  gift:     { label: 'Open gift/souvenir', ep: 2, cooldownMin: 30 },
};

const RULES = {
  excitedThreshold: 32,
  decayEveryMinutes: 30,
  decayAmount: 1,
};

const STORAGE_KEY = 'buddy-excite';

const EP_LEVELS = [
  { min: 32, label: 'Ready for excited confirmation', cls: 'ready'    },
  { min: 24, label: 'Very close',                     cls: 'close'    },
  { min: 16, label: 'Building excitement',            cls: 'building' },
  { min: 8,  label: 'Warming up',                     cls: 'warming'  },
  { min: 0,  label: 'Calm',                           cls: 'calm'     },
];

const MAINTAIN_RISK_MINUTES = 25;

// ── State ──────────────────────────────────────────────────────────────────

let state = defaultState();
let pendingNotifications = [];

function defaultState() {
  return {
    version: 1,
    mode: 'building',
    sessionStartedAt: new Date().toISOString(),
    excitedStartedAt: null,
    interactions: [],
    settings: { notificationsEnabled: false },
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (_) {
    state = defaultState();
  }
  if (!state.sessionStartedAt) state.sessionStartedAt = new Date().toISOString();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Core calculation ───────────────────────────────────────────────────────

function recalculate(now) {
  const sorted = [...state.interactions].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  // Track the last EP-granting time per type to enforce cooldowns
  const lastEPTimeByType = {};
  let totalEP = 0;
  let lastEPAt = null;

  for (const interaction of sorted) {
    const cfg = INTERACTION_TYPES[interaction.type];
    if (!cfg) continue;

    const createdMs = new Date(interaction.createdAt).getTime();
    const prevEPMs = lastEPTimeByType[interaction.type];
    const cooldownMs = cfg.cooldownMin * 60 * 1000;
    const onCooldown = prevEPMs !== undefined && createdMs - prevEPMs < cooldownMs;

    if (onCooldown) {
      interaction.counted = false;
      interaction.pointsAwarded = 0;
    } else {
      interaction.counted = true;
      interaction.pointsAwarded = cfg.ep;
      totalEP += cfg.ep;
      lastEPTimeByType[interaction.type] = createdMs;
      lastEPAt = createdMs;
    }
  }

  // Apply EP decay based on time since last EP-granting interaction
  if (lastEPAt !== null) {
    const minutesSinceLast = (now - lastEPAt) / 60000;
    const decayPeriods = Math.floor(minutesSinceLast / RULES.decayEveryMinutes);
    totalEP = Math.max(0, totalEP - decayPeriods * RULES.decayAmount);
  }

  // Compute current cooldown state for each type
  const cooldowns = {};
  for (const type of Object.keys(INTERACTION_TYPES)) {
    const cfg = INTERACTION_TYPES[type];
    const cooldownMs = cfg.cooldownMin * 60 * 1000;
    // Find the most recent EP-granting interaction of this type
    const lastGranted = lastEPTimeByType[type];
    if (lastGranted !== undefined) {
      const readyAt = lastGranted + cooldownMs;
      cooldowns[type] = { readyAt, msRemaining: Math.max(0, readyAt - now) };
    } else {
      cooldowns[type] = { readyAt: 0, msRemaining: 0 };
    }
  }

  return { ep: totalEP, lastEPAt, cooldowns };
}

// ── Recommendations ────────────────────────────────────────────────────────

function getRecommendation(calc) {
  const now = Date.now();
  const available = [];
  let soonestType = null;
  let soonestMs = Infinity;

  for (const [type, cd] of Object.entries(calc.cooldowns)) {
    if (cd.msRemaining === 0) {
      available.push(INTERACTION_TYPES[type].label);
    } else if (cd.msRemaining < soonestMs) {
      soonestMs = cd.msRemaining;
      soonestType = type;
    }
  }

  if (state.mode === 'maintaining') {
    // In maintaining mode prioritize battle/snapshot/play
    const priority = ['battle', 'snapshot', 'play'];
    const priorityAvailable = priority
      .filter((t) => calc.cooldowns[t].msRemaining === 0)
      .map((t) => INTERACTION_TYPES[t].label);
    if (priorityAvailable.length > 0) {
      return `Do now: <strong>${priorityAvailable.join(', ')}</strong>`;
    }
  }

  if (available.length > 0) {
    return `Do now: <strong>${available.join(', ')}</strong>`;
  }

  if (soonestType !== null) {
    const minRemaining = Math.ceil(soonestMs / 60000);
    return `Next useful interaction in <strong>${minRemaining} min</strong>: ${INTERACTION_TYPES[soonestType].label}`;
  }

  return 'Start your first interaction!';
}

function isRiskOfLosingExcited(calc) {
  if (state.mode !== 'maintaining') return false;
  const now = Date.now();
  // Check time since last any interaction
  if (state.interactions.length === 0) return false;
  const lastInteraction = state.interactions.reduce((latest, i) =>
    new Date(i.createdAt) > new Date(latest.createdAt) ? i : latest
  );
  const minutesSince = (now - new Date(lastInteraction.createdAt).getTime()) / 60000;
  return minutesSince >= MAINTAIN_RISK_MINUTES;
}

// ── Interaction logging ────────────────────────────────────────────────────

function logInteraction(type) {
  const now = Date.now();
  const calc = recalculate(now);
  const cd = calc.cooldowns[type];
  const onCooldown = cd.msRemaining > 0;
  const cfg = INTERACTION_TYPES[type];

  const interaction = {
    id: crypto.randomUUID(),
    type,
    createdAt: new Date(now).toISOString(),
    pointsAwarded: onCooldown ? 0 : cfg.ep,
    counted: !onCooldown,
    note: '',
  };

  state.interactions.push(interaction);
  saveState();
  recalculateAndRender();
  scheduleNotifications();
}

// ── Notifications ──────────────────────────────────────────────────────────

function clearPendingNotifications() {
  for (const id of pendingNotifications) clearTimeout(id);
  pendingNotifications = [];
}

function scheduleNotifications() {
  clearPendingNotifications();
  if (!state.settings.notificationsEnabled) return;
  if (Notification.permission !== 'granted') return;

  const now = Date.now();
  const calc = recalculate(now);

  const readyTypes = Object.entries(calc.cooldowns)
    .filter(([, cd]) => cd.msRemaining > 0)
    .sort(([, a], [, b]) => a.msRemaining - b.msRemaining);

  if (readyTypes.length === 0) return;

  // Schedule one notification at the time when the first interaction becomes ready
  const [, firstCd] = readyTypes[0];
  const delay = firstCd.msRemaining;

  const id = setTimeout(() => {
    const names = Object.entries(recalculate(Date.now()).cooldowns)
      .filter(([, cd]) => cd.msRemaining === 0)
      .map(([type]) => INTERACTION_TYPES[type].label);
    if (names.length === 0) return;
    new Notification('Buddy interaction ready', {
      body: `${names.join(', ')} should now be useful.`,
      icon: '/assets/icons/icon.svg',
    });
    scheduleNotifications();
  }, delay);

  pendingNotifications.push(id);
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    updateNotificationsUI('not-supported');
    return;
  }
  const permission = await Notification.requestPermission();
  state.settings.notificationsEnabled = permission === 'granted';
  saveState();
  scheduleNotifications();
  updateNotificationsUI(permission);
}

// ── Session management ─────────────────────────────────────────────────────

function startNewSession() {
  if (!confirm('Start a new buddy session? All current interactions will be cleared.')) return;
  clearPendingNotifications();
  state.mode = 'building';
  state.sessionStartedAt = new Date().toISOString();
  state.excitedStartedAt = null;
  state.interactions = [];
  saveState();
  recalculateAndRender();
}

function confirmExcited() {
  state.mode = 'maintaining';
  state.excitedStartedAt = new Date().toISOString();
  saveState();
  recalculateAndRender();
}

function endExcited() {
  state.mode = 'building';
  state.excitedStartedAt = null;
  saveState();
  recalculateAndRender();
}

// ── Time formatting ────────────────────────────────────────────────────────

function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMinutes(ms) {
  const min = Math.ceil(ms / 60000);
  return `${min} min`;
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function epLevel(ep) {
  return EP_LEVELS.find((l) => ep >= l.min) || EP_LEVELS[EP_LEVELS.length - 1];
}

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const now = Date.now();
  const calc = recalculate(now);
  const level = epLevel(calc.ep);

  // Status bar
  const badge = el('mode-badge');
  badge.textContent = state.mode === 'maintaining' ? 'Excited mode' : 'Building';
  badge.className = 'mode-badge' + (state.mode === 'maintaining' ? ' maintaining' : '');
  el('session-time').textContent = `Started ${formatTime(state.sessionStartedAt)}`;

  // Progress
  const fraction = el('progress-fraction');
  fraction.textContent = `${calc.ep} / ${RULES.excitedThreshold}`;
  fraction.className = 'progress-fraction ' + level.cls;

  el('progress-label').textContent = level.label;

  const pct = Math.min(100, (calc.ep / RULES.excitedThreshold) * 100);
  const fill = el('progress-bar-fill');
  fill.style.width = pct + '%';
  fill.className = 'progress-bar-fill ' + level.cls;

  // Recommendation
  el('recommendation').innerHTML = getRecommendation(calc);

  // Interaction buttons
  for (const [type, cfg] of Object.entries(INTERACTION_TYPES)) {
    const btn = el('btn-' + type);
    if (!btn) continue;
    const cd = calc.cooldowns[type];
    const ready = cd.msRemaining === 0;
    btn.className = 'interaction-btn' + (ready ? ' ready' : '');
    const cooldownEl = btn.querySelector('.btn-cooldown');
    cooldownEl.textContent = ready ? 'Ready now' : `Ready in ${formatMinutes(cd.msRemaining)}`;
  }

  // Excited controls
  const confirmBtn = el('btn-confirm-excited');
  const endBtn = el('btn-end-excited');
  if (state.mode === 'building') {
    confirmBtn.style.display = '';
    endBtn.style.display = 'none';
  } else {
    confirmBtn.style.display = 'none';
    endBtn.style.display = '';
  }

  // Maintenance status panel
  const maintenancePanel = el('maintenance-status');
  if (state.mode === 'maintaining') {
    maintenancePanel.classList.add('visible');
    el('maintenance-since').textContent = `Excited since ${formatTime(state.excitedStartedAt)}`;
    const riskWarn = el('risk-warning');
    if (isRiskOfLosingExcited(calc)) {
      riskWarn.classList.add('visible');
    } else {
      riskWarn.classList.remove('visible');
    }
  } else {
    maintenancePanel.classList.remove('visible');
  }

  // History
  renderHistory();

  // Notifications UI
  updateNotificationsUI(
    Notification && Notification.permission !== 'default'
      ? Notification.permission
      : state.settings.notificationsEnabled ? 'granted' : 'prompt'
  );
}

function renderHistory() {
  const list = el('history-list');
  const empty = el('history-empty');
  const sorted = [...state.interactions].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  if (sorted.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = sorted.map((i) => {
    const cfg = INTERACTION_TYPES[i.type];
    const label = cfg ? cfg.label : i.type;
    const epText = i.counted
      ? `+${i.pointsAwarded} EP`
      : 'cooldown active';
    const epCls = i.counted ? 'history-ep' : 'history-ep cooldown';
    return `<li class="history-item">
      <span class="history-time">${formatTime(i.createdAt)}</span>
      <span class="history-type">${label}</span>
      <span class="${epCls}">${epText}</span>
    </li>`;
  }).join('');
}

function updateNotificationsUI(permissionOrStatus) {
  const btn = el('btn-notifications');
  const statusEl = el('notifications-status');

  if (!('Notification' in window) || permissionOrStatus === 'not-supported') {
    btn.textContent = 'Reminders unavailable';
    btn.disabled = true;
    statusEl.textContent = 'Your browser does not support notifications.';
    return;
  }

  const granted = Notification.permission === 'granted' && state.settings.notificationsEnabled;
  if (granted) {
    btn.textContent = 'Disable reminders';
    statusEl.textContent = 'Reminders enabled.';
  } else if (Notification.permission === 'denied') {
    btn.textContent = 'Reminders blocked';
    btn.disabled = true;
    statusEl.textContent = 'Notifications are blocked. Enable them in browser settings.';
  } else {
    btn.textContent = 'Enable reminders';
    btn.disabled = false;
    statusEl.textContent = '';
  }
}

function recalculateAndRender() {
  render();
}

// ── Boot ───────────────────────────────────────────────────────────────────

function attachEvents() {
  // Interaction buttons
  for (const type of Object.keys(INTERACTION_TYPES)) {
    const btn = el('btn-' + type);
    if (btn) btn.addEventListener('click', () => logInteraction(type));
  }

  el('btn-confirm-excited').addEventListener('click', confirmExcited);
  el('btn-end-excited').addEventListener('click', endExcited);
  el('btn-new-session').addEventListener('click', startNewSession);
  el('btn-notifications').addEventListener('click', () => {
    if (state.settings.notificationsEnabled) {
      state.settings.notificationsEnabled = false;
      clearPendingNotifications();
      saveState();
      render();
    } else {
      enableNotifications();
    }
  });
}

function init() {
  loadState();
  attachEvents();
  render();
  setInterval(recalculateAndRender, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) recalculateAndRender();
  });
  if (state.settings.notificationsEnabled) scheduleNotifications();
}

init();
