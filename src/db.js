'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('@neondatabase/serverless');

function getDefaultDbPath() {
  return process.env.BEMVU_DB_PATH || path.join(os.homedir(), '.bemvu', 'bemvu.db');
}

function createDatabase(dbPath) {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbPath && connectionString) {
    return createPostgresDatabase(connectionString);
  }
  if (!dbPath && process.env.VERCEL) {
    throw new Error('DATABASE_URL or POSTGRES_URL must be configured for Vercel deployments.');
  }

  return createSqliteDatabase(dbPath);
}

function migrateSqliteUsers(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const emailColumn = columns.find((column) => column.name === 'email');
  const hasPhoneColumn = columns.some((column) => column.name === 'phone');
  const hasInvestmentTargetColumn = columns.some((column) => column.name === 'monthly_investment_target');
  const hasNeedsTargetColumn = columns.some((column) => column.name === 'monthly_needs_target');
  const hasWantsTargetColumn = columns.some((column) => column.name === 'monthly_wants_target');
  const hasProfilePhotoColumn = columns.some((column) => column.name === 'profile_photo');

  if (emailColumn?.notnull) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          phone TEXT,
          password_hash TEXT NOT NULL,
          monthly_budget INTEGER NOT NULL DEFAULT 0,
          monthly_investment_target INTEGER NOT NULL DEFAULT 20,
          monthly_needs_target INTEGER NOT NULL DEFAULT 50,
          monthly_wants_target INTEGER NOT NULL DEFAULT 30,
          profile_photo TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        INSERT INTO users_new (
          id, name, email, phone, password_hash, monthly_budget, monthly_investment_target,
          monthly_needs_target, monthly_wants_target, profile_photo, created_at
        )
        SELECT id, name, email, ${hasPhoneColumn ? 'phone' : 'NULL'}, password_hash, monthly_budget,
          ${hasInvestmentTargetColumn ? 'monthly_investment_target' : '20'},
          ${hasNeedsTargetColumn ? 'monthly_needs_target' : '50'},
          ${hasWantsTargetColumn ? 'monthly_wants_target' : '30'},
          ${hasProfilePhotoColumn ? 'profile_photo' : "''"}, created_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    if (!hasPhoneColumn) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    if (!hasInvestmentTargetColumn) {
      db.exec('ALTER TABLE users ADD COLUMN monthly_investment_target INTEGER NOT NULL DEFAULT 20');
    }
    if (!hasNeedsTargetColumn) {
      db.exec('ALTER TABLE users ADD COLUMN monthly_needs_target INTEGER NOT NULL DEFAULT 50');
    }
    if (!hasWantsTargetColumn) {
      db.exec('ALTER TABLE users ADD COLUMN monthly_wants_target INTEGER NOT NULL DEFAULT 30');
    }
    if (!hasProfilePhotoColumn) {
      db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT NOT NULL DEFAULT ''");
    }
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone)');
}

function migrateSqliteTransactions(db) {
  const columns = db.prepare('PRAGMA table_info(transactions)').all();
  if (!columns.some((column) => column.name === 'investment_type')) {
    db.exec("ALTER TABLE transactions ADD COLUMN investment_type TEXT NOT NULL DEFAULT ''");
  }
}

function migrateSqliteFinanceModules(db) {
  const debtColumns = db.prepare('PRAGMA table_info(debts)').all();
  if (!debtColumns.some((column) => column.name === 'kind')) {
    db.exec("ALTER TABLE debts ADD COLUMN kind TEXT NOT NULL DEFAULT 'payable'");
  }
  if (!debtColumns.some((column) => column.name === 'monthly_installment')) {
    db.exec('ALTER TABLE debts ADD COLUMN monthly_installment INTEGER NOT NULL DEFAULT 0');
  }
}

