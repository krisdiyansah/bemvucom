'use strict';

const CATEGORIES = {
  expense: [
    'Makan & Minum',
    'Transportasi',
    'Tagihan & Utilitas',
    'Bayar Hutang',
    'Belanja Rumah Tangga',
    'Kesehatan',
    'Pendidikan',
    'Hiburan & Nongkrong',
    'Belanja Pribadi',
    'Langganan Digital',
    'Perjalanan & Liburan',
    'Tabungan & Investasi',
    'Lainnya (Keluar)',
  ],
  income: [
    'Gaji & Upah',
    'Bisnis & Freelance',
    'Investasi & Dividen',
    'Bonus & Hadiah',
    'Pinjaman / Hutang',
    'Pelunasan Piutang',
    'Lainnya (Masuk)',
  ],
};

const LANG_KEY = 'bemvu_lang';
const THEME_KEY = 'bemvu_theme';

function getInitialLang() {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'id';
  } catch {
    return 'id';
  }
}

function getInitialTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

const state = {
  user: null,
  lang: getInitialLang(),
  theme: getInitialTheme(),
  usdRate: null,
  langRequestId: 0,
  loginChannel: 'email',
  registrationChannel: 'email',
  passwordResetPending: false,
  passwordResetChannel: 'email',
  passwordResetEmail: '',
  passwordResetPhone: '',
  month: getTodayMonth(),
  view: 'daily',
  txType: 'expense',
  transactions: [],
  recap: null,
  analysis: null,
  logs: [],
  aiReports: [],
  chatHistory: [],
};
let pendingProfilePhoto = '';
let activeSaveOperations = 0;

function t(key, values = {}) {
  const dict = (window.BEMVU_I18N && window.BEMVU_I18N[state.lang]) || (window.BEMVU_I18N && window.BEMVU_I18N.id) || {};
  return String(dict[key] || key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  );
}

function updatePasswordToggleLabel(button) {
  const key = button.getAttribute('aria-pressed') === 'true'
    ? button.dataset.i18nHide
    : button.dataset.i18nShow;
  const label = t(key);
  button.setAttribute('aria-label', label);
  button.title = label;
}

function catLabel(cat) {
  if (state.lang === 'en' && window.BEMVU_CAT_EN) {
    return window.BEMVU_CAT_EN[cat] || cat;
  }
  return cat;
}

function methodLabel(method) {
  if (state.lang === 'en' && window.BEMVU_METHOD_EN) {
    return window.BEMVU_METHOD_EN[method] || method;
  }
  return method;
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch {
    // ignore storage errors
  }
  const isDark = state.theme === 'dark';
  document.querySelectorAll('.js-theme-icon').forEach((el) => {
    el.innerHTML = isDark ? '&#9728;' : '&#9790;';
  });
  document.querySelectorAll('.js-theme-label').forEach((el) => {
    el.textContent = isDark ? t('themeLight') : t('themeDark');
  });
  if (state.view === 'recap' && state.recap) {
    requestAnimationFrame(() => {
      drawMonthlyChart();
      drawDailyChart();
    });
  }
}

function populatePaymentMethods() {
  const sel = document.getElementById('tx-method');
  if (!sel) return;
  const prev = sel.value || 'QRIS';
  const walletMethods = window.BEMVU_FINANCE_MODULES
    ? window.BEMVU_FINANCE_MODULES.walletMethodNames()
    : [];
  const methods = [...new Set([
    'QRIS', 'Tunai', 'Transfer Bank', 'E-Wallet', 'Kartu Debit', 'Auto-Debit', ...walletMethods,
  ])];
  sel.innerHTML = methods
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(methodLabel(m))}</option>`)
    .join('');
  sel.value = methods.includes(prev) ? prev : 'QRIS';
}

async function fetchUsdRate() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/IDR', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(t('exchangeRateError'));
    const data = await response.json();
    const rate = Number(data?.rates?.USD);
    if (data?.result !== 'success' || data?.base_code !== 'IDR' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(t('exchangeRateError'));
    }
    return rate;
  } catch {
    throw new Error(t('exchangeRateError'));
  } finally {
    clearTimeout(timeout);
  }
}

function toIdr(amount, lang = state.lang) {
  const value = Number(amount) || 0;
  return lang === 'en' && state.usdRate ? Math.round(value / state.usdRate) : Math.round(value);
}

function fromIdr(amount, lang = state.lang) {
  const value = Number(amount) || 0;
  return lang === 'en' && state.usdRate ? value * state.usdRate : value;
}

function convertMoneyInputs(fromLang, toLang) {
  [
    'tx-amount', 'reg-budget', 'profile-budget', 'debt-amount',
    'budget-monthly-limit', 'finance-debt-amount', 'finance-debt-installment',
    'wallet-opening-balance', 'wallet-transfer-amount', 'goal-target-amount', 'recurring-amount',
    'investment-entry-amount',
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.value === '') return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const converted = fromIdr(toIdr(value, fromLang), toLang);
    input.value = toLang === 'en' ? converted.toFixed(2) : String(Math.round(converted));
  });
}

function updateCurrencyInputs() {
  const isUsd = state.lang === 'en';
  const positiveIds = [
    'tx-amount', 'reg-budget', 'profile-budget', 'debt-amount',
    'budget-monthly-limit', 'finance-debt-amount', 'finance-debt-installment',
    'wallet-opening-balance', 'wallet-transfer-amount', 'goal-target-amount', 'recurring-amount',
    'investment-entry-amount',
  ];
  const nonNegativeIds = ['finance-debt-installment', 'wallet-opening-balance', 'profile-budget'];
  positiveIds.filter((id) => !nonNegativeIds.includes(id)).forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.step = isUsd ? '0.01' : '1';
    input.min = isUsd ? '0.01' : '1';
  });
  nonNegativeIds.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.step = isUsd ? '0.01' : '1';
    input.min = '0';
  });
  document.querySelectorAll('.quick-amounts [data-add-idr]').forEach((button) => {
    const amount = Number(button.dataset.addIdr);
    button.textContent = `+${formatIDR(amount)}`;
  });
}

async function applyLanguage(lang, refreshData = true) {
  const nextLang = lang === 'en' ? 'en' : 'id';
  const requestId = ++state.langRequestId;
  if (nextLang === 'en' && (state.lang !== 'en' || !state.usdRate)) {
    const rate = await fetchUsdRate();
    if (requestId !== state.langRequestId) return;
    state.usdRate = rate;
  }
  if (requestId !== state.langRequestId) return;
  convertMoneyInputs(state.lang, nextLang);
  state.lang = nextLang;
  document.documentElement.lang = state.lang;
  try {
    localStorage.setItem(LANG_KEY, state.lang);
  } catch {
    // ignore storage errors
  }
  document.querySelectorAll('.js-lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === state.lang);
  });
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.dataset.i18nPh;
    if (key) el.placeholder = t(key);
  });
  document.querySelectorAll('.js-prompt-btn').forEach((btn) => {
    btn.dataset.prompt = t(btn.dataset.promptKey);
  });
  document.querySelectorAll('.js-theme-label').forEach((el) => {
    el.textContent = state.theme === 'dark' ? t('themeLight') : t('themeDark');
  });
  document.querySelectorAll('.js-password-toggle').forEach(updatePasswordToggleLabel);
  updateAuthFlowLabels();
  updateCurrencyInputs();

  // Only update app-specific UI when user is logged in
  if (state.user) {
    setTxType(state.txType);
    populateFilterCategories();
    populatePaymentMethods();

    const editId = document.getElementById('tx-edit-id').value;
    document.getElementById('tx-form-title').textContent = editId ? `${t('txFormTitleEdit')} #${editId}` : t('txFormTitleAdd');
    document.getElementById('tx-submit-btn').textContent = editId ? t('txSubmitEdit') : t('txSubmitAdd');

    renderTransactions();
    renderAiChat();
    if (refreshData) {
      refreshAllData();
    }
  }
}

function getTodayDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function withMinimumDelay(operation, minimumMs) {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    const remainingMs = minimumMs - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
  }
}

function getTodayMonth() {
  return getTodayDate().slice(0, 7);
}

