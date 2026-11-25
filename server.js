'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { createDatabase, hashPassword, verifyPassword, logActivity } = require('./src/db');
const { buildRecap, formatMonthLabel, getPreviousMonths, getValidMonthKey } = require('./src/analytics');
const { generateAiAnalysis, answerFinancialQuestion, formatIDR, formatCurrency } = require('./src/ai');
const { EmailConfigurationError, createOtpEmailSender } = require('./src/email');
const {
  WhatsAppConfigurationError,
  WhatsAppDeliveryError,
  createOtpWhatsAppSender,
} = require('./src/whatsapp');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const OTP_LIFETIME_MS = 10 * 60 * 1000;
const OTP_RESEND_DELAY_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const DEFAULT_PAYMENT_METHODS = [
  { name: 'QRIS', type: 'ewallet' },
  { name: 'Tunai', type: 'cash' },
  { name: 'Transfer Bank', type: 'bank' },
  { name: 'E-Wallet', type: 'ewallet' },
  { name: 'Kartu Debit', type: 'bank' },
  { name: 'Auto-Debit', type: 'bank' },
];
const INVESTMENT_TYPES = new Set([
  'crypto',
  'jamsostek',
  'stocks',
  'mutual_fund',
  'savings',
  'emergency_fund',
  'deposit',
  'gold',
  'bonds',
  'other',
]);
const INVESTMENT_RETURN_CATEGORY = 'Investasi & Dividen';
const INVESTMENT_CONTRIBUTION_CATEGORY = 'Tabungan & Investasi';
const MAX_PROFILE_PHOTO_LENGTH = 850000;

function isValidInvestmentType(type, category, investmentType) {
  if (!investmentType) return true;
  const isContribution = type === 'expense' && category === INVESTMENT_CONTRIBUTION_CATEGORY;
  const isReturn = type === 'income' && category === INVESTMENT_RETURN_CATEGORY;
  return (isContribution || isReturn) && INVESTMENT_TYPES.has(investmentType);
}

function normalizeInvestmentType(type, category, investmentType) {
  return isValidInvestmentType(type, category, investmentType) ? investmentType : '';
}

function validateProfilePhoto(value) {
  const dataUrl = String(value || '');
  if (!dataUrl) return '';
  if (dataUrl.length > MAX_PROFILE_PHOTO_LENGTH) return null;

  const match = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const image = Buffer.from(match[1], 'base64');
  if (
    image.length < 4 ||
    image.length > 600 * 1024 ||
    image.toString('base64') !== match[1] ||
    image[0] !== 0xff ||
    image[1] !== 0xd8 ||
    image[2] !== 0xff ||
    image[image.length - 2] !== 0xff ||
    image[image.length - 1] !== 0xd9
  ) {
    return null;
  }
  return dataUrl;
}
function addRecurringInterval(dateString, frequency) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (frequency === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7);
  } else if (frequency === 'monthly') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + 1);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return date.toISOString().slice(0, 10);
}

async function getWalletBalances(db, userId) {
  const wallets = await db.prepare(`
    SELECT w.id, w.name, w.wallet_type, w.opening_balance,
      COALESCE((
        SELECT SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END)
        FROM transactions t
        WHERE t.user_id = w.user_id AND t.payment_method = w.name
      ), 0) AS transaction_balance,
      COALESCE((
        SELECT SUM(wt.amount) FROM wallet_transfers wt
        WHERE wt.user_id = w.user_id AND wt.to_wallet_id = w.id
      ), 0) AS transfer_in,
      COALESCE((
        SELECT SUM(wt.amount) FROM wallet_transfers wt
        WHERE wt.user_id = w.user_id AND wt.from_wallet_id = w.id
      ), 0) AS transfer_out
    FROM wallets w
    WHERE w.user_id = ?
    ORDER BY LOWER(w.name)
  `).all(userId);
  return wallets.map((wallet) => ({
    ...wallet,
    opening_balance: Number(wallet.opening_balance) || 0,
    balance:
      (Number(wallet.opening_balance) || 0) +
      (Number(wallet.transaction_balance) || 0) +
      (Number(wallet.transfer_in) || 0) -
      (Number(wallet.transfer_out) || 0),
  }));
}

const RECURRING_FREQUENCIES = new Set(['weekly', 'monthly', 'yearly']);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(value) {
  let phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) {
    phone = phone.slice(2);
  } else if (phone.startsWith('+')) {
    phone = phone.slice(1);
  } else if (phone.startsWith('0')) {
    phone = `62${phone.slice(1)}`;
  } else if (phone.startsWith('8')) {
    phone = `62${phone}`;
  }
  return /^[1-9]\d{7,14}$/.test(phone) ? phone : '';
}

function hashOtp(code, salt) {
  return crypto.scryptSync(code, salt, 64).toString('hex');
}