function createSqliteDatabase(dbPath) {
  const resolved = dbPath || getDefaultDbPath();
  if (resolved !== ':memory:') {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (!dbPath) {
      const legacyPath = path.join(__dirname, '..', 'data', 'bemvu.db');
      if (!fs.existsSync(resolved) && fs.existsSync(legacyPath)) {
        const legacyDb = new DatabaseSync(legacyPath);
        try {
          legacyDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } finally {
          legacyDb.close();
        }
        fs.copyFileSync(legacyPath, resolved);
      }
    }
  }

  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = OFF;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      monthly_budget INTEGER NOT NULL DEFAULT 0,
      monthly_investment_target INTEGER NOT NULL DEFAULT 20,
      profile_photo TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS email_otps (
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'password-reset')),
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      monthly_budget INTEGER NOT NULL DEFAULT 0,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT NOT NULL,
      PRIMARY KEY (email, purpose)
    );

    CREATE TABLE IF NOT EXISTS whatsapp_otps (
      phone TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
      name TEXT NOT NULL DEFAULT '',
      monthly_budget INTEGER NOT NULL DEFAULT 0,
      code_salt TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT NOT NULL,
      PRIMARY KEY (phone, purpose)
    );

    CREATE INDEX IF NOT EXISTS idx_email_otps_expiry ON email_otps(expires_at);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_otps_expiry ON whatsapp_otps(expires_at);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      investment_type TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'Tunai / QRIS',
      tx_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, tx_date DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_user_type ON transactions(user_id, type);

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_logs_user_time ON activity_logs(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      month_key TEXT NOT NULL,
      health_score INTEGER NOT NULL,
      grade TEXT NOT NULL,
      summary TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ai_user_month ON ai_reports(user_id, month_key, id DESC);

    CREATE TABLE IF NOT EXISTS debts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      principal_amount INTEGER NOT NULL CHECK (principal_amount > 0),
      due_date TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS debt_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      debt_id INTEGER NOT NULL,
      transaction_id INTEGER UNIQUE,
      amount INTEGER NOT NULL CHECK (amount > 0),
      payment_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE,
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_debt_payments_user_debt ON debt_payments(user_id, debt_id, payment_date DESC);

    CREATE TABLE IF NOT EXISTS category_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      monthly_limit INTEGER NOT NULL CHECK (monthly_limit > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (user_id, category),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_category_budgets_user ON category_budgets(user_id, category);

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      wallet_type TEXT NOT NULL DEFAULT 'other',
      opening_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id, id);

    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      from_wallet_id INTEGER NOT NULL,
      to_wallet_id INTEGER NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      transfer_date TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (from_wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (to_wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user_date ON wallet_transfers(user_id, transfer_date DESC, id DESC);

    CREATE TABLE IF NOT EXISTS financial_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      target_amount INTEGER NOT NULL CHECK (target_amount > 0),
      saved_amount INTEGER NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
      due_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_goals_user ON financial_goals(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      investment_type TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'Tunai / QRIS',
      frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
      next_due_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_user_due ON recurring_transactions(user_id, is_active, next_due_date);
  `);
  migrateSqliteUsers(db);
  migrateSqliteTransactions(db);
  migrateSqliteFinanceModules(db);
  db.exec('PRAGMA foreign_keys = ON;');

  const transactionContext = new AsyncLocalStorage();
  let queue = Promise.resolve();
  const serialize = (operation) => {
    if (transactionContext.getStore()) return operation();
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  return {
    ready: Promise.resolve(),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...params) => serialize(() => statement.get(...params)),
        all: (...params) => serialize(() => statement.all(...params)),
        run: (...params) => serialize(() => statement.run(...params)),
      };
    },
    exec: (sql) => serialize(() => db.exec(sql)),
    transaction: (operation) =>
      serialize(() => transactionContext.run(true, async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      })),
    close: () => db.close(),
  };
}

const POSTGRES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    monthly_budget BIGINT NOT NULL DEFAULT 0,
    monthly_investment_target INTEGER NOT NULL DEFAULT 20,
    monthly_needs_target INTEGER NOT NULL DEFAULT 50,
    monthly_wants_target INTEGER NOT NULL DEFAULT 30,
    profile_photo TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS email_otps (
    email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'password-reset')),
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    monthly_budget BIGINT NOT NULL DEFAULT 0,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (email, purpose)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_email_otps_expiry ON email_otps(expires_at)',
  `CREATE TABLE IF NOT EXISTS whatsapp_otps (
    phone TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
    name TEXT NOT NULL DEFAULT '',
    monthly_budget BIGINT NOT NULL DEFAULT 0,
    code_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (phone, purpose)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_whatsapp_otps_expiry ON whatsapp_otps(expires_at)',
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    investment_type TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT 'Tunai / QRIS',
    tx_date TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, tx_date DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_tx_user_type ON transactions(user_id, type)',
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_logs_user_time ON activity_logs(user_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS ai_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month_key TEXT NOT NULL,
    health_score INTEGER NOT NULL,
    grade TEXT NOT NULL,
    summary TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_ai_user_month ON ai_reports(user_id, month_key, id DESC)',
  `CREATE TABLE IF NOT EXISTS debts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    principal_amount BIGINT NOT NULL CHECK (principal_amount > 0),
    due_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'payable' CHECK (kind IN ('payable', 'receivable')),
    monthly_installment BIGINT NOT NULL DEFAULT 0 CHECK (monthly_installment >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS debt_payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    payment_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_debt_payments_user_debt ON debt_payments(user_id, debt_id, payment_date DESC)',
  `CREATE TABLE IF NOT EXISTS category_budgets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    monthly_limit BIGINT NOT NULL CHECK (monthly_limit > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, category)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_category_budgets_user ON category_budgets(user_id, category)',
  `CREATE TABLE IF NOT EXISTS wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    wallet_type TEXT NOT NULL DEFAULT 'other',
    opening_balance BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, name)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id, id)',
  `CREATE TABLE IF NOT EXISTS wallet_transfers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    to_wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    amount BIGINT NOT NULL CHECK (amount > 0),
    transfer_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user_date ON wallet_transfers(user_id, transfer_date DESC, id DESC)',
  `CREATE TABLE IF NOT EXISTS financial_goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_amount BIGINT NOT NULL CHECK (target_amount > 0),
    saved_amount BIGINT NOT NULL DEFAULT 0 CHECK (saved_amount >= 0),
    due_date TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_goals_user ON financial_goals(user_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS recurring_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    investment_type TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT 'Tunai / QRIS',
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
    next_due_date TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_recurring_user_due ON recurring_transactions(user_id, is_active, next_due_date)',
];

const POSTGRES_MIGRATIONS = [
  'ALTER TABLE users ALTER COLUMN email DROP NOT NULL',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_investment_target INTEGER NOT NULL DEFAULT 20',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_needs_target INTEGER NOT NULL DEFAULT 50',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_wants_target INTEGER NOT NULL DEFAULT 30',
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS investment_type TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE debts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'payable'",
  'ALTER TABLE debts ADD COLUMN IF NOT EXISTS monthly_installment BIGINT NOT NULL DEFAULT 0',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone)',
];

function toPostgresPlaceholders(sql) {
  let index = 0;
  let quote = '';
  let result = '';

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote) {
        if (sql[i + 1] === quote) {
          result += sql[i + 1];
          i += 1;
        } else {
          quote = '';
        }
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      result += char;
    } else if (char === '?') {
      index += 1;
      result += `$${index}`;
    } else {
      result += char;
    }
  }

  return result;
}

function normalizePostgresResult(result) {
  const integerTypeOids = new Set([20, 1700]);
  for (const row of result.rows) {
    for (const field of result.fields || []) {
      if (integerTypeOids.has(field.dataTypeID) && row[field.name] !== null) {
        const value = Number(row[field.name]);
        if (Number.isSafeInteger(value)) row[field.name] = value;
      }
    }
  }
  return result;
}

function createPostgresDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 1 });
  const transactionContext = new AsyncLocalStorage();
  const rawQuery = async (sql, params = []) => {
    const client = transactionContext.getStore() || pool;
    return normalizePostgresResult(
      await client.query(toPostgresPlaceholders(sql), params)
    );
  };
  let ready;
  const initialize = () => {
    if (!ready) {
      ready = (async () => {
        for (const statement of POSTGRES_SCHEMA) {
          await rawQuery(statement);
        }
        for (const statement of POSTGRES_MIGRATIONS) {
          await rawQuery(statement);
        }
      })();
    }
    return ready;
  };
  const query = async (sql, params = []) => {
    await initialize();
    return rawQuery(sql, params);
  };

  return {
    get ready() {
      return initialize();
    },
    prepare(sql) {
      return {
        get: async (...params) => (await query(sql, params)).rows[0],
        all: async (...params) => (await query(sql, params)).rows,
        run: async (...params) => {
          const result = await query(sql, params);
          return {
            changes: result.rowCount || 0,
            lastInsertRowid: result.rows[0]?.id,
          };
        },
      };
    },
    exec: (sql) => query(sql),
    transaction: async (operation) => {
      await initialize();
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query('BEGIN');
        transactionStarted = true;
        const result = await transactionContext.run(client, operation);
        await client.query('COMMIT');
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(keyHex, 'hex');
  if (derived.length !== stored.length) return false;
  return crypto.timingSafeEqual(derived, stored);
}

async function logActivity(db, userId, action, detail) {
  await db.prepare(
    'INSERT INTO activity_logs (user_id, action, detail) VALUES (?, ?, ?)'
  ).run(userId, action, detail);
}

module.exports = {
  createDatabase,
  hashPassword,
  verifyPassword,
  logActivity,
};