function formatIDR(val) {
  const num = Math.round(Number(val) || 0);
  if (state.lang === 'en' && state.usdRate) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num * state.usdRate);
  }
  const sign = num < 0 ? '-' : '';
  return `${sign}Rp ${Math.abs(num).toLocaleString('id-ID')}`;
}

function formatShortIDR(val) {
  if (state.lang === 'en' && state.usdRate) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(Number(val || 0) * state.usdRate);
  }
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}M`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}jt`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}rb`;
  return `${sign}${abs}`;
}

function formatPercentage(value) {
  const number = Number(value);
  const safeNumber = Number.isFinite(number) ? number : 0;
  const locale = state.lang === 'en' ? 'en-US' : 'id-ID';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(safeNumber)}%`;
}

function formatDateID(dateStr) {
  const dt = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return dateStr;
  return dt.toLocaleDateString(state.lang === 'en' ? 'en-US' : 'id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

async function prepareProfilePhoto(file) {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowedTypes.has(file.type)) throw new Error(t('profilePhotoInvalid'));
  if (file.size > 10 * 1024 * 1024) throw new Error(t('profilePhotoTooLarge'));

  const imageUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(t('profilePhotoInvalid')));
    });
    image.src = imageUrl;
    await loaded;
    if (!image.naturalWidth || !image.naturalHeight) throw new Error(t('profilePhotoInvalid'));

    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t('profilePhotoInvalid'));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.86;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > 800000 && quality > 0.56) {
      quality = Math.max(0.55, quality - 0.1);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > 800000) throw new Error(t('profilePhotoTooLarge'));
    return dataUrl;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3400);
}

function getApiBase() {
  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  if (window.location.port === '3000' || !window.location.port) return '';
  return `${window.location.protocol}//${window.location.hostname || 'localhost'}:3000`;
}

const API_BASE = getApiBase();
const TOKEN_KEY = 'bemvu_auth_token';
const SAVE_DELAY_MS = 3000;

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

async function api(url, options = {}) {
  const token = getStoredToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const opts = {
    credentials: 'include',
    ...options,
    headers,
  };
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
  }
  const method = (opts.method || 'GET').toUpperCase();
  const endpoint = url.split('?')[0];
  const isAuthFlow = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/logout',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/password-reset/resend',
  ].includes(endpoint);
  const isDataWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
    && !isAuthFlow
    && !url.startsWith('/api/ai/');
  if (isDataWrite) {
    activeSaveOperations += 1;
    document.getElementById('save-loading').hidden = false;
  }
  try {
    if (isDataWrite) {
      await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS));
    }

    let resp;
    try {
      resp = await fetch(`${API_BASE}${url}`, opts);
    } catch {
      throw new Error('Server Bemvu (http://localhost:3000) belum menyala. Jalankan start.bat atau "node server.js".');
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.error || `Permintaan gagal (${resp.status})`);
    }
    return data;
  } finally {
    if (isDataWrite) {
      activeSaveOperations = Math.max(0, activeSaveOperations - 1);
      document.getElementById('save-loading').hidden = activeSaveOperations === 0;
    }
  }
}

/* ==================== AUTH ==================== */

function setAuthTab(mode) {
  const isLogin = mode === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('tab-login').setAttribute('aria-selected', String(isLogin));
  document.getElementById('tab-register').setAttribute('aria-selected', String(!isLogin));
  document.getElementById('login-form').hidden = !isLogin;
  document.getElementById('password-reset-form').hidden = true;
  document.getElementById('register-form').hidden = isLogin;
  document.getElementById('login-error').hidden = true;
  document.getElementById('register-error').hidden = true;
}

function setGroupEnabled(id, enabled) {
  document.querySelectorAll(`#${id} input, #${id} select, #${id} textarea`).forEach((input) => {
    input.disabled = !enabled;
  });
}

function setLoginChannel(channel) {
  state.loginChannel = channel === 'whatsapp' ? 'whatsapp' : 'email';
  document.getElementById('login-channel').value = state.loginChannel;
  document.getElementById('login-channel-wrap').dataset.channel = state.loginChannel;
  const isWhatsApp = state.loginChannel === 'whatsapp';
  document.getElementById('login-email-fields').hidden = isWhatsApp;
  document.getElementById('login-whatsapp-fields').hidden = !isWhatsApp;
  setGroupEnabled('login-email-fields', !isWhatsApp);
  setGroupEnabled('login-whatsapp-fields', isWhatsApp);
  document.getElementById('login-email').required = !isWhatsApp;
  document.getElementById('login-password').required = !isWhatsApp;
  document.getElementById('login-phone').required = isWhatsApp;
  document.getElementById('login-phone-password').required = isWhatsApp;
  updateAuthFlowLabels();
}

function setRegistrationChannel(channel) {
  state.registrationChannel = channel === 'whatsapp' ? 'whatsapp' : 'email';
  document.getElementById('register-channel').value = state.registrationChannel;
  document.getElementById('register-channel-wrap').dataset.channel = state.registrationChannel;
  const isWhatsApp = state.registrationChannel === 'whatsapp';
  document.getElementById('register-email-fields').hidden = isWhatsApp;
  document.getElementById('register-whatsapp-fields').hidden = !isWhatsApp;
  setGroupEnabled('register-email-fields', !isWhatsApp);
  setGroupEnabled('register-whatsapp-fields', isWhatsApp);
  document.getElementById('reg-email').required = !isWhatsApp;
  document.getElementById('reg-password').required = !isWhatsApp;
  document.getElementById('reg-phone').required = isWhatsApp;
  document.getElementById('reg-phone-password').required = isWhatsApp;
}

function setPasswordResetChannel(channel) {
  state.passwordResetChannel = channel === 'whatsapp' ? 'whatsapp' : 'email';
  document.getElementById('reset-channel').value = state.passwordResetChannel;
  const isWhatsApp = state.passwordResetChannel === 'whatsapp';
  document.getElementById('reset-email-field').hidden = isWhatsApp;
  document.getElementById('reset-phone-field').hidden = !isWhatsApp;
  setGroupEnabled('reset-email-field', !state.passwordResetPending && !isWhatsApp);
  setGroupEnabled('reset-phone-field', !state.passwordResetPending && isWhatsApp);
  document.getElementById('reset-email').required = !isWhatsApp;
  document.getElementById('reset-phone').required = isWhatsApp;
  document.getElementById('reset-password-field').hidden = false;
  setGroupEnabled('reset-password-field', state.passwordResetPending);
}

function updateAuthFlowLabels() {
  const loginBtn = document.querySelector('#login-form button[type="submit"]');
  if (loginBtn) {
    loginBtn.dataset.i18n = 'loginBtn';
    loginBtn.textContent = t('loginBtn');
  }
  const forgotBtn = document.getElementById('forgot-password-btn');
  if (forgotBtn) {
    forgotBtn.dataset.i18n = 'forgotPasswordBtn';
    forgotBtn.textContent = t('forgotPasswordBtn');
  }
  const registerBtn = document.getElementById('register-submit-btn');
  if (registerBtn) {
    registerBtn.dataset.i18n = 'registerBtn';
    registerBtn.textContent = t('registerBtn');
  }
  const resetBtn = document.getElementById('reset-submit-btn');
  if (resetBtn) {
    const key = state.passwordResetPending ? 'resetPasswordBtn' : 'sendResetCodeBtn';
    resetBtn.dataset.i18n = key;
    resetBtn.textContent = t(key);
  }
  if (state.passwordResetPending) {
    const statusKey = state.passwordResetChannel === 'whatsapp'
      ? 'whatsappRecoverySent'
      : 'resetOtpInstructions';
    document.getElementById('reset-otp-status').textContent = t(statusKey);
  }
}

function setPasswordResetPending(pending, identifier = '') {
  state.passwordResetPending = pending;
  if (identifier) {
    if (state.passwordResetChannel === 'whatsapp') state.passwordResetPhone = identifier;
    else state.passwordResetEmail = identifier;
  }
  document.getElementById('reset-email-fields').hidden = pending;
  document.getElementById('reset-code-fields').hidden = !pending;
  setGroupEnabled('reset-email-fields', !pending);
  setGroupEnabled('reset-code-fields', pending);
  setPasswordResetChannel(state.passwordResetChannel);
  document.getElementById('reset-otp').value = '';
  document.getElementById('reset-new-password').value = '';
  document.getElementById('reset-error').hidden = true;
  updateAuthFlowLabels();
}

