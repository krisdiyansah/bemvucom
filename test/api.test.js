'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');
const { createDatabase } = require('../src/db');
const { createOtpWhatsAppSender, WhatsAppConfigurationError } = require('../src/whatsapp');

async function req(baseUrl, path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;

  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const setCookie = resp.headers.get('set-cookie');
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: resp.status, json, text, setCookie, headers: resp.headers };
}

test('Bemvu full-stack flow: auth, isolation, daily log, monthly recap, AI insight', async (t) => {
  const otpCodes = new Map();
  const app = createApp({
    dbPath: ':memory:',
    sendOtpEmail: async ({ to, code, purpose }) => {
      otpCodes.set(`${to}:${purpose}`, code);
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    app.db.close();
    app.close();
  });

  // 1. HTML landing page renders
  const htmlResp = await req(baseUrl, '/');
  assert.equal(htmlResp.status, 200);
  assert.match(htmlResp.text, /Bemvu/);
  assert.match(htmlResp.text, /PERSONAL FINANCE LEDGER/);

  // 2. Protected routes require auth
  const unauth = await req(baseUrl, '/api/transactions');
  assert.equal(unauth.status, 401);

  // 3. Register User A
  const regA = await req(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Raka Pratama',
      email: 'raka@example.com',
      password: 'password123',
      monthly_budget: 5000000,
    },
  });
  assert.equal(regA.status, 201);
  assert.equal(regA.json.user.email, 'raka@example.com');
  assert.equal(regA.json.user.monthly_investment_target, 20);
  assert.equal(otpCodes.has('raka@example.com:register'), false);
  assert.ok(regA.setCookie);
  const cookieA = regA.setCookie.split(';')[0];

  // 4. Logout & Login User A
  const logoutA = await req(baseUrl, '/api/auth/logout', { method: 'POST', cookie: cookieA });
  assert.equal(logoutA.status, 200);
  const afterLogout = await req(baseUrl, '/api/auth/me', { cookie: cookieA });
  assert.equal(afterLogout.status, 401);

  const loginA = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'raka@example.com', password: 'password123' },
  });
  assert.equal(loginA.status, 200);
  const sessionA = loginA.setCookie.split(';')[0];
  const investmentTargetUpdate = await req(baseUrl, '/api/auth/profile', {
    method: 'PATCH',
    cookie: sessionA,
    body: { monthly_investment_target: 25 },
  });
  assert.equal(investmentTargetUpdate.status, 200);
  assert.equal(investmentTargetUpdate.json.user.monthly_investment_target, 25);
  const persistedInvestmentTarget = await req(baseUrl, '/api/auth/me', { cookie: sessionA });
  assert.equal(persistedInvestmentTarget.json.user.monthly_investment_target, 25);
  const invalidInvestmentTarget = await req(baseUrl, '/api/auth/profile', {
    method: 'PATCH',
    cookie: sessionA,
    body: { monthly_investment_target: 101 },
  });
  assert.equal(invalidInvestmentTarget.status, 400);

  // 5. Create transactions across two months
  const tx1 = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: sessionA,
    body: {
      type: 'income',
      amount: 10000000,
      category: 'Gaji & Upah',
      description: 'Gaji November',
      payment_method: 'Transfer Bank',
      tx_date: '2026-11-01',
    },
  });
  assert.equal(tx1.status, 201);

  const tx2 = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: sessionA,
    body: {
      type: 'expense',
      amount: 2500000,
      category: 'Makan & Minum',
      description: 'Belanja makan bulanan',
      payment_method: 'QRIS',
      tx_date: '2026-11-10',
    },
  });
  assert.equal(tx2.status, 201);

  const tx3 = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: sessionA,
    body: {
      type: 'expense',
      amount: 1200000,
      category: 'Hiburan & Nongkrong',
      description: 'Nongkrong akhir pekan',
      payment_method: 'QRIS',
      tx_date: '2026-10-15',
    },
  });
  assert.equal(tx3.status, 201);

  // Edit tx2
  const editTx2 = await req(baseUrl, `/api/transactions/${tx2.json.transaction.id}`, {
    method: 'PUT',
    cookie: sessionA,
    body: { amount: 2200000 },
  });
  assert.equal(editTx2.status, 200);
  assert.equal(editTx2.json.transaction.amount, 2200000);

  // 6. Verify Recap & Monthly Series
  const recapResp = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie: sessionA });
  assert.equal(recapResp.status, 200);
  const { recap } = recapResp.json;
  assert.equal(recap.summary.totalIncome, 10000000);
  assert.equal(recap.summary.totalExpense, 2200000);
  assert.equal(recap.summary.netBalance, 7800000);
  assert.equal(recap.monthlySeries.length, 6);
  const octPoint = recap.monthlySeries.find((m) => m.monthKey === '2026-10');
  const novPoint = recap.monthlySeries.find((m) => m.monthKey === '2026-11');
  assert.equal(octPoint.expense, 1200000);
  assert.equal(novPoint.income, 10000000);
  assert.equal(novPoint.expense, 2200000);

  // 7. AI Insight (GET read-only + POST analyze) & Q&A
  const aiInsightResp = await req(baseUrl, '/api/ai/insight?month=2026-11', { cookie: sessionA });
  assert.equal(aiInsightResp.status, 200);
  assert.ok(aiInsightResp.json.analysis.healthScore >= 70);

  const aiInsightEn = await req(
    baseUrl,
    '/api/ai/insight?month=2026-11&lang=en&usdRate=0.0001',
    { cookie: sessionA }
  );
  assert.equal(aiInsightEn.status, 200);
  assert.match(aiInsightEn.json.analysis.headline, /\$/);
  assert.doesNotMatch(aiInsightEn.json.analysis.headline, /Pemasukan|Pengeluaran|Rasio tabungan/i);

  const aiResp = await req(baseUrl, '/api/ai/analyze', {
    method: 'POST',
    cookie: sessionA,
    body: { month: '2026-11' },
  });
  assert.equal(aiResp.status, 200);
  assert.ok(aiResp.json.analysis.healthScore >= 70);
  assert.match(aiResp.json.analysis.chartAnalysis, /grafik|pengeluaran/i);
  assert.ok(aiResp.json.analysis.insights.length >= 1);

  const askResp = await req(baseUrl, '/api/ai/ask', {
    method: 'POST',
    cookie: sessionA,
    body: { month: '2026-11', question: 'Apakah aman beli barang Rp 500.000?' },
  });
  assert.equal(askResp.status, 200);
  assert.match(askResp.json.answer, /aman/i);

  const askEnResp = await req(baseUrl, '/api/ai/ask', {
    method: 'POST',
    cookie: sessionA,
    body: { month: '2026-11', question: 'Is it safe to buy a $250 item?', lang: 'en', usdRate: 0.0001 },
  });
  assert.equal(askEnResp.status, 200);
  assert.match(askEnResp.json.answer, /\$/);
  assert.match(askEnResp.json.answer, /Relatively safe/i);

  // 8. Export CSV
  const csvResp = await req(baseUrl, '/api/transactions/export?month=2026-11', { cookie: sessionA });
  assert.equal(csvResp.status, 200);
  assert.match(csvResp.text, /Gaji & Upah/);
  assert.match(csvResp.text, /2200000/);

  // 9. User B isolation check
  const regB = await req(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Sinta', email: 'sinta@example.com', password: 'password123' },
  });
  assert.equal(regB.status, 201);
  const sessionB = regB.setCookie.split(';')[0];

  const txListB = await req(baseUrl, '/api/transactions?month=2026-11', { cookie: sessionB });
  assert.equal(txListB.status, 200);
  assert.equal(txListB.json.transactions.length, 0);

  const forbiddenEdit = await req(baseUrl, `/api/transactions/${tx1.json.transaction.id}`, {
    method: 'DELETE',
    cookie: sessionB,
  });
  assert.equal(forbiddenEdit.status, 404);

  // 10. Activity logs check for User A
  const logsA = await req(baseUrl, '/api/logs', { cookie: sessionA });
  assert.equal(logsA.status, 200);
  assert.ok(logsA.json.logs.some((l) => l.action === 'CREATE_TX'));
  assert.ok(logsA.json.logs.some((l) => l.action === 'AI_ANALYSIS'));
  assert.equal(logsA.json.aiReports.length, 1);

  // 11. Cross-origin (Live Server :5500) + Bearer token check
  const corsResp = await fetch(`${baseUrl}/api/auth/me`, {
    headers: {
      Origin: 'http://localhost:5500',
      Authorization: `Bearer ${loginA.json.token}`,
    },
  });
  assert.equal(corsResp.status, 200);
  assert.equal(corsResp.headers.get('access-control-allow-origin'), 'http://localhost:5500');

  // 12. Debt creation + Bayar Hutang expense reduces Sisa Hutang
  const debtCreate = await req(baseUrl, '/api/debts', {
    method: 'POST',
    cookie: sessionA,
    body: {
      title: 'Pinjaman Laptop',
      principal_amount: 3000000,
      notes: 'Cicilan 3x',
    },
  });
  assert.equal(debtCreate.status, 201);

  const payDebtTx = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: sessionA,
    body: {
      type: 'expense',
      amount: 1000000,
      category: 'Bayar Hutang',
      description: 'Cicilan ke-1',
      payment_method: 'Transfer Bank',
      tx_date: '2026-11-18',
    },
  });
  assert.equal(payDebtTx.status, 201);

  const recapAfterDebt = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie: sessionA });
  assert.equal(recapAfterDebt.status, 200);
  assert.equal(recapAfterDebt.json.recap.debt.totalPrincipal, 3000000);
  assert.equal(recapAfterDebt.json.recap.debt.paidMonth, 1000000);
  assert.equal(recapAfterDebt.json.recap.debt.paidAllTime, 1000000);
  assert.equal(recapAfterDebt.json.recap.debt.remainingDebt, 2000000);

  const askDebt = await req(baseUrl, '/api/ai/ask', {
    method: 'POST',
    cookie: sessionA,
    body: { month: '2026-11', question: 'Berapa sisa hutang saya?' },
  });
  assert.equal(askDebt.status, 200);
  assert.match(askDebt.json.answer, /2\.000\.000/);

  const loanIncome = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: sessionA,
    body: {
      type: 'income',
      amount: 2000000,
      category: 'Pinjaman / Hutang',
      description: 'Dana pinjaman',
      payment_method: 'Transfer Bank',
      tx_date: '2026-11-22',
    },
  });
  assert.equal(loanIncome.status, 201);

  const recapWithLoan = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie: sessionA });
  assert.equal(recapWithLoan.status, 200);
  assert.equal(recapWithLoan.json.recap.summary.totalIncome, 12000000);
  assert.equal(recapWithLoan.json.recap.summary.netBalance, 8800000);
  assert.equal(
    recapWithLoan.json.recap.incomeBreakdown.find((item) => item.category === 'Pinjaman / Hutang').amount,
    2000000
  );

  // 13. Password reset verifies email and invalidates existing sessions
  const forgotPassword = await req(baseUrl, '/api/auth/forgot-password', {
    method: 'POST',
    body: { email: 'raka@example.com' },
  });
  assert.equal(forgotPassword.status, 200);
  const wrongResetOtp = await req(baseUrl, '/api/auth/reset-password', {
    method: 'POST',
    body: { email: 'raka@example.com', code: '000000', password: 'newpassword123' },
  });
  assert.equal(wrongResetOtp.status, 400);

  const resetPassword = await req(baseUrl, '/api/auth/reset-password', {
    method: 'POST',
    body: {
      email: 'raka@example.com',
      code: otpCodes.get('raka@example.com:password-reset'),
      password: 'newpassword123',
    },
  });
  assert.equal(resetPassword.status, 200);
  const staleSession = await req(baseUrl, '/api/auth/me', { cookie: sessionA });
  assert.equal(staleSession.status, 401);
  const oldPasswordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'raka@example.com', password: 'password123' },
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'raka@example.com', password: 'newpassword123' },
  });
  assert.equal(newPasswordLogin.status, 200);
});

