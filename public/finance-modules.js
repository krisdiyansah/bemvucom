'use strict';

window.BEMVU_FINANCE_MODULES = (() => {
  let budgets = [];
  let debts = [];
  let unlinkedPayments = [];
  let wallets = [];
  let transfers = [];
  let goals = [];
  let recurring = [];
  let debtSummary = {};
  let investmentData = { summary: {}, breakdown: [], monthlySeries: [], transactions: [] };

  const defaultMethods = ['QRIS', 'Tunai', 'Transfer Bank', 'E-Wallet', 'Kartu Debit', 'Auto-Debit'];
  const investmentTypeKeys = {
    crypto: 'investmentTypeCrypto',
    jamsostek: 'investmentTypeJamsostek',
    stocks: 'investmentTypeStocks',
    mutual_fund: 'investmentTypeMutualFund',
    deposit: 'investmentTypeDeposit',
    gold: 'investmentTypeGold',
    bonds: 'investmentTypeBonds',
    savings: 'investmentTypeSavings',
    emergency_fund: 'investmentTypeEmergencyFund',
    other: 'investmentTypeOther',
  };

  function walletMethodNames() {
    return wallets.map((wallet) => wallet.name);
  }

  function investmentTypeLabel(type) {
    return t(investmentTypeKeys[type] || 'investmentTypeOther');
  }

  function setCategoryOptions(select, type, selected = '') {
    if (!select) return;
    const categories = CATEGORIES[type] || [];
    select.innerHTML = categories
      .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(catLabel(category))}</option>`)
      .join('');
    if (categories.includes(selected)) select.value = selected;
  }

  function setWalletOptions(select, selected = '') {
    if (!select) return;
    select.innerHTML = wallets
      .map((wallet) => `<option value="${wallet.id}">${escapeHtml(wallet.name)}</option>`)
      .join('');
    if (wallets.some((wallet) => String(wallet.id) === String(selected))) select.value = String(selected);
  }

  function populateWalletControls() {
    if (typeof populatePaymentMethods === 'function') populatePaymentMethods();
    const methodSelect = document.getElementById('recurring-payment-method');
    if (methodSelect) {
      const current = methodSelect.value;
      const methods = [...new Set([...defaultMethods, ...walletMethodNames()])];
      methodSelect.innerHTML = methods
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(methodLabel(name))}</option>`)
        .join('');
      methodSelect.value = methods.includes(current) ? current : (methods.includes('Tunai') ? 'Tunai' : methods[0] || '');
    }
    const investmentMethod = document.getElementById('investment-entry-method');
    if (investmentMethod) {
      const current = investmentMethod.value;
      const methods = [...new Set([...defaultMethods, ...walletMethodNames()])];
      investmentMethod.innerHTML = methods
        .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(methodLabel(name))}</option>`)
        .join('');
      investmentMethod.value = methods.includes(current) ? current : (methods.includes('Tunai') ? 'Tunai' : methods[0] || '');
    }

    const from = document.getElementById('wallet-transfer-from');
    const to = document.getElementById('wallet-transfer-to');
    const previousFrom = from.value;
    const previousTo = to.value;
    setWalletOptions(from, previousFrom);
    setWalletOptions(to, previousTo);
    if (wallets.length > 1 && from.value === to.value) to.value = String(wallets[1].id);
    const submit = document.querySelector('#wallet-transfer-form button[type="submit"]');
    if (submit) submit.disabled = wallets.length < 2;
  }

  function renderBudgetModule() {
    const categorySelect = document.getElementById('budget-category');
    const selected = categorySelect.value;
    setCategoryOptions(categorySelect, 'expense', selected);
    const categoryBudget = budgets.find((item) => item.category === categorySelect.value);
    const budgetInput = document.getElementById('budget-monthly-limit');
    if (categoryBudget && !budgetInput.value) {
      budgetInput.value = fromIdr(categoryBudget.monthly_limit).toFixed(state.lang === 'en' ? 2 : 0);
    }
    const currentBudgets = budgets;
    const totalLimit = currentBudgets.reduce((sum, item) => sum + Number(item.monthly_limit), 0);
    const totalSpent = currentBudgets.reduce((sum, item) => sum + Number(item.spent), 0);
    const remaining = Math.max(0, totalLimit - totalSpent);
    document.getElementById('budget-summary').innerHTML = [
      [t('budgetTotalLimit'), formatIDR(totalLimit)],
      [t('budgetTotalSpent'), formatIDR(totalSpent)],
      [t('budgetTotalRemaining'), formatIDR(remaining)],
    ].map(([label, amount]) => `
      <article class="finance-summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(amount)}</strong>
      </article>
    `).join('');

    const alerts = currentBudgets.filter((item) => item.monthly_limit > 0 && item.spent / item.monthly_limit >= 0.8);
    document.getElementById('budget-alerts').innerHTML = alerts.map((item) => {
      const over = item.spent >= item.monthly_limit;
      return `<div class="finance-alert ${over ? 'is-danger' : 'is-warning'}">
        <strong>${escapeHtml(t(over ? 'budgetOverAlert' : 'budgetNearAlert', { category: catLabel(item.category) }))}</strong>
        <span>${escapeHtml(formatIDR(item.spent))} / ${escapeHtml(formatIDR(item.monthly_limit))}</span>
      </div>`;
    }).join('');

    const list = document.getElementById('budget-list');
    if (!currentBudgets.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t('budgetEmpty'))}</div>`;
      return;
    }
    list.innerHTML = currentBudgets.map((item) => {
      const percentage = Math.round((item.spent / item.monthly_limit) * 100);
      const over = percentage >= 100;
      const warning = percentage >= 80;
      return `<div class="finance-list-item">
        <div class="finance-item-top">
          <strong>${escapeHtml(catLabel(item.category))}</strong>
          <span class="finance-status ${over ? 'is-danger' : warning ? 'is-warning' : ''}">${percentage}%</span>
        </div>
        <div class="finance-item-meta">
          <span>${escapeHtml(t('budgetSpent'))}: ${escapeHtml(formatIDR(item.spent))}</span>
          <span>${escapeHtml(t('budgetLimit'))}: ${escapeHtml(formatIDR(item.monthly_limit))}</span>
        </div>
        <div class="finance-progress ${over ? 'is-danger' : warning ? 'is-warning' : ''}" role="progressbar" aria-valuenow="${Math.min(percentage, 100)}" aria-valuemin="0" aria-valuemax="100">
          <span style="width:${Math.min(percentage, 100)}%"></span>
        </div>
        <div class="finance-item-actions">
          <span>${escapeHtml(t('budgetRemaining'))}: ${escapeHtml(formatIDR(Math.max(0, item.monthly_limit - item.spent)))}</span>
          <button class="btn btn-outline btn-xs js-budget-delete" data-id="${item.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.js-budget-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm(t('budgetDeleteConfirm'))) return;
        try {
          await api(`/api/budgets/${button.dataset.id}`, { method: 'DELETE' });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderDebtModule() {
    const summary = debtSummary;
    const stats = [
      [t('debtTotalOwed'), formatIDR(summary.totalPrincipal || 0)],
      [t('debtTotalPaid'), formatIDR(summary.paidAllTime || 0)],
      [t('debtOutstanding'), formatIDR(summary.remainingDebt || 0)],
      [t('receivableOutstanding'), formatIDR(summary.remainingReceivable || 0)],
    ];
    document.getElementById('debt-view-summary').innerHTML = stats.map(([label, amount]) => `
      <article class="finance-summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(amount)}</strong>
      </article>
    `).join('');

    const list = document.getElementById('finance-debt-list');
    if (!debts.length && !unlinkedPayments.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t('debtViewEmpty'))}</div>`;
      return;
    }
    const debtCards = debts.map((debt) => {
      const paid = Number(debt.paid_amount) || 0;
      const remaining = Number(debt.remaining_amount) || 0;
      const percentage = debt.principal_amount ? Math.min(100, Math.round((paid / debt.principal_amount) * 100)) : 0;
      const payments = (debt.payments || []).map((payment) => `
        <div class="finance-history-row">
          <span>${escapeHtml(payment.payment_date)}</span>
          <strong>${escapeHtml(formatIDR(payment.amount))}</strong>
          ${payment.notes ? `<small>${escapeHtml(payment.notes)}</small>` : ''}
        </div>
      `).join('') || `<small>${escapeHtml(t('debtNoPayments'))}</small>`;
      return `<div class="finance-list-item">
        <div class="finance-item-top">
          <strong>${escapeHtml(debt.title)}</strong>
          <span class="finance-status ${debt.kind === 'receivable' ? 'is-positive' : 'is-warning'}">
            ${escapeHtml(t(debt.kind === 'receivable' ? 'debtReceivable' : 'debtPayable'))}
          </span>
        </div>
        <div class="finance-item-meta">
          <span>${escapeHtml(t('debtPrincipalLabel'))}: ${escapeHtml(formatIDR(debt.principal_amount))}</span>
          <span>${escapeHtml(t('debtOutstanding'))}: ${escapeHtml(formatIDR(remaining))}</span>
          ${debt.monthly_installment ? `<span>${escapeHtml(t('debtInstallmentLabel'))}: ${escapeHtml(formatIDR(debt.monthly_installment))}</span>` : ''}
          ${debt.due_date ? `<span>${escapeHtml(t('dueDateShort'))}: ${escapeHtml(debt.due_date)}</span>` : ''}
        </div>
        <div class="finance-progress ${debt.kind === 'receivable' ? 'is-positive' : ''}" role="progressbar" aria-valuenow="${percentage}" aria-valuemin="0" aria-valuemax="100">
          <span style="width:${percentage}%"></span>
        </div>
        <div class="finance-item-actions">
          <button class="btn btn-outline btn-xs js-debt-delete" data-id="${debt.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
        </div>
        ${remaining > 0 ? `<details class="finance-history finance-payment-details">
          <summary>${escapeHtml(t('debtRecordPaymentBtn'))}</summary>
          <form class="tx-form js-debt-payment-form" data-id="${debt.id}">
            <div class="field-row">
              <div class="field">
                <label>${escapeHtml(t('debtPaymentAmountLabel'))}</label>
                <input name="amount" type="number" min="${state.lang === 'en' ? '0.01' : '1'}" step="${state.lang === 'en' ? '0.01' : '1'}" required />
              </div>
              <div class="field">
                <label>${escapeHtml(t('debtPaymentDateLabel'))}</label>
                <input name="payment_date" type="date" value="${getTodayDate()}" required />
              </div>
            </div>
            <div class="field">
              <label>${escapeHtml(t('debtPaymentMethodLabel'))}</label>
              <select name="payment_method">${wallets.map((wallet) => `
                <option value="${escapeHtml(wallet.name)}">${escapeHtml(methodLabel(wallet.name))}</option>
              `).join('')}</select>
            </div>
            <button class="btn btn-primary btn-xs" type="submit">${escapeHtml(t('debtSavePaymentBtn'))}</button>
          </form>
        </details>` : ''}
        <details class="finance-history">
          <summary>${escapeHtml(t('debtHistory'))} (${(debt.payments || []).length})</summary>
          ${payments}
        </details>
      </div>`;
    }).join('');
    const oldPayments = unlinkedPayments.length
      ? `<div class="finance-list-item">
          <strong>${escapeHtml(t('debtUnlinkedHistory'))}</strong>
          ${unlinkedPayments.map((payment) => `
            <div class="finance-history-row">
              <span>${escapeHtml(payment.payment_date)}</span>
              <strong>${escapeHtml(formatIDR(payment.amount))}</strong>
              <small>${escapeHtml(payment.description || methodLabel(payment.payment_method))}</small>
            </div>
          `).join('')}
        </div>`
      : '';
    list.innerHTML = `${debtCards}${oldPayments}`;

    list.querySelectorAll('.js-debt-payment-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = toIdr(form.elements.amount.value);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          showToast(t('invalidAmount'), true);
          return;
        }
        try {
          await api(`/api/debts/${form.dataset.id}/payments`, {
            method: 'POST',
            body: {
              amount,
              payment_date: form.elements.payment_date.value,
              payment_method: form.elements.payment_method.value,
            },
          });
          showToast(t('debtPaymentSuccess'));
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
    list.querySelectorAll('.js-debt-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm(t('debtDeleteConfirm'))) return;
        try {
          await api(`/api/debts/${button.dataset.id}`, { method: 'DELETE' });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderWalletModule() {
    const total = wallets.reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0);
    document.getElementById('wallet-summary').innerHTML = `
      <article class="finance-summary-card">
        <span>${escapeHtml(t('walletTotalBalance'))}</span>
        <strong>${escapeHtml(formatIDR(total))}</strong>
      </article>
      <article class="finance-summary-card">
        <span>${escapeHtml(t('walletCount'))}</span>
        <strong>${wallets.length}</strong>
      </article>
    `;

    const typeLabels = { cash: 'walletCash', bank: 'walletBank', ewallet: 'walletEwallet', other: 'walletOther' };
    document.getElementById('wallet-list').innerHTML = wallets.map((wallet) => `
      <article class="finance-wallet-card">
        <div class="finance-item-top">
          <strong>${escapeHtml(wallet.name)}</strong>
          <span class="finance-status">${escapeHtml(t(typeLabels[wallet.wallet_type] || 'walletOther'))}</span>
        </div>
        <strong class="finance-wallet-balance">${escapeHtml(formatIDR(wallet.balance))}</strong>
        <form class="wallet-opening-form js-wallet-opening-form" data-id="${wallet.id}">
          <label>${escapeHtml(t('walletOpeningLabel'))}</label>
          <div class="finance-inline-control">
            <input name="opening_balance" type="number" min="0" step="${state.lang === 'en' ? '0.01' : '1'}" value="${fromIdr(wallet.opening_balance).toFixed(state.lang === 'en' ? 2 : 0)}" required />
            <button class="btn btn-outline btn-xs" type="submit">${escapeHtml(t('walletSaveOpening'))}</button>
          </div>
        </form>
      </article>
    `).join('') || `<div class="empty-state">${escapeHtml(t('walletEmpty'))}</div>`;

    document.getElementById('wallet-transfer-list').innerHTML = transfers.map((transfer) => `
      <div class="finance-list-item compact">
        <div class="finance-item-top">
          <strong>${escapeHtml(transfer.from_name)} &rarr; ${escapeHtml(transfer.to_name)}</strong>
          <strong>${escapeHtml(formatIDR(transfer.amount))}</strong>
        </div>
        <small>${escapeHtml(transfer.transfer_date)}${transfer.notes ? ` · ${escapeHtml(transfer.notes)}` : ''}</small>
      </div>
    `).join('') || `<div class="empty-state">${escapeHtml(t('walletTransferEmpty'))}</div>`;

    document.querySelectorAll('.js-wallet-opening-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = toIdr(form.elements['opening_balance'].value);
        if (!Number.isSafeInteger(amount) || amount < 0) {
          showToast(t('walletOpeningInvalid'), true);
          return;
        }
        try {
          await api(`/api/wallets/${form.dataset.id}`, { method: 'PATCH', body: { opening_balance: amount } });
          showToast(t('walletOpeningSaved'));
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderGoalModule() {
    const list = document.getElementById('goal-list');
    if (!goals.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t('goalEmpty'))}</div>`;
      return;
    }
    list.innerHTML = goals.map((goal) => {
      const percent = goal.target_amount > 0 ? Math.round((goal.saved_amount / goal.target_amount) * 100) : 0;
      const remaining = Math.max(0, goal.target_amount - goal.saved_amount);
      let monthlyNeeded = '';
      if (goal.due_date && remaining > 0) {
        const [year, month] = goal.due_date.split('-').map(Number);
        const monthsLeft = Math.max(1, (year - new Date().getFullYear()) * 12 + month - (new Date().getMonth() + 1));
        monthlyNeeded = `<small>${escapeHtml(t('goalMonthlyNeeded', { amount: formatIDR(Math.ceil(remaining / monthsLeft)) }))}</small>`;
      }
      return `<div class="finance-list-item">
        <div class="finance-item-top">
          <strong>${escapeHtml(goal.title)}</strong>
          <span class="finance-status ${percent >= 100 ? 'is-positive' : ''}">${Math.min(percent, 100)}%</span>
        </div>
        <div class="finance-item-meta">
          <span>${escapeHtml(t('goalSavedLabel'))}: ${escapeHtml(formatIDR(goal.saved_amount))}</span>
          <span>${escapeHtml(t('goalTargetLabel'))}: ${escapeHtml(formatIDR(goal.target_amount))}</span>
          ${goal.due_date ? `<span>${escapeHtml(t('goalDueLabel'))}: ${escapeHtml(goal.due_date)}</span>` : ''}
        </div>
        <div class="finance-progress is-positive" role="progressbar" aria-valuenow="${Math.min(percent, 100)}" aria-valuemin="0" aria-valuemax="100">
          <span style="width:${Math.min(percent, 100)}%"></span>
        </div>
        ${monthlyNeeded}
        <div class="finance-item-actions">
          <span>${escapeHtml(t('goalRemainingLabel'))}: ${escapeHtml(formatIDR(remaining))}</span>
          <div>
            <button class="btn btn-primary btn-xs js-goal-contribute" data-id="${goal.id}" type="button">${escapeHtml(t('goalContributeBtn'))}</button>
            <button class="btn btn-outline btn-xs js-goal-delete" data-id="${goal.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.js-goal-contribute').forEach((button) => {
      button.addEventListener('click', async () => {
        const value = window.prompt(t('goalContributionPrompt'));
        if (value === null || !value.trim()) return;
        const amount = toIdr(value);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          showToast(t('invalidAmount'), true);
          return;
        }
        try {
          await api(`/api/goals/${button.dataset.id}/contributions`, { method: 'POST', body: { amount } });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
    list.querySelectorAll('.js-goal-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm(t('goalDeleteConfirm'))) return;
        try {
          await api(`/api/goals/${button.dataset.id}`, { method: 'DELETE' });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderRecurringModule() {
    const today = getTodayDate();
    const cutoff = new Date(`${today}T00:00:00`);
    cutoff.setDate(cutoff.getDate() + 7);
    const cutoffDate = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
    const dueSoon = recurring.filter((item) => item.is_active && item.next_due_date <= cutoffDate);
    const alerts = dueSoon.map((item) => {
      const overdue = item.next_due_date < today;
      const dueToday = item.next_due_date === today;
      const messageKey = overdue ? 'recurringOverdue' : dueToday ? 'recurringDue' : 'recurringUpcoming';
      return `<div class="finance-alert ${overdue ? 'is-danger' : dueToday ? 'is-warning' : 'is-neutral'}">
        <strong>${escapeHtml(t(messageKey, { title: item.description || item.category }))}</strong>
        <span>${escapeHtml(item.next_due_date)} · ${escapeHtml(formatIDR(item.amount))}</span>
      </div>`;
    }).join('');
    document.getElementById('recurring-alerts').innerHTML = alerts || `
      <div class="finance-alert is-neutral">${escapeHtml(t('recurringNoDue'))}</div>
    `;

    const frequencyLabels = { weekly: 'frequencyWeekly', monthly: 'frequencyMonthly', yearly: 'frequencyYearly' };
    const list = document.getElementById('recurring-list');
    if (!recurring.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t('recurringEmpty'))}</div>`;
      return;
    }
    list.innerHTML = recurring.map((item) => {
      const overdue = item.next_due_date < today;
      const dueToday = item.next_due_date === today;
      return `<div class="finance-list-item">
        <div class="finance-item-top">
          <strong>${escapeHtml(item.description || catLabel(item.category))}</strong>
          <span class="finance-status ${overdue || dueToday ? 'is-warning' : ''}">${escapeHtml(item.next_due_date)}</span>
        </div>
        <div class="finance-item-meta">
          <span>${escapeHtml(catLabel(item.category))}</span>
          <span>${escapeHtml(t(frequencyLabels[item.frequency] || 'frequencyMonthly'))}</span>
          <span>${escapeHtml(methodLabel(item.payment_method))}</span>
          <strong>${escapeHtml(formatIDR(item.amount))}</strong>
        </div>
        <div class="finance-item-actions">
          <button class="btn btn-primary btn-xs js-recurring-confirm" data-id="${item.id}" type="button">${escapeHtml(t('recurringConfirmBtn'))}</button>
          <button class="btn btn-outline btn-xs js-recurring-delete" data-id="${item.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.js-recurring-confirm').forEach((button) => {
      button.addEventListener('click', async () => {
        const item = recurring.find((entry) => entry.id === Number(button.dataset.id));
        if (!item || !window.confirm(t('recurringConfirmPrompt', {
          title: item.description || item.category,
          amount: formatIDR(item.amount),
        }))) return;
        try {
          await api(`/api/recurring/${item.id}/confirm`, {
            method: 'POST',
            body: { tx_date: getTodayDate() },
          });
          showToast(t('recurringConfirmSuccess'));
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
    list.querySelectorAll('.js-recurring-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm(t('recurringDeleteConfirm'))) return;
        try {
          await api(`/api/recurring/${button.dataset.id}`, { method: 'DELETE' });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderInvestmentTrendChart(series) {
    const container = document.getElementById('investment-trend-chart');
    const maxValue = Math.max(0, ...series.map((item) => Math.max(item.invested, item.returns)));
    if (!series.length || maxValue === 0) {
      container.innerHTML = `<div class="empty-state">${escapeHtml(t('investmentNoData'))}</div>`;
      return;
    }

    const width = 760;
    const height = 300;
    const left = 78;
    const right = 18;
    const top = 18;
    const bottom = 48;
    const plotHeight = height - top - bottom;
    const plotWidth = width - left - right;
    const groupWidth = plotWidth / series.length;
    const barWidth = Math.min(28, groupWidth * 0.3);
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = maxValue * (4 - index) / 4;
      const y = top + plotHeight * index / 4;
      return `<line class="investment-chart-gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>
        <text class="investment-chart-axis-label" x="${left - 8}" y="${y + 4}" text-anchor="end">${escapeHtml(formatShortIDR(value))}</text>`;
    }).join('');
    const bars = series.map((item, index) => {
      const center = left + groupWidth * (index + 0.5);
      const investedHeight = (item.invested / maxValue) * plotHeight;
      const returnsHeight = (item.returns / maxValue) * plotHeight;
      const investedX = center - barWidth - 2;
      const returnsX = center + 2;
      const investedY = top + plotHeight - investedHeight;
      const returnsY = top + plotHeight - returnsHeight;
      return `<g>
        <rect class="investment-chart-bar is-contribution" x="${investedX}" y="${investedY}" width="${barWidth}" height="${investedHeight}" rx="4">
          <title>${escapeHtml(item.label)} — ${escapeHtml(t('investmentContributions'))}: ${escapeHtml(formatIDR(item.invested))}</title>
        </rect>
        <rect class="investment-chart-bar is-return" x="${returnsX}" y="${returnsY}" width="${barWidth}" height="${returnsHeight}" rx="4">
          <title>${escapeHtml(item.label)} — ${escapeHtml(t('investmentReturns'))}: ${escapeHtml(formatIDR(item.returns))}</title>
        </rect>
        <text class="investment-chart-month" x="${center}" y="${height - 16}" text-anchor="middle">${escapeHtml(item.label)}</text>
      </g>`;
    }).join('');
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t('investmentTrendTitle'))}">
      <title>${escapeHtml(t('investmentTrendTitle'))}</title>
      ${grid}${bars}
    </svg>`;
  }

  function renderInvestmentModule() {
    const summary = investmentData.summary || {};
    const breakdown = investmentData.breakdown || [];
    const series = investmentData.monthlySeries || [];
    const transactions = investmentData.transactions || [];
    const summaryCards = [
      [t('investmentAllTimeInvested'), formatIDR(summary.allTimeInvested)],
      [t('investmentAllTimeReturns'), formatIDR(summary.allTimeReturns)],
      [t('investmentCurrentLabel'), formatIDR(summary.monthlyInvested)],
      [t('investmentIncomeLabel'), formatIDR(summary.monthlyReturns)],
    ];
    document.getElementById('investment-summary').innerHTML = summaryCards.map(([label, amount]) => `
      <article class="finance-summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(amount)}</strong>
      </article>
    `).join('');

    const current = series[series.length - 1] || { invested: 0 };
    const previous = series[series.length - 2] || { invested: 0 };
    let trend = t(current.invested > 0 ? 'investmentTrendFirst' : 'investmentTrendNoData');
    if (current.invested > 0 && previous.invested > 0) {
      const difference = current.invested - previous.invested;
      trend = difference === 0
        ? t('investmentTrendFlat')
        : t(difference > 0 ? 'investmentTrendUp' : 'investmentTrendDown', {
          rate: Math.round(Math.abs(difference) / previous.invested * 100),
        });
    }
    document.getElementById('investment-insight').textContent = t('investmentInsightSummary', {
      invested: formatIDR(summary.monthlyInvested),
      returns: formatIDR(summary.monthlyReturns),
      trend,
    });

    renderInvestmentTrendChart(series);
    const totalInvested = Number(summary.monthlyInvested) || 0;
    const monthlyBreakdown = breakdown.filter((item) => item.invested > 0 || item.returns > 0);
    document.getElementById('investment-type-breakdown').innerHTML = monthlyBreakdown.length
      ? monthlyBreakdown.map((item) => {
        const share = totalInvested > 0 ? Math.round(Number(item.invested) / totalInvested * 100) : 0;
        return `<div class="investment-breakdown-row">
          <div class="investment-breakdown-heading">
            <strong>${escapeHtml(investmentTypeLabel(item.type))}</strong>
            <span>${share}%</span>
          </div>
          <div class="finance-progress is-positive" role="progressbar" aria-valuenow="${share}" aria-valuemin="0" aria-valuemax="100">
            <span style="width:${share}%"></span>
          </div>
          <div class="investment-breakdown-values">
            <span>${escapeHtml(t('investmentContributions'))}: ${escapeHtml(formatIDR(item.invested))}</span>
            <span>${escapeHtml(t('investmentReturns'))}: ${escapeHtml(formatIDR(item.returns))}</span>
          </div>
        </div>`;
      }).join('')
      : `<div class="empty-state">${escapeHtml(t('investmentNoData'))}</div>`;

    const list = document.getElementById('investment-transaction-list');
    if (!transactions.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t('investmentHistoryEmpty'))}</div>`;
      return;
    }
    list.innerHTML = transactions.map((item) => {
      const isReturn = item.type === 'income';
      return `<div class="finance-list-item compact">
        <div class="finance-item-top">
          <strong>${escapeHtml(investmentTypeLabel(item.investment_type))}</strong>
          <span class="finance-status ${isReturn ? 'is-positive' : 'is-warning'}">${escapeHtml(t(isReturn ? 'investmentReturnShort' : 'investmentContributionShort'))}</span>
        </div>
        <div class="finance-item-meta">
          <span>${escapeHtml(item.tx_date)}</span>
          <strong class="${isReturn ? 'text-emerald' : ''}">${isReturn ? '+' : '−'}${escapeHtml(formatIDR(item.amount))}</strong>
        </div>
        <small>${escapeHtml(item.description || methodLabel(item.payment_method))}</small>
        <div class="finance-item-actions">
          <span>${escapeHtml(methodLabel(item.payment_method))}</span>
          <button class="btn btn-outline btn-xs js-investment-delete" data-id="${item.id}" type="button">${escapeHtml(t('deleteBtn'))}</button>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.js-investment-delete').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.confirm(t('investmentDeleteConfirm'))) return;
        try {
          await api(`/api/transactions/${button.dataset.id}`, { method: 'DELETE' });
          await refreshAllData();
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  function renderAll() {
    const recurringCategory = document.getElementById('recurring-category');
    const recurringCategoryValue = recurringCategory.value;
    setCategoryOptions(
      recurringCategory,
      document.getElementById('recurring-type').value,
      recurringCategoryValue
    );
    renderBudgetModule();
    renderDebtModule();
    renderWalletModule();
    renderInvestmentModule();
    renderGoalModule();
    renderRecurringModule();
  }

  async function loadAll() {
    const month = encodeURIComponent(state.month);
    const results = await Promise.allSettled([
      api(`/api/budgets?month=${month}`),
      api('/api/debts'),
      api('/api/wallets'),
      api(`/api/investments?month=${month}&lang=${state.lang}`),
      api('/api/goals'),
      api('/api/recurring'),
    ]);
    const errors = [];
    if (results[0].status === 'fulfilled') budgets = results[0].value.budgets || [];
    else errors.push(results[0].reason.message);
    if (results[1].status === 'fulfilled') {
      debts = results[1].value.debts || [];
      unlinkedPayments = results[1].value.unlinkedPayments || [];
      debtSummary = results[1].value.summary || {};
    } else errors.push(results[1].reason.message);
    if (results[2].status === 'fulfilled') {
      wallets = results[2].value.wallets || [];
      transfers = results[2].value.transfers || [];
    } else errors.push(results[2].reason.message);
    if (results[3].status === 'fulfilled') investmentData = results[3].value;
    else errors.push(results[3].reason.message);
    if (results[4].status === 'fulfilled') goals = results[4].value.goals || [];
    else errors.push(results[4].reason.message);
    if (results[5].status === 'fulfilled') recurring = results[5].value.recurring || [];
    else errors.push(results[5].reason.message);

    populateWalletControls();
    renderAll();
    if (errors.length) showToast(`${t('financeLoadError')} ${errors.join(' ')}`, true);
  }

  function init() {
    setCategoryOptions(document.getElementById('budget-category'), 'expense');
    setCategoryOptions(document.getElementById('recurring-category'), 'expense');
    document.getElementById('budget-category').addEventListener('change', (event) => {
      const current = budgets.find((item) => item.category === event.target.value);
      document.getElementById('budget-monthly-limit').value = current
        ? fromIdr(current.monthly_limit).toFixed(state.lang === 'en' ? 2 : 0)
        : '';
    });
    document.getElementById('recurring-next-due').value = getTodayDate();
    document.getElementById('wallet-transfer-date').value = getTodayDate();
    document.getElementById('investment-entry-date').value = getTodayDate();
    document.getElementById('recurring-type').addEventListener('change', (event) => {
      setCategoryOptions(document.getElementById('recurring-category'), event.target.value);
    });

    document.getElementById('category-budget-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const amount = toIdr(document.getElementById('budget-monthly-limit').value);
      try {
        await api('/api/budgets', {
          method: 'POST',
          body: { category: document.getElementById('budget-category').value, monthly_limit: amount },
        });
        form.reset();
        showToast(t('budgetSaved'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('finance-debt-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api('/api/debts', {
          method: 'POST',
          body: {
            kind: document.getElementById('finance-debt-kind').value,
            title: document.getElementById('finance-debt-title').value,
            principal_amount: toIdr(document.getElementById('finance-debt-amount').value),
            monthly_installment: toIdr(document.getElementById('finance-debt-installment').value),
            due_date: document.getElementById('finance-debt-due').value,
            notes: document.getElementById('finance-debt-notes').value,
          },
        });
        form.reset();
        showToast(t('debtSaved'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('wallet-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api('/api/wallets', {
          method: 'POST',
          body: {
            name: document.getElementById('wallet-name').value,
            wallet_type: document.getElementById('wallet-type').value,
            opening_balance: toIdr(document.getElementById('wallet-opening-balance').value),
          },
        });
        form.reset();
        document.getElementById('wallet-opening-balance').value = '0';
        showToast(t('walletCreated'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('wallet-transfer-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api('/api/wallet-transfers', {
          method: 'POST',
          body: {
            from_wallet_id: Number(document.getElementById('wallet-transfer-from').value),
            to_wallet_id: Number(document.getElementById('wallet-transfer-to').value),
            amount: toIdr(document.getElementById('wallet-transfer-amount').value),
            transfer_date: document.getElementById('wallet-transfer-date').value,
          },
        });
        form.reset();
        document.getElementById('wallet-transfer-date').value = getTodayDate();
        showToast(t('walletTransferSuccess'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('investment-entry-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const amount = toIdr(document.getElementById('investment-entry-amount').value);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        showToast(t('invalidAmount'), true);
        return;
      }
      const isReturn = document.getElementById('investment-entry-kind').value === 'return';
      try {
        await api('/api/transactions', {
          method: 'POST',
          body: {
            type: isReturn ? 'income' : 'expense',
            category: isReturn ? 'Investasi & Dividen' : 'Tabungan & Investasi',
            investment_type: document.getElementById('investment-entry-type').value,
            amount,
            tx_date: document.getElementById('investment-entry-date').value,
            payment_method: document.getElementById('investment-entry-method').value,
            description: document.getElementById('investment-entry-description').value,
          },
        });
        form.reset();
        document.getElementById('investment-entry-date').value = getTodayDate();
        showToast(t('investmentEntrySaved'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('goal-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api('/api/goals', {
          method: 'POST',
          body: {
            title: document.getElementById('goal-title').value,
            target_amount: toIdr(document.getElementById('goal-target-amount').value),
            due_date: document.getElementById('goal-due-date').value,
          },
        });
        form.reset();
        showToast(t('goalCreated'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });

    document.getElementById('recurring-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api('/api/recurring', {
          method: 'POST',
          body: {
            type: document.getElementById('recurring-type').value,
            amount: toIdr(document.getElementById('recurring-amount').value),
            category: document.getElementById('recurring-category').value,
            description: document.getElementById('recurring-description').value,
            payment_method: document.getElementById('recurring-payment-method').value,
            frequency: document.getElementById('recurring-frequency').value,
            next_due_date: document.getElementById('recurring-next-due').value,
          },
        });
        form.reset();
        document.getElementById('recurring-type').value = 'expense';
        setCategoryOptions(document.getElementById('recurring-category'), 'expense');
        document.getElementById('recurring-next-due').value = getTodayDate();
        showToast(t('recurringCreated'));
        await refreshAllData();
      } catch (error) {
        showToast(error.message, true);
      }
    });
  }

  return { init, loadAll, walletMethodNames };
})();