function startResendCountdown(button) {
  const previousTimer = Number(button.dataset.timerId);
  if (previousTimer) clearInterval(previousTimer);
  let seconds = 60;
  button.disabled = true;
  button.textContent = t('resendIn', { seconds });
  const timer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      button.disabled = false;
      button.textContent = t('resendCodeBtn');
      delete button.dataset.timerId;
    } else {
      button.textContent = t('resendIn', { seconds });
    }
  }, 1000);
  button.dataset.timerId = String(timer);
}

function showAuthScreen() {
  document.getElementById('session-loading').hidden = true;
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-screen').hidden = true;
}

async function showAppScreen(user) {
  state.user = user;
  document.getElementById('session-loading').hidden = true;
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-screen').hidden = false;
  setTxType(state.txType);
  populateFilterCategories();
  populatePaymentMethods();
  renderUserHeader();
  await refreshAllData();
  const hashView = window.location.hash.replace('#', '');
  if (['daily', 'recap', 'budgets', 'debts', 'wallets', 'investments', 'goals', 'recurring', 'ai', 'logs', 'settings'].includes(hashView) && hashView !== state.view) {
    switchView(hashView);
  }
}

function renderProfilePhotoPreview(profilePhoto) {
  const preview = document.getElementById('profile-photo-preview');
  const initial = state.user ? (state.user.name[0] || 'B').toUpperCase() : 'B';
  preview.innerHTML = profilePhoto
    ? `<img src="${escapeHtml(profilePhoto)}" alt="" />`
    : escapeHtml(initial);
}

function renderUserHeader() {
  if (!state.user) return;
  renderUserWatermark();
  document.getElementById('user-display-name').textContent = state.user.name;
  document.getElementById('user-display-email').textContent =
    state.user.email || state.user.phone || '';
  const initial = (state.user.name[0] || 'B').toUpperCase();
  const profilePhoto = state.user.profile_photo || '';
  const avatar = document.getElementById('user-avatar');
  avatar.innerHTML = profilePhoto
    ? `<img src="${escapeHtml(profilePhoto)}" alt="" />`
    : escapeHtml(initial);
  avatar.classList.toggle('has-photo', Boolean(profilePhoto));
  renderProfilePhotoPreview(pendingProfilePhoto || profilePhoto);
  document.getElementById('profile-photo-remove-btn').hidden = !profilePhoto;
  document.getElementById('profile-name').value = state.user.name;
  document.getElementById('profile-budget').value = fromIdr(state.user.monthly_budget || 0);
}

function renderUserWatermark() {
  const watermark = document.getElementById('user-watermark');
  if (!watermark || !state.user) return;

  const identity = state.user.email || state.user.phone || state.user.name;
  const timestamp = new Intl.DateTimeFormat(state.lang === 'en' ? 'en-US' : 'id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
  const label = `${identity} • ${timestamp} • BEMVU`;
  const tiles = document.createDocumentFragment();
  for (let index = 0; index < 30; index += 1) {
    const tile = document.createElement('span');
    tile.textContent = label;
    tiles.appendChild(tile);
  }
  watermark.replaceChildren(tiles);
}

/* ==================== NAVIGATION & MONTH ==================== */

function switchView(viewName) {
  const views = ['daily', 'recap', 'budgets', 'debts', 'wallets', 'investments', 'goals', 'recurring', 'ai', 'logs', 'settings'];
  const valid = views.includes(viewName) ? viewName : 'daily';
  state.view = valid;
  document.querySelector('.kpi-grid').hidden = valid !== 'daily';
  try {
    if (window.location.hash !== `#${valid}`) {
      history.replaceState(null, '', `#${valid}`);
    }
  } catch {
    // ignore hash errors
  }
  document.querySelectorAll('.nav-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === valid);
  });
  views.forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== valid;
  });

  if (valid === 'recap' && state.recap) {
    requestAnimationFrame(() => {
      drawMonthlyChart();
      drawDailyChart();
    });
  } else if (valid === 'ai') {
    runAiAnalysis(false);
  } else if (valid === 'logs') {
    loadLogs();
  }
}

function shiftMonth(delta) {
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('month-picker').value = state.month;
  refreshAllData();
}

/* ==================== TRANSACTION FORM & LOG ==================== */

function setTxType(type) {
  state.txType = type;
  const expBtn = document.getElementById('type-expense-btn');
  const incBtn = document.getElementById('type-income-btn');
  expBtn.classList.toggle('active-expense', type === 'expense');
  incBtn.classList.toggle('active-income', type === 'income');

  const select = document.getElementById('tx-category');
  const prev = select.value;
  select.innerHTML = CATEGORIES[type]
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(catLabel(c))}</option>`)
    .join('');
  if (CATEGORIES[type].includes(prev)) {
    select.value = prev;
  }
}

function populateFilterCategories() {
  const filterCat = document.getElementById('filter-category');
  const current = filterCat.value;
  const allCats = [...CATEGORIES.income, ...CATEGORIES.expense];
  filterCat.innerHTML =
    `<option value="">${escapeHtml(t('allCats'))}</option>` +
    allCats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(catLabel(c))}</option>`).join('');
  filterCat.value = current;
}

function resetTxForm() {
  document.getElementById('tx-edit-id').value = '';
  document.getElementById('tx-form-title').textContent = t('txFormTitleAdd');
  document.getElementById('tx-submit-btn').textContent = t('txSubmitAdd');
  document.getElementById('tx-cancel-edit-btn').hidden = true;
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-desc').value = '';
  document.getElementById('tx-date').value = getTodayDate();
  setTxType('expense');
}

function startEditTx(tx) {
  document.getElementById('tx-edit-id').value = String(tx.id);
  document.getElementById('tx-form-title').textContent = `${t('txFormTitleEdit')} #${tx.id}`;
  document.getElementById('tx-submit-btn').textContent = t('txSubmitEdit');
  document.getElementById('tx-cancel-edit-btn').hidden = false;
  setTxType(tx.type);
  document.getElementById('tx-amount').value = fromIdr(tx.amount).toFixed(state.lang === 'en' ? 2 : 0);
  document.getElementById('tx-category').value = tx.category;
  document.getElementById('tx-date').value = tx.tx_date;
  document.getElementById('tx-method').value = tx.payment_method || 'QRIS';
  document.getElementById('tx-desc').value = tx.description || '';
  switchView('daily');
  document.getElementById('tx-amount').focus();
}