function matchesOtp(code, row) {
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashOtp(code, row.code_salt), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function getCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

function sendJson(res, status, data, extraHeaders = {}, req = null) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(req ? getCorsHeaders(req) : {}),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBytes = 1024 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(req.body ? JSON.parse(req.body) : {});
      } catch {
        return Promise.reject(new Error('Format JSON tidak valid'));
      }
    }
    if (Buffer.isBuffer(req.body)) {
      try {
        return Promise.resolve(req.body.length ? JSON.parse(req.body.toString('utf8')) : {});
      } catch {
        return Promise.reject(new Error('Format JSON tidak valid'));
      }
    }
    if (req.body && typeof req.body === 'object') {
      return Promise.resolve(req.body);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Format JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addRecurringInterval(date, frequency) {
  const [year, month, day] = date.split('-').map(Number);
  if (frequency === 'weekly') {
    const next = new Date(Date.UTC(year, month - 1, day + 7));
    return next.toISOString().slice(0, 10);
  }

  const nextYear = year + (frequency === 'yearly' ? 1 : 0);
  const nextMonth = month - 1 + (frequency === 'monthly' ? 1 : 0);
  const nextMonthYear = nextYear + Math.floor(nextMonth / 12);
  const monthIndex = nextMonth % 12;
  const lastDay = new Date(Date.UTC(nextMonthYear, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(nextMonthYear, monthIndex, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

function getUsdRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function enhanceWithGeminiIfAvailable(recap, analysis, question, lang = 'id', usdRate = 0) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const isEn = lang === 'en';
    const formatMoney = (amount) => formatCurrency(amount, lang, usdRate);
    const prompt = question
      ? isEn
        ? `You are Bemvu personal finance advisor (English, concise, wise, data-grounded). Month ${recap.monthLabel}: Income ${formatMoney(recap.summary.totalIncome)}, Expenses ${formatMoney(recap.summary.totalExpense)}, Surplus ${formatMoney(recap.summary.netBalance)}, Health Score ${analysis.healthScore}/100. Top category: ${recap.expenseBreakdown[0]?.category || '-'} (${formatMoney(recap.expenseBreakdown[0]?.amount || 0)}). User question: "${question}". Reply in max 4 practical sentences.`
        : `Anda adalah penasihat keuangan pribadi Bemvu (bahasa Indonesia, ringkas, bijak, berbasis data nyata). Data bulan ${recap.monthLabel}: Pemasukan ${formatMoney(recap.summary.totalIncome)}, Pengeluaran ${formatMoney(recap.summary.totalExpense)}, Surplus ${formatMoney(recap.summary.netBalance)}, Skor Kesehatan ${analysis.healthScore}/100. Kategori terbesar: ${recap.expenseBreakdown[0]?.category || '-'} (${formatMoney(recap.expenseBreakdown[0]?.amount || 0)}). Pertanyaan user: "${question}". Jawab singkat (maks 4 kalimat) dan praktis.`
      : isEn
        ? `You are Bemvu financial advisor. Provide a concise 2-3 sentence wise executive summary in English from this monthly chart data: ${JSON.stringify(recap.monthlySeries)}, active month ${recap.monthLabel}, income ${formatMoney(recap.summary.totalIncome)}, expenses ${formatMoney(recap.summary.totalExpense)}, score ${analysis.healthScore}/100.`
        : `Anda adalah penasihat keuangan Bemvu. Berikan ringkasan eksekutif 2-3 kalimat berbahasa Indonesia yang bijak dari data grafik bulanan berikut: ${JSON.stringify(recap.monthlySeries)}, bulan aktif ${recap.monthLabel}, pemasukan ${formatMoney(recap.summary.totalIncome)}, pengeluaran ${formatMoney(recap.summary.totalExpense)}, skor ${analysis.healthScore}/100.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

function createApp(options = {}) {
  const db = createDatabase(options.dbPath);
  const sendOtpEmail = options.sendOtpEmail || createOtpEmailSender();
  const sendOtpWhatsApp = options.sendOtpWhatsApp || createOtpWhatsAppSender();
  const publicDir = options.publicDir || path.join(__dirname, 'public');

  async function issueOtp(email, purpose, payload = {}) {
    const now = new Date();
    const nowIso = now.toISOString();
    await db.prepare('DELETE FROM email_otps WHERE expires_at <= ?').run(nowIso);

    const previous = await db.prepare(
      'SELECT last_sent_at FROM email_otps WHERE email = ? AND purpose = ?'
    ).get(email, purpose);
    if (previous && now.getTime() - Date.parse(previous.last_sent_at) < OTP_RESEND_DELAY_MS) {
      throw new HttpError(429, 'Tunggu 60 detik sebelum meminta kode OTP baru.');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = hashOtp(code, salt);
    try {
      await sendOtpEmail({ to: email, code, purpose });
    } catch (error) {
      if (error instanceof EmailConfigurationError) {
        throw new HttpError(
          503,
          'Email OTP belum dikonfigurasi. Tetapkan SMTP_USER dan SMTP_PASS pada environment server, lalu restart atau deploy ulang.'
        );
      }
      console.error('[Bemvu OTP] Email delivery failed:', error.message);
      throw new HttpError(503, 'Kode OTP gagal dikirim. Periksa koneksi dan konfigurasi Gmail SMTP.');
    }

    const sentAt = new Date();
    const sentAtIso = sentAt.toISOString();
    await db.prepare(`
      INSERT INTO email_otps (
        email, purpose, name, password_hash, monthly_budget,
        code_salt, code_hash, expires_at, attempts, last_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(email, purpose) DO UPDATE SET
        name = excluded.name,
        password_hash = excluded.password_hash,
        monthly_budget = excluded.monthly_budget,
        code_salt = excluded.code_salt,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent_at = excluded.last_sent_at
    `).run(
      email,
      purpose,
      payload.name || '',
      payload.passwordHash || '',
      payload.monthlyBudget || 0,
      salt,
      codeHash,
      new Date(sentAt.getTime() + OTP_LIFETIME_MS).toISOString(),
      sentAtIso
    );
  }

  async function issueWhatsAppOtp(phone, purpose, payload = {}) {
    const now = new Date();
    await db.prepare('DELETE FROM whatsapp_otps WHERE expires_at <= ?').run(now.toISOString());

    const previous = await db.prepare(
      'SELECT last_sent_at FROM whatsapp_otps WHERE phone = ? AND purpose = ?'
    ).get(phone, purpose);
    if (previous && now.getTime() - Date.parse(previous.last_sent_at) < OTP_RESEND_DELAY_MS) {
      throw new HttpError(429, 'Tunggu 60 detik sebelum meminta kode OTP baru.');
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = hashOtp(code, salt);
    try {
      await sendOtpWhatsApp({ to: phone, code, purpose });
    } catch (error) {
      if (error instanceof WhatsAppConfigurationError) {
        console.error('[Bemvu WhatsApp OTP] Configuration incomplete:', error.message);
        throw new HttpError(
          503,
          'Layanan verifikasi WhatsApp belum aktif. Silakan hubungi admin aplikasi.'
        );
      }
      if (error instanceof WhatsAppDeliveryError) {
        console.error(`[Bemvu WhatsApp OTP] Meta API returned HTTP ${error.status}.`);
        throw new HttpError(503, 'Kode OTP WhatsApp gagal dikirim. Periksa konfigurasi Meta WhatsApp Cloud API.');
      }
      console.error(
        '[Bemvu WhatsApp OTP] Delivery failed:',
        error instanceof Error ? error.name : 'UnknownError'
      );
      throw new HttpError(503, 'Kode OTP WhatsApp gagal dikirim. Periksa koneksi server.');
    }

    const sentAt = new Date();
    await db.prepare(`
      INSERT INTO whatsapp_otps (
        phone, purpose, name, monthly_budget,
        code_salt, code_hash, expires_at, attempts, last_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(phone, purpose) DO UPDATE SET
        name = excluded.name,
        monthly_budget = excluded.monthly_budget,
        code_salt = excluded.code_salt,
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        last_sent_at = excluded.last_sent_at
    `).run(
      phone,
      purpose,
      payload.name || '',
      payload.monthlyBudget || 0,
      salt,
      codeHash,
      new Date(sentAt.getTime() + OTP_LIFETIME_MS).toISOString(),
      sentAt.toISOString()
    );
  }

  async function verifyOtp(email, purpose, code) {
    const row = await db.prepare(
      'SELECT * FROM email_otps WHERE email = ? AND purpose = ?'
    ).get(email, purpose);
    if (!row) {
      throw new HttpError(400, 'Kode OTP salah atau sudah kedaluwarsa.');
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await db.prepare('DELETE FROM email_otps WHERE email = ? AND purpose = ?').run(email, purpose);
      throw new HttpError(400, 'Kode OTP sudah kedaluwarsa. Minta kode baru.');
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Terlalu banyak percobaan. Minta kode OTP baru.');
    }
    if (!matchesOtp(code, row)) {
      const attempts = row.attempts + 1;
      await db.prepare(
        'UPDATE email_otps SET attempts = ? WHERE email = ? AND purpose = ?'
      ).run(attempts, email, purpose);
      throw new HttpError(
        attempts >= OTP_MAX_ATTEMPTS ? 429 : 400,
        attempts >= OTP_MAX_ATTEMPTS
          ? 'Terlalu banyak percobaan. Minta kode OTP baru.'
          : 'Kode OTP salah.'
      );
    }
    return row;
  }

  async function verifyWhatsAppOtp(phone, purpose, code) {
    const row = await db.prepare(
      'SELECT * FROM whatsapp_otps WHERE phone = ? AND purpose = ?'
    ).get(phone, purpose);
    if (!row) {
      throw new HttpError(400, 'Kode OTP salah atau sudah kedaluwarsa.');
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await db.prepare('DELETE FROM whatsapp_otps WHERE phone = ? AND purpose = ?').run(phone, purpose);
      throw new HttpError(400, 'Kode OTP sudah kedaluwarsa. Minta kode baru.');
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Terlalu banyak percobaan. Minta kode OTP baru.');
    }
    if (!matchesOtp(code, row)) {
      const attempts = row.attempts + 1;
      await db.prepare(
        'UPDATE whatsapp_otps SET attempts = ? WHERE phone = ? AND purpose = ?'
      ).run(attempts, phone, purpose);
      throw new HttpError(
        attempts >= OTP_MAX_ATTEMPTS ? 429 : 400,
        attempts >= OTP_MAX_ATTEMPTS
          ? 'Terlalu banyak percobaan. Minta kode OTP baru.'
          : 'Kode OTP salah.'
      );
    }
    return row;
  }

  async function getAuthUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    let token = cookies.bemvu_session;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7).trim();
    }
    if (!token) return null;

    const row = await db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.monthly_budget, u.monthly_investment_target,
        u.monthly_needs_target, u.monthly_wants_target, u.profile_photo, u.created_at, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

    if (!row) return null;
    if (new Date(row.expires_at) <= new Date()) {
      await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }

    return {
      token,
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      monthly_budget: row.monthly_budget,
      monthly_investment_target: row.monthly_investment_target,
      monthly_needs_target: row.monthly_needs_target,
      monthly_wants_target: row.monthly_wants_target,
      profile_photo: row.profile_photo || '',
      created_at: row.created_at,
    };
  }

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      userId,
      expires
    );
    return token;
  }

  function sessionCookieHeader(token, clear = false) {
    const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
    if (clear) {
      return `bemvu_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    }
    return `bemvu_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}${secure}`;
  }

  const handleRequest = async (req, res) => {
    try {
      await db.ready;
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method;

      for (const [k, v] of Object.entries(getCorsHeaders(req))) {
        res.setHeader(k, v);
      }

      if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      // API Routes
      if (pathname.startsWith('/api/')) {
        // Health check
        if (method === 'GET' && pathname === '/api/health') {
          return sendJson(res, 200, { ok: true, service: 'bemvu' });
        }

        // Auth: Register with email or WhatsApp and a password
        if (method === 'POST' && pathname === '/api/auth/register') {
          const body = await readBody(req);
          const name = String(body.name || '').trim();
          const channel = String(body.channel || 'email');
          const email = String(body.email || '').trim().toLowerCase();
          const password = String(body.password || '');
          const budget = Math.max(0, Math.round(Number(body.monthly_budget) || 0));

          if (name.length < 2) {
            return sendJson(res, 400, { error: 'Nama lengkap minimal 2 karakter.' });
          }
          if (password.length < 6) {
            return sendJson(res, 400, { error: 'Kata sandi minimal 6 karakter.' });
          }
          if (channel === 'whatsapp') {
            const phone = normalizePhone(body.phone);
            if (!phone) {
              return sendJson(res, 400, { error: 'Masukkan nomor WhatsApp dengan kode negara yang valid.' });
            }
            if (await db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
              return sendJson(res, 409, { error: 'Nomor WhatsApp sudah terdaftar. Silakan masuk.' });
            }

            const { user, token } = await db.transaction(async () => {
              const info = await db.prepare(
                "INSERT INTO users (name, email, phone, password_hash, monthly_budget) VALUES (?, NULL, ?, ?, ?) RETURNING id"
              ).run(name, phone, hashPassword(password), budget);
              const userId = Number(info.lastInsertRowid);
              await db.prepare('DELETE FROM whatsapp_otps WHERE phone = ? AND purpose = ?').run(phone, 'register');
              await logActivity(db, userId, 'REGISTER', 'Akun baru terdaftar menggunakan nomor WhatsApp');
              const token = await createSession(userId);
              const user = await db.prepare(
                'SELECT id, name, email, phone, monthly_budget, monthly_investment_target, monthly_needs_target, monthly_wants_target, profile_photo, created_at FROM users WHERE id = ?'
              ).get(userId);
              return { user, token };
            });
            return sendJson(
              res,
              201,
              { user, token },
              { 'Set-Cookie': sessionCookieHeader(token) }
            );
          }
          if (channel !== 'email') {
            return sendJson(res, 400, { error: 'Pilih email atau WhatsApp untuk mendaftar.' });
          }
          if (!isValidEmail(email)) {
            return sendJson(res, 400, { error: 'Format email tidak valid.' });
          }

          const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
          if (existing) {
            return sendJson(res, 409, { error: 'Email sudah terdaftar. Silakan masuk.' });
          }

          const { user, token } = await db.transaction(async () => {
            const info = await db.prepare(
              'INSERT INTO users (name, email, password_hash, monthly_budget) VALUES (?, ?, ?, ?) RETURNING id'
            ).run(name, email, hashPassword(password), budget);
            const userId = Number(info.lastInsertRowid);
            await db.prepare('DELETE FROM email_otps WHERE email = ? AND purpose = ?').run(email, 'register');
            await logActivity(db, userId, 'REGISTER', `Akun baru terdaftar menggunakan email (${email})`);
            const token = await createSession(userId);
            const user = await db.prepare(
              'SELECT id, name, email, phone, monthly_budget, monthly_investment_target, monthly_needs_target, monthly_wants_target, profile_photo, created_at FROM users WHERE id = ?'
            ).get(userId);
            return { user, token };
          });
          return sendJson(
            res,
            201,
            { user, token },
            { 'Set-Cookie': sessionCookieHeader(token) }
          );
        }

        if (
          method === 'POST' &&
          ['/api/auth/register/verify', '/api/auth/register/resend'].includes(pathname)
        ) {
          return sendJson(res, 410, {
            error: 'Pendaftaran sekarang menggunakan kata sandi dan tidak memerlukan OTP. Silakan daftar kembali.',
          });
        }

        // Auth: Start password reset without revealing whether an account exists
        if (method === 'POST' && pathname === '/api/auth/forgot-password') {
          const body = await readBody(req);
          if (body.channel === 'whatsapp' || body.phone) {
            const phone = normalizePhone(body.phone);
            if (!phone) {
              return sendJson(res, 400, { error: 'Masukkan nomor WhatsApp dengan kode negara yang valid.' });
            }
            if (await db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
              try {
                await issueWhatsAppOtp(phone, 'login');
              } catch (error) {
                if (!(error instanceof HttpError) || error.statusCode !== 429) throw error;
              }
            }
            return sendJson(res, 200, { ok: true, channel: 'whatsapp' });
          }

          const email = String(body.email || '').trim().toLowerCase();
          if (!isValidEmail(email)) {
            return sendJson(res, 400, { error: 'Format email tidak valid.' });
          }
          const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
          if (user) {
            try {
              await issueOtp(email, 'password-reset');
            } catch (error) {
              if (!(error instanceof HttpError) || error.statusCode !== 429) throw error;
            }
          }
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'POST' && pathname === '/api/auth/password-reset/resend') {
          const body = await readBody(req);
          if (body.channel === 'whatsapp' || body.phone) {
            const phone = normalizePhone(body.phone);
            if (!phone) {
              return sendJson(res, 400, { error: 'Masukkan nomor WhatsApp dengan kode negara yang valid.' });
            }
            if (await db.prepare('SELECT id FROM users WHERE phone = ?').get(phone)) {
              try {
                await issueWhatsAppOtp(phone, 'login');
              } catch (error) {
                if (!(error instanceof HttpError) || error.statusCode !== 429) throw error;
              }
            }
            return sendJson(res, 200, { ok: true, channel: 'whatsapp' });
          }

          const email = String(body.email || '').trim().toLowerCase();
          if (!isValidEmail(email)) {
            return sendJson(res, 400, { error: 'Format email tidak valid.' });
          }
          const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
          if (user) {
            try {
              await issueOtp(email, 'password-reset');
            } catch (error) {
              if (!(error instanceof HttpError) || error.statusCode !== 429) throw error;
            }
          }
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'POST' && pathname === '/api/auth/reset-password') {
          const body = await readBody(req);
          if (body.phone !== undefined) {
            const phone = normalizePhone(body.phone);
            const code = String(body.code || '').trim();
            const password = String(body.password || '');
            if (!phone || !/^\d{6}$/.test(code)) {
              return sendJson(res, 400, { error: 'Masukkan nomor WhatsApp dan kode OTP 6 digit yang valid.' });
            }
            if (password.length < 6) {
              return sendJson(res, 400, { error: 'Kata sandi minimal 6 karakter.' });
            }
            const pending = await verifyWhatsAppOtp(phone, 'login', code);
            const user = await db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
            if (!user || pending.purpose !== 'login') {
              return sendJson(res, 400, { error: 'Kode OTP salah atau sudah kedaluwarsa.' });
            }

            await db.transaction(async () => {
              const consumed = await db.prepare(
                'DELETE FROM whatsapp_otps WHERE phone = ? AND purpose = ? AND code_hash = ?'
              ).run(phone, 'login', pending.code_hash);
              if (consumed.changes !== 1) {
                throw new HttpError(400, 'Kode OTP sudah digunakan. Minta kode baru.');
              }
              await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
                hashPassword(password),
                user.id
              );
              await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
              await logActivity(db, user.id, 'PASSWORD_RESET', 'Kata sandi diatur ulang melalui WhatsApp');
            });

            return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader('', true) });
          }

          const email = String(body.email || '').trim().toLowerCase();
          const code = String(body.code || '').trim();
          const password = String(body.password || '');
          if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
            return sendJson(res, 400, { error: 'Masukkan email dan kode OTP 6 digit yang valid.' });
          }
          if (password.length < 6) {
            return sendJson(res, 400, { error: 'Kata sandi minimal 6 karakter.' });
          }
          const pending = await verifyOtp(email, 'password-reset', code);
          const user = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
          if (!user || pending.purpose !== 'password-reset') {
            return sendJson(res, 400, { error: 'Kode OTP salah atau sudah kedaluwarsa.' });
          }

          await db.transaction(async () => {
            await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
              hashPassword(password),
              user.id
            );
            await db.prepare('DELETE FROM email_otps WHERE email = ? AND purpose = ?').run(email, 'password-reset');
            await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
            await logActivity(db, user.id, 'PASSWORD_RESET', 'Kata sandi diatur ulang melalui verifikasi email');
          });

          return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookieHeader('', true) });
        }

        // Auth: Login
        if (method === 'POST' && pathname === '/api/auth/login') {
          const body = await readBody(req);
          if (body.phone !== undefined) {
            const phone = normalizePhone(body.phone);
            if (!phone) {
              return sendJson(res, 400, { error: 'Masukkan nomor WhatsApp dengan kode negara yang valid.' });
            }
            const password = String(body.password || '');
            const row = await db.prepare(
              'SELECT id, name, email, phone, password_hash, monthly_budget, monthly_investment_target, monthly_needs_target, monthly_wants_target, profile_photo, created_at FROM users WHERE phone = ?'
            ).get(phone);

            if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
              return sendJson(res, 401, { error: 'Nomor WhatsApp atau kata sandi salah.' });
            }

            const token = await createSession(row.id);
            await logActivity(db, row.id, 'LOGIN', 'Masuk menggunakan nomor WhatsApp dan kata sandi');
            return sendJson(
              res,
              200,
              {
                token,
                user: {
                  id: row.id,
                  name: row.name,
                  email: row.email,
                  phone: row.phone,
                  monthly_budget: row.monthly_budget,
                  monthly_investment_target: row.monthly_investment_target,
                  monthly_needs_target: row.monthly_needs_target,
                  monthly_wants_target: row.monthly_wants_target,
                  profile_photo: row.profile_photo || '',
                  created_at: row.created_at,
                },
              },
              { 'Set-Cookie': sessionCookieHeader(token) }
            );
          }

          const email = String(body.email || '').trim().toLowerCase();
          const password = String(body.password || '');

          const row = await db.prepare(
            'SELECT id, name, email, phone, password_hash, monthly_budget, monthly_investment_target, monthly_needs_target, monthly_wants_target, profile_photo, created_at FROM users WHERE email = ?'
          ).get(email);

          if (!row || !verifyPassword(password, row.password_hash)) {
            return sendJson(res, 401, { error: 'Email atau kata sandi salah.' });
          }

          const token = await createSession(row.id);
          await logActivity(db, row.id, 'LOGIN', 'Masuk ke dashboard Bemvu');

          return sendJson(
            res,
            200,
            {
              token,
              user: {
                id: row.id,
                name: row.name,
                email: row.email,
                phone: row.phone,
                monthly_budget: row.monthly_budget,
                monthly_investment_target: row.monthly_investment_target,
                monthly_needs_target: row.monthly_needs_target,
                monthly_wants_target: row.monthly_wants_target,
                profile_photo: row.profile_photo || '',
                created_at: row.created_at,
              },
            },
            { 'Set-Cookie': sessionCookieHeader(token) }
          );
        }

        if (
          method === 'POST' &&
          ['/api/auth/login/verify', '/api/auth/login/resend'].includes(pathname)
        ) {
          return sendJson(res, 410, {
            error: 'Login menggunakan email atau nomor WhatsApp dan kata sandi. Gunakan lupa kata sandi untuk pemulihan.',
          });
        }

        // Auth: Logout
        if (method === 'POST' && pathname === '/api/auth/logout') {
          const user = await getAuthUser(req);
          if (user) {
            await db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
            await logActivity(db, user.id, 'LOGOUT', 'Keluar dari sesi akun');
          }
          return sendJson(
            res,
            200,
            { ok: true },
            { 'Set-Cookie': sessionCookieHeader('', true) }
          );
        }

        // Protected routes
        const user = await getAuthUser(req);
        if (!user) {
          return sendJson(res, 401, { error: 'Silakan login terlebih dahulu.' });
        }

        // Get current user
        if (method === 'GET' && pathname === '/api/auth/me') {
          return sendJson(res, 200, {
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              phone: user.phone,
              monthly_budget: user.monthly_budget,
              monthly_investment_target: user.monthly_investment_target,
              monthly_needs_target: user.monthly_needs_target,
              monthly_wants_target: user.monthly_wants_target,
              profile_photo: user.profile_photo || '',
              created_at: user.created_at,
            },
          });
        }

        // Update profile / monthly budget
        if (method === 'PATCH' && pathname === '/api/auth/profile') {
          const body = await readBody(req);
          const isEnglish = body.lang === 'en';
          const name = body.name !== undefined ? String(body.name).trim() : user.name;
          const budget =
            body.monthly_budget !== undefined
              ? Math.max(0, Math.round(Number(body.monthly_budget) || 0))
              : user.monthly_budget;
          const investmentTarget =
            body.monthly_investment_target !== undefined
              ? Number(body.monthly_investment_target)
              : Number(user.monthly_investment_target ?? 20);
          const needsTarget =
            body.monthly_needs_target !== undefined
              ? Number(body.monthly_needs_target)
              : Number(user.monthly_needs_target ?? 50);
          const wantsTarget =
            body.monthly_wants_target !== undefined
              ? Number(body.monthly_wants_target)
              : Number(user.monthly_wants_target ?? 30);
          const profilePhoto =
            body.profile_photo !== undefined ? validateProfilePhoto(body.profile_photo) : user.profile_photo || '';
          const allocationTargetsProvided =
            body.monthly_needs_target !== undefined || body.monthly_wants_target !== undefined;
          const fullAllocationProvided =
            body.monthly_needs_target !== undefined &&
            body.monthly_wants_target !== undefined &&
            body.monthly_investment_target !== undefined;

          if (name.length < 2) {
            return sendJson(res, 400, {
              error: isEnglish ? 'Name must contain at least 2 characters.' : 'Nama minimal 2 karakter.',
            });
          }
          if (profilePhoto === null) {
            return sendJson(res, 400, {
              error: isEnglish
                ? 'The profile photo is invalid or too large.'
                : 'Foto profil tidak valid atau ukurannya terlalu besar.',
            });
          }
          if (
            ![investmentTarget, needsTarget, wantsTarget].every(
              (target) => Number.isInteger(target) && target >= 0 && target <= 100
            )
          ) {
            return sendJson(res, 400, {
              error: isEnglish
                ? 'Allocation targets must be whole numbers between 0 and 100 percent.'
                : 'Target alokasi harus berupa bilangan bulat antara 0 dan 100 persen.',
            });
          }
          if (
            allocationTargetsProvided &&
            fullAllocationProvided &&
            needsTarget + wantsTarget + investmentTarget !== 100
          ) {
            return sendJson(res, 400, {
              error: isEnglish
                ? 'Needs, wants, and savings targets must add up to 100 percent.'
                : 'Target kebutuhan, keinginan, dan tabungan harus berjumlah 100 persen.',
            });
          }

          await db.prepare(`
            UPDATE users
            SET name = ?, monthly_budget = ?, monthly_investment_target = ?,
              monthly_needs_target = ?, monthly_wants_target = ?, profile_photo = ?
            WHERE id = ?
          `).run(
            name,
            budget,
            investmentTarget,
            needsTarget,
            wantsTarget,
            profilePhoto,
            user.id
          );
          await logActivity(
            db,
            user.id,
            'UPDATE_PROFILE',
            `Memperbarui profil, target pengeluaran bulanan ${formatIDR(budget)}, dan alokasi 50/30/20: ${needsTarget}/${wantsTarget}/${investmentTarget}%`
          );

          const updated = await db.prepare(
            'SELECT id, name, email, phone, monthly_budget, monthly_investment_target, monthly_needs_target, monthly_wants_target, profile_photo, created_at FROM users WHERE id = ?'
          ).get(user.id);
          return sendJson(res, 200, { user: updated });
        }

        if (method === 'POST' && pathname === '/api/auth/change-password') {
          const body = await readBody(req);
          const currentPassword = String(body.current_password || '');
          const newPassword = String(body.new_password || '');
          const isEnglish = body.lang === 'en';
          if (newPassword.length < 6 || newPassword.length > 128) {
            return sendJson(res, 400, {
              error: isEnglish
                ? 'New password must contain between 6 and 128 characters.'
                : 'Kata sandi baru harus terdiri dari 6 hingga 128 karakter.',
            });
          }
          const credentials = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
          if (!currentPassword || !credentials || !verifyPassword(currentPassword, credentials.password_hash)) {
            return sendJson(res, 400, {
              error: isEnglish ? 'Current password is incorrect.' : 'Kata sandi saat ini salah.',
            });
          }

          await db.transaction(async () => {
            await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
              hashPassword(newPassword),
              user.id
            );
            await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user.id, user.token);
            await logActivity(db, user.id, 'PASSWORD_CHANGE', 'Kata sandi akun diubah');
          });
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'GET' && pathname === '/api/investments') {
          const month = getValidMonthKey(url.searchParams.get('month'));
          const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'id';
          const months = getPreviousMonths(month, 6);
          const [allTime, monthlyRows, seriesRows, transactions] = await Promise.all([
            db.prepare(`
              SELECT
                COALESCE(SUM(CASE WHEN type = 'expense' AND category = ? THEN amount ELSE 0 END), 0) AS invested,
                COALESCE(SUM(CASE WHEN type = 'income' AND category = ? THEN amount ELSE 0 END), 0) AS returns
              FROM transactions
              WHERE user_id = ?
            `).get(INVESTMENT_CONTRIBUTION_CATEGORY, INVESTMENT_RETURN_CATEGORY, user.id),
            db.prepare(`
              SELECT
                COALESCE(NULLIF(investment_type, ''), CASE WHEN type = 'expense' THEN 'savings' ELSE 'other' END) AS investment_type,
                COALESCE(SUM(CASE WHEN type = 'expense' AND category = ? THEN amount ELSE 0 END), 0) AS invested,
                COALESCE(SUM(CASE WHEN type = 'income' AND category = ? THEN amount ELSE 0 END), 0) AS returns
              FROM transactions
              WHERE user_id = ? AND substr(tx_date, 1, 7) = ?
                AND ((type = 'expense' AND category = ?) OR (type = 'income' AND category = ?))
              GROUP BY COALESCE(NULLIF(investment_type, ''), CASE WHEN type = 'expense' THEN 'savings' ELSE 'other' END)
            `).all(
              INVESTMENT_CONTRIBUTION_CATEGORY,
              INVESTMENT_RETURN_CATEGORY,
              user.id,
              month,
              INVESTMENT_CONTRIBUTION_CATEGORY,
              INVESTMENT_RETURN_CATEGORY
            ),
            db.prepare(`
              SELECT substr(tx_date, 1, 7) AS month_key,
                COALESCE(SUM(CASE WHEN type = 'expense' AND category = ? THEN amount ELSE 0 END), 0) AS invested,
                COALESCE(SUM(CASE WHEN type = 'income' AND category = ? THEN amount ELSE 0 END), 0) AS returns
              FROM transactions
              WHERE user_id = ? AND substr(tx_date, 1, 7) >= ? AND substr(tx_date, 1, 7) <= ?
                AND ((type = 'expense' AND category = ?) OR (type = 'income' AND category = ?))
              GROUP BY substr(tx_date, 1, 7)
            `).all(
              INVESTMENT_CONTRIBUTION_CATEGORY,
              INVESTMENT_RETURN_CATEGORY,
              user.id,
              months[0],
              month,
              INVESTMENT_CONTRIBUTION_CATEGORY,
              INVESTMENT_RETURN_CATEGORY
            ),
            db.prepare(`
              SELECT id, type, amount, category, investment_type, description, payment_method, tx_date
              FROM transactions
              WHERE user_id = ?
                AND ((type = 'expense' AND category = ?) OR (type = 'income' AND category = ?))
              ORDER BY tx_date DESC, id DESC
              LIMIT 100
            `).all(user.id, INVESTMENT_CONTRIBUTION_CATEGORY, INVESTMENT_RETURN_CATEGORY),
          ]);
          const seriesMap = new Map(seriesRows.map((row) => [row.month_key, row]));
          return sendJson(res, 200, {
            month,
            summary: {
              allTimeInvested: Number(allTime.invested) || 0,
              allTimeReturns: Number(allTime.returns) || 0,
              monthlyInvested: monthlyRows.reduce((total, row) => total + (Number(row.invested) || 0), 0),
              monthlyReturns: monthlyRows.reduce((total, row) => total + (Number(row.returns) || 0), 0),
            },
            breakdown: monthlyRows.map((row) => ({
              type: row.investment_type,
              invested: Number(row.invested) || 0,
              returns: Number(row.returns) || 0,
            })).sort((a, b) => b.invested - a.invested),
            monthlySeries: months.map((monthKey) => {
              const row = seriesMap.get(monthKey) || {};
              return {
                monthKey,
                label: formatMonthLabel(monthKey, true, lang),
                invested: Number(row.invested) || 0,
                returns: Number(row.returns) || 0,
              };
            }),
            transactions,
          });
        }

        if (method === 'GET' && pathname === '/api/budgets') {
          const month = getValidMonthKey(url.searchParams.get('month'));
          const budgets = await db.prepare(`
            SELECT b.id, b.category, b.monthly_limit,
              COALESCE(SUM(t.amount), 0) AS spent
            FROM category_budgets b
            LEFT JOIN transactions t
              ON t.user_id = b.user_id
              AND t.category = b.category
              AND t.type = 'expense'
              AND substr(t.tx_date, 1, 7) = ?
            WHERE b.user_id = ?
            GROUP BY b.id
            ORDER BY LOWER(b.category)
          `).all(month, user.id);
          return sendJson(res, 200, {
            month,
            budgets: budgets.map((budget) => ({
              ...budget,
              monthly_limit: Number(budget.monthly_limit) || 0,
              spent: Number(budget.spent) || 0,
            })),
          });
        }

        if (method === 'POST' && pathname === '/api/budgets') {
          const body = await readBody(req);
          const category = String(body.category || '').trim().slice(0, 120);
          const limit = Math.round(Number(body.monthly_limit));
          if (!category || !Number.isSafeInteger(limit) || limit <= 0) {
            return sendJson(res, 400, { error: 'Pilih kategori dan masukkan batas anggaran yang lebih besar dari 0.' });
          }
          const result = await db.prepare(`
            INSERT INTO category_budgets (user_id, category, monthly_limit)
            VALUES (?, ?, ?)
            ON CONFLICT (user_id, category) DO UPDATE SET
              monthly_limit = excluded.monthly_limit,
              updated_at = CURRENT_TIMESTAMP
            RETURNING id
          `).run(user.id, category, limit);
          await logActivity(db, user.id, 'SET_CATEGORY_BUDGET', `Mengatur batas ${category} ${formatIDR(limit)} per bulan`);
          return sendJson(res, 200, { id: Number(result.lastInsertRowid), category, monthly_limit: limit });
        }

        const budgetMatch = pathname.match(/^\/api\/budgets\/(\d+)$/);
        if (budgetMatch && method === 'DELETE') {
          const removed = await db.prepare(
            'DELETE FROM category_budgets WHERE id = ? AND user_id = ?'
          ).run(Number(budgetMatch[1]), user.id);
          if (!removed.changes) return sendJson(res, 404, { error: 'Anggaran kategori tidak ditemukan.' });
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'GET' && pathname === '/api/wallets') {
          const existingMethods = await db.prepare(
            'SELECT DISTINCT payment_method FROM transactions WHERE user_id = ?'
          ).all(user.id);
          const methods = new Map(DEFAULT_PAYMENT_METHODS.map((method) => [method.name, method.type]));
          existingMethods.forEach((row) => {
            if (row.payment_method) methods.set(row.payment_method, methods.get(row.payment_method) || 'other');
          });
          for (const [name, walletType] of methods) {
            await db.prepare(`
              INSERT INTO wallets (user_id, name, wallet_type, opening_balance)
              VALUES (?, ?, ?, 0)
              ON CONFLICT (user_id, name) DO NOTHING
            `).run(user.id, name, walletType);
          }
          const wallets = await getWalletBalances(db, user.id);
          const transfers = await db.prepare(`
            SELECT wt.id, wt.amount, wt.transfer_date, wt.notes,
              from_wallet.name AS from_name, to_wallet.name AS to_name
            FROM wallet_transfers wt
            JOIN wallets from_wallet ON from_wallet.id = wt.from_wallet_id
            JOIN wallets to_wallet ON to_wallet.id = wt.to_wallet_id
            WHERE wt.user_id = ?
            ORDER BY wt.transfer_date DESC, wt.id DESC
            LIMIT 50
          `).all(user.id);
          return sendJson(res, 200, { wallets, transfers });
        }

        if (method === 'POST' && pathname === '/api/wallets') {
          const body = await readBody(req);
          const name = String(body.name || '').trim().slice(0, 60);
          const walletType = String(body.wallet_type || 'other');
          const openingBalance = Math.round(Number(body.opening_balance));
          if (name.length < 2) return sendJson(res, 400, { error: 'Nama dompet minimal 2 karakter.' });
          if (!['cash', 'bank', 'ewallet', 'other'].includes(walletType)) {
            return sendJson(res, 400, { error: 'Jenis dompet tidak valid.' });
          }
          if (!Number.isSafeInteger(openingBalance) || openingBalance < 0) {
            return sendJson(res, 400, { error: 'Saldo awal harus berupa angka nol atau lebih.' });
          }
          if (await db.prepare('SELECT id FROM wallets WHERE user_id = ? AND name = ?').get(user.id, name)) {
            return sendJson(res, 409, { error: 'Nama dompet sudah digunakan.' });
          }
          const result = await db.prepare(`
            INSERT INTO wallets (user_id, name, wallet_type, opening_balance)
            VALUES (?, ?, ?, ?) RETURNING id
          `).run(user.id, name, walletType, openingBalance);
          await logActivity(db, user.id, 'CREATE_WALLET', `Membuat dompet "${name}"`);
          return sendJson(res, 201, { wallet: { id: Number(result.lastInsertRowid), name, wallet_type: walletType, opening_balance: openingBalance } });
        }

        const walletMatch = pathname.match(/^\/api\/wallets\/(\d+)$/);
        if (walletMatch && method === 'PATCH') {
          const walletId = Number(walletMatch[1]);
          const body = await readBody(req);
          const openingBalance = Math.round(Number(body.opening_balance));
          if (!Number.isSafeInteger(openingBalance) || openingBalance < 0) {
            return sendJson(res, 400, { error: 'Saldo awal harus berupa angka nol atau lebih.' });
          }
          const updated = await db.prepare(`
            UPDATE wallets SET opening_balance = ?
            WHERE id = ? AND user_id = ?
          `).run(openingBalance, walletId, user.id);
          if (!updated.changes) return sendJson(res, 404, { error: 'Dompet tidak ditemukan.' });
          return sendJson(res, 200, { ok: true });
        }

        if (walletMatch && method === 'DELETE') {
          const walletId = Number(walletMatch[1]);
          const wallet = await db.prepare('SELECT id, name FROM wallets WHERE id = ? AND user_id = ?').get(walletId, user.id);
          if (!wallet) return sendJson(res, 404, { error: 'Dompet tidak ditemukan.' });
          const hasTransactions = await db.prepare(
            'SELECT id FROM transactions WHERE user_id = ? AND payment_method = ? LIMIT 1'
          ).get(user.id, wallet.name);
          const hasTransfers = await db.prepare(`
            SELECT id FROM wallet_transfers
            WHERE user_id = ? AND (from_wallet_id = ? OR to_wallet_id = ?) LIMIT 1
          `).get(user.id, walletId, walletId);
          if (hasTransactions || hasTransfers) {
            return sendJson(res, 409, { error: 'Dompet yang sudah memiliki riwayat transaksi atau transfer tidak dapat dihapus.' });
          }
          await db.prepare('DELETE FROM wallets WHERE id = ? AND user_id = ?').run(walletId, user.id);
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'POST' && pathname === '/api/wallet-transfers') {
          const body = await readBody(req);
          const fromWalletId = Number(body.from_wallet_id);
          const toWalletId = Number(body.to_wallet_id);
          const amount = Math.round(Number(body.amount));
          const transferDate = String(body.transfer_date || '').trim();
          const notes = String(body.notes || '').trim().slice(0, 160);
          if (!Number.isSafeInteger(fromWalletId) || !Number.isSafeInteger(toWalletId) || fromWalletId === toWalletId) {
            return sendJson(res, 400, { error: 'Pilih dua dompet yang berbeda untuk transfer.' });
          }
          if (!Number.isSafeInteger(amount) || amount <= 0) {
            return sendJson(res, 400, { error: 'Nominal transfer harus lebih besar dari 0.' });
          }
          if (!isValidDate(transferDate)) return sendJson(res, 400, { error: 'Tanggal transfer tidak valid.' });
          const fromWallet = await db.prepare(
            'SELECT id FROM wallets WHERE id = ? AND user_id = ?'
          ).get(fromWalletId, user.id);
          const toWallet = await db.prepare(
            'SELECT id FROM wallets WHERE id = ? AND user_id = ?'
          ).get(toWalletId, user.id);
          if (!fromWallet || !toWallet) return sendJson(res, 404, { error: 'Dompet asal atau tujuan tidak ditemukan.' });

          const transfer = await db.transaction(async () => {
            const balances = await getWalletBalances(db, user.id);
            const source = balances.find((wallet) => wallet.id === fromWalletId);
            if (!source || source.balance < amount) {
              throw new HttpError(400, 'Saldo dompet asal tidak mencukupi untuk transfer ini.');
            }
            const result = await db.prepare(`
              INSERT INTO wallet_transfers (user_id, from_wallet_id, to_wallet_id, amount, transfer_date, notes)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING id
            `).run(user.id, fromWalletId, toWalletId, amount, transferDate, notes);
            return Number(result.lastInsertRowid);
          });
          await logActivity(db, user.id, 'WALLET_TRANSFER', `Transfer ${formatIDR(amount)} antar dompet`);
          return sendJson(res, 201, { id: transfer });
        }

        // List transactions
        if (method === 'GET' && pathname === '/api/transactions') {
          const month = url.searchParams.get('month');
          const date = url.searchParams.get('date');
          const type = url.searchParams.get('type');
          const category = url.searchParams.get('category');
          const q = (url.searchParams.get('q') || '').trim().toLowerCase();

          let sql = `
            SELECT id, type, amount, category, investment_type, description, payment_method, tx_date, created_at, updated_at
            FROM transactions
            WHERE user_id = ?
          `;
          const params = [user.id];

          if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            sql += ' AND substr(tx_date, 1, 7) = ?';
            params.push(month);
          }
          if (date && isValidDate(date)) {
            sql += ' AND tx_date = ?';
            params.push(date);
          }
          if (type === 'income' || type === 'expense') {
            sql += ' AND type = ?';
            params.push(type);
          }
          if (category) {
            sql += ' AND category = ?';
            params.push(category);
          }
          if (q) {
            sql += ' AND (LOWER(description) LIKE ? OR LOWER(category) LIKE ? OR LOWER(investment_type) LIKE ? OR LOWER(payment_method) LIKE ?)';
            const like = `%${q}%`;
            params.push(like, like, like, like);
          }

          sql += ' ORDER BY tx_date DESC, id DESC LIMIT 500';
          const items = await db.prepare(sql).all(...params);
          return sendJson(res, 200, { transactions: items });
        }

        // Export CSV
        if (method === 'GET' && pathname === '/api/transactions/export') {
          const month = url.searchParams.get('month');
          let sql = `
            SELECT tx_date, type, category, investment_type, amount, payment_method, description, created_at
            FROM transactions
            WHERE user_id = ?
          `;
          const params = [user.id];
          if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
            sql += ' AND substr(tx_date, 1, 7) = ?';
            params.push(month);
          }
          sql += ' ORDER BY tx_date DESC, id DESC';
          const rows = await db.prepare(sql).all(...params);

          const lines = [
            'Tanggal,Jenis,Kategori,Jenis Tabungan/Investasi,Nominal (IDR),Metode,Catatan,Dicatat Pada',
            ...rows.map((r) =>
              [
                csvEscape(r.tx_date),
                csvEscape(r.type === 'income' ? 'Pemasukan' : 'Pengeluaran'),
                csvEscape(r.category),
                csvEscape(r.investment_type),
                csvEscape(r.amount),
                csvEscape(r.payment_method),
                csvEscape(r.description),
                csvEscape(r.created_at),
              ].join(',')
            ),
          ];

          const csv = '\uFEFF' + lines.join('\r\n');
          const fileLabel = month || 'semua';
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="bemvu-log-${fileLabel}.csv"`,
          });
          return res.end(csv);
        }

        // Create transaction
        if (method === 'POST' && pathname === '/api/transactions') {
          const body = await readBody(req);
          const type = body.type;
          const amount = Math.round(Number(body.amount));
          const category = String(body.category || '').trim();
          const investmentType = String(body.investment_type || '').trim();
          const description = String(body.description || '').trim().slice(0, 240);
          const paymentMethod = String(body.payment_method || 'Tunai / QRIS').trim().slice(0, 60);
          const txDate = String(body.tx_date || '').trim();

          if (type !== 'income' && type !== 'expense') {
            return sendJson(res, 400, { error: 'Jenis transaksi harus pemasukan atau pengeluaran.' });
          }
          if (!Number.isFinite(amount) || amount <= 0) {
            return sendJson(res, 400, { error: 'Nominal harus lebih besar dari 0.' });
          }
          if (!category) {
            return sendJson(res, 400, { error: 'Kategori wajib dipilih.' });
          }
          if (!isValidInvestmentType(type, category, investmentType)) {
            return sendJson(res, 400, { error: 'Jenis tabungan/investasi tidak valid untuk kategori ini.' });
          }
          if (!isValidDate(txDate)) {
            return sendJson(res, 400, { error: 'Format tanggal tidak valid (YYYY-MM-DD).' });
          }

          const info = await db.prepare(`
            INSERT INTO transactions (user_id, type, amount, category, investment_type, description, payment_method, tx_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
          `).run(user.id, type, amount, category, investmentType, description, paymentMethod, txDate);

          const created = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(info.lastInsertRowid));
          await logActivity(
            db,
            user.id,
            'CREATE_TX',
            `${type === 'income' ? 'Pemasukan' : 'Pengeluaran'} ${formatIDR(amount)} (${category}) pada ${txDate}${description ? ` — ${description}` : ''}`
          );

          return sendJson(res, 201, { transaction: created });
        }

        // Update / Delete transaction by ID
        const txMatch = pathname.match(/^\/api\/transactions\/(\d+)$/);
        if (txMatch) {
          const txId = Number(txMatch[1]);
          const existing = await db.prepare(
            'SELECT * FROM transactions WHERE id = ? AND user_id = ?'
          ).get(txId, user.id);

          if (!existing) {
            return sendJson(res, 404, { error: 'Transaksi tidak ditemukan.' });
          }

          if (method === 'PUT') {
            const body = await readBody(req);
            const type = body.type || existing.type;
            const amount = body.amount !== undefined ? Math.round(Number(body.amount)) : existing.amount;
            const category = body.category !== undefined ? String(body.category).trim() : existing.category;
            const investmentType =
              body.investment_type !== undefined
                ? String(body.investment_type || '').trim()
                : existing.investment_type || '';
            const description =
              body.description !== undefined ? String(body.description).trim().slice(0, 240) : existing.description;
            const paymentMethod =
              body.payment_method !== undefined
                ? String(body.payment_method).trim().slice(0, 60)
                : existing.payment_method;
            const txDate = body.tx_date !== undefined ? String(body.tx_date).trim() : existing.tx_date;

            if (type !== 'income' && type !== 'expense') {
              return sendJson(res, 400, { error: 'Jenis transaksi tidak valid.' });
            }
            if (!Number.isFinite(amount) || amount <= 0) {
              return sendJson(res, 400, { error: 'Nominal harus lebih besar dari 0.' });
            }
            if (!category || !isValidDate(txDate)) {
              return sendJson(res, 400, { error: 'Kategori dan tanggal wajib valid.' });
            }
            if (!isValidInvestmentType(type, category, investmentType)) {
              return sendJson(res, 400, { error: 'Jenis tabungan/investasi tidak valid untuk kategori ini.' });
            }
            const normalizedInvestmentType = normalizeInvestmentType(type, category, investmentType);

            await db.prepare(`
              UPDATE transactions
              SET type = ?, amount = ?, category = ?, investment_type = ?, description = ?, payment_method = ?, tx_date = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND user_id = ?
            `).run(type, amount, category, normalizedInvestmentType, description, paymentMethod, txDate, txId, user.id);

            const updated = await db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
            await logActivity(
              db,
              user.id,
              'UPDATE_TX',
              `Mengubah transaksi #${txId}: ${type === 'income' ? 'Pemasukan' : 'Pengeluaran'} ${formatIDR(amount)} (${category})`
            );
            return sendJson(res, 200, { transaction: updated });
          }

          if (method === 'DELETE') {
            await db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(txId, user.id);
            await logActivity(
              db,
              user.id,
              'DELETE_TX',
              `Menghapus ${existing.type === 'income' ? 'Pemasukan' : 'Pengeluaran'} ${formatIDR(existing.amount)} (${existing.category}) tgl ${existing.tx_date}`
            );
            return sendJson(res, 200, { ok: true });
          }
        }

        // Debts: list, create, delete
        if (method === 'GET' && pathname === '/api/debts') {
          const items = await db.prepare(`
            SELECT id, title, principal_amount, due_date, notes, kind, monthly_installment, created_at
            FROM debts
            WHERE user_id = ?
            ORDER BY id DESC
          `).all(user.id);
          const paymentRows = await db.prepare(`
            SELECT id, debt_id, amount, payment_date, notes
            FROM debt_payments WHERE user_id = ?
            ORDER BY payment_date DESC, id DESC
          `).all(user.id);
          const paymentsByDebt = new Map();
          for (const payment of paymentRows) {
            if (!paymentsByDebt.has(payment.debt_id)) paymentsByDebt.set(payment.debt_id, []);
            paymentsByDebt.get(payment.debt_id).push(payment);
          }
          const debts = items.map((debt) => {
            const payments = paymentsByDebt.get(debt.id) || [];
            const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
            return {
              ...debt,
              kind: debt.kind || 'payable',
              monthly_installment: Number(debt.monthly_installment) || 0,
              paid_amount: paidAmount,
              remaining_amount: Math.max(0, Number(debt.principal_amount) - paidAmount),
              payments,
            };
          });
          const payablePrincipal = debts
            .filter((debt) => debt.kind === 'payable')
            .reduce((sum, debt) => sum + Number(debt.principal_amount), 0);
          const receivablePrincipal = debts
            .filter((debt) => debt.kind === 'receivable')
            .reduce((sum, debt) => sum + Number(debt.principal_amount), 0);
          const payablePaid = debts
            .filter((debt) => debt.kind === 'payable')
            .reduce((sum, debt) => sum + debt.paid_amount, 0);
          const receivablePaid = debts
            .filter((debt) => debt.kind === 'receivable')
            .reduce((sum, debt) => sum + debt.paid_amount, 0);
          const unlinkedPaid = await db.prepare(`
            SELECT COALESCE(SUM(t.amount), 0) AS amount
            FROM transactions t
            LEFT JOIN debt_payments dp ON dp.transaction_id = t.id
            WHERE t.user_id = ? AND t.type = 'expense' AND t.category = 'Bayar Hutang'
              AND dp.id IS NULL
          `).get(user.id);
          const unlinkedPayments = await db.prepare(`
            SELECT t.id, t.amount, t.tx_date AS payment_date, t.description, t.payment_method
            FROM transactions t
            LEFT JOIN debt_payments dp ON dp.transaction_id = t.id
            WHERE t.user_id = ? AND t.type = 'expense' AND t.category = 'Bayar Hutang'
              AND dp.id IS NULL
            ORDER BY t.tx_date DESC, t.id DESC
            LIMIT 50
          `).all(user.id);
          return sendJson(res, 200, {
            debts,
            unlinkedPayments,
            summary: {
              totalPrincipal: payablePrincipal,
              paidAllTime: payablePaid + (Number(unlinkedPaid.amount) || 0),
              remainingDebt: Math.max(0, payablePrincipal - payablePaid - (Number(unlinkedPaid.amount) || 0)),
              receivablePrincipal,
              receivablePaid,
              remainingReceivable: Math.max(0, receivablePrincipal - receivablePaid),
            },
          });
        }

        if (method === 'POST' && pathname === '/api/debts') {
          const body = await readBody(req);
          const title = String(body.title || '').trim().slice(0, 120);
          const principal = Math.round(Number(body.principal_amount));
          const dueDate = String(body.due_date || '').trim().slice(0, 20);
          const notes = String(body.notes || '').trim().slice(0, 240);
          if (body.kind !== undefined && !['payable', 'receivable'].includes(body.kind)) {
            return sendJson(res, 400, { error: 'Pilih jenis hutang atau piutang yang valid.' });
          }
          const kind = body.kind === 'receivable' ? 'receivable' : 'payable';
          const monthlyInstallment = Math.round(Number(body.monthly_installment) || 0);

          if (title.length < 2) {
            return sendJson(res, 400, { error: 'Nama / keterangan hutang atau piutang minimal 2 karakter.' });
          }
          if (!Number.isFinite(principal) || principal <= 0) {
            return sendJson(res, 400, { error: 'Nominal hutang harus lebih besar dari 0.' });
          }
          if (!Number.isSafeInteger(monthlyInstallment) || monthlyInstallment < 0) {
            return sendJson(res, 400, { error: 'Nominal cicilan tidak valid.' });
          }
          if (dueDate && !isValidDate(dueDate)) return sendJson(res, 400, { error: 'Tanggal jatuh tempo tidak valid.' });

          const info = await db.prepare(`
            INSERT INTO debts (user_id, title, principal_amount, due_date, notes, kind, monthly_installment)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
          `).run(user.id, title, principal, dueDate, notes, kind, monthlyInstallment);

          const created = await db.prepare('SELECT * FROM debts WHERE id = ?').get(Number(info.lastInsertRowid));
          await logActivity(db, user.id, 'CREATE_DEBT', `Mencatat ${kind === 'payable' ? 'hutang' : 'piutang'} "${title}" sebesar ${formatIDR(principal)}`);
          return sendJson(res, 201, { debt: created });
        }

        const debtPaymentMatch = pathname.match(/^\/api\/debts\/(\d+)\/payments$/);
        if (debtPaymentMatch && method === 'POST') {
          const debtId = Number(debtPaymentMatch[1]);
          const body = await readBody(req);
          const amount = Math.round(Number(body.amount));
          const paymentDate = String(body.payment_date || '').trim();
          const paymentMethod = String(body.payment_method || 'Tunai').trim().slice(0, 60);
          const notes = String(body.notes || '').trim().slice(0, 160);
          if (!Number.isSafeInteger(amount) || amount <= 0) {
            return sendJson(res, 400, { error: 'Nominal pembayaran harus lebih besar dari 0.' });
          }
          if (!isValidDate(paymentDate)) return sendJson(res, 400, { error: 'Tanggal pembayaran tidak valid.' });
          const debt = await db.prepare(
            'SELECT id, title, principal_amount, kind FROM debts WHERE id = ? AND user_id = ?'
          ).get(debtId, user.id);
          if (!debt) return sendJson(res, 404, { error: 'Catatan hutang/piutang tidak ditemukan.' });

          const payment = await db.transaction(async () => {
            const paid = await db.prepare(
              'SELECT COALESCE(SUM(amount), 0) AS amount FROM debt_payments WHERE user_id = ? AND debt_id = ?'
            ).get(user.id, debtId);
            const remaining = Math.max(0, Number(debt.principal_amount) - Number(paid.amount || 0));
            if (amount > remaining) throw new HttpError(400, 'Pembayaran melebihi sisa hutang/piutang.');
            const transactionType = debt.kind === 'receivable' ? 'income' : 'expense';
            const category = debt.kind === 'receivable' ? 'Pelunasan Piutang' : 'Bayar Hutang';
            const transactionDescription = notes || `${debt.kind === 'receivable' ? 'Pelunasan piutang' : 'Cicilan hutang'}: ${debt.title}`;
            const txResult = await db.prepare(`
              INSERT INTO transactions (user_id, type, amount, category, description, payment_method, tx_date)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
            `).run(user.id, transactionType, amount, category, transactionDescription, paymentMethod, paymentDate);
            const txId = Number(txResult.lastInsertRowid);
            await db.prepare(`
              INSERT INTO debt_payments (user_id, debt_id, transaction_id, amount, payment_date, notes)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(user.id, debtId, txId, amount, paymentDate, notes);
            return { transactionId: txId, remaining: remaining - amount };
          });
          await logActivity(db, user.id, 'DEBT_PAYMENT', `Mencatat pembayaran ${formatIDR(amount)} untuk "${debt.title}"`);
          return sendJson(res, 201, { payment, transactionId: payment.transactionId });
        }

        const debtMatch = pathname.match(/^\/api\/debts\/(\d+)$/);
        if (debtMatch && method === 'DELETE') {
          const debtId = Number(debtMatch[1]);
          const existing = await db.prepare('SELECT * FROM debts WHERE id = ? AND user_id = ?').get(debtId, user.id);
          if (!existing) {
            return sendJson(res, 404, { error: 'Catatan hutang tidak ditemukan.' });
          }
          await db.prepare('DELETE FROM debts WHERE id = ? AND user_id = ?').run(debtId, user.id);
          await logActivity(db, user.id, 'DELETE_DEBT', `Menghapus catatan hutang "${existing.title}" (${formatIDR(existing.principal_amount)})`);
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'GET' && pathname === '/api/goals') {
          const goals = await db.prepare(`
            SELECT id, title, target_amount, saved_amount, due_date, created_at
            FROM financial_goals WHERE user_id = ? ORDER BY id DESC
          `).all(user.id);
          return sendJson(res, 200, {
            goals: goals.map((goal) => ({
              ...goal,
              target_amount: Number(goal.target_amount) || 0,
              saved_amount: Number(goal.saved_amount) || 0,
            })),
          });
        }

        if (method === 'POST' && pathname === '/api/goals') {
          const body = await readBody(req);
          const title = String(body.title || '').trim().slice(0, 120);
          const targetAmount = Math.round(Number(body.target_amount));
          const dueDate = String(body.due_date || '').trim();
          if (title.length < 2) return sendJson(res, 400, { error: 'Nama target minimal 2 karakter.' });
          if (!Number.isSafeInteger(targetAmount) || targetAmount <= 0) {
            return sendJson(res, 400, { error: 'Nominal target harus lebih besar dari 0.' });
          }
          if (dueDate && !isValidDate(dueDate)) return sendJson(res, 400, { error: 'Tanggal target tidak valid.' });
          const result = await db.prepare(`
            INSERT INTO financial_goals (user_id, title, target_amount, due_date)
            VALUES (?, ?, ?, ?) RETURNING id
          `).run(user.id, title, targetAmount, dueDate);
          await logActivity(db, user.id, 'CREATE_GOAL', `Membuat target tabungan "${title}" sebesar ${formatIDR(targetAmount)}`);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        const goalContributionMatch = pathname.match(/^\/api\/goals\/(\d+)\/contributions$/);
        if (goalContributionMatch && method === 'POST') {
          const goalId = Number(goalContributionMatch[1]);
          const body = await readBody(req);
          const amount = Math.round(Number(body.amount));
          if (!Number.isSafeInteger(amount) || amount <= 0) {
            return sendJson(res, 400, { error: 'Nominal tabungan harus lebih besar dari 0.' });
          }
          const updated = await db.prepare(`
            UPDATE financial_goals SET saved_amount = saved_amount + ?
            WHERE id = ? AND user_id = ?
          `).run(amount, goalId, user.id);
          if (!updated.changes) return sendJson(res, 404, { error: 'Target tabungan tidak ditemukan.' });
          await logActivity(db, user.id, 'CONTRIBUTE_GOAL', `Menambahkan ${formatIDR(amount)} ke target tabungan`);
          return sendJson(res, 200, { ok: true });
        }

        const goalMatch = pathname.match(/^\/api\/goals\/(\d+)$/);
        if (goalMatch && method === 'DELETE') {
          const removed = await db.prepare(
            'DELETE FROM financial_goals WHERE id = ? AND user_id = ?'
          ).run(Number(goalMatch[1]), user.id);
          if (!removed.changes) return sendJson(res, 404, { error: 'Target tabungan tidak ditemukan.' });
          return sendJson(res, 200, { ok: true });
        }

        if (method === 'GET' && pathname === '/api/recurring') {
          const recurring = await db.prepare(`
            SELECT id, type, amount, category, investment_type, description,
              payment_method, frequency, next_due_date, is_active, created_at
            FROM recurring_transactions
            WHERE user_id = ?
            ORDER BY is_active DESC, next_due_date ASC, id DESC
          `).all(user.id);
          return sendJson(res, 200, {
            recurring: recurring.map((item) => ({
              ...item,
              amount: Number(item.amount) || 0,
              is_active: Boolean(item.is_active),
            })),
          });
        }

        if (method === 'POST' && pathname === '/api/recurring') {
          const body = await readBody(req);
          const type = body.type === 'income' ? 'income' : 'expense';
          const amount = Math.round(Number(body.amount));
          const category = String(body.category || '').trim().slice(0, 120);
          const investmentType = String(body.investment_type || '').trim();
          const description = String(body.description || '').trim().slice(0, 240);
          const paymentMethod = String(body.payment_method || 'Tunai').trim().slice(0, 60);
          const frequency = String(body.frequency || '');
          const nextDueDate = String(body.next_due_date || '').trim();
          if (body.type !== 'income' && body.type !== 'expense') {
            return sendJson(res, 400, { error: 'Jenis transaksi rutin tidak valid.' });
          }
          if (!Number.isSafeInteger(amount) || amount <= 0 || !category) {
            return sendJson(res, 400, { error: 'Nominal dan kategori transaksi rutin wajib valid.' });
          }
          if (!RECURRING_FREQUENCIES.has(frequency)) {
            return sendJson(res, 400, { error: 'Pilih frekuensi mingguan, bulanan, atau tahunan.' });
          }
          if (!isValidDate(nextDueDate)) return sendJson(res, 400, { error: 'Tanggal jatuh tempo tidak valid.' });
          if (
            investmentType &&
            (type !== 'expense' || category !== 'Tabungan & Investasi' || !INVESTMENT_TYPES.has(investmentType))
          ) {
            return sendJson(res, 400, { error: 'Jenis tabungan/investasi tidak valid untuk transaksi rutin ini.' });
          }
          const result = await db.prepare(`
            INSERT INTO recurring_transactions (
              user_id, type, amount, category, investment_type, description,
              payment_method, frequency, next_due_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
          `).run(user.id, type, amount, category, investmentType, description, paymentMethod, frequency, nextDueDate);
          return sendJson(res, 201, { id: Number(result.lastInsertRowid) });
        }

        const recurringConfirmationMatch = pathname.match(/^\/api\/recurring\/(\d+)\/confirm$/);
        if (recurringConfirmationMatch && method === 'POST') {
          const recurringId = Number(recurringConfirmationMatch[1]);
          const body = await readBody(req);
          const txDate = String(body.tx_date || new Date().toISOString().slice(0, 10)).trim();
          if (!isValidDate(txDate)) return sendJson(res, 400, { error: 'Tanggal transaksi tidak valid.' });
          const result = await db.transaction(async () => {
            const item = await db.prepare(`
              SELECT id, type, amount, category, investment_type, description,
                payment_method, frequency, next_due_date, is_active
              FROM recurring_transactions WHERE id = ? AND user_id = ?
            `).get(recurringId, user.id);
            if (!item || !item.is_active) throw new HttpError(404, 'Transaksi rutin tidak ditemukan atau sudah dinonaktifkan.');
            const nextDueDate = addRecurringInterval(item.next_due_date, item.frequency);
            const updated = await db.prepare(`
              UPDATE recurring_transactions SET next_due_date = ?
              WHERE id = ? AND user_id = ? AND next_due_date = ? AND is_active = 1
            `).run(nextDueDate, recurringId, user.id, item.next_due_date);
            if (!updated.changes) throw new HttpError(409, 'Jadwal ini sudah dikonfirmasi. Muat ulang daftar transaksi rutin.');
            const txResult = await db.prepare(`
              INSERT INTO transactions (
                user_id, type, amount, category, investment_type, description, payment_method, tx_date
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
            `).run(
              user.id,
              item.type,
              item.amount,
              item.category,
              item.investment_type || '',
              item.description || '',
              item.payment_method || 'Tunai',
              txDate
            );
            return { transactionId: Number(txResult.lastInsertRowid), nextDueDate };
          });
          await logActivity(db, user.id, 'CONFIRM_RECURRING', `Mengonfirmasi transaksi rutin #${recurringId}`);
          return sendJson(res, 201, result);
        }

        const recurringMatch = pathname.match(/^\/api\/recurring\/(\d+)$/);
        if (recurringMatch && method === 'DELETE') {
          const removed = await db.prepare(
            'DELETE FROM recurring_transactions WHERE id = ? AND user_id = ?'
          ).run(Number(recurringMatch[1]), user.id);
          if (!removed.changes) return sendJson(res, 404, { error: 'Transaksi rutin tidak ditemukan.' });
          return sendJson(res, 200, { ok: true });
        }

        // Analytics recap & monthly charts
        if (method === 'GET' && pathname === '/api/analytics/recap') {
          const month = getValidMonthKey(url.searchParams.get('month'));
          const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'id';
          const recap = await buildRecap(db, user.id, month, lang);
          return sendJson(res, 200, { recap });
        }

        // AI Insight (read-only view for tab switching, no DB write)
        if (method === 'GET' && pathname === '/api/ai/insight') {
          const month = getValidMonthKey(url.searchParams.get('month'));
          const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'id';
          const usdRate = getUsdRate(url.searchParams.get('usdRate'));
          const recap = await buildRecap(db, user.id, month, lang);
          const analysis = generateAiAnalysis(recap, user, lang, usdRate);
          return sendJson(res, 200, { analysis, recap });
        }

        // AI Insight Analysis (explicit run & save snapshot)
        if (method === 'POST' && pathname === '/api/ai/analyze') {
          const body = await readBody(req);
          const month = getValidMonthKey(body.month || url.searchParams.get('month'));
          const lang = body.lang === 'en' ? 'en' : 'id';
          const usdRate = getUsdRate(body.usdRate);
          const recap = await buildRecap(db, user.id, month, lang);
          const analysis = generateAiAnalysis(recap, user, lang, usdRate);

          const geminiNote = await enhanceWithGeminiIfAvailable(recap, analysis, null, lang, usdRate);
          if (geminiNote) {
            analysis.geminiSummary = geminiNote;
          }

          await db.prepare(`
            INSERT INTO ai_reports (user_id, month_key, health_score, grade, summary, report_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            user.id,
            recap.monthKey,
            analysis.healthScore,
            analysis.grade,
            analysis.headline,
            JSON.stringify(analysis)
          );

          await logActivity(
            db,
            user.id,
            'AI_ANALYSIS',
            `Analisis AI untuk ${recap.monthLabel}: Skor ${analysis.healthScore}/100 (${analysis.grade})`
          );

          return sendJson(res, 200, { analysis, recap });
        }

        // AI Interactive Q&A
        if (method === 'POST' && pathname === '/api/ai/ask') {
          const body = await readBody(req);
          const month = getValidMonthKey(body.month);
          const lang = body.lang === 'en' ? 'en' : 'id';
          const usdRate = getUsdRate(body.usdRate);
          const question = String(body.question || '').trim();
          if (!question) {
            return sendJson(res, 400, {
              error: lang === 'en' ? 'Question cannot be empty.' : 'Pertanyaan tidak boleh kosong.',
            });
          }
          const recap = await buildRecap(db, user.id, month, lang);
          const analysis = generateAiAnalysis(recap, user, lang, usdRate);
          const geminiReply = await enhanceWithGeminiIfAvailable(recap, analysis, question, lang, usdRate);
          const answer = geminiReply || answerFinancialQuestion(question, recap, analysis, user, lang, usdRate);

          await logActivity(db, user.id, 'AI_ASK', `Bertanya ke Bemvu AI: "${question.slice(0, 80)}"`);
          return sendJson(res, 200, {
            answer,
            poweredBy: geminiReply ? 'Gemini + Bemvu Ledger' : 'Bemvu Financial AI Engine',
          });
        }

        // AI history + Activity Logs
        if (method === 'GET' && pathname === '/api/logs') {
          const logs = await db.prepare(`
            SELECT id, action, detail, created_at
            FROM activity_logs
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 100
          `).all(user.id);

          const aiReports = await db.prepare(`
            SELECT id, month_key, health_score, grade, summary, created_at
            FROM ai_reports
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 20
          `).all(user.id);

          return sendJson(res, 200, { logs, aiReports });
        }

        // Seed 3 months of realistic sample data for quick demo
        if (method === 'POST' && pathname === '/api/demo/seed') {
          const body = await readBody(req);
          const anchorMonth = getValidMonthKey(body.month);
          const [y, m] = anchorMonth.split('-').map(Number);

          const monthStr = (offset) => {
            const d = new Date(y, m - 1 + offset, 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          };

          const m0 = monthStr(0);
          const m1 = monthStr(-1);
          const m2 = monthStr(-2);

          const samples = [
            // 2 months ago
            ['income', 8500000, 'Gaji & Upah', 'Gaji bulanan utama', 'Transfer Bank', `${m2}-01`],
            ['expense', 1450000, 'Tagihan & Utilitas', 'Listrik, air, internet rumah', 'Auto-Debit', `${m2}-05`],
            ['expense', 1800000, 'Makan & Minum', 'Belanja makan & sembako', 'QRIS', `${m2}-10`],
            ['expense', 650000, 'Transportasi', 'BBM & tol harian', 'E-Wallet', `${m2}-14`],
            ['expense', 950000, 'Hiburan & Nongkrong', 'Nonton & kopi akhir pekan', 'QRIS', `${m2}-19`],
            ['expense', 1500000, 'Tabungan & Investasi', 'Setor rutin reksa dana', 'Transfer Bank', `${m2}-25`],
            // 1 month ago
            ['income', 8500000, 'Gaji & Upah', 'Gaji bulanan utama', 'Transfer Bank', `${m1}-01`],
            ['income', 1750000, 'Bisnis & Freelance', 'Proyek desain UI', 'Transfer Bank', `${m1}-12`],
            ['expense', 1500000, 'Tagihan & Utilitas', 'Listrik, internet, sewa', 'Auto-Debit', `${m1}-05`],
            ['expense', 2100000, 'Makan & Minum', 'Kebutuhan makan & dapur', 'QRIS', `${m1}-11`],
            ['expense', 780000, 'Transportasi', 'Transportasi kerja', 'E-Wallet', `${m1}-15`],
            ['expense', 1650000, 'Belanja Pribadi', 'Sepatu kerja & pakaian', 'Kartu Debit', `${m1}-20`],
            ['expense', 1200000, 'Hiburan & Nongkrong', 'Makan malam keluarga', 'QRIS', `${m1}-23`],
            ['expense', 750000, 'Bayar Hutang', 'Cicilan bulan lalu', 'Transfer Bank', `${m1}-25`],
            ['expense', 1600000, 'Tabungan & Investasi', 'Tabungan dana darurat', 'Transfer Bank', `${m1}-26`],
            // Current selected month
            ['income', 8750000, 'Gaji & Upah', 'Gaji bulanan', 'Transfer Bank', `${m0}-01`],
            ['income', 1250000, 'Bisnis & Freelance', 'Jasa konsultasi web', 'Transfer Bank', `${m0}-09`],
            ['expense', 1480000, 'Tagihan & Utilitas', 'Listrik, internet fiber & air', 'Auto-Debit', `${m0}-03`],
            ['expense', 920000, 'Belanja Rumah Tangga', 'Groceries mingguan', 'Kartu Debit', `${m0}-06`],
            ['expense', 420000, 'Makan & Minum', 'Makan siang & kopi minggu 1', 'QRIS', `${m0}-07`],
            ['expense', 560000, 'Transportasi', 'BBM & parkir', 'E-Wallet', `${m0}-10`],
            ['expense', 840000, 'Makan & Minum', 'Makan harian & pesan antar', 'QRIS', `${m0}-14`],
            ['expense', 1150000, 'Hiburan & Nongkrong', 'Hangout akhir pekan', 'QRIS', `${m0}-16`],
            ['expense', 350000, 'Kesehatan', 'Vitamin & cek kesehatan', 'Kartu Debit', `${m0}-18`],
            ['expense', 750000, 'Bayar Hutang', 'Angsuran laptop bulan ini', 'Transfer Bank', `${m0}-19`],
            ['expense', 2000000, 'Tabungan & Investasi', 'Top-up reksa dana & emas', 'Transfer Bank', `${m0}-20`],
          ];

          await db.transaction(async () => {
            const insertStmt = db.prepare(`
              INSERT INTO transactions (user_id, type, amount, category, description, payment_method, tx_date)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const row of samples) {
              await insertStmt.run(user.id, ...row);
            }
            const existingDebtCount = (await db.prepare(
              'SELECT COUNT(*) AS cnt FROM debts WHERE user_id = ?'
            ).get(user.id)).cnt;
            if (existingDebtCount === 0) {
              await db.prepare(`
                INSERT INTO debts (user_id, title, principal_amount, due_date, notes)
                VALUES (?, ?, ?, ?, ?)
              `).run(user.id, 'Cicilan Laptop Kerja', 4500000, '', 'Angsuran 6 bulan');
            }
            if (!user.monthly_budget || user.monthly_budget === 0) {
              await db.prepare('UPDATE users SET monthly_budget = ? WHERE id = ?').run(7000000, user.id);
            }
          });

          await logActivity(db, user.id, 'DEMO_SEED', `Memuat ${samples.length} transaksi contoh 3 bulan`);
          return sendJson(res, 201, { count: samples.length });
        }

        return sendJson(res, 404, { error: 'Endpoint API tidak ditemukan.' });
      }

      // Static file serving from public/
      let relPath = pathname === '/' ? '/index.html' : pathname;
      try {
        relPath = decodeURIComponent(relPath);
      } catch {
        return sendJson(res, 400, { error: 'Bad URL' });
      }
      const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
      let filePath = path.join(publicDir, safePath);

      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(publicDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
      res.end(content);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.statusCode, { error: err.message }, {}, req);
      }
      console.error('[Bemvu Error]', err);
      sendJson(res, 500, { error: err.message || 'Terjadi kesalahan pada server.' });
    }
  };
  const server = http.createServer(handleRequest);

  server.db = db;
  server.handleRequest = handleRequest;
  return server;
}

if (require.main === module) {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const PORT = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Bemvu Personal Finance Ledger berjalan di http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
