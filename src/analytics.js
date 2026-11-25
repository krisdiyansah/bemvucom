'use strict';

const NEEDS_CATEGORIES = new Set([
  'Makan & Minum',
  'Transportasi',
  'Tagihan & Utilitas',
  'Bayar Hutang',
  'Kesehatan',
  'Pendidikan',
  'Belanja Rumah Tangga',
]);

const DEBT_CATEGORIES = new Set([
  'Bayar Hutang',
]);

const SAVINGS_CATEGORIES = new Set([
  'Tabungan & Investasi',
]);

const MONTH_NAMES_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const MONTH_SHORT_ID = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_SHORT_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function getValidMonthKey(raw) {
  if (typeof raw === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    return raw;
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function formatMonthLabel(monthKey, short = false, lang = 'id') {
  const [y, m] = monthKey.split('-').map(Number);
  const names = lang === 'en'
    ? (short ? MONTH_SHORT_EN : MONTH_NAMES_EN)
    : (short ? MONTH_SHORT_ID : MONTH_NAMES_ID);
  return `${names[m - 1]} ${y}`;
}

function getPreviousMonths(monthKey, count) {
  const [year, month] = monthKey.split('-').map(Number);
  const result = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(year, month - 1 - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    result.push(`${y}-${m}`);
  }
  return result;
}

function getDaysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month, 0).getDate();
}