test('Vercel-style parsed request bodies create accounts without OTP', async (t) => {
  let deliveredCode = '';
  const app = createApp({
    dbPath: ':memory:',
    sendOtpEmail: async ({ code, to }) => {
      assert.equal(to, 'vercel-user@gmail.com');
      deliveredCode = code;
    },
  });
  t.after(() => app.db.close());

  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
  };
  await app.handleRequest({
    method: 'POST',
    url: '/api/auth/register',
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: {
      name: 'Vercel User',
      email: 'vercel-user@gmail.com',
      password: 'secure-password',
    },
  }, response);

  assert.equal(response.status, 201);
  assert.equal(JSON.parse(response.body).user.email, 'vercel-user@gmail.com');
  assert.equal(deliveredCode, '');
});

test('WhatsApp registration and login use passwords without OTP; recovery resets password', async (t) => {
  const otpCodes = new Map();
  const app = createApp({
    dbPath: ':memory:',
    sendOtpEmail: async () => {},
    sendOtpWhatsApp: async ({ to, code, purpose }) => {
      otpCodes.set(`${to}:${purpose}`, code);
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const unknownLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { phone: '0812 3456 7890', password: 'password123' },
  });
  assert.equal(unknownLogin.status, 401);
  assert.equal(otpCodes.has('6281234567890:login'), false);

  const registration = await req(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      channel: 'whatsapp',
      name: 'WhatsApp User',
      phone: '0812 3456 7890',
      password: 'password123',
      monthly_budget: 1500000,
    },
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.json.user.email, null);
  assert.equal(registration.json.user.phone, '6281234567890');
  assert.equal(otpCodes.has('6281234567890:register'), false);
  const registrationCookie = registration.setCookie.split(';')[0];
  const legacyRegisterOtp = await req(baseUrl, '/api/auth/register/verify', {
    method: 'POST',
    body: { channel: 'whatsapp', phone: '0812 3456 7890', code: '123456' },
  });
  assert.equal(legacyRegisterOtp.status, 410);

  const wrongPassword = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { phone: '+62 812-3456-7890', password: 'wrong-password' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(otpCodes.has('6281234567890:login'), false);

  const passwordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { phone: '0812 3456 7890', password: 'password123' },
  });
  assert.equal(passwordLogin.status, 200);
  assert.equal(passwordLogin.json.user.phone, '6281234567890');

  const transaction = await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie: registrationCookie,
    body: {
      type: 'income',
      amount: 250000,
      category: 'Gaji & Upah',
      description: 'Simpan data WA',
      payment_method: 'Tunai',
      tx_date: '2026-11-15',
    },
  });
  assert.equal(transaction.status, 201);
  await req(baseUrl, '/api/auth/logout', { method: 'POST', cookie: registrationCookie });
  const returningLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { phone: '0812 3456 7890', password: 'password123' },
  });
  assert.equal(returningLogin.status, 200);
  const savedData = await req(baseUrl, '/api/transactions?month=2026-11', {
    cookie: returningLogin.setCookie.split(';')[0],
  });
  assert.equal(savedData.json.transactions.length, 1);
  assert.equal(savedData.json.transactions[0].description, 'Simpan data WA');

  const recoveryRequest = await req(baseUrl, '/api/auth/forgot-password', {
    method: 'POST',
    body: { channel: 'whatsapp', phone: '0812 3456 7890' },
  });
  assert.equal(recoveryRequest.status, 200);
  const otpLogin = await req(baseUrl, '/api/auth/login/verify', {
    method: 'POST',
    body: {
      phone: '0812 3456 7890',
      code: otpCodes.get('6281234567890:login'),
    },
  });
  assert.equal(otpLogin.status, 410);
  const reset = await req(baseUrl, '/api/auth/reset-password', {
    method: 'POST',
    body: {
      phone: '0812 3456 7890',
      code: otpCodes.get('6281234567890:login'),
      password: 'new-password-123',
    },
  });
  assert.equal(reset.status, 200);
  const newPasswordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { phone: '0812 3456 7890', password: 'new-password-123' },
  });
  assert.equal(newPasswordLogin.status, 200);
});

