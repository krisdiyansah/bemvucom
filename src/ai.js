'use strict';

function formatIDR(amount) {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(Math.round(amount || 0));
  return `${sign}Rp ${abs.toLocaleString('id-ID')}`;
}

function formatCurrency(amount, lang = 'id', usdRate = 0) {
  const value = Number(amount) || 0;
  if (lang === 'en' && Number.isFinite(usdRate) && usdRate > 0) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value * usdRate);
  }
  return formatIDR(value);
}

function pct(part, total) {
  if (!total || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

const CATEGORY_EN = {
  'Makan & Minum': 'Food & Drinks',
  'Transportasi': 'Transportation',
  'Tagihan & Utilitas': 'Bills & Utilities',
  'Bayar Hutang': 'Debt Payment',
  'Belanja Rumah Tangga': 'Groceries & Household',
  'Kesehatan': 'Healthcare',
  'Pendidikan': 'Education',
  'Hiburan & Nongkrong': 'Entertainment & Dining',
  'Belanja Pribadi': 'Personal Shopping',
  'Langganan Digital': 'Digital Subscriptions',
  'Perjalanan & Liburan': 'Travel & Vacation',
  'Tabungan & Investasi': 'Savings & Investment',
  'Lainnya (Keluar)': 'Other (Expense)',
  'Gaji & Upah': 'Salary & Wages',
  'Bisnis & Freelance': 'Business & Freelance',
  'Investasi & Dividen': 'Investments & Dividends',
  'Bonus & Hadiah': 'Bonus & Gifts',
  'Pinjaman / Hutang': 'Loans / Borrowed Funds',
  'Lainnya (Masuk)': 'Other (Income)',
};

function catLabel(cat, lang) {
  if (lang === 'en') return CATEGORY_EN[cat] || cat;
  return cat;
}

function generateAiAnalysis(recap, user, lang = 'id', usdRate = 0) {
  const formatIDR = (amount) => formatCurrency(amount, lang, usdRate);
  const isEn = lang === 'en';
  const { summary, monthlySeries, dailySeries, expenseBreakdown, monthLabel, daysCount, elapsedDays } = recap;
  const { totalIncome, totalExpense, netBalance, effectiveSavings, savingsRate, dailyAvgExpense, needsExpense, wantsExpense } = summary;
  const budget = Number(user?.monthly_budget || 0);

  if (summary.txCount === 0 && monthlySeries.every((m) => m.txCount === 0)) {
    return {
      monthKey: recap.monthKey,
      monthLabel,
      healthScore: 0,
      grade: isEn ? 'No Data Yet' : 'Belum Ada Data',
      headline: isEn
        ? `No transactions recorded in ${monthLabel} yet.`
        : `Belum ada catatan transaksi di bulan ${monthLabel}.`,
      chartAnalysis: isEn
        ? 'Your monthly chart is still empty. Start logging daily income and expenses or click "Load Sample Data" so Bemvu AI can analyze your cashflow trend.'
        : 'Grafik bulanan masih kosong. Mulai catat pemasukan dan pengeluaran harian Anda atau gunakan tombol "Muat Data Contoh" agar Bemvu AI dapat menganalisis tren arus kas Anda.',
      allocation: { hasIncome: false, needsPct: 0, wantsPct: 0, savingsPct: 0 },
      metrics: {
        projectedExpense: 0,
        safeDailyCap: budget > 0 ? Math.round(budget / daysCount) : 0,
        expenseDeltaPct: null,
        incomeDeltaPct: null,
        peakExpenseDay: null,
      },
      insights: [
        {
          priority: 'info',
          title: isEn ? 'Build a Daily Logging Habit' : 'Mulai Bangun Kebiasaan Catat Harian',
          message: isEn
            ? 'Record every transaction—even small ones like coffee or parking—for 7 consecutive days to uncover hidden spending leaks.'
            : 'Catat setiap transaksi sekecil apa pun (kopi, parkir, belanja harian) selama 7 hari berturut-turut untuk membuka pola kebocoran anggaran.',
        },
      ],
      wiseSteps: isEn
        ? [
            'Set a monthly spending limit in Account Logs & Settings.',
            'Set aside at least 20% of income right after payday.',
            'Categorize transactions accurately so monthly charts stay reliable.',
          ]
        : [
            'Tentukan target pengeluaran bulanan di menu Log & Pengaturan.',
            'Sisihkan minimal 20% dari pemasukan begitu gaji/pendapatan masuk.',
            'Kelompokkan transaksi sesuai kategori agar grafik bulanan akurat.',
          ],
    };
  }

  // 1. Analyze 6-month chart series
  const activeMonths = monthlySeries.filter((m) => m.txCount > 0);
  const currentIdx = monthlySeries.length - 1;
  const prevMonth = currentIdx > 0 ? monthlySeries[currentIdx - 1] : null;

  let expenseDeltaPct = null;
  let incomeDeltaPct = null;
  if (prevMonth && prevMonth.expense > 0) {
    expenseDeltaPct = Math.round(((totalExpense - prevMonth.expense) / prevMonth.expense) * 1000) / 10;
  }
  if (prevMonth && prevMonth.income > 0) {
    incomeDeltaPct = Math.round(((totalIncome - prevMonth.income) / prevMonth.income) * 1000) / 10;
  }

  const avgPastExpense = activeMonths.length > 1
    ? Math.round(
        activeMonths.slice(0, -1).reduce((acc, m) => acc + m.expense, 0) / (activeMonths.length - 1)
      )
    : 0;

  const bestSavingsMonth = activeMonths.reduce(
    (best, m) => (!best || m.net > best.net ? m : best),
    null
  );
  const highestExpenseMonth = activeMonths.reduce(
    (peak, m) => (!peak || m.expense > peak.expense ? m : peak),
    null
  );

  // 2. Daily pattern & projection
  const peakExpenseDay = dailySeries.reduce(
    (max, d) => (d.expense > (max?.expense || 0) ? d : max),
    null
  );

  const projectedExpense = Math.round(dailyAvgExpense * daysCount);
  const remainingDays = Math.max(1, daysCount - elapsedDays + 1);
  const safeDailyCap = budget > 0
    ? Math.max(0, Math.round((budget - totalExpense) / remainingDays))
    : totalIncome > 0
      ? Math.max(0, Math.round((totalIncome * 0.8 - totalExpense) / remainingDays))
      : 0;

  let weekendSum = 0;
  let weekendDays = 0;
  let weekdaySum = 0;
  let weekdayDays = 0;
  for (const d of dailySeries) {
    if (d.expense <= 0) continue;
    const dow = new Date(`${d.date}T12:00:00`).getDay();
    if (dow === 0 || dow === 6) {
      weekendSum += d.expense;
      weekendDays += 1;
    } else {
      weekdaySum += d.expense;
      weekdayDays += 1;
    }
  }
  const avgWeekend = weekendDays > 0 ? weekendSum / weekendDays : 0;
  const avgWeekday = weekdayDays > 0 ? weekdaySum / weekdayDays : 0;

  // 3. 50 / 30 / 20 Allocation
  const needsPct = pct(needsExpense, totalIncome);
  const wantsPct = pct(wantsExpense, totalIncome);
  const savingsPct = totalIncome > 0 ? Math.max(0, Math.round((effectiveSavings / totalIncome) * 1000) / 10) : 0;

  // 4. Financial Health Score (0-100)
  let score = 50;
  if (totalIncome > 0) {
    if (savingsRate >= 30) score += 28;
    else if (savingsRate >= 20) score += 22;
    else if (savingsRate >= 10) score += 12;
    else if (savingsRate >= 0) score += 2;
    else score -= 22;

    if (wantsPct <= 30) score += 10;
    else if (wantsPct <= 40) score += 3;
    else score -= 10;

    if (needsPct <= 55) score += 7;
    else if (needsPct > 70) score -= 7;
  } else if (totalExpense > 0) {
    score = 32;
  }

  if (budget > 0) {
    const budgetRatio = totalExpense / budget;
    if (budgetRatio <= 0.85) score += 8;
    else if (budgetRatio <= 1.0) score += 3;
    else score -= 14;
  }

  if (expenseDeltaPct !== null) {
    if (expenseDeltaPct <= -5) score += 5;
    else if (expenseDeltaPct >= 25) score -= 8;
  }

  score = Math.max(5, Math.min(100, Math.round(score)));

  let grade = isEn ? 'Needs Attention' : 'Perlu Perhatian';
  if (score >= 82) grade = isEn ? 'Very Healthy' : 'Sangat Sehat';
  else if (score >= 65) grade = isEn ? 'Healthy' : 'Sehat';
  else if (score >= 45) grade = isEn ? 'Needs Attention' : 'Perlu Perhatian';
  else grade = isEn ? 'Critical' : 'Kritis';

  // 5. Chart Narrative
  const chartParts = [];
  if (prevMonth && prevMonth.txCount > 0) {
    if (expenseDeltaPct !== null) {
      if (expenseDeltaPct > 10) {
        chartParts.push(
          isEn
            ? `On the monthly chart, ${monthLabel} expenses (${formatIDR(totalExpense)}) rose ${expenseDeltaPct}% compared to ${prevMonth.fullLabel} (${formatIDR(prevMonth.expense)}).`
            : `Pada grafik bulanan, pengeluaran ${monthLabel} (${formatIDR(totalExpense)}) naik ${expenseDeltaPct}% dibanding ${prevMonth.fullLabel} (${formatIDR(prevMonth.expense)}).`
        );
      } else if (expenseDeltaPct < -5) {
        chartParts.push(
          isEn
            ? `The chart shows a positive trend: ${monthLabel} spending dropped ${Math.abs(expenseDeltaPct)}% vs ${prevMonth.fullLabel} (saving ${formatIDR(prevMonth.expense - totalExpense)}).`
            : `Grafik menunjukkan tren positif: pengeluaran ${monthLabel} turun ${Math.abs(expenseDeltaPct)}% dibanding ${prevMonth.fullLabel} (hemat ${formatIDR(prevMonth.expense - totalExpense)}).`
        );
      } else {
        chartParts.push(
          isEn
            ? `${monthLabel} spending stayed relatively stable (${expenseDeltaPct >= 0 ? '+' : ''}${expenseDeltaPct}%) compared to the previous month.`
            : `Pengeluaran ${monthLabel} relatif stabil (${expenseDeltaPct >= 0 ? '+' : ''}${expenseDeltaPct}%) dibanding bulan sebelumnya.`
        );
      }
    }
  } else if (avgPastExpense > 0) {
    const vsAvg = Math.round(((totalExpense - avgPastExpense) / avgPastExpense) * 100);
    chartParts.push(
      isEn
        ? `This month's spending is ${vsAvg >= 0 ? `${vsAvg}% above` : `${Math.abs(vsAvg)}% below`} your historical average (${formatIDR(avgPastExpense)}).`
        : `Pengeluaran bulan ini berada ${vsAvg >= 0 ? `${vsAvg}% di atas` : `${Math.abs(vsAvg)}% di bawah`} rata-rata historis Anda (${formatIDR(avgPastExpense)}).`
    );
  } else {
    chartParts.push(
      isEn
        ? `The ${monthLabel} chart records ${formatIDR(totalIncome)} in income and ${formatIDR(totalExpense)} in expenses.`
        : `Grafik ${monthLabel} mencatat pemasukan ${formatIDR(totalIncome)} dan pengeluaran ${formatIDR(totalExpense)}.`
    );
  }

  if (bestSavingsMonth && activeMonths.length >= 2) {
    chartParts.push(
      isEn
        ? `Your best surplus in the last 6 months was in ${bestSavingsMonth.fullLabel} at ${formatIDR(bestSavingsMonth.net)}.`
        : `Surplus terbaik dalam 6 bulan terakhir terjadi pada ${bestSavingsMonth.fullLabel} sebesar ${formatIDR(bestSavingsMonth.net)}.`
    );
  }
  if (highestExpenseMonth && highestExpenseMonth.monthKey !== recap.monthKey && activeMonths.length >= 2) {
    chartParts.push(
      isEn
        ? `Historical peak spending occurred in ${highestExpenseMonth.fullLabel} (${formatIDR(highestExpenseMonth.expense)}).`
        : `Puncak pengeluaran historis tercatat di ${highestExpenseMonth.fullLabel} (${formatIDR(highestExpenseMonth.expense)}).`
    );
  }
  if (peakExpenseDay && peakExpenseDay.expense > 0) {
    chartParts.push(
      isEn
        ? `On this month's daily chart, the biggest spending spike occurred on day ${peakExpenseDay.day} at ${formatIDR(peakExpenseDay.expense)}.`
        : `Di grafik harian bulan ini, lonjakan belanja terbesar terjadi pada tanggal ${peakExpenseDay.day} sebesar ${formatIDR(peakExpenseDay.expense)}.`
    );
  }

  // 6. Headline & Insights
  let headline = '';
  if (totalIncome === 0 && totalExpense > 0) {
    headline = isEn
      ? `Expenses total ${formatIDR(totalExpense)}, with no income recorded yet in ${monthLabel}.`
      : `Pengeluaran tercatat ${formatIDR(totalExpense)}, namun belum ada pemasukan yang dicatat di ${monthLabel}.`;
  } else if (netBalance < 0) {
    headline = isEn
      ? `Deficit of ${formatIDR(Math.abs(netBalance))} in ${monthLabel} — expenses exceeded income by ${Math.abs(savingsRate)}%.`
      : `Defisit ${formatIDR(Math.abs(netBalance))} di ${monthLabel} — pengeluaran melampaui pemasukan sebesar ${Math.abs(savingsRate)}%.`;
  } else if (savingsRate >= 20) {
    headline = isEn
      ? `Cashflow surplus of ${formatIDR(netBalance)} with a healthy ${savingsRate}% savings rate in ${monthLabel}.`
      : `Arus kas surplus ${formatIDR(netBalance)} dengan rasio tabungan sehat ${savingsRate}% di ${monthLabel}.`;
  } else {
    headline = isEn
      ? `Cashflow surplus of ${formatIDR(netBalance)}, though your savings rate (${savingsRate}%) is below the ideal 20% target.`
      : `Arus kas surplus ${formatIDR(netBalance)}, namun rasio tabungan (${savingsRate}%) masih di bawah target ideal 20%.`;
  }

  const insights = [];
  const topCat = expenseBreakdown[0];
  if (topCat && totalExpense > 0) {
    const topName = catLabel(topCat.category, lang);
    insights.push({
      priority: topCat.share >= 40 ? 'warning' : 'info',
      title: isEn
        ? `Largest Spending Category: ${topName} (${topCat.share}%)`
        : `Pos Pengeluaran Terbesar: ${topName} (${topCat.share}%)`,
      message: isEn
        ? `${topName} absorbed ${formatIDR(topCat.amount)} or ${topCat.share}% of this month's expenses. Review whether this aligns with your priorities.`
        : `Kategori ${topName} menyerap ${formatIDR(topCat.amount)} atau ${topCat.share}% dari total pengeluaran bulan ini. Evaluasi apakah nominal ini masih sesuai prioritas Anda.`,
    });
  }

  if (totalIncome > 0) {
    if (wantsPct > 30) {
      const excessWants = Math.round(wantsExpense - totalIncome * 0.3);
      insights.push({
        priority: 'warning',
        title: isEn
          ? `High Lifestyle Share (${wantsPct}% vs 30% limit)`
          : `Porsi Gaya Hidup Tinggi (${wantsPct}% vs batas 30%)`,
        message: isEn
          ? `Wants spending reached ${formatIDR(wantsExpense)}. Trimming about ${formatIDR(excessWants)} restores your 50/30/20 balance.`
          : `Belanja kategori keinginan mencapai ${formatIDR(wantsExpense)}. Mengurangi sekitar ${formatIDR(excessWants)} akan mengembalikan anggaran Anda ke rasio bijak 50/30/20.`,
      });
    } else if (savingsRate >= 20) {
      insights.push({
        priority: 'positive',
        title: isEn
          ? `Strong Savings Discipline (${savingsRate}%)`
          : `Disiplin Menabung Terjaga (${savingsRate}%)`,
        message: isEn
          ? `You retained ${formatIDR(effectiveSavings)} from income. Consider allocating into a 3–6 month emergency fund or low-risk money market funds.`
          : `Anda berhasil menyisihkan ${formatIDR(effectiveSavings)} dari pemasukan. Pertimbangkan mengalokasikan ke instrumen dana darurat (minimal 3–6x pengeluaran bulanan) atau reksa dana pasar uang.`,
      });
    } else {
      const neededFor20 = Math.max(0, Math.round(totalIncome * 0.2 - effectiveSavings));
      insights.push({
        priority: 'warning',
        title: isEn
          ? 'Savings Below the 20% Target'
          : 'Tabungan Belum Mencapai Target 20%',
        message: isEn
          ? `Current savings rate is ${savingsRate}%. Trim non-essential spending by ${formatIDR(neededFor20)} to hit ${formatIDR(totalIncome * 0.2)} in savings.`
          : `Saat ini rasio tabungan Anda ${savingsRate}%. Kurangi pengeluaran tidak mendesak sebesar ${formatIDR(neededFor20)} agar tabungan bulan ini mencapai ${formatIDR(totalIncome * 0.2)}.`,
      });
    }
  }

  if (budget > 0) {
    const usedPct = pct(totalExpense, budget);
    if (totalExpense > budget) {
      insights.push({
        priority: 'danger',
        title: isEn ? `Over Monthly Budget (${usedPct}%)` : `Melewati Target Anggaran (${usedPct}%)`,
        message: isEn
          ? `Expenses exceeded your ${formatIDR(budget)} budget by ${formatIDR(totalExpense - budget)}. Pause non-essential purchases until month-end.`
          : `Pengeluaran sudah melampaui batas bulanan ${formatIDR(budget)} sebesar ${formatIDR(totalExpense - budget)}. Terapkan mode hemat ketat pada pos keinginan hingga akhir bulan.`,
      });
    } else if (projectedExpense > budget) {
      insights.push({
        priority: 'warning',
        title: isEn ? 'Month-End Projection Alert' : 'Waspada Proyeksi Akhir Bulan',
        message: isEn
          ? `At ${formatIDR(dailyAvgExpense)}/day, total spending may reach ${formatIDR(projectedExpense)} (above ${formatIDR(budget)}). Keep daily spending under ${formatIDR(safeDailyCap)}/day.`
          : `Dengan rata-rata belanja ${formatIDR(dailyAvgExpense)}/hari, total pengeluaran berpotensi menembus ${formatIDR(projectedExpense)} (di atas target ${formatIDR(budget)}). Batasi belanja maksimal ${formatIDR(safeDailyCap)}/hari.`,
      });
    } else {
      insights.push({
        priority: 'positive',
        title: isEn ? `Budget On Track (${usedPct}% Used)` : `Anggaran Terkendali (${usedPct}% dari Target)`,
        message: isEn
          ? `Remaining budget is ${formatIDR(budget - totalExpense)}. Safe daily cap for the rest of the month is ${formatIDR(safeDailyCap)}/day.`
          : `Sisa anggaran Anda ${formatIDR(budget - totalExpense)}. Batas belanja harian aman hingga akhir bulan adalah ${formatIDR(safeDailyCap)}/hari.`,
      });
    }
  }

  if (avgWeekend > 0 && avgWeekday > 0 && avgWeekend > avgWeekday * 1.45) {
    const ratio = (avgWeekend / avgWeekday).toFixed(1);
    insights.push({
      priority: 'info',
      title: isEn
        ? `Weekend Spending ${ratio}x Higher`
        : `Pola Pengeluaran Akhir Pekan ${ratio}x Lebih Tinggi`,
      message: isEn
        ? `Weekend average (${formatIDR(avgWeekend)}/day) is much higher than weekdays (${formatIDR(avgWeekday)}/day). Set a dedicated weekend cap.`
        : `Rata-rata belanja saat Sabtu–Minggu (${formatIDR(avgWeekend)}/hari) jauh lebih tinggi dibanding hari kerja (${formatIDR(avgWeekday)}/hari). Tetapkan budget khusus akhir pekan sebelum keluar rumah.`,
    });
  }

  const debt = recap.debt || { totalPrincipal: 0, paidMonth: 0, paidAllTime: 0, remainingDebt: 0 };
  if (debt.remainingDebt > 0 || debt.paidMonth > 0) {
    const debtRatio = totalIncome > 0 ? pct(debt.paidMonth, totalIncome) : 0;
    const estMonths = debt.paidMonth > 0 && debt.remainingDebt > 0
      ? Math.ceil(debt.remainingDebt / debt.paidMonth)
      : null;
    if (debt.remainingDebt > 0) {
      insights.push({
        priority: debtRatio > 30 ? 'warning' : 'info',
        title: isEn
          ? `Remaining Debt Watch: ${formatIDR(debt.remainingDebt)}`
          : `Pantauan Sisa Hutang: ${formatIDR(debt.remainingDebt)}`,
        message: isEn
          ? `You paid ${formatIDR(debt.paidMonth)} toward debt this month${totalIncome > 0 ? ` (${debtRatio}% of income)` : ''}.${estMonths ? ` At this pace, remaining debt could be cleared in ~${estMonths} months.` : ' Log "Debt Payment" expenses regularly to accelerate payoff.'}`
          : `Bulan ini Anda membayar hutang sebesar ${formatIDR(debt.paidMonth)}${totalIncome > 0 ? ` (${debtRatio}% dari pemasukan)` : ''}.${estMonths ? ` Dengan ritme bayar saat ini, sisa hutang berpotensi lunas dalam sekitar ${estMonths} bulan.` : ' Catat transaksi kategori "Bayar Hutang" secara rutin untuk mempercepat pelunasan.'}`,
      });
    } else if (debt.totalPrincipal > 0 && debt.remainingDebt === 0) {
      insights.push({
        priority: 'positive',
        title: isEn ? 'All Recorded Debts Paid Off!' : 'Seluruh Hutang Tercatat Sudah Lunas!',
        message: isEn
          ? `Total debt of ${formatIDR(debt.totalPrincipal)} has been fully paid (${formatIDR(debt.paidAllTime)}). Redirect those installments into savings or investments.`
          : `Total hutang sebesar ${formatIDR(debt.totalPrincipal)} sudah terbayar penuh (${formatIDR(debt.paidAllTime)}). Alihkan dana cicilan sebelumnya ke tabungan atau investasi.`,
      });
    }
  }

  const wiseSteps = [];
  if (debt.remainingDebt > 0) {
    wiseSteps.push(
      isEn
        ? `Prioritize paying down ${formatIDR(debt.remainingDebt)} remaining debt while keeping monthly installments under 30% of income.`
        : `Prioritaskan pelunasan sisa hutang ${formatIDR(debt.remainingDebt)} dengan porsi cicilan aman maksimal 30% dari pemasukan.`
    );
  }
  if (safeDailyCap > 0) {
    wiseSteps.push(
      isEn
        ? `Keep daily spending under ${formatIDR(safeDailyCap)}/day for the rest of ${monthLabel}.`
        : `Jaga pengeluaran harian di bawah ${formatIDR(safeDailyCap)}/hari untuk sisa bulan ${monthLabel}.`
    );
  }
  if (topCat) {
    const save15 = Math.round(topCat.amount * 0.15);
    const topName = catLabel(topCat.category, lang);
    wiseSteps.push(
      isEn
        ? `Cut 15% from "${topName}" to save an extra ${formatIDR(save15)} next month.`
        : `Pangkas 15% dari pos "${topName}" untuk menghemat tambahan ${formatIDR(save15)} bulan depan.`
    );
  }
  if (totalIncome > 0) {
    const emergencyTarget = Math.max(totalExpense, 1000000) * 6;
    wiseSteps.push(
      isEn
        ? `Ideal emergency fund target (6x monthly spending): around ${formatIDR(emergencyTarget)}.`
        : `Target dana darurat ideal Anda (6x pengeluaran bulanan): sekitar ${formatIDR(emergencyTarget)}.`
    );
  }
  wiseSteps.push(
    isEn
      ? `Apply a 24-hour waiting rule before non-essential purchases above ${formatIDR(150000)}.`
      : 'Terapkan aturan tunggu 24 jam sebelum membeli barang non-pokok di atas Rp 150.000.'
  );

  return {
    monthKey: recap.monthKey,
    monthLabel,
    healthScore: score,
    grade,
    headline,
    chartAnalysis: chartParts.join(' '),
    allocation: {
      hasIncome: totalIncome > 0,
      needsPct,
      wantsPct,
      savingsPct,
    },
    metrics: {
      projectedExpense,
      safeDailyCap,
      expenseDeltaPct,
      incomeDeltaPct,
      peakExpenseDay: peakExpenseDay && peakExpenseDay.expense > 0 ? peakExpenseDay : null,
    },
    insights,
    wiseSteps,
  };
}

function answerFinancialQuestion(question, recap, analysis, user, lang = 'id', usdRate = 0) {
  const formatIDR = (amount) => formatCurrency(amount, lang, usdRate);
  const isEn = lang === 'en';
  const q = String(question || '').toLowerCase().trim();
  if (!q) {
    return isEn
      ? 'Please type a question about your cashflow, monthly chart, or spending plan.'
      : 'Silakan ketik pertanyaan seputar arus kas, grafik bulanan, atau rencana pengeluaran Anda.';
  }

  const { summary, expenseBreakdown, monthLabel, monthlySeries } = recap;
  const topCat = expenseBreakdown[0];

  const amountMatch = q.match(/(\d[\d.,]*)\s*(jt|juta|rb|ribu|k|m)?/);
  if (
    amountMatch &&
    (q.includes('beli') || q.includes('aman') || q.includes('cukup') || q.includes('mampu') || q.includes('cicil') || q.includes('bayar') ||
      q.includes('buy') || q.includes('afford') || q.includes('safe') || q.includes('spend') || q.includes('pay'))
  ) {
    let nominal = Number(amountMatch[1].replace(/[.,]/g, ''));
    const unit = amountMatch[2];
    if (unit === 'jt' || unit === 'juta' || unit === 'm') nominal *= 1_000_000;
    else if (unit === 'rb' || unit === 'ribu' || unit === 'k') nominal *= 1_000;
    if (isEn && usdRate > 0) nominal = Math.round(nominal / usdRate);

    if (nominal > 0) {
      const afterNet = summary.netBalance - nominal;
      const budget = Number(user?.monthly_budget || 0);
      const afterBudget = budget > 0 ? budget - (summary.totalExpense + nominal) : null;

      if (summary.netBalance <= 0) {
        return isEn
          ? `Not recommended right now. Your ${monthLabel} net balance is ${formatIDR(summary.netBalance)}. Adding ${formatIDR(nominal)} would deepen the deficit to ${formatIDR(afterNet)}.`
          : `Tidak disarankan saat ini. Saldo bersih bulan ${monthLabel} sedang ${formatIDR(summary.netBalance)}. Pengeluaran tambahan ${formatIDR(nominal)} akan memperdalam defisit menjadi ${formatIDR(afterNet)}. Sebaiknya tunda hingga arus kas kembali positif.`;
      }
      if (afterNet < 0) {
        return isEn
          ? `Risk of deficit. Your ${monthLabel} surplus is ${formatIDR(summary.netBalance)}, so spending ${formatIDR(nominal)} would leave you at -${formatIDR(Math.abs(afterNet))}.`
          : `Berisiko defisit. Surplus bulan ${monthLabel} saat ini ${formatIDR(summary.netBalance)}, sehingga transaksi ${formatIDR(nominal)} akan membuat bulan ini minus ${formatIDR(Math.abs(afterNet))}. Pertimbangkan menabung dulu atau membagi rencana ke bulan depan.`;
      }
      if (afterBudget !== null && afterBudget < 0) {
        return isEn
          ? `Your cash surplus covers it (remaining ${formatIDR(afterNet)}), but ${formatIDR(nominal)} would push spending ${formatIDR(Math.abs(afterBudget))} over your monthly budget target.`
          : `Saldo Anda memang cukup (sisa surplus ${formatIDR(afterNet)}), tetapi pembelian ${formatIDR(nominal)} akan membuat pengeluaran melewati target anggaran bulanan Anda sebesar ${formatIDR(Math.abs(afterBudget))}. Pastikan pembelian ini benar-benar prioritas.`;
      }
      return isEn
        ? `Relatively safe for ${monthLabel} cashflow. After ${formatIDR(nominal)}, you still retain a ${formatIDR(afterNet)} surplus. Make sure your 20% savings (${formatIDR(summary.totalIncome * 0.2)}) remain untouched.`
        : `Relatif aman secara arus kas bulan ${monthLabel}. Setelah dikurangi ${formatIDR(nominal)}, Anda masih memiliki surplus ${formatIDR(afterNet)}. Pastikan dana tabungan 20% (${formatIDR(summary.totalIncome * 0.2)}) tetap tidak terganggu.`;
    }
  }

  if (q.includes('grafik') || q.includes('tren') || q.includes('bulan') || q.includes('chart') || q.includes('trend') || q.includes('month')) {
    const active = monthlySeries.filter((m) => m.txCount > 0);
    const listStr = active
      .map((m) =>
        isEn
          ? `${m.label}: In ${formatIDR(m.income)} / Out ${formatIDR(m.expense)}`
          : `${m.label}: Masuk ${formatIDR(m.income)} / Keluar ${formatIDR(m.expense)}`
      )
      .join('; ');
    return `${analysis.chartAnalysis}${listStr ? `\n\n${isEn ? 'Active chart summary' : 'Ringkasan grafik aktif'}: ${listStr}.` : ''}`;
  }

  if (q.includes('boros') || q.includes('hemat') || q.includes('kurangi') || q.includes('kategori') || q.includes('besar') ||
      q.includes('most') || q.includes('save') || q.includes('cut') || q.includes('category') || q.includes('biggest')) {
    if (!topCat) {
      return isEn
        ? `No expenses recorded in ${monthLabel} to analyze yet.`
        : `Belum ada data pengeluaran di ${monthLabel} untuk dianalisis.`;
    }
    const secondCat = expenseBreakdown[1];
    const save15 = Math.round(topCat.amount * 0.15);
    const topName = catLabel(topCat.category, lang);
    const secondName = secondCat ? catLabel(secondCat.category, lang) : '';
    return isEn
      ? `Your biggest expense in ${monthLabel} is "${topName}" at ${formatIDR(topCat.amount)} (${topCat.share}% of expenses)${secondCat ? `, followed by "${secondName}" (${formatIDR(secondCat.amount)})` : ''}. Cutting "${topName}" by 15% saves ${formatIDR(save15)} per month.`
      : `Pos terbesar di ${monthLabel} adalah "${topName}" sebesar ${formatIDR(topCat.amount)} (${topCat.share}% dari total pengeluaran)${secondCat ? `, disusul "${secondName}" (${formatIDR(secondCat.amount)})` : ''}. Jika Anda menekan pos "${topName}" sebesar 15% saja, Anda langsung menghemat ${formatIDR(save15)} per bulan.`;
  }

  if (q.includes('hutang') || q.includes('utang') || q.includes('cicil') || q.includes('lunas') || q.includes('debt') || q.includes('loan')) {
    const d = recap.debt || { totalPrincipal: 0, paidMonth: 0, paidAllTime: 0, remainingDebt: 0 };
    if (d.totalPrincipal === 0 && d.paidAllTime === 0) {
      return isEn
        ? 'No debt recorded yet. Click "+ Add Debt" on the cumulative card to log principal debt, then record payments under the "Debt Payment" category.'
        : 'Belum ada data hutang yang dicatat. Klik "+ Catat Hutang" pada kartu Saldo Kumulatif untuk mencatat pokok hutang, lalu catat pembayaran lewat kategori "Bayar Hutang".';
    }
    const estMonths = d.paidMonth > 0 && d.remainingDebt > 0 ? Math.ceil(d.remainingDebt / d.paidMonth) : null;
    return isEn
      ? `Debt Status: Recorded principal ${formatIDR(d.totalPrincipal)}, paid ${formatIDR(d.paidAllTime)} (${formatIDR(d.paidMonth)} this month), remaining debt ${formatIDR(d.remainingDebt)}.${estMonths ? ` At ${formatIDR(d.paidMonth)}/month, estimated payoff is ~${estMonths} months.` : ''}`
      : `Status Hutang Anda: Total pokok tercatat ${formatIDR(d.totalPrincipal)}, sudah dibayar ${formatIDR(d.paidAllTime)} (bulan ini ${formatIDR(d.paidMonth)}), sehingga sisa hutang saat ini ${formatIDR(d.remainingDebt)}.${estMonths ? ` Dengan pembayaran ${formatIDR(d.paidMonth)}/bulan, estimasi lunas sekitar ${estMonths} bulan lagi.` : ''}`;
  }

  if (q.includes('tabung') || q.includes('invest') || q.includes('darurat') || q.includes('gaji') || q.includes('50') ||
      q.includes('allocat') || q.includes('salary') || q.includes('emergency')) {
    const baseIncome = summary.totalIncome > 0 ? summary.totalIncome : summary.totalExpense;
    return isEn
      ? `Based on ${monthLabel} income (${formatIDR(summary.totalIncome)}), the ideal 50/30/20 split is:\n• Needs (50%): ${formatIDR(baseIncome * 0.5)} (actual: ${formatIDR(summary.needsExpense)})\n• Wants (30%): ${formatIDR(baseIncome * 0.3)} (actual: ${formatIDR(summary.wantsExpense)})\n• Savings & Investment (20%): ${formatIDR(baseIncome * 0.2)} (actual: ${formatIDR(summary.effectiveSavings)}).`
      : `Berdasarkan pemasukan ${monthLabel} (${formatIDR(summary.totalIncome)}), pembagian ideal 50/30/20 adalah:\n• Kebutuhan Pokok (50%): ${formatIDR(baseIncome * 0.5)} (realisasi saat ini: ${formatIDR(summary.needsExpense)})\n• Keinginan/Gaya Hidup (30%): ${formatIDR(baseIncome * 0.3)} (realisasi: ${formatIDR(summary.wantsExpense)})\n• Tabungan & Investasi (20%): ${formatIDR(baseIncome * 0.2)} (realisasi: ${formatIDR(summary.effectiveSavings)}).`;
  }

  return isEn
    ? `${monthLabel} Summary: Income ${formatIDR(summary.totalIncome)}, Expenses ${formatIDR(summary.totalExpense)}, Net ${formatIDR(summary.netBalance)} (Health Score: ${analysis.healthScore}/100 - ${analysis.grade}). ${analysis.wiseSteps[0] || ''}`
    : `Ringkasan ${monthLabel}: Pemasukan ${formatIDR(summary.totalIncome)}, Pengeluaran ${formatIDR(summary.totalExpense)}, Surplus/Defisit ${formatIDR(summary.netBalance)} (Skor Kesehatan: ${analysis.healthScore}/100 - ${analysis.grade}). ${analysis.wiseSteps[0] || ''}`;
}

module.exports = {
  generateAiAnalysis,
  answerFinancialQuestion,
  formatIDR,
  formatCurrency,
};