async function buildRecap(db, userId, requestedMonth, lang = 'id') {
  const monthKey = getValidMonthKey(requestedMonth);
  const daysCount = getDaysInMonth(monthKey);

  // Selected month transactions
  const monthTxs = await db.prepare(`
    SELECT id, type, amount, category, investment_type, description, payment_method, tx_date, created_at
    FROM transactions
    WHERE user_id = ? AND substr(tx_date, 1, 7) = ?
    ORDER BY tx_date DESC, id DESC
  `).all(userId, monthKey);

  let totalIncome = 0;
  let liquidIncome = 0;
  let totalExpense = 0;
  let needsExpense = 0;
  let wantsExpense = 0;
  let savingsAllocated = 0;
  let debtPaidMonth = 0;

  const expenseByCategory = new Map();
  const incomeByCategory = new Map();
  const investmentByType = new Map();
  const dailyMap = new Map();

  for (let d = 1; d <= daysCount; d++) {
    const dayStr = `${monthKey}-${String(d).padStart(2, '0')}`;
    dailyMap.set(dayStr, { date: dayStr, day: d, income: 0, expense: 0, count: 0 });
  }

  for (const tx of monthTxs) {
    const dayEntry = dailyMap.get(tx.tx_date);
    if (dayEntry) {
      dayEntry.count += 1;
      if (tx.type === 'income') dayEntry.income += tx.amount;
      else dayEntry.expense += tx.amount;
    }

    if (tx.type === 'income') {
      totalIncome += tx.amount;
      if (tx.investment_type !== 'jamsostek') liquidIncome += tx.amount;
      incomeByCategory.set(tx.category, (incomeByCategory.get(tx.category) || 0) + tx.amount);
    } else {
      totalExpense += tx.amount;
      expenseByCategory.set(tx.category, (expenseByCategory.get(tx.category) || 0) + tx.amount);
      if (DEBT_CATEGORIES.has(tx.category)) {
        debtPaidMonth += tx.amount;
      }
      if (SAVINGS_CATEGORIES.has(tx.category)) {
        savingsAllocated += tx.amount;
        const type = tx.investment_type || 'savings';
        investmentByType.set(type, (investmentByType.get(type) || 0) + tx.amount);
      } else if (NEEDS_CATEGORIES.has(tx.category)) {
        needsExpense += tx.amount;
      } else {
        wantsExpense += tx.amount;
      }
    }
  }

  const netBalance = totalIncome - totalExpense;
  const liquidBalance = liquidIncome - totalExpense;
  const remainingLiquidBalance = liquidIncome - totalExpense + savingsAllocated;
  const effectiveSavings = netBalance + savingsAllocated;
  const savingsRate = totalIncome > 0 ? Math.round((effectiveSavings / totalIncome) * 1000) / 10 : 0;

  // Determine elapsed days for average burn calculation
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const elapsedDays = monthKey === currentMonthKey ? Math.max(1, now.getDate()) : daysCount;
  const dailyAvgExpense = Math.round(totalExpense / elapsedDays);

  // All-time totals + debt payments
  const allTimeRow = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS "allIncome",
      COALESCE(SUM(CASE WHEN type = 'income' AND (investment_type IS NULL OR investment_type <> 'jamsostek') THEN amount ELSE 0 END), 0) AS "allLiquidIncome",
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS "allExpense",
      COALESCE(SUM(CASE WHEN type = 'expense' AND category = 'Tabungan & Investasi' THEN amount ELSE 0 END), 0) AS "allSavingsAllocated",
      COALESCE(SUM(CASE WHEN type = 'expense' AND category = 'Bayar Hutang' THEN amount ELSE 0 END), 0) AS "debtPaidAllTime",
      COUNT(*) AS "allCount"
    FROM transactions
    WHERE user_id = ?
  `).get(userId);

  const debtItems = await db.prepare(`
    SELECT id, title, principal_amount, due_date, notes, kind, monthly_installment, created_at
    FROM debts
    WHERE user_id = ? AND kind = 'payable'
    ORDER BY id DESC
  `).all(userId);

  const totalDebtPrincipal = debtItems.reduce((acc, d) => acc + d.principal_amount, 0);
  const debtPaidAllTime = allTimeRow.debtPaidAllTime || 0;
  const remainingDebt = Math.max(0, totalDebtPrincipal - debtPaidAllTime);

  // Monthly trend (6 months ending at selected month)
  const trendMonths = getPreviousMonths(monthKey, 6);
  const firstMonth = trendMonths[0];
  const trendRows = await db.prepare(`
    SELECT
      substr(tx_date, 1, 7) AS month_key,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense,
      COUNT(*) AS tx_count
    FROM transactions
    WHERE user_id = ?
      AND substr(tx_date, 1, 7) >= ?
      AND substr(tx_date, 1, 7) <= ?
    GROUP BY substr(tx_date, 1, 7)
  `).all(userId, firstMonth, monthKey);

  const trendLookup = new Map(trendRows.map((r) => [r.month_key, r]));
  const monthlySeries = trendMonths.map((mk) => {
    const row = trendLookup.get(mk) || { income: 0, expense: 0, tx_count: 0 };
    const net = row.income - row.expense;
    const rate = row.income > 0 ? Math.round((net / row.income) * 1000) / 10 : 0;
    return {
      monthKey: mk,
      label: formatMonthLabel(mk, true, lang),
      fullLabel: formatMonthLabel(mk, false, lang),
      income: row.income,
      expense: row.expense,
      net,
      savingsRate: rate,
      txCount: row.tx_count,
    };
  });

  const sortMap = (map, total) =>
    Array.from(map.entries())
      .map(([category, amount]) => ({
        category,
        amount,
        share: total > 0 ? Math.round((amount / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

  return {
    monthKey,
    monthLabel: formatMonthLabel(monthKey, false, lang),
    daysCount,
    elapsedDays,
    summary: {
      totalIncome,
      liquidIncome,
      liquidBalance,
      remainingLiquidBalance,
      totalExpense,
      netBalance,
      effectiveSavings,
      savingsRate,
      dailyAvgExpense,
      txCount: monthTxs.length,
      needsExpense,
      wantsExpense,
      savingsAllocated,
      debtPaidMonth,
    },
    allTime: {
      totalIncome: allTimeRow.allIncome,
      liquidIncome: allTimeRow.allLiquidIncome,
      totalExpense: allTimeRow.allExpense,
      netBalance: allTimeRow.allIncome - allTimeRow.allExpense,
      liquidBalance: allTimeRow.allLiquidIncome - allTimeRow.allExpense,
      remainingLiquidBalance: allTimeRow.allLiquidIncome - allTimeRow.allExpense + allTimeRow.allSavingsAllocated,
      txCount: allTimeRow.allCount,
    },
    debt: {
      totalPrincipal: totalDebtPrincipal,
      paidMonth: debtPaidMonth,
      paidAllTime: debtPaidAllTime,
      remainingDebt,
      items: debtItems,
    },
    dailySeries: Array.from(dailyMap.values()),
    monthlySeries,
    expenseBreakdown: sortMap(expenseByCategory, totalExpense),
    incomeBreakdown: sortMap(incomeByCategory, totalIncome),
    investmentBreakdown: Array.from(investmentByType.entries())
      .map(([type, amount]) => ({ type, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

module.exports = {
  NEEDS_CATEGORIES,
  SAVINGS_CATEGORIES,
  getValidMonthKey,
  formatMonthLabel,
  getPreviousMonths,
  buildRecap,
};