test('WhatsApp setup errors are logged for admins without exposing config to users', async (t) => {
  const app = createApp({
    dbPath: ':memory:',
    sendOtpWhatsApp: async () => {
      throw new WhatsAppConfigurationError(
        'Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_OTP_TEMPLATE_NAME.'
      );
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const originalConsoleError = console.error;
  const serverLogs = [];
  console.error = (...args) => serverLogs.push(args.join(' '));
  try {
    const registration = await req(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        channel: 'whatsapp',
        name: 'Test User',
        phone: '+6281234567890',
        password: 'password123',
      },
    });
    assert.equal(registration.status, 201);
    const response = await req(baseUrl, '/api/auth/forgot-password', {
      method: 'POST',
      body: { channel: 'whatsapp', phone: '+6281234567890' },
    });
    assert.equal(response.status, 503);
    assert.equal(
      response.json.error,
      'Layanan verifikasi WhatsApp belum aktif. Silakan hubungi admin aplikasi.'
    );
    assert.doesNotMatch(response.json.error, /WHATSAPP_ACCESS_TOKEN|PHONE_NUMBER_ID|TEMPLATE_NAME/);
    assert.match(serverLogs.join(' '), /WHATSAPP_ACCESS_TOKEN/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('SQLite migration makes email optional without losing linked account data', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bemvu-migration-'));
  const dbPath = path.join(tempDir, 'legacy.db');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      monthly_budget INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      principal_amount INTEGER NOT NULL,
      due_date TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    INSERT INTO users (name, email, password_hash) VALUES ('Existing User', 'existing@example.com', 'legacy-hash');
    INSERT INTO sessions (token, user_id, expires_at) VALUES ('legacy-session', 1, '2099-01-01T00:00:00.000Z');
    INSERT INTO debts (user_id, title, principal_amount) VALUES (1, 'Legacy Debt', 2500);
  `);
  legacyDb.close();

  const db = createDatabase(dbPath);
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  assert.equal(
    (await db.prepare('SELECT email FROM users WHERE id = ?').get(1)).email,
    'existing@example.com'
  );
  assert.equal(
    (await db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(1)).token,
    'legacy-session'
  );
  assert.equal(
    (await db.prepare('SELECT monthly_investment_target FROM users WHERE id = ?').get(1))
      .monthly_investment_target,
    20
  );
  assert.equal((await db.prepare('SELECT profile_photo FROM users WHERE id = ?').get(1)).profile_photo, '');
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
  await db.prepare(
    "INSERT INTO users (name, email, phone, password_hash) VALUES (?, NULL, ?, '')"
  ).run('New WhatsApp User', '6281234567890');
  assert.equal(
    (await db.prepare('SELECT phone FROM users WHERE id = ?').get(2)).phone,
    '6281234567890'
  );
  const legacyDebt = await db.prepare('SELECT kind, monthly_installment FROM debts WHERE id = ?').get(1);
  assert.equal(legacyDebt.kind, 'payable');
  assert.equal(legacyDebt.monthly_installment, 0);
});

test('Meta WhatsApp sender uses the configured authentication template', async () => {
  let requestUrl = '';
  let requestOptions;
  const sendOtp = createOtpWhatsAppSender({
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789',
    WHATSAPP_OTP_TEMPLATE_NAME: 'bemvu_auth_code',
  }, async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return { ok: true, status: 200 };
  });

  await sendOtp({ to: '6281234567890', code: '123456', purpose: 'login' });
  assert.equal(requestUrl, 'https://graph.facebook.com/v27.0/123456789/messages');
  assert.equal(requestOptions.headers.Authorization, 'Bearer test-token');
  const payload = JSON.parse(requestOptions.body);
  assert.equal(payload.to, '6281234567890');
  assert.equal(payload.template.name, 'bemvu_auth_code');
  assert.equal(payload.template.components[0].parameters[0].text, '123456');
  assert.equal(payload.template.components[1].parameters[0].text, '123456');

  const unconfiguredSender = createOtpWhatsAppSender({}, async () => ({ ok: true }));
  await assert.rejects(
    unconfiguredSender({ to: '6281234567890', code: '123456' }),
    WhatsAppConfigurationError
  );
});

test('Vercel accepts POSTGRES_URL when DATABASE_URL is not set', async (t) => {
  const previous = {
    vercel: process.env.VERCEL,
    databaseUrl: process.env.DATABASE_URL,
    postgresUrl: process.env.POSTGRES_URL,
  };
  t.after(() => {
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previous.postgresUrl;
  });

  process.env.VERCEL = '1';
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = 'postgresql://bemvu:test@localhost/bemvu';
  const db = createDatabase();
  await db.close();
});

test('Vercel API reports missing database configuration as a clear service error', async (t) => {
  const previous = {
    vercel: process.env.VERCEL,
    databaseUrl: process.env.DATABASE_URL,
    postgresUrl: process.env.POSTGRES_URL,
  };
  t.after(() => {
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
    if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = previous.postgresUrl;
  });

  process.env.VERCEL = '1';
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const handler = require('../api');
  const response = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };

  await handler({ method: 'GET', url: '/api/health', headers: {} }, response);
  assert.equal(response.status, 503);
  assert.match(response.body, /DATABASE_URL or POSTGRES_URL/);
});

test('Monthly recap counts the savings and investment category separately', async (t) => {
  const app = createApp({
    dbPath: ':memory:',
    sendOtpEmail: async () => {},
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const registration = await req(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Cashflow Test', email: 'cashflow@example.com', password: 'secure-password' },
  });
  const cookie = registration.setCookie.split(';')[0];
  await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie,
    body: {
      type: 'income',
      amount: 1000000,
      category: 'Gaji & Upah',
      tx_date: '2026-11-05',
    },
  });
  await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie,
    body: {
      type: 'expense',
      amount: 200000,
      category: 'Tabungan & Investasi',
      tx_date: '2026-11-06',
    },
  });

  const recap = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie });
  assert.equal(recap.status, 200);
  assert.equal(recap.json.recap.summary.totalIncome, 1000000);
  assert.equal(recap.json.recap.summary.savingsAllocated, 200000);
});

test('Sidebar finance modules persist budgets, debts, wallets, goals, and recurring bills per account', async (t) => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const register = async (name, email) => {
    const response = await req(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { name, email, password: 'secure-password' },
    });
    assert.equal(response.status, 201);
    return response.setCookie.split(';')[0];
  };
  const cookie = await register('Finance Modules', 'modules@example.com');
  const otherCookie = await register('Other Account', 'other-modules@example.com');

  const budget = await req(baseUrl, '/api/budgets', {
    method: 'POST',
    cookie,
    body: { category: 'Makan & Minum', monthly_limit: 1000000 },
  });
  assert.equal(budget.status, 200);
  await req(baseUrl, '/api/transactions', {
    method: 'POST',
    cookie,
    body: {
      type: 'expense',
      amount: 800000,
      category: 'Makan & Minum',
      payment_method: 'Tunai',
      tx_date: '2026-11-10',
    },
  });
  const budgets = await req(baseUrl, '/api/budgets?month=2026-11', { cookie });
  assert.equal(budgets.json.budgets[0].spent, 800000);
  assert.equal(budgets.json.budgets[0].monthly_limit, 1000000);

  const wallet = await req(baseUrl, '/api/wallets', {
    method: 'POST',
    cookie,
    body: { name: 'Rekening Utama', wallet_type: 'bank', opening_balance: 2000000 },
  });
  assert.equal(wallet.status, 201);
  const walletId = wallet.json.wallet.id;
  const targetWallet = await req(baseUrl, '/api/wallets', {
    method: 'POST',
    cookie,
    body: { name: 'Dana Tunai', wallet_type: 'cash', opening_balance: 0 },
  });
  assert.equal(targetWallet.status, 201);
  const transfer = await req(baseUrl, '/api/wallet-transfers', {
    method: 'POST',
    cookie,
    body: {
      from_wallet_id: walletId,
      to_wallet_id: targetWallet.json.wallet.id,
      amount: 500000,
      transfer_date: '2026-11-12',
    },
  });
  assert.equal(transfer.status, 201);
  const walletState = await req(baseUrl, '/api/wallets', { cookie });
  const sourceWallet = walletState.json.wallets.find((item) => item.id === walletId);
  assert.equal(sourceWallet.balance, 1500000);
  assert.equal(walletState.json.transfers.length, 1);
  const recapAfterTransfer = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie });
  assert.equal(recapAfterTransfer.json.recap.summary.totalExpense, 800000);
  assert.equal(recapAfterTransfer.json.recap.summary.totalIncome, 0);

  const debt = await req(baseUrl, '/api/debts', {
    method: 'POST',
    cookie,
    body: {
      title: 'Cicilan Laptop',
      principal_amount: 900000,
      monthly_installment: 300000,
      due_date: '2026-12-01',
      kind: 'payable',
    },
  });
  assert.equal(debt.status, 201);
  const debtId = debt.json.debt.id;
  const debtPayment = await req(baseUrl, `/api/debts/${debtId}/payments`, {
    method: 'POST',
    cookie,
    body: { amount: 300000, payment_date: '2026-11-20', payment_method: 'Rekening Utama' },
  });
  assert.equal(debtPayment.status, 201);
  const debtState = await req(baseUrl, '/api/debts', { cookie });
  assert.equal(debtState.json.debts[0].remaining_amount, 600000);
  assert.equal(debtState.json.debts[0].payments.length, 1);
  const invalidDebtOverpayment = await req(baseUrl, `/api/debts/${debtId}/payments`, {
    method: 'POST',
    cookie,
    body: { amount: 700000, payment_date: '2026-11-21', payment_method: 'Tunai' },
  });
  assert.equal(invalidDebtOverpayment.status, 400);

  const receivable = await req(baseUrl, '/api/debts', {
    method: 'POST',
    cookie,
    body: { title: 'Pinjaman ke teman', principal_amount: 1000000, kind: 'receivable' },
  });
  assert.equal(receivable.status, 201);
  const receivablePayment = await req(baseUrl, `/api/debts/${receivable.json.debt.id}/payments`, {
    method: 'POST',
    cookie,
    body: { amount: 400000, payment_date: '2026-11-22', payment_method: 'Rekening Utama' },
  });
  assert.equal(receivablePayment.status, 201);
  const debtsAfterReceivable = await req(baseUrl, '/api/debts', { cookie });
  assert.equal(debtsAfterReceivable.json.summary.remainingReceivable, 600000);

  const goal = await req(baseUrl, '/api/goals', {
    method: 'POST',
    cookie,
    body: { title: 'Dana Darurat', target_amount: 5000000, due_date: '2027-06-01' },
  });
  assert.equal(goal.status, 201);
  const contribution = await req(baseUrl, `/api/goals/${goal.json.id}/contributions`, {
    method: 'POST',
    cookie,
    body: { amount: 1000000 },
  });
  assert.equal(contribution.status, 200);
  const goals = await req(baseUrl, '/api/goals', { cookie });
  assert.equal(goals.json.goals[0].saved_amount, 1000000);

  const recurring = await req(baseUrl, '/api/recurring', {
    method: 'POST',
    cookie,
    body: {
      type: 'expense',
      amount: 250000,
      category: 'Tagihan & Utilitas',
      description: 'Listrik',
      payment_method: 'Rekening Utama',
      frequency: 'weekly',
      next_due_date: '2026-11-24',
    },
  });
  assert.equal(recurring.status, 201);
  const confirmation = await req(baseUrl, `/api/recurring/${recurring.json.id}/confirm`, {
    method: 'POST',
    cookie,
  });
  assert.equal(confirmation.status, 201);
  const recurringState = await req(baseUrl, '/api/recurring', { cookie });
  assert.equal(recurringState.json.recurring[0].next_due_date, '2026-12-01');
  const finalRecap = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie });
  assert.equal(finalRecap.json.recap.summary.totalIncome, 400000);
  assert.equal(finalRecap.json.recap.summary.totalExpense, 1350000);
  assert.equal(finalRecap.json.recap.debt.remainingDebt, 600000);
  const finalWallets = await req(baseUrl, '/api/wallets', { cookie });
  assert.equal(finalWallets.json.wallets.find((item) => item.id === walletId).balance, 1350000);

  const isolatedBudgets = await req(baseUrl, '/api/budgets?month=2026-11', { cookie: otherCookie });
  const isolatedWallets = await req(baseUrl, '/api/wallets', { cookie: otherCookie });
  const isolatedGoals = await req(baseUrl, '/api/goals', { cookie: otherCookie });
  assert.equal(isolatedBudgets.json.budgets.length, 0);
  assert.equal(isolatedWallets.json.wallets.some((item) => item.name === 'Rekening Utama'), false);
  assert.equal(isolatedGoals.json.goals.length, 0);
});

test('Investment analysis tracks types, six-month totals, returns, and account isolation', async (t) => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const register = async (name, email) => {
    const response = await req(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { name, email, password: 'secure-password' },
    });
    assert.equal(response.status, 201);
    return response.setCookie.split(';')[0];
  };
  const cookie = await register('Investment Owner', 'investment-owner@example.com');
  const otherCookie = await register('Other Owner', 'investment-other@example.com');
  const record = (body) => req(baseUrl, '/api/transactions', { method: 'POST', cookie, body });

  const cryptoContribution = await record({
    type: 'expense',
    amount: 300000,
    category: 'Tabungan & Investasi',
    investment_type: 'crypto',
    tx_date: '2026-11-02',
  });
  assert.equal(cryptoContribution.status, 201);
  const jamsostekContribution = await record({
    type: 'expense',
    amount: 500000,
    category: 'Tabungan & Investasi',
    investment_type: 'jamsostek',
    tx_date: '2026-11-03',
  });
  assert.equal(jamsostekContribution.status, 201);
  const investmentReturn = await record({
    type: 'income',
    amount: 25000,
    category: 'Investasi & Dividen',
    investment_type: 'crypto',
    tx_date: '2026-11-04',
  });
  assert.equal(investmentReturn.status, 201);
  const salary = await record({
    type: 'income',
    amount: 2000000,
    category: 'Gaji & Upah',
    tx_date: '2026-11-01',
  });
  assert.equal(salary.status, 201);
  const jamsostekBalance = await record({
    type: 'income',
    amount: 1164800,
    category: 'Investasi & Dividen',
    investment_type: 'jamsostek',
    tx_date: '2026-11-05',
  });
  assert.equal(jamsostekBalance.status, 201);
  const previousMonthContribution = await record({
    type: 'expense',
    amount: 100000,
    category: 'Tabungan & Investasi',
    investment_type: 'mutual_fund',
    tx_date: '2026-10-15',
  });
  assert.equal(previousMonthContribution.status, 201);

  const report = await req(baseUrl, '/api/investments?month=2026-11&lang=en', { cookie });
  assert.equal(report.status, 200);
  assert.equal(report.json.summary.allTimeInvested, 900000);
  assert.equal(report.json.summary.allTimeReturns, 1189800);
  assert.equal(report.json.summary.monthlyInvested, 800000);
  assert.equal(report.json.summary.monthlyReturns, 1189800);
  assert.equal(report.json.monthlySeries.length, 6);
  assert.equal(report.json.monthlySeries[4].monthKey, '2026-10');
  assert.equal(report.json.monthlySeries[4].invested, 100000);
  assert.equal(report.json.monthlySeries[5].label, 'Nov 2026');
  assert.equal(report.json.monthlySeries[5].invested, 800000);
  assert.equal(report.json.breakdown.find((item) => item.type === 'crypto').returns, 25000);
  assert.equal(report.json.breakdown.find((item) => item.type === 'jamsostek').returns, 1164800);
  assert.equal(report.json.transactions.length, 5);

  const recap = await req(baseUrl, '/api/analytics/recap?month=2026-11', { cookie });
  assert.equal(recap.status, 200);
  assert.equal(recap.json.recap.summary.netBalance, 2389800);
  assert.equal(recap.json.recap.summary.liquidIncome, 2025000);
  assert.equal(recap.json.recap.summary.liquidBalance, 1225000);
  assert.equal(recap.json.recap.summary.remainingLiquidBalance, 2025000);
  assert.equal(recap.json.recap.allTime.netBalance, 2289800);
  assert.equal(recap.json.recap.allTime.liquidBalance, 1125000);
  assert.equal(recap.json.recap.allTime.remainingLiquidBalance, 2025000);

  const invalidInvestmentType = await record({
    type: 'expense',
    amount: 1000,
    category: 'Makan & Minum',
    investment_type: 'crypto',
    tx_date: '2026-11-05',
  });
  assert.equal(invalidInvestmentType.status, 400);
  const isolatedReport = await req(baseUrl, '/api/investments?month=2026-11', { cookie: otherCookie });
  assert.equal(isolatedReport.json.summary.allTimeInvested, 0);
  assert.equal(isolatedReport.json.transactions.length, 0);
});

test('Profile photo persists securely and password changes revoke other sessions', async (t) => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => {
    app.db.close();
    app.close();
  });

  const registration = await req(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Settings User', email: 'settings@example.com', password: 'secure-password' },
  });
  assert.equal(registration.status, 201);
  const firstSession = registration.setCookie.split(';')[0];

  const secondLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'settings@example.com', password: 'secure-password' },
  });
  assert.equal(secondLogin.status, 200);
  const secondSession = secondLogin.setCookie.split(';')[0];

  const photo = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
  const photoUpdate = await req(baseUrl, '/api/auth/profile', {
    method: 'PATCH',
    cookie: firstSession,
    body: { profile_photo: photo },
  });
  assert.equal(photoUpdate.status, 200);
  assert.equal(photoUpdate.json.user.profile_photo, photo);

  const invalidPhoto = await req(baseUrl, '/api/auth/profile', {
    method: 'PATCH',
    cookie: firstSession,
    body: { profile_photo: 'data:image/jpeg;base64,not-a-jpeg', lang: 'en' },
  });
  assert.equal(invalidPhoto.status, 400);
  assert.match(invalidPhoto.json.error, /profile photo/i);
  const profileAfterInvalidPhoto = await req(baseUrl, '/api/auth/me', { cookie: firstSession });
  assert.equal(profileAfterInvalidPhoto.json.user.profile_photo, photo);

  const profileEdit = await req(baseUrl, '/api/auth/profile', {
    method: 'PATCH',
    cookie: firstSession,
    body: { name: 'Updated Settings User' },
  });
  assert.equal(profileEdit.status, 200);
  assert.equal(profileEdit.json.user.profile_photo, photo);

  const incorrectPassword = await req(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    cookie: firstSession,
    body: { current_password: 'wrong-password', new_password: 'new-secure-password', lang: 'en' },
  });
  assert.equal(incorrectPassword.status, 400);
  assert.match(incorrectPassword.json.error, /current password/i);

  const passwordChange = await req(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    cookie: firstSession,
    body: { current_password: 'secure-password', new_password: 'new-secure-password', lang: 'en' },
  });
  assert.equal(passwordChange.status, 200);
  assert.equal((await req(baseUrl, '/api/auth/me', { cookie: firstSession })).status, 200);
  assert.equal((await req(baseUrl, '/api/auth/me', { cookie: secondSession })).status, 401);

  const oldPasswordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'settings@example.com', password: 'secure-password' },
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await req(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'settings@example.com', password: 'new-secure-password' },
  });
  assert.equal(newPasswordLogin.status, 200);
});