function renderTransactions() {
  const container = document.getElementById('tx-log-list');
  const items = state.transactions;

  if (!items.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>${escapeHtml(t('emptyTxTitle'))}</strong>
        ${escapeHtml(t('emptyTxDesc'))}
      </div>
    `;
    return;
  }

  // Group by tx_date
  const groups = new Map();
  for (const tx of items) {
    if (!groups.has(tx.tx_date)) groups.set(tx.tx_date, []);
    groups.get(tx.tx_date).push(tx);
  }

  container.innerHTML = Array.from(groups.entries())
    .map(([dateStr, txs]) => {
      const dayNet = txs.reduce(
        (acc, t) => acc + (t.type === 'income' ? t.amount : -t.amount),
        0
      );
      const netCls = dayNet >= 0 ? 'text-emerald' : 'text-rose';
      const netPrefix = dayNet > 0 ? '+' : '';

      const rowsHtml = txs
        .map((tx) => {
          const isIncome = tx.type === 'income';
          const amtClass = isIncome ? 'text-emerald' : 'text-rose';
          const amtPrefix = isIncome ? '+' : '-';
          return `
            <div class="tx-row">
              <div class="tx-main">
                <div class="tx-cat-line">
                  <span class="tx-cat">${escapeHtml(catLabel(tx.category))}</span>
                  <span class="tx-method-pill">${escapeHtml(methodLabel(tx.payment_method || 'Tunai'))}</span>
                </div>
                <div class="tx-desc">${escapeHtml(tx.description || t('noNotes'))}</div>
              </div>
              <div class="tx-amount ${amtClass}">${amtPrefix}${formatIDR(tx.amount)}</div>
              <div class="tx-actions">
                <button class="btn btn-outline btn-xs js-edit-tx" data-id="${tx.id}" type="button">${escapeHtml(t('editBtn'))}</button>
                <button class="btn btn-outline btn-xs js-del-tx" data-id="${tx.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="day-group">
          <div class="day-group-head">
            <span>${escapeHtml(formatDateID(dateStr))}</span>
            <span class="day-group-net ${netCls}">${netPrefix}${formatIDR(dayNet)}</span>
          </div>
          <div>${rowsHtml}</div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.js-edit-tx').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tx = state.transactions.find((t) => t.id === Number(btn.dataset.id));
      if (tx) startEditTx(tx);
    });
  });

  container.querySelectorAll('.js-del-tx').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      try {
        await api(`/api/transactions/${id}`, { method: 'DELETE' });
        showToast('Catatan transaksi dihapus dari log.');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

/* ==================== DATA LOADING & KPI ==================== */

async function loadTransactions() {
  const params = new URLSearchParams({ month: state.month });
  const q = document.getElementById('filter-search').value.trim();
  const type = document.getElementById('filter-type').value;
  const cat = document.getElementById('filter-category').value;
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (cat) params.set('category', cat);

  const data = await api(`/api/transactions?${params.toString()}`);
  state.transactions = data.transactions || [];
  renderTransactions();
}

async function loadRecap() {
  const data = await api(`/api/analytics/recap?month=${encodeURIComponent(state.month)}&lang=${state.lang}`);
  state.recap = data.recap;
  renderKpis();
  renderRecapSection();
}

async function refreshAllData() {
  await Promise.all([
    loadTransactions(),
    loadRecap(),
    window.BEMVU_FINANCE_MODULES.loadAll(),
  ]);
  if (state.view === 'ai') {
    await runAiAnalysis(false);
  } else if (state.view === 'logs') {
    await loadLogs();
  }
}

function renderKpis() {
  const r = state.recap;
  if (!r) return;

  document.querySelectorAll('.js-month-label').forEach((el) => {
    el.textContent = r.monthLabel;
  });

  const s = r.summary;
  document.getElementById('kpi-income').textContent = formatIDR(s.totalIncome);
  document.getElementById('kpi-income-sub').textContent = t('incomeSourcesCount', { count: r.incomeBreakdown.length });

  document.getElementById('kpi-expense').textContent = formatIDR(s.totalExpense);
  document.getElementById('kpi-expense-sub').textContent = `${t('averagePrefix')} ${formatIDR(s.dailyAvgExpense)}${t('dayUnit')}`;

  const netEl = document.getElementById('kpi-net');
  netEl.textContent = formatIDR(s.netBalance);
  netEl.className = `kpi-value ${s.netBalance >= 0 ? 'text-emerald' : 'text-rose'}`;
  document.getElementById('kpi-savings-rate').textContent = t('savingsRateSummary', { rate: s.savingsRate, count: s.txCount });

  const liquidEl = document.getElementById('kpi-liquid');
  liquidEl.textContent = formatIDR(s.remainingLiquidBalance);
  liquidEl.className = `kpi-value ${s.remainingLiquidBalance >= 0 ? 'text-emerald' : 'text-rose'}`;

  document.getElementById('kpi-alltime').textContent = formatIDR(r.allTime.netBalance);
  document.getElementById('kpi-alltime-sub').textContent = t('totalRecords', { count: r.allTime.txCount });

  const debt = r.debt || { totalPrincipal: 0, paidMonth: 0, paidAllTime: 0, remainingDebt: 0, items: [] };
  const debtRemEl = document.getElementById('kpi-debt-remaining');
  debtRemEl.textContent = formatIDR(debt.remainingDebt);
  debtRemEl.classList.toggle('settled', debt.remainingDebt === 0);

  if (debt.totalPrincipal === 0 && debt.paidAllTime > 0) {
    document.getElementById('kpi-debt-sub').textContent = t('debtPaymentSummary', {
      month: formatIDR(debt.paidMonth),
      total: formatIDR(debt.paidAllTime),
    });
  } else {
    document.getElementById('kpi-debt-sub').textContent = t('debtPaymentThisMonth', {
      month: formatIDR(debt.paidMonth),
      total: formatIDR(debt.paidAllTime),
    });
  }

  renderInvestmentPanel();
  renderDebtModal();
}

function renderInvestmentPanel() {
  const recap = state.recap;
  if (!recap) return;

  const summary = recap.summary;
  const income = Number(summary.totalIncome) || 0;
  const investment = Number(summary.savingsAllocated) || 0;
  const target = Number(state.user?.monthly_investment_target ?? 20);
  const targetAmount = Math.round((income * target) / 100);
  const investmentRate = income > 0 ? (investment / income) * 100 : 0;
  const progress = target > 0
    ? Math.min((investmentRate / target) * 100, 100)
    : investment > 0 ? 100 : 0;

  document.getElementById('investment-current').textContent = formatIDR(investment);
  document.getElementById('investment-current-rate').textContent = t('investmentPercentOfIncome', {
    rate: formatPercentage(investmentRate),
  });
  document.getElementById('investment-target-amount').textContent = formatIDR(targetAmount);
  document.getElementById('investment-progress-text').textContent = t('investmentProgressText', {
    actual: formatPercentage(investmentRate),
    target: formatPercentage(target),
  });
  document.getElementById('investment-progress-fill').style.width = `${progress}%`;
  document.getElementById('investment-target-input').value = String(target);

  const setCashflowRow = (key, amount, percent) => {
    document.getElementById(`cashflow-${key}-amount`).textContent = formatIDR(amount);
    document.getElementById(`cashflow-${key}-percent`).textContent = formatPercentage(percent);
    document.getElementById(`cashflow-${key}-meter`).style.width =
      `${Math.min(Math.abs(percent), 100)}%`;
  };
  const percentOfIncome = (amount) => income > 0 ? (amount / income) * 100 : 0;
  const needsExpense = Number(summary.needsExpense) || 0;
  const wantsExpense = Number(summary.wantsExpense) || 0;
  const remainingLiquidBalance = Number(summary.remainingLiquidBalance) || 0;
  const balance = Number(summary.netBalance) || 0;

  setCashflowRow('income', income, income > 0 ? 100 : 0);
  setCashflowRow('needs', needsExpense, percentOfIncome(needsExpense));
  setCashflowRow('wants', wantsExpense, percentOfIncome(wantsExpense));
  setCashflowRow('investment', investment, investmentRate);
  setCashflowRow('liquid', remainingLiquidBalance, percentOfIncome(remainingLiquidBalance));
  setCashflowRow('balance', balance, percentOfIncome(balance));
  document.querySelector('.cashflow-liquid').classList.toggle('is-negative', remainingLiquidBalance < 0);
  document.querySelector('.cashflow-balance').classList.toggle('is-negative', balance < 0);
  document.getElementById('cashflow-no-income').hidden = income > 0;

  const investmentIncome = (recap.incomeBreakdown || [])
    .filter((entry) => entry.category === 'Investasi & Dividen')
    .reduce((total, entry) => total + (Number(entry.amount) || 0), 0);
  document.getElementById('investment-income').textContent = formatIDR(investmentIncome);
}

function renderDebtModal() {
  const debt = state.recap?.debt || { totalPrincipal: 0, paidMonth: 0, paidAllTime: 0, remainingDebt: 0, items: [] };
  document.getElementById('debt-modal-principal').textContent = formatIDR(debt.totalPrincipal);
  document.getElementById('debt-modal-paid').textContent = formatIDR(debt.paidAllTime);
  document.getElementById('debt-modal-remaining').textContent = formatIDR(debt.remainingDebt);

  const listEl = document.getElementById('debt-list');
  if (!debt.items || !debt.items.length) {
    listEl.innerHTML = `<div class="empty-state">${escapeHtml(t('debtEmpty'))}</div>`;
    return;
  }

  listEl.innerHTML = debt.items
    .map(
      (item) => `
      <div class="debt-item">
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <div class="card-sub">${escapeHtml(t('debtPrincipalShort'))}: ${formatIDR(item.principal_amount)}${item.due_date ? ` • ${escapeHtml(t('dueDateShort'))}: ${escapeHtml(item.due_date)}` : ''}${item.notes ? ` • ${escapeHtml(item.notes)}` : ''}</div>
        </div>
        <button class="btn btn-outline btn-xs js-del-debt" data-id="${item.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
      </div>
    `
    )
    .join('');

  listEl.querySelectorAll('.js-del-debt').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/debts/${btn.dataset.id}`, { method: 'DELETE' });
        showToast('Catatan hutang dihapus.');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

/* ==================== RECAP & CANVAS CHARTS ==================== */

function renderRecapSection() {
  const r = state.recap;
  if (!r) return;

  // Category breakdown
  const catList = document.getElementById('category-breakdown-list');
  if (!r.expenseBreakdown.length) {
    catList.innerHTML = `<div class="empty-state"><strong>${escapeHtml(t('emptyExpMonth'))}</strong></div>`;
  } else {
    catList.innerHTML = r.expenseBreakdown
      .map(
        (item, idx) => `
        <div class="breakdown-item">
          <div class="breakdown-top">
            <span>${escapeHtml(catLabel(item.category))}</span>
            <span>${formatIDR(item.amount)} (${item.share}%)</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${Math.min(100, item.share)}%; background:${idx === 0 ? '#0F1E36' : idx === 1 ? '#22D38B' : '#475569'}"></div>
          </div>
        </div>
      `
      )
      .join('');
  }

  // Monthly recap table
  const tbody = document.getElementById('monthly-recap-tbody');
  tbody.innerHTML = r.monthlySeries
    .slice()
    .reverse()
    .map((m) => {
      const netCls = m.net >= 0 ? 'text-emerald' : 'text-rose';
      return `
        <tr>
          <td><strong>${escapeHtml(m.fullLabel)}</strong></td>
          <td>${m.txCount} ${escapeHtml(t('logUnit'))}</td>
          <td class="text-emerald">${formatIDR(m.income)}</td>
          <td class="text-rose">${formatIDR(m.expense)}</td>
          <td class="${netCls}"><strong>${formatIDR(m.net)}</strong></td>
          <td>${m.income > 0 ? `${m.savingsRate}%` : '-'}</td>
        </tr>
      `;
    })
    .join('');

  if (state.view === 'recap') {
    requestAnimationFrame(() => {
      drawMonthlyChart();
      drawDailyChart();
    });
  }
}

function setupCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.parentElement.clientWidth || 640;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawMonthlyChart() {
  const canvas = document.getElementById('monthly-chart');
  const tooltip = document.getElementById('monthly-tooltip');
  const series = state.recap?.monthlySeries || [];
  if (!canvas || !series.length) return;

  const { ctx, width, height } = setupCanvas(canvas, 280);
  const pad = { top: 22, right: 20, bottom: 38, left: 60 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);

  const maxVal = Math.max(
    100000,
    ...series.map((m) => Math.max(m.income, m.expense, Math.abs(m.net)))
  );

  // Grid lines
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px Plus Jakarta Sans, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = pad.top + plotH * (1 - ratio);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatShortIDR(maxVal * ratio), pad.left - 8, y);
  }

  const slotW = plotW / series.length;
  const barW = Math.min(26, Math.max(10, slotW * 0.24));
  const hitRegions = [];
  const linePts = [];

  series.forEach((m, idx) => {
    const cx = pad.left + slotW * idx + slotW / 2;
    const incH = (m.income / maxVal) * plotH;
    const expH = (m.expense / maxVal) * plotH;

    // Income bar
    ctx.fillStyle = '#22D38B';
    roundRect(ctx, cx - barW - 3, pad.top + plotH - incH, barW, incH, 5);
    ctx.fill();

    // Expense bar
    ctx.fillStyle = '#EF4444';
    roundRect(ctx, cx + 3, pad.top + plotH - expH, barW, expH, 5);
    ctx.fill();

    // Net point
    const clampedNet = Math.max(0, m.net);
    const netY = pad.top + plotH - (clampedNet / maxVal) * plotH;
    linePts.push({ x: cx, y: netY, m });

    // X label
    ctx.fillStyle = '#0F1E36';
    ctx.font = '600 11px Plus Jakarta Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(m.label, cx, pad.top + plotH + 12);

    hitRegions.push({
      x1: pad.left + slotW * idx,
      x2: pad.left + slotW * (idx + 1),
      cx,
      m,
    });
  });

  // Surplus trend line
  ctx.strokeStyle = '#0F1E36';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  linePts.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  linePts.forEach((p) => {
    ctx.fillStyle = '#0F1E36';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = hitRegions.find((r) => x >= r.x1 && x <= r.x2);
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    const { m } = hit;
    tooltip.innerHTML = `
      <strong>${escapeHtml(m.fullLabel)}</strong><br/>
      ${escapeHtml(t('chartIncome'))}: ${formatIDR(m.income)}<br/>
      ${escapeHtml(t('chartExpense'))}: ${formatIDR(m.expense)}<br/>
      ${escapeHtml(t('chartNet'))}: ${formatIDR(m.net)}
    `;
    tooltip.style.left = `${Math.min(width - 180, Math.max(8, hit.cx - 75))}px`;
    tooltip.style.top = '10px';
    tooltip.hidden = false;
  };
  canvas.onmouseleave = () => {
    tooltip.hidden = true;
  };
}

function drawDailyChart() {
  const canvas = document.getElementById('daily-chart');
  const tooltip = document.getElementById('daily-tooltip');
  const days = state.recap?.dailySeries || [];
  if (!canvas || !days.length) return;

  const { ctx, width, height } = setupCanvas(canvas, 240);
  const pad = { top: 18, right: 12, bottom: 32, left: 54 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  ctx.clearRect(0, 0, width, height);

  const maxVal = Math.max(50000, ...days.map((d) => Math.max(d.income, d.expense)));

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '10px Plus Jakarta Sans, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 3; i++) {
    const ratio = i / 3;
    const y = pad.top + plotH * (1 - ratio);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatShortIDR(maxVal * ratio), pad.left - 6, y);
  }

  const slotW = plotW / days.length;
  const barW = Math.max(2, slotW * 0.42);
  const hitRegions = [];

  days.forEach((d, idx) => {
    const x0 = pad.left + slotW * idx;
    const incH = (d.income / maxVal) * plotH;
    const expH = (d.expense / maxVal) * plotH;

    if (incH > 0) {
      ctx.fillStyle = '#22D38B';
      ctx.fillRect(x0 + 1, pad.top + plotH - incH, barW, incH);
    }
    if (expH > 0) {
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(x0 + barW + 1, pad.top + plotH - expH, barW, expH);
    }

    if (d.day === 1 || d.day % 5 === 0 || d.day === days.length) {
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(String(d.day), x0 + slotW / 2, pad.top + plotH + 8);
    }

    hitRegions.push({ x1: x0, x2: x0 + slotW, d });
  });

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = hitRegions.find((r) => x >= r.x1 && x <= r.x2);
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    const { d } = hit;
    tooltip.innerHTML = `
      <strong>${escapeHtml(t('chartDay', { day: d.day }))}</strong> (${escapeHtml(t('chartLogCount', { count: d.count }))})<br/>
      ${escapeHtml(t('chartInShort'))}: ${formatIDR(d.income)}<br/>
      ${escapeHtml(t('chartOutShort'))}: ${formatIDR(d.expense)}
    `;
    tooltip.style.left = `${Math.min(width - 160, Math.max(8, x - 60))}px`;
    tooltip.style.top = '8px';
    tooltip.hidden = false;
  };
  canvas.onmouseleave = () => {
    tooltip.hidden = true;
  };
}

function roundRect(ctx, x, y, w, h, r) {
  if (h <= 0) {
    ctx.beginPath();
    return;
  }
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, 0);
  ctx.arcTo(x, y + h, x, y, 0);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/* ==================== AI INSIGHT ==================== */

async function runAiAnalysis(saveSnapshot = true) {
  try {
    const data = saveSnapshot
      ? await api('/api/ai/analyze', {
          method: 'POST',
          body: { month: state.month, lang: state.lang, usdRate: state.usdRate },
        })
      : await api(`/api/ai/insight?month=${encodeURIComponent(state.month)}&lang=${state.lang}&usdRate=${encodeURIComponent(state.usdRate || '')}`);
    state.analysis = data.analysis;
    state.recap = data.recap;
    renderAiView();
    renderAiChat();
    if (saveSnapshot) {
      showToast(t('analysisComplete', { score: data.analysis.healthScore }));
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderAiView() {
  const a = state.analysis;
  if (!a) return;

  const scoreCircle = document.getElementById('ai-score-circle');
  const circumference = 314.16;
  const offset = circumference - (Math.max(0, Math.min(100, a.healthScore)) / 100) * circumference;
  scoreCircle.style.strokeDashoffset = String(offset);
  scoreCircle.style.stroke =
    a.healthScore >= 75 ? '#22D38B' : a.healthScore >= 50 ? '#F59E0B' : '#EF4444';

  document.getElementById('ai-score-num').textContent = String(a.healthScore);
  document.getElementById('ai-grade-badge').textContent = a.grade;
  document.getElementById('ai-headline').textContent = a.headline;
  document.getElementById('ai-chart-analysis').textContent = a.chartAnalysis;

  const gemBox = document.getElementById('ai-gemini-box');
  if (a.geminiSummary) {
    gemBox.textContent = `${t('geminiSummaryPrefix')}: ${a.geminiSummary}`;
    gemBox.hidden = false;
  } else {
    gemBox.hidden = true;
  }

  // 50/30/20 bars
  const alloc = a.allocation;
  const allocEl = document.getElementById('ai-allocation-bars');
  const rows = [
    { label: t('allocNeeds'), val: alloc.needsPct, color: '#0F1E36' },
    { label: t('allocWants'), val: alloc.wantsPct, color: alloc.wantsPct > 30 ? '#EF4444' : '#F59E0B' },
    { label: t('allocSavings'), val: alloc.savingsPct, color: '#22D38B' },
  ];
  allocEl.innerHTML = rows
    .map(
      (r) => `
      <div class="alloc-row">
        <div class="alloc-top">
          <span>${r.label}</span>
          <strong>${r.val}%</strong>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${Math.min(100, r.val)}%; background:${r.color}"></div>
        </div>
      </div>
    `
    )
    .join('');

  // Mini metrics
  const m = a.metrics;
  const deltaText =
    m.expenseDeltaPct === null
      ? t('noCompare')
      : `${m.expenseDeltaPct >= 0 ? '+' : ''}${m.expenseDeltaPct}% ${t('vsPrevMonth')}`;
  document.getElementById('ai-mini-metrics').innerHTML = `
    <div class="mini-stat">
      <span>${escapeHtml(t('metricProj'))}</span>
      <strong>${formatIDR(m.projectedExpense)}</strong>
    </div>
    <div class="mini-stat">
      <span>${escapeHtml(t('metricSafeCap'))}</span>
      <strong>${formatIDR(m.safeDailyCap)} ${escapeHtml(t('dayUnit'))}</strong>
    </div>
    <div class="mini-stat">
      <span>${escapeHtml(t('metricTrend'))}</span>
      <strong>${deltaText}</strong>
    </div>
    <div class="mini-stat">
      <span>${escapeHtml(t('metricPeak'))}</span>
      <strong>${m.peakExpenseDay ? `${escapeHtml(t('dayPrefix'))} ${m.peakExpenseDay.day} (${formatShortIDR(m.peakExpenseDay.expense)})` : '-'}</strong>
    </div>
  `;

  // Insights
  document.getElementById('ai-insights-list').innerHTML = a.insights
    .map(
      (item) => `
      <div class="insight-item ${escapeHtml(item.priority)}">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.message)}</p>
      </div>
    `
    )
    .join('');

  document.getElementById('ai-wise-steps').innerHTML = a.wiseSteps
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('');
}

function renderAiChat() {
  const box = document.getElementById('ai-chat-history');
  if (!state.chatHistory.length) {
    box.innerHTML = `
      <div class="chat-bubble chat-ai">
        ${escapeHtml(t('aiWelcome'))} <strong>${escapeHtml(state.recap?.monthLabel || state.month)}</strong>. ${escapeHtml(t('aiWelcomeEnd'))}
      </div>
    `;
    return;
  }
  box.innerHTML = state.chatHistory
    .map(
      (msg) => `
      <div class="chat-bubble ${msg.role === 'user' ? 'chat-user' : 'chat-ai'}">
        ${escapeHtml(msg.text)}
        ${msg.meta ? `<span class="chat-meta">${escapeHtml(msg.meta)}</span>` : ''}
      </div>
    `
    )
    .join('');
  box.scrollTop = box.scrollHeight;
}

async function askAi(question) {
  const q = question.trim();
  if (!q) return;
  state.chatHistory.push({ role: 'user', text: q });
  renderAiChat();
  try {
    const data = await api('/api/ai/ask', {
      method: 'POST',
      body: { month: state.month, question: q, lang: state.lang, usdRate: state.usdRate },
    });
    state.chatHistory.push({
      role: 'ai',
      text: data.answer,
      meta: data.poweredBy,
    });
    renderAiChat();
  } catch (err) {
    showToast(err.message, true);
  }
}

/* ==================== LOGS & SETTINGS ==================== */

async function loadLogs() {
  try {
    const data = await api('/api/logs');
    state.logs = data.logs || [];
    state.aiReports = data.aiReports || [];
    renderLogsView();
  } catch (err) {
    showToast(err.message, true);
  }
}

function renderLogsView() {
  const logEl = document.getElementById('activity-log-list');
  if (!state.logs.length) {
    logEl.innerHTML = '<div class="empty-state"><strong>Belum ada log aktivitas</strong></div>';
  } else {
    logEl.innerHTML = state.logs
      .map(
        (l) => `
        <div class="log-entry">
          <div class="log-entry-top">
            <span class="log-tag">${escapeHtml(l.action)}</span>
            <span class="log-time">${escapeHtml(l.created_at)}</span>
          </div>
          <div>${escapeHtml(l.detail)}</div>
        </div>
      `
      )
      .join('');
  }

  const aiHistEl = document.getElementById('ai-report-history');
  if (!state.aiReports.length) {
    aiHistEl.innerHTML = '<div class="empty-state">Belum ada riwayat analisis AI tersimpan.</div>';
  } else {
    aiHistEl.innerHTML = state.aiReports
      .map(
        (r) => `
        <div class="log-entry">
          <div class="log-entry-top">
            <strong>${escapeHtml(r.month_key)} — Skor ${r.health_score}/100 (${escapeHtml(r.grade)})</strong>
            <span class="log-time">${escapeHtml(r.created_at)}</span>
          </div>
          <div>${escapeHtml(r.summary)}</div>
        </div>
      `
      )
      .join('');
  }
}

/* ==================== INIT & EVENT LISTENERS ==================== */

function bindEvents() {
  // Auth tabs & forms
  document.getElementById('tab-login').addEventListener('click', () => setAuthTab('login'));
  document.getElementById('tab-register').addEventListener('click', () => setAuthTab('register'));
  const finishLogin = async (data) => {
    if (data.token) setStoredToken(data.token);
    showToast(`Selamat datang kembali, ${data.user.name}!`);
    await showAppScreen(data.user);
  };

  document.getElementById('login-channel').addEventListener('change', (event) => {
    document.getElementById('login-error').hidden = true;
    setLoginChannel(event.target.value);
  });
  document.getElementById('register-channel').addEventListener('change', (event) => {
    setRegistrationChannel(event.target.value);
    document.getElementById('register-error').hidden = true;
  });
  document.getElementById('reset-channel').addEventListener('change', (event) => {
    setPasswordResetChannel(event.target.value);
    updateAuthFlowLabels();
    document.getElementById('reset-error').hidden = true;
  });
  setLoginChannel('email');
  setRegistrationChannel('email');
  setPasswordResetChannel('email');

  document.querySelectorAll('.js-password-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.target);
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(visible));
      button.classList.toggle('is-visible', visible);
      updatePasswordToggleLabel(button);
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    const loginBtn = e.currentTarget.querySelector('button[type="submit"]');
    if (loginBtn.disabled) return;
    errEl.hidden = true;
    loginBtn.disabled = true;
    loginBtn.classList.add('is-loading');
    loginBtn.textContent = t('loginLoading');
    try {
      const body = state.loginChannel === 'whatsapp'
        ? {
          phone: document.getElementById('login-phone').value,
          password: document.getElementById('login-phone-password').value,
        }
        : {
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        };
      const data = await withMinimumDelay(
        () => api('/api/auth/login', {
          method: 'POST',
          body,
        }),
        3000
      );
      await finishLogin(data);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      loginBtn.disabled = false;
      loginBtn.classList.remove('is-loading');
      loginBtn.textContent = t('loginBtn');
    }
  });

  document.getElementById('forgot-password-btn').addEventListener('click', () => {
    const resetForm = document.getElementById('password-reset-form');
    const channel = state.loginChannel === 'whatsapp' ? 'whatsapp' : 'email';
    state.passwordResetPending = false;
    setPasswordResetChannel(channel);
    if (channel === 'whatsapp') {
      document.getElementById('reset-phone').value =
        document.getElementById('login-phone').value.trim();
    } else {
      document.getElementById('reset-email').value =
        document.getElementById('login-email').value.trim();
    }
    resetForm.hidden = false;
    document.getElementById('login-form').hidden = true;
    document.getElementById('reset-error').hidden = true;
    setPasswordResetPending(false);
    updateAuthFlowLabels();
    document.getElementById(channel === 'whatsapp' ? 'reset-phone' : 'reset-email').focus();
  });

  document.getElementById('reset-cancel-btn').addEventListener('click', () => {
    document.getElementById('password-reset-form').hidden = true;
    document.getElementById('login-form').hidden = false;
    document.getElementById('reset-error').hidden = true;
  });

  document.getElementById('password-reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('reset-error');
    errEl.hidden = true;
    try {
      if (!state.passwordResetPending) {
        if (state.passwordResetChannel === 'whatsapp') {
          const phone = document.getElementById('reset-phone').value.trim();
          await api('/api/auth/forgot-password', {
            method: 'POST',
            body: { channel: 'whatsapp', phone },
          });
          setPasswordResetPending(true, phone);
          startResendCountdown(document.getElementById('reset-resend-btn'));
          document.getElementById('reset-otp').focus();
          return;
        }

        const email = document.getElementById('reset-email').value.trim();
        await api('/api/auth/forgot-password', {
          method: 'POST',
          body: { email },
        });
        setPasswordResetPending(true, email);
        document.getElementById('reset-otp-status').textContent = t('resetOtpSent');
        startResendCountdown(document.getElementById('reset-resend-btn'));
        document.getElementById('reset-otp').focus();
        return;
      }

      if (state.passwordResetChannel === 'whatsapp') {
        const phone = state.passwordResetPhone;
        await api('/api/auth/reset-password', {
          method: 'POST',
          body: {
            phone,
            code: document.getElementById('reset-otp').value.trim(),
            password: document.getElementById('reset-new-password').value,
          },
        });
        setPasswordResetPending(false);
        state.passwordResetPhone = '';
        document.getElementById('password-reset-form').hidden = true;
        document.getElementById('login-form').hidden = false;
        setLoginChannel('whatsapp');
        document.getElementById('login-phone').value = phone;
        document.getElementById('login-phone-password').value = '';
        showToast(t('passwordResetSuccess'));
        document.getElementById('login-phone-password').focus();
        return;
      }

      const email = state.passwordResetEmail;
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: {
          email,
          code: document.getElementById('reset-otp').value.trim(),
          password: document.getElementById('reset-new-password').value,
        },
      });
      setPasswordResetPending(false);
      state.passwordResetEmail = '';
      document.getElementById('password-reset-form').hidden = true;
      document.getElementById('login-form').hidden = false;
      document.getElementById('login-email').value = email;
      document.getElementById('login-password').value = '';
      showToast(t('passwordResetSuccess'));
      document.getElementById('login-password').focus();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  document.getElementById('reset-resend-btn').addEventListener('click', async () => {
    const errEl = document.getElementById('reset-error');
    errEl.hidden = true;
    try {
      const body = state.passwordResetChannel === 'whatsapp'
        ? { channel: 'whatsapp', phone: state.passwordResetPhone }
        : { email: state.passwordResetEmail };
      await api('/api/auth/password-reset/resend', { method: 'POST', body });
      document.getElementById('reset-otp-status').textContent = t(
        state.passwordResetChannel === 'whatsapp' ? 'whatsappRecoverySent' : 'resetOtpSent'
      );
      startResendCountdown(document.getElementById('reset-resend-btn'));
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('register-error');
    errEl.hidden = true;
    try {
      const name = document.getElementById('reg-name').value;
      const monthlyBudget = toIdr(document.getElementById('reg-budget').value);
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: state.registrationChannel === 'whatsapp'
          ? {
            channel: 'whatsapp',
            name,
            phone: document.getElementById('reg-phone').value.trim(),
            password: document.getElementById('reg-phone-password').value,
            monthly_budget: monthlyBudget,
          }
          : {
            name,
            email: document.getElementById('reg-email').value.trim(),
            password: document.getElementById('reg-password').value,
            monthly_budget: monthlyBudget,
          },
      });
      if (data.token) setStoredToken(data.token);
      showToast(t('registrationSuccess'));
      await showAppScreen(data.user);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async (event) => {
    const logoutBtn = event.currentTarget;
    if (logoutBtn.disabled) return;
    logoutBtn.disabled = true;
    logoutBtn.classList.add('is-loading');
    logoutBtn.textContent = t('logoutLoading');
    let logoutError;
    try {
      await withMinimumDelay(() => api('/api/auth/logout', { method: 'POST' }), 3000);
    } catch (error) {
      logoutError = error;
    }
    setStoredToken('');
    state.user = null;
    state.chatHistory = [];
    showAuthScreen();
    if (logoutError) {
      showToast(`${t('logoutFailed')} ${logoutError.message}`, true);
    } else {
      showToast(t('logoutSuccess'));
    }
    logoutBtn.disabled = false;
    logoutBtn.classList.remove('is-loading');
    logoutBtn.textContent = t('logoutBtn');
  });

  // Language toggle
  document.querySelectorAll('.js-lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyLanguage(btn.dataset.lang).catch((err) => showToast(err.message, true));
    });
  });

  // Theme toggle
  document.querySelectorAll('.js-theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
  });

  // Mobile sidebar toggle
  const menuBtn = document.getElementById('topbar-menu-btn');
  const sidebar = document.getElementById('app-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  if (menuBtn && sidebar && sidebarBackdrop) {
    const closeSidebar = () => {
      sidebar.classList.remove('sidebar-open');
      sidebarBackdrop.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    };

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sidebar.classList.toggle('sidebar-open');
      sidebarBackdrop.hidden = !isOpen;
      menuBtn.setAttribute('aria-expanded', String(isOpen));
    });
    sidebarBackdrop.addEventListener('click', closeSidebar);
    sidebar.addEventListener('click', (e) => {
      if (e.target.closest('.nav-pill')) closeSidebar();
    });
  }

  // Navigation & Month picker
  document.querySelectorAll('.nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  const monthPicker = document.getElementById('month-picker');
  monthPicker.value = state.month;
  monthPicker.addEventListener('change', () => {
    if (monthPicker.value) {
      state.month = monthPicker.value;
      refreshAllData();
    }
  });
  document.getElementById('prev-month-btn').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('next-month-btn').addEventListener('click', () => shiftMonth(1));

  // Transaction type toggle & quick amounts
  document.getElementById('type-expense-btn').addEventListener('click', () => setTxType('expense'));
  document.getElementById('type-income-btn').addEventListener('click', () => setTxType('income'));
  document.querySelectorAll('.quick-amounts .chip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('tx-amount');
      const cur = Number(input.value || 0);
      const add = fromIdr(Number(btn.dataset.addIdr));
      input.value = (cur + add).toFixed(state.lang === 'en' ? 2 : 0);
    });
  });

  document.getElementById('tx-cancel-edit-btn').addEventListener('click', resetTxForm);

  document.getElementById('tx-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('tx-edit-id').value;
    const payload = {
      type: state.txType,
      amount: toIdr(document.getElementById('tx-amount').value),
      category: document.getElementById('tx-category').value,
      tx_date: document.getElementById('tx-date').value,
      payment_method: document.getElementById('tx-method').value,
      description: document.getElementById('tx-desc').value,
    };

    try {
      if (editId) {
        await api(`/api/transactions/${editId}`, { method: 'PUT', body: payload });
        showToast('Perubahan transaksi disimpan ke database.');
      } else {
        await api('/api/transactions', { method: 'POST', body: payload });
        showToast('Transaksi harian tercatat ke log akun!');
      }
      const savedMonth = payload.tx_date.slice(0, 7);
      if (savedMonth && savedMonth !== state.month) {
        state.month = savedMonth;
        monthPicker.value = savedMonth;
      }
      resetTxForm();
      await refreshAllData();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Filters & Export
  let filterTimer = null;
  const triggerFilter = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => loadTransactions().catch(() => {}), 180);
  };
  document.getElementById('filter-search').addEventListener('input', triggerFilter);
  document.getElementById('filter-type').addEventListener('change', triggerFilter);
  document.getElementById('filter-category').addEventListener('change', triggerFilter);

  document.getElementById('export-csv-btn').addEventListener('click', async () => {
    try {
      const token = getStoredToken();
      const resp = await fetch(`${API_BASE}/api/transactions/export?month=${encodeURIComponent(state.month)}`, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) throw new Error('Gagal mengekspor CSV.');
      const blob = await resp.blob();
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = `bemvu-log-${state.month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(dlUrl);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('seed-demo-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/demo/seed', {
        method: 'POST',
        body: { month: state.month },
      });
      showToast(`${data.count} transaksi contoh 3 bulan berhasil dimuat!`);
      const me = await api('/api/auth/me');
      state.user = me.user;
      renderUserHeader();
      await refreshAllData();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // AI buttons & chat
  document.getElementById('go-ai-from-log-btn').addEventListener('click', () => switchView('ai'));
  document.getElementById('analyze-from-recap-btn').addEventListener('click', () => switchView('ai'));
  document.getElementById('refresh-ai-btn').addEventListener('click', () => runAiAnalysis(true));

  document.querySelectorAll('.js-prompt-btn').forEach((btn) => {
    btn.addEventListener('click', () => askAi(btn.dataset.prompt));
  });

  document.getElementById('ai-chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('ai-chat-input');
    const q = input.value;
    input.value = '';
    await askAi(q);
  });

  // Profile & Logs
  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/auth/profile', {
        method: 'PATCH',
        body: {
          name: document.getElementById('profile-name').value,
          monthly_budget: toIdr(document.getElementById('profile-budget').value),
          lang: state.lang,
        },
      });
      state.user = data.user;
      renderUserHeader();
      showToast(t('profileSaved'));
    } catch (err) {
      showToast(err.message, true);
    }
  });

  const profilePhotoInput = document.getElementById('profile-photo-input');
  const profilePhotoSubmit = document.getElementById('profile-photo-submit');
  profilePhotoInput.addEventListener('change', async () => {
    const file = profilePhotoInput.files && profilePhotoInput.files[0];
    if (!file) {
      pendingProfilePhoto = '';
      profilePhotoSubmit.disabled = true;
      renderUserHeader();
      return;
    }

    profilePhotoInput.disabled = true;
    profilePhotoSubmit.disabled = true;
    try {
      pendingProfilePhoto = await prepareProfilePhoto(file);
      renderProfilePhotoPreview(pendingProfilePhoto);
      profilePhotoSubmit.disabled = false;
    } catch (error) {
      pendingProfilePhoto = '';
      profilePhotoInput.value = '';
      renderProfilePhotoPreview(state.user.profile_photo || '');
      showToast(error.message, true);
    } finally {
      profilePhotoInput.disabled = false;
    }
  });

  document.getElementById('profile-photo-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pendingProfilePhoto) {
      showToast(t('profilePhotoInvalid'), true);
      return;
    }
    profilePhotoSubmit.disabled = true;
    try {
      const data = await api('/api/auth/profile', {
        method: 'PATCH',
        body: { profile_photo: pendingProfilePhoto, lang: state.lang },
      });
      state.user = data.user;
      pendingProfilePhoto = '';
      profilePhotoInput.value = '';
      renderUserHeader();
      showToast(t('profilePhotoSaved'));
    } catch (error) {
      showToast(error.message, true);
    } finally {
      profilePhotoSubmit.disabled = !pendingProfilePhoto;
    }
  });

  document.getElementById('profile-photo-remove-btn').addEventListener('click', async () => {
    if (!window.confirm(t('profilePhotoRemoveConfirm'))) return;
    try {
      const data = await api('/api/auth/profile', {
        method: 'PATCH',
        body: { profile_photo: '', lang: state.lang },
      });
      state.user = data.user;
      pendingProfilePhoto = '';
      profilePhotoInput.value = '';
      renderUserHeader();
      showToast(t('profilePhotoRemoved'));
    } catch (error) {
      showToast(error.message, true);
    }
  });

  document.getElementById('change-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-account-password').value;
    const confirmPassword = document.getElementById('confirm-account-password').value;
    if (newPassword !== confirmPassword) {
      showToast(t('passwordMismatch'), true);
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword, lang: state.lang },
      });
      form.reset();
      showToast(t('passwordChangeSuccess'));
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('investment-target-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = document.getElementById('investment-target-input');
    const button = form.querySelector('button[type="submit"]');
    const target = Number(input.value);
    if (!Number.isInteger(target) || target < 0 || target > 100) {
      showToast(t('investmentTargetInvalid'), true);
      return;
    }

    button.disabled = true;
    button.classList.add('is-loading');
    button.textContent = t('investmentTargetSaving');
    try {
      const data = await api('/api/auth/profile', {
        method: 'PATCH',
        body: { monthly_investment_target: target, lang: state.lang },
      });
      state.user = data.user;
      renderInvestmentPanel();
      showToast(t('investmentTargetSaved'));
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.textContent = t('investmentTargetSave');
    }
  });

  document.getElementById('refresh-logs-btn').addEventListener('click', loadLogs);

  // Debt manager modal
  const debtModal = document.getElementById('debt-modal');
  document.getElementById('open-debt-modal-btn').addEventListener('click', () => {
    renderDebtModal();
    debtModal.showModal();
  });
  document.getElementById('close-debt-modal-btn').addEventListener('click', () => debtModal.close());
  debtModal.addEventListener('click', (e) => {
    if (e.target === debtModal) debtModal.close();
  });

  document.getElementById('debt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/debts', {
        method: 'POST',
        body: {
          title: document.getElementById('debt-title').value,
          principal_amount: toIdr(document.getElementById('debt-amount').value),
          due_date: document.getElementById('debt-due').value,
          notes: document.getElementById('debt-notes').value,
        },
      });
      document.getElementById('debt-form').reset();
      showToast('Catatan hutang berhasil ditambahkan!');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('quick-pay-debt-btn').addEventListener('click', () => {
    debtModal.close();
    switchView('daily');
    setTxType('expense');
    document.getElementById('tx-category').value = 'Bayar Hutang';
    document.getElementById('tx-amount').focus();
  });

  window.addEventListener('resize', () => {
    if (state.view === 'recap' && state.recap) {
      drawMonthlyChart();
      drawDailyChart();
    }
  });
}

async function init() {
  // Apply persisted theme & language immediately (before auth check)
  applyTheme(state.theme);
  try {
    await applyLanguage(state.lang, false);
  } catch (err) {
    await applyLanguage('id', false);
    showToast(err.message, true);
  }

  bindEvents();
  window.BEMVU_FINANCE_MODULES.init();
  populateFilterCategories();
  resetTxForm();
  renderAiChat();

  try {
    const data = await api('/api/auth/me');
    await showAppScreen(data.user);
  } catch {
    showAuthScreen();
  }
}

init();
