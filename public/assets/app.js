'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const INTERACTION_TYPES = {
  feed:          { label: 'Feed',                              ep: 1, cooldownMin: 30 },
  play:          { label: 'Play',                              ep: 1, cooldownMin: 30 },
  battle:        { label: 'Battle',                           ep: 1, cooldownMin: 30 },
  walk:          { label: 'Walk 2 km',                        ep: 3, cooldownMin: 0  },
  snapshot:      { label: 'Take a snapshot',                  ep: 3, cooldownMin: 30 },
  gift:          { label: 'Open a souvenir/present',          ep: 3, cooldownMin: 30 },
  newplace:      { label: 'Visit a new location',             ep: 1, cooldownMin: 30 },
  buddylocation: { label: 'Visit a location found by buddy',  ep: 1, cooldownMin: 30 },
  route:         { label: 'Follow a route',                   ep: 4, cooldownMin: 0  },
};

const RULES = {
  excitedThreshold: 32,
  decayEveryMinutes: 30,
  decayAmount: 1,
};

const STORAGE_KEY = 'buddy-excite';
const EXCITED_CONFIRMATION_TYPE = 'excited-confirmation';
const ZERO_COOLDOWN_LOCKOUT_MS = 5000;

// sprite index 0–4 = left-to-right in buddy-moods.webp; null = no sprite
const EP_LEVELS = [
  { min: 32, label: 'Excited', cls: 'mood-excited', sprite: 4 },
  { min: 16, label: 'Fun',     cls: 'mood-fun',     sprite: 3 },
  { min: 8,  label: 'Smile',   cls: 'mood-smile',   sprite: 2 },
  { min: 4,  label: 'Happy',   cls: 'mood-happy',   sprite: 1 },
  { min: 2,  label: 'Normal',  cls: 'mood-normal',  sprite: 0 },
  { min: 1,  label: 'Dull',    cls: 'mood-dull',    sprite: null },
  { min: 0,  label: 'Tired',   cls: 'mood-tired',   sprite: null },
];

const MAINTAIN_RISK_MINUTES = 25;

// ── State ──────────────────────────────────────────────────────────────────

let state = defaultState();
let pendingNotifications = [];
let recentPresses = {};

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
  let lastActivityAt = null; // any interaction resets decay, even cooldown-blocked ones

  for (const interaction of sorted) {
    if (interaction.type === EXCITED_CONFIRMATION_TYPE) {
      const createdMs = new Date(interaction.createdAt).getTime();
      const bonus = Number(interaction.pointsAwarded) || 0;
      interaction.counted = bonus > 0;
      interaction.pointsAwarded = bonus;
      totalEP += bonus;
      lastActivityAt = createdMs;
      lastEPAt = createdMs;
      continue;
    }

    const cfg = INTERACTION_TYPES[interaction.type];
    if (!cfg) continue;

    const createdMs = new Date(interaction.createdAt).getTime();
    const prevEPMs = lastEPTimeByType[interaction.type];
    const cooldownMs = cfg.cooldownMin * 60 * 1000;
    const onCooldown = prevEPMs !== undefined && createdMs - prevEPMs < cooldownMs;

    lastActivityAt = createdMs;

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

  // Decay resets on any activity, not just EP-granting ones
  if (lastActivityAt !== null) {
    const minutesSinceLast = (now - lastActivityAt) / 60000;
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

  if (cfg.cooldownMin === 0) {
    recentPresses[type] = now;
    // Add a small buffer to ensure the lockout has fully elapsed before re-rendering
    setTimeout(recalculateAndRender, ZERO_COOLDOWN_LOCKOUT_MS + 50);
  }

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
  const now = Date.now();
  const calc = recalculate(now);
  if (calc.ep < RULES.excitedThreshold) {
    state.interactions.push({
      id: crypto.randomUUID(),
      type: EXCITED_CONFIRMATION_TYPE,
      createdAt: new Date(now).toISOString(),
      pointsAwarded: RULES.excitedThreshold - calc.ep,
      counted: true,
      note: '',
    });
  }
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

  // Mood sprite
  const sprite = el('mood-sprite');
  if (level.sprite !== null && level.sprite !== undefined) {
    sprite.className = `mood-sprite sprite-${level.sprite}`;
  } else {
    sprite.className = 'mood-sprite hidden';
  }

  // Recommendation
  el('recommendation').innerHTML = getRecommendation(calc);

  // Interaction buttons
  for (const [type, cfg] of Object.entries(INTERACTION_TYPES)) {
    const btn = el('btn-' + type);
    if (!btn) continue;
    const cd = calc.cooldowns[type];
    const lastPress = recentPresses[type];
    const lockedOut = cfg.cooldownMin === 0 && lastPress !== undefined && (now - lastPress) < ZERO_COOLDOWN_LOCKOUT_MS;
    const ready = cd.msRemaining === 0 && !lockedOut;
    btn.disabled = lockedOut;
    btn.className = 'interaction-btn' + (ready ? ' ready' : '');
    const cooldownEl = btn.querySelector('.btn-cooldown');
    cooldownEl.textContent = lockedOut ? 'Please wait…' : (ready ? 'Ready now' : `Ready in ${formatMinutes(cd.msRemaining)}`);
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

  if (state.interactions.length === 0) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Sort oldest-first to compute gaps, then reverse for display
  const sorted = [...state.interactions].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  const now = Date.now();
  const displayItems = [];

  for (let idx = 0; idx < sorted.length; idx++) {
    displayItems.push({ kind: 'interaction', i: sorted[idx] });

    const currentMs = new Date(sorted[idx].createdAt).getTime();
    const nextMs = idx + 1 < sorted.length
      ? new Date(sorted[idx + 1].createdAt).getTime()
      : now;

    const gapMin = Math.floor((nextMs - currentMs) / 60000);
    const decayAmount = Math.floor(gapMin / RULES.decayEveryMinutes) * RULES.decayAmount;
    if (decayAmount > 0) {
      displayItems.push({ kind: 'decay', amount: decayAmount, gapMin });
    }
  }

  displayItems.reverse();

  list.innerHTML = displayItems.map((item) => {
    if (item.kind === 'decay') {
      return `<li class="history-item history-decay">
        <span class="history-time"></span>
        <span class="history-type">Decay (${item.gapMin} min inactive)</span>
        <span class="history-ep negative">−${item.amount} EP</span>
      </li>`;
    }
    const { i } = item;
    const cfg = INTERACTION_TYPES[i.type];
    const label = i.type === EXCITED_CONFIRMATION_TYPE
      ? 'Buddy confirmed excited'
      : (cfg ? cfg.label : i.type);
    const epText = i.counted ? `+${i.pointsAwarded} EP` : 'cooldown active';
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
