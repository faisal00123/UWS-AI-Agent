/**
 * Owner surfaces: daily reports (with reconciliation), backup monitoring,
 * the settings editor and the system/user admin page.
 */
import {
  $, $$, api, esc, errMsg, toast, promptDialog, confirmDialog, sevBadge,
  fmtDateTime, fmtBytes, fmtMoney, fmtDuration, tableHtml, titleCase, label, dash,
} from '../lib.js';

/* ------------------------------------------------------- integrations --- */

/**
 * Phase 11A integrations panel: one card per integration showing provider,
 * config status, connection status, API readiness, last health check, and
 * (owner only) a Test-connection button + enable/disable toggle. Never shows
 * a secret — only env-var NAMES via credentialPresence and redacted details.
 *
 * Phase 11B: an "Onboarding" column (pending / verified / failed) with a
 * free-verification button (owner). Live mode stays locked until telephony
 * shows `verified` here.
 */
function renderIntegrationsPanel(integ, isOwner) {
  if (!integ) return '';
  const adapters = integ.adapters ?? [];
  const health = integ.health ?? {};
  const usage = integ.usage ?? [];
  const toggles = integ.toggles ?? {};
  const onboarding = integ.onboarding ?? {};
  const credByKey = new Map((integ.credentialPresence ?? []).map((c) => [c.key, c]));
  const usageByKey = new Map(usage.map((u) => [u.integration, u]));

  const stateBadge = (state) => {
    if (state === 'configured') return '<span class="badge ok">configured</span>';
    if (state === 'disabled') return '<span class="badge muted">disabled</span>';
    if (state === 'error') return '<span class="badge danger">error</span>';
    return '<span class="badge muted">unconfigured</span>';
  };

  const onboardBadge = (ob) => {
    if (ob?.state === 'verified') return '<span class="badge ok">verified</span>';
    if (ob?.state === 'failed') return '<span class="badge danger">failed</span>';
    if (ob?.state === 'disabled') return '<span class="badge muted">off</span>';
    return '<span class="badge muted">pending</span>';
  };

  const rows = adapters.map((a) => {
    const key = a.key;
    const h = health[key];
    const u = usageByKey.get(key);
    const ob = onboarding[key];
    const enabled = toggles[key] !== false;
    const cred = credByKey.get(key);
    const readiness = a.state === 'configured'
      ? (a.simulated ? 'simulated (no network)' : 'ready')
      : a.state === 'disabled' ? 'off'
        : 'not ready';
    return `<tr data-integration="${esc(key)}">
      <td><strong>${esc(a.label ?? key)}</strong>
        <div class="muted small">provider: ${esc(a.implementation ?? '—')}${a.simulated ? ' · simulated' : ''}</div></td>
      <td>${stateBadge(a.state)}</td>
      <td class="small">${esc(readiness)}</td>
      <td class="muted small">${onboardBadge(ob)}${ob?.verifiedAt ? `<div>${esc(fmtDateTime(ob.verifiedAt))}</div>` : ob?.detail ? `<div>${esc(ob.detail)}</div>` : ''}</td>
      <td class="small">${(cred?.missing ?? []).length ? `<span style="color:var(--warn)">missing: ${esc((cred.missing ?? []).join(', '))}</span>` : '<span class="muted">all present</span>'}</td>
      <td class="muted small">${h ? `${h.ok ? '<span class="badge ok">ok</span>' : '<span class="badge danger">fail</span>'} ${esc(fmtDateTime(h.checkedAt))}<div>${esc(h.detail ?? '')}</div>` : 'never checked'}</td>
      <td class="muted small">${u ? `${u.ok} ok · ${u.error} err · ${u.rateLimited} thr · ${u.disabled} off` : '—'}</td>
      <td class="nowrap">
        ${isOwner ? `<button class="btn sm ghost" data-onboard-integration="${esc(key)}">${ob?.state === 'verified' ? 'Re-verify' : 'Verify'}</button>` : ''}
        ${isOwner ? `<button class="btn sm ghost" data-test-integration="${esc(key)}">Test</button>` : ''}
        ${isOwner ? `<label class="small" style="margin-left:6px"><input type="checkbox" data-toggle-integration="${esc(key)}" ${enabled ? 'checked' : ''}/> On</label>` : ''}
      </td>
    </tr>`;
  });

  const emailQ = integ.emailQueue ?? null;
  const res = integ.resilience ?? null;
  const tmpl = integ.portfolioTemplate ?? null;

  return `<div class="card"><div class="card-head"><h2>Integrations</h2>
      <button class="btn sm" data-action="refresh-integrations">Refresh</button></div>
    ${tableHtml({
      head: ['Integration', 'Status', 'Readiness', 'Onboarding', 'Credentials', 'Last health check', 'Usage (7d)', isOwner ? 'Controls' : ''],
      rows,
      empty: 'No integrations reported.',
    })}
    <p class="muted small">Rate limit: ${res ? esc(res.ratePerMinute) : '—'}/min per integration · Retry (idempotent ops only): ${res ? esc(res.retryAttempts) : '—'} attempt(s).
    Portfolio template: ${tmpl ? `<code>${esc(tmpl.name)}</code> (${esc(tmpl.language)})` : 'not set'}.
    Email queue: ${emailQ ? `${emailQ.pending} pending · ${emailQ.failed} failed · ${emailQ.sent} sent` : '—'}.
    <strong>Verify</strong> runs a free connection probe (no calls, messages or paid API requests) and records the outcome —
    LIVE mode requires the telephony integration to be <strong>verified</strong>.
    Secrets are never displayed here — only variable names and redacted details.</p>
  </div>`;
}

/* ------------------------------------------------------------- reports --- */

export async function renderReports(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Daily reports</h1><p class="desc">One report per business day: totals, reconciliation checks and honest missing-data notes.</p></div>
      <div class="btn-row">
        <label class="field" style="margin:0"><span class="small muted">Report date</span>
          <input type="date" name="date"/></label>
        <button class="btn primary" data-action="generate">Generate / refresh</button>
      </div>
    </div>
    <div data-detail></div>
    <div class="card"><div class="card-head"><h2>Existing reports</h2></div><div data-list></div></div>`;

  const detail = $('[data-detail]', root);
  const list = $('[data-list]', root);
  const dateInput = $('[name=date]', root);
  dateInput.value = new Date().toISOString().slice(0, 10);

  const loadList = async () => {
    try {
      const res = await api('GET', '/api/reports?limit=30');
      const rows = (res.items ?? []).map((r) => `<tr class="clickable" data-date="${esc(r.reportDate)}">
        <td>${esc(r.reportDate)}</td>
        <td>${r.status === 'final' ? '<span class="badge ok">final</span>' : '<span class="badge warn">draft</span>'}</td>
        <td>${r.discrepanciesCount ? `<span class="badge danger">${esc(r.discrepanciesCount)} discrepancy(ies)</span>` : '<span class="badge ok">clean</span>'}</td>
        <td>${r.totals?.mode === 'live' ? '<span class="badge danger">live</span>' : '<span class="badge info">simulation</span>'}</td>
        <td class="muted small">${esc(fmtDateTime(r.generatedAt))}</td>
      </tr>`);
      list.innerHTML = tableHtml({ head: ['Date', 'Status', 'Reconciliation', 'Mode', 'Generated'], rows, empty: 'No reports yet — generate one for any business day.' });
      $$('tr.clickable', list).forEach((tr) => tr.addEventListener('click', () => {
        dateInput.value = tr.dataset.date;
        showReport(tr.dataset.date);
      }));
    } catch (err) {
      list.innerHTML = `<div class="banner danger"><div>${esc(errMsg(err))}</div></div>`;
    }
  };

  const showReport = async (date) => {
    detail.innerHTML = `<div class="loading"><span class="spinner"></span> Loading ${esc(date)}…</div>`;
    try {
      const res = await api('GET', `/api/reports/${esc(date)}`);
      const r = res.report;
      if (!r) {
        detail.innerHTML = `<div class="empty">No report for ${esc(date)} yet.</div>`;
        return;
      }
      const t = r.totals;
      const rec = r.reconciliation ?? {};
      const discRows = (rec.discrepancies ?? []).map((d) => `<tr>
        <td>${sevBadge(d.severity)}</td>
        <td>${esc(d.code)}<div class="small">${esc(d.detail)}</div>
          ${(d.refs ?? []).length ? `<div class="muted small mono">${esc((d.refs ?? []).join(', '))}</div>` : ''}</td>
        <td class="right mono">${esc(d.count)}</td>
      </tr>`);
      const checkRows = (rec.checks ?? []).map((c) => `<tr>
        <td>${c.passed ? '<span class="badge ok">pass</span>' : '<span class="badge danger">fail</span>'}</td>
        <td>${esc(c.label ?? c.code)}<div class="muted small">${esc(c.detail)}</div></td>
      </tr>`);
      const budgetRows = (t.budget?.usage ?? []).map((u) => `<tr>
        <td>${esc(titleCase(u.metric))}</td><td class="right mono">${esc(u.used)}</td>
        <td class="right mono">${esc(u.limit)}</td><td>${esc(label(u.state))}</td>
      </tr>`);

      detail.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h2>Report ${esc(r.reportDate)} ${r.status === 'final' ? '<span class="badge ok">final</span>' : '<span class="badge warn">draft (today)</span>'}</h2>
            <span class="muted small">generated ${esc(fmtDateTime(r.generatedAt))} · mode ${esc(t.mode)}${t.mode === 'live' ? ' — these were real customer interactions' : ''}</span>
          </div>
          <div class="grid cols-4">
            <div class="stat"><div class="label">Leads created</div><div class="value">${esc(t.leads?.created ?? 0)}</div></div>
            <div class="stat"><div class="label">Attempts</div><div class="value">${esc(t.attempts?.total ?? 0)}</div>
              <div class="hint">${esc(t.attempts?.allowed ?? 0)} allowed · ${esc(t.attempts?.blocked ?? 0)} blocked</div></div>
            <div class="stat"><div class="label">Calls</div><div class="value">${esc(t.calls?.total ?? 0)}</div>
              <div class="hint">${esc(t.calls?.simulated ?? 0)} simulated · ${esc(t.calls?.live ?? 0)} live</div></div>
            <div class="stat"><div class="label">Messages</div><div class="value">${esc(t.messages?.total ?? 0)}</div>
              <div class="hint">${esc(t.messages?.simulated ?? 0)} simulated · ${esc(t.messages?.live ?? 0)} live</div></div>
          </div>
          <div class="grid cols-4" style="margin-top:12px">
            <div class="stat"><div class="label">Opt-outs</div><div class="value sm">${esc(t.optOuts ?? 0)}</div></div>
            <div class="stat"><div class="label">Follow-ups</div><div class="value sm">${esc(t.followups?.completed ?? 0)}/${esc(t.followups?.created ?? 0)}</div>
              <div class="hint">${esc(t.followups?.dueNow ?? 0)} due now</div></div>
            <div class="stat"><div class="label">Call duration</div><div class="value sm">${esc(fmtDuration(t.calls?.totalDurationSeconds ?? 0))}</div></div>
            <div class="stat"><div class="label">Spend</div><div class="value sm">${esc(fmtMoney(t.costs?.totalMinor ?? 0, t.costs?.currency))}</div></div>
          </div>
          ${(t.attempts?.blockedByCode && Object.keys(t.attempts.blockedByCode).length)
            ? `<p class="small muted" style="margin-top:10px">Blocked by: ${esc(Object.entries(t.attempts.blockedByCode).map(([k, v]) => `${label(k)}=${v}`).join(' · '))}</p>` : ''}
        </div>
        <div class="card"><div class="card-head"><h2>Budget usage</h2></div>
          ${tableHtml({ head: ['Metric', 'Used', 'Limit', 'State'], rows: budgetRows, empty: 'No budget usage recorded.' })}</div>
        <div class="card"><div class="card-head"><h2>Reconciliation</h2>
          <span class="muted small">Ledger, counters and execution rows are cross-checked for drift.</span></div>
          ${tableHtml({ head: ['', 'Check'], rows: checkRows, empty: 'No checks recorded.' })}
          <h3 style="margin-top:14px">Discrepancies</h3>
          ${tableHtml({ head: ['Severity', 'Finding', 'Count'], rows: discRows, empty: 'No discrepancies — ledger and counters agree.' })}
          ${(r.missingData ?? []).length
            ? `<div class="banner warn" style="margin-top:12px"><div><strong>Missing data (reported, never estimated)</strong>
                <ul class="small">${(r.missingData ?? []).map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div></div>` : ''}
        </div>`;
    } catch (err) {
      detail.innerHTML = `<div class="banner danger"><div>${esc(errMsg(err))}</div></div>`;
    }
  };

  $('[data-action=generate]', root).addEventListener('click', async (e) => {
    e.target.disabled = true;
    const date = dateInput.value;
    if (!date) return;
    try {
      await api('POST', `/api/reports/${esc(date)}/generate`);
      toast('Report generated', date);
      await Promise.all([showReport(date), loadList()]);
    } catch (err) {
      toast('Generation failed', errMsg(err), 'err');
    } finally {
      e.target.disabled = false;
    }
  });

  await loadList();
  await showReport(dateInput.value);
}

/* ------------------------------------------------------------- backups --- */

export async function renderBackups(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> Loading backups…</div>`;
  let res;
  try {
    res = await api('GET', '/api/backups');
  } catch (err) {
    root.innerHTML = `<div class="banner danger"><div>${esc(errMsg(err))}</div></div>`;
    return;
  }

  const statusBadge = (s) => s === 'verified' ? '<span class="badge ok">verified</span>'
    : s === 'completed' ? '<span class="badge info">completed</span>'
    : s === 'failed' ? '<span class="badge danger">failed</span>'
    : '<span class="badge warn">running</span>';

  const items = (res.items ?? []).map((b) => {
    const v = b.verifyResult;
    const checks = (v?.checks ?? []).map((c) => `${c.code}:${c.passed ? 'pass' : 'FAIL'}`).join(' ');
    return `<tr>
      <td class="small nowrap">${esc(fmtDateTime(b.createdAt))}</td>
      <td>${statusBadge(b.status)}</td>
      <td>${b.encrypted ? '<span class="badge ok">encrypted</span>' : '<span class="badge warn">plain</span>'}</td>
      <td class="small">${esc(fmtBytes(b.sizeBytes))}</td>
      <td class="small muted">${esc(checks || (b.error ?? ''))}</td>
      <td class="nowrap"><button class="btn sm" data-test="${esc(b.id)}">Restore test</button></td>
    </tr>`;
  });

  const tests = (res.restoreTests ?? []).map((t) => `<tr>
    <td class="small nowrap">${esc(fmtDateTime(t.startedAt))}</td>
    <td>${t.status === 'passed' ? '<span class="badge ok">passed</span>' : t.status === 'failed' ? '<span class="badge danger">failed</span>' : '<span class="badge warn">running</span>'}</td>
    <td class="small muted">${esc((t.checks ?? []).map((c) => `${c.code}:${c.passed ? 'pass' : 'FAIL'}`).join(' ') || (t.error ?? ''))}</td>
  </tr>`);

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Backups</h1><p class="desc">Encrypted snapshots, verified on creation and proven restorable by periodic restore tests.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    <div class="grid cols-4">
      <div class="stat"><div class="label">Scheduled backups</div>
        <div class="value sm">${res.enabled ? 'Enabled' : 'Disabled'}</div>
        <div class="hint">every ${esc(res.intervalHours)}h · keep ${esc(res.retentionDays)}d</div></div>
      <div class="stat"><div class="label">Encryption</div>
        <div class="value sm">${res.encryptionConfigured ? 'Configured' : 'NOT configured'}</div>
        <div class="hint">${res.encryptionConfigured ? 'AES-256-GCM with a passphrase-derived key' : 'Set BACKUP_PASSPHRASE before going live'}</div></div>
      <div class="stat"><div class="label">Last backup</div>
        <div class="value sm">${res.lastBackup ? esc(fmtDateTime(res.lastBackup.createdAt)) : 'none'}</div>
        <div class="hint">${res.lastBackup ? statusBadge(res.lastBackup.status) : 'run npm run backup'}</div></div>
      <div class="stat"><div class="label">Last restore test</div>
        <div class="value sm">${res.lastRestoreTest ? esc(fmtDateTime(res.lastRestoreTest.startedAt)) : 'never'}</div>
        <div class="hint">${res.lastRestoreTest ? (res.lastRestoreTest.status === 'passed' ? '<span class="badge ok">passed</span>' : '<span class="badge danger">failed</span>') : `every ${esc(res.restoreTestDays)}d`}</div></div>
    </div>
    ${!res.enabled ? `<div class="banner warn"><div><strong>Backups are disabled.</strong>
      Set BACKUP_ENABLED=true and BACKUP_PASSPHRASE in the environment. The doctor reports this too.</div></div>` : ''}
    <div class="card"><div class="card-head"><h2>Backup history</h2>
      <span class="muted small">Create one now with <code>npm run backup</code>.</span></div>
      ${tableHtml({ head: ['Created', 'Status', 'Encryption', 'Size', 'Verification', ''], rows: items, empty: 'No backups yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Restore tests</h2>
      <span class="muted small">Each test decrypts the snapshot into a scratch database and recounts every table against the manifest.</span></div>
      ${tableHtml({ head: ['Started', 'Result', 'Checks'], rows: tests, empty: 'No restore tests yet — a backup you have never restored is a guess.' })}</div>`;

  $$('[data-test]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api('POST', `/api/backups/${encodeURIComponent(btn.dataset.test)}/restore-test`);
        toast(r.restoreTest?.status === 'passed' ? 'Restore test passed' : 'Restore test result',
          r.restoreTest?.status === 'passed' ? 'The snapshot was decrypted, opened and recounted successfully.' : (r.restoreTest?.error ?? ''),
          r.restoreTest?.status === 'passed' ? 'ok' : 'err');
        renderBackups(root, ctx);
      } catch (err) {
        toast('Restore test failed', errMsg(err), 'err');
        btn.disabled = false;
      }
    });
  });
  $('[data-action=refresh]', root).addEventListener('click', () => renderBackups(root, ctx));
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderBackups(root, ctx)));
}

/* ------------------------------------------------------------ settings --- */

const SETTING_HINTS = {
  calling_schedule: 'When outbound calls may be placed (business timezone).',
  daily_call_limit: 'Hard maximum outbound call attempts per business day.',
  daily_budget: 'Hard cap on paid outbound calling + messaging spend.',
  retry_policy: 'How often and how long to retry a failed contact.',
  followup_policy: 'Automatic follow-up timing per stage.',
  eligible_channels: 'Which channels outreach may use at all.',
  recording_policy: 'Call recording is opt-in and off by default.',
  notification_destinations: 'Where operational alerts are delivered.',
  retention: 'How long raw data is kept before pruning.',
  scoring_weights: 'Relative weight of each scoring factor.',
  discovery_policy: 'Which sectors/cities discovery covers.',
  conversation_policy: 'AI talk track, disclosure and handoff rules.',
  portfolio_policy: 'Which portfolio items may be shared, and when.',
};

export async function renderSettings(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> Loading settings…</div>`;
  let res;
  try {
    res = await api('GET', '/api/settings');
  } catch (err) {
    root.innerHTML = `<div class="banner danger"><div>${esc(errMsg(err))}</div></div>`;
    return;
  }

  const ceilings = res.hardCeilings ?? {};
  const cards = (res.settings ?? []).map((s) => {
    const value = s.value;
    const isObj = value !== null && typeof value === 'object';
    const editor = typeof value === 'boolean'
      ? `<label class="small"><input type="checkbox" data-key="${esc(s.key)}" ${value ? 'checked' : ''}/> ${esc(s.label)}</label>`
      : typeof value === 'number'
        ? `<input type="number" data-key="${esc(s.key)}" value="${esc(value)}"/>`
        : `<textarea data-key="${esc(s.key)}" rows="${isObj ? 6 : 2}">${esc(isObj ? JSON.stringify(value, null, 2) : value ?? '')}</textarea>`;
    return `<div class="card">
      <div class="card-head">
        <h2>${esc(s.label)} ${s.sensitive ? '<span class="badge warn">sensitive — requires password</span>' : ''}</h2>
        <span class="muted small">${s.source === 'database' ? `saved v${esc(s.version)}${s.updatedAt ? ' · ' + esc(fmtDateTime(s.updatedAt)) : ''}` : 'default'}</span>
      </div>
      <p class="muted small">${esc(SETTING_HINTS[s.key] ?? s.description ?? '')}</p>
      ${editor}
      <div class="btn-row" style="margin-top:8px">
        <button class="btn sm primary" data-save="${esc(s.key)}">Save</button>
        ${s.source === 'database' ? `<button class="btn sm ghost" data-reset="${esc(s.key)}">Reset to default</button>` : ''}
      </div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Settings</h1><p class="desc">Owner-only. Changes to sensitive settings require a fresh password confirmation.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    ${Object.keys(ceilings).length ? `<div class="banner info"><div><strong>Compiled-in hard ceilings</strong>
      <div class="small">Daily call limit ≤ ${esc(ceilings.dailyCallLimit)} · daily budget ≤ ${esc(fmtMoney(ceilings.dailyBudgetMinor ?? 0, ceilings.currency ?? 'PKR'))} — settings can never exceed these.</div></div></div>` : ''}
    <div data-settings>${cards}</div>`;

  const send = async (updates) => {
    try {
      const r = await api('PUT', '/api/settings', { json: { updates } });
      const rejected = r.rejected ?? [];
      if (rejected.length) {
        toast('Partly applied', rejected.map((x) => x.message ?? x.reason ?? JSON.stringify(x)).join('; '), 'warn');
      } else {
        toast('Saved', `${(r.applied ?? []).length} setting(s) updated.`);
      }
      renderSettings(root, ctx);
    } catch (err) {
      if (err.code !== 'reauth_required') toast('Save failed', errMsg(err), 'err');
    }
  };

  $$('[data-save]', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.save;
      const el = $(`[data-key="${key}"]`, root);
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'number') value = Number(el.value);
      else {
        const text = el.value.trim();
        try { value = text ? JSON.parse(text) : null; } catch { value = text; }
      }
      send({ [key]: value });
    });
  });
  $$('[data-reset]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reset this setting?',
        body: '<p>The saved override is removed and the compiled-in default applies again.</p>',
        confirmLabel: 'Reset',
      });
      if (!ok) return;
      try {
        await api('DELETE', `/api/settings/${encodeURIComponent(btn.dataset.reset)}`);
        toast('Reset to default');
        renderSettings(root, ctx);
      } catch (err) {
        toast('Reset failed', errMsg(err), 'err');
      }
    });
  });
  $('[data-action=refresh]', root).addEventListener('click', () => renderSettings(root, ctx));
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderSettings(root, ctx)));
}

/* -------------------------------------------------------------- system --- */

export async function renderSystem(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> Loading system…</div>`;
  let sys, users, integ, liftRes;
  try {
    [sys, users, integ, liftRes] = await Promise.all([
      api('GET', '/api/system'),
      ctx.user?.role === 'owner' ? api('GET', '/api/auth/users').catch(() => ({ users: [] })) : Promise.resolve(null),
      api('GET', '/api/integrations').catch(() => null),
      // Phase 11B: owner-only unsuppression review queue.
      ctx.user?.role === 'owner' ? api('GET', '/api/suppression/candidates').catch(() => null) : Promise.resolve(null),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="banner danger"><div>${esc(errMsg(err))}</div></div>`;
    return;
  }

  const provHtml = (sys.providers ?? []).map((p) => `<div class="card">
    <div class="card-head"><h2>${esc(p.label ?? p.key)}</h2>
      ${p.state === 'configured' ? '<span class="badge ok">configured</span>'
        : p.state === 'partial' ? '<span class="badge warn">partial</span>'
        : p.state === 'error' ? '<span class="badge danger">error</span>'
        : '<span class="badge muted">unconfigured</span>'}</div>
    ${(p.features ?? []).length ? `<p class="small">Supports: ${esc((p.features ?? []).join(', '))}</p>` : ''}
    ${(p.missing ?? []).length ? `<p class="small" style="color:var(--warn)">Missing: ${esc((p.missing ?? []).join(', '))}</p>` : ''}
    ${(p.requiredSetup ?? []).length ? `<ul class="small muted">${(p.requiredSetup ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  </div>`).join('');

  // ---- Phase 11A integrations panel (per-integration controls) ----
  const isOwner = ctx.user?.role === 'owner';
  const integHtml = renderIntegrationsPanel(integ, isOwner);

  // ---- Phase 11B: opt-in unsuppression review queue (owner only) ----
  const liftCandidates = liftRes?.candidates ?? [];
  const reviewHtml = isOwner
    ? `<div class="card"><div class="card-head"><h2>Suppression review queue</h2></div>
        <p class="muted small">Leads with a suppression record who later sent an opt-in or consent message.
        Lifting never happens automatically: each decision needs your reason and is written to the audit trail.
        The suppression row and its evidence are never deleted — only marked as lifted.</p>
        ${tableHtml({
          head: ['Lead', 'Scope', 'Suppression', 'New opt-in evidence', 'Suppressed since', 'Decision'],
          rows: liftCandidates.map((c) => `<tr>
            <td><strong>${esc(c.displayName)}</strong><div class="muted small">${esc(c.businessId)}</div></td>
            <td class="small">${esc(c.scope)}</td>
            <td class="small">${esc(c.reason)}${c.permanent ? ' <span class="badge warn">permanent</span>' : ''}${c.evidence ? `<div class="muted small">${esc(c.evidence)}</div>` : ''}</td>
            <td class="muted small">${esc(c.optInSummary)}<div>${esc(fmtDateTime(c.optInAt))}</div></td>
            <td class="muted small">${esc(fmtDateTime(c.suppressedAt))}</td>
            <td class="nowrap">
              <button class="btn sm primary" data-lift-suppression="${esc(c.suppressionId)}">Lift</button>
              <button class="btn sm ghost" data-keep-suppression="${esc(c.suppressionId)}">Keep</button>
            </td>
          </tr>`),
          empty: 'Nothing is waiting for review.',
        })}
      </div>`
    : '';

  const jobRows = (sys.recent_jobs ?? sys.recentJobs ?? []).map((j) => `<tr>
    <td>${esc(j.job_name)}</td>
    <td>${j.status === 'ok' ? '<span class="badge ok">ok</span>' : j.status === 'noop' ? '<span class="badge muted">noop</span>' : `<span class="badge danger">${esc(j.status)}</span>`}</td>
    <td class="muted small">${esc(fmtDateTime(j.started_at))}</td>
    <td class="muted small">${esc(j.detail ?? '')}</td>
    <td class="muted small">${esc(j.error ?? '')}</td>
  </tr>`);

  const incidentRows = (sys.incidents ?? []).map((i) => `<tr>
    <td>${sevBadge(i.severity)}</td>
    <td>${esc(i.title)}<div class="muted small">${esc(i.component ?? '')}</div></td>
    <td>${esc(label(i.status))}</td>
    <td class="muted small">${esc(fmtDateTime(i.detected_at))}</td>
  </tr>`);

  const userRows = (users?.users ?? []).map((u) => `<tr>
    <td>${esc(u.displayName ?? u.display_name)}</td>
    <td class="small">${esc(u.email)}</td>
    <td>${u.role === 'owner' ? '<span class="badge info">owner</span>' : '<span class="badge muted">staff</span>'}</td>
    <td class="muted small">${u.lastLoginAt ?? u.last_login_at ? esc(fmtDateTime(u.lastLoginAt ?? u.last_login_at)) : 'never'}</td>
    <td class="nowrap">${ctx.user?.role === 'owner' && u.id !== ctx.user.id
      ? `<button class="btn sm ghost" data-revoke="${esc(u.id)}">Revoke sessions</button>` : ''}</td>
  </tr>`);

  root.innerHTML = `
    <div class="page-head">
      <div><h1>System</h1><p class="desc">Runtime, integrations, background jobs and user accounts.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    <div class="grid cols-4">
      <div class="stat"><div class="label">Status</div>
        <div class="value sm">${sys.status === 'ok' ? 'OK' : 'Degraded'}</div>
        <div class="hint">${sys.status === 'ok' ? 'All migrations applied' : 'Pending migrations or DB issue'}</div></div>
      <div class="stat"><div class="label">Node</div><div class="value sm">${esc(sys.node)}</div>
        <div class="hint">up ${esc(Math.round(sys.uptimeSeconds ?? 0))}s</div></div>
      <div class="stat"><div class="label">Database</div>
        <div class="value sm">${sys.database?.ok ? 'OK' : 'Error'}</div>
        <div class="hint">${esc(sys.database?.path ?? '')}</div></div>
      <div class="stat"><div class="label">Mode</div>
        <div class="value sm">${esc(titleCase(sys.operatingState?.mode ?? 'unknown'))}</div>
        <div class="hint">${sys.summary?.reason ? esc(sys.summary.reason) : ''}</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">${provHtml || '<div class="empty">No providers reported.</div>'}</div>
    ${integHtml}
    ${reviewHtml}
    <div class="card"><div class="card-head"><h2>Background jobs</h2></div>
      ${tableHtml({ head: ['Job', 'Status', 'Started', 'Detail', 'Error'], rows: jobRows, empty: 'No job runs yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Incidents</h2></div>
      ${tableHtml({ head: ['Severity', 'Incident', 'Status', 'Detected'], rows: incidentRows, empty: 'No incidents recorded.' })}</div>
    ${users ? `
    <div class="card"><div class="card-head"><h2>Users</h2>
      <button class="btn sm primary" data-action="adduser">Add user</button></div>
      ${tableHtml({ head: ['Name', 'Email', 'Role', 'Last sign-in', ''], rows: userRows, empty: 'No users?' })}
    </div>
    <div class="card"><div class="card-head"><h2>Change your password</h2></div>
      <form data-changepw class="inline-form">
        <label class="field"><span>Current password</span><input type="password" name="currentPassword" autocomplete="current-password" required/></label>
        <label class="field"><span>New password</span><input type="password" name="newPassword" autocomplete="new-password" required/></label>
        <button type="submit" class="btn primary">Change password</button>
      </form>
      <p class="muted small">Changing your password signs out every other session.</p>
    </div>` : ''}`;

  $('[data-action=refresh]', root).addEventListener('click', () => renderSystem(root, ctx));
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderSystem(root, ctx)));

  // ---- Phase 11A integration controls (owner only) ----
  const refreshIntegrationsBtn = $('[data-action=refresh-integrations]', root);
  if (refreshIntegrationsBtn) refreshIntegrationsBtn.addEventListener('click', () => renderSystem(root, ctx));

  $$('[data-test-integration]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Testing…';
      try {
        const out = await api('POST', `/api/integrations/${encodeURIComponent(btn.dataset.testIntegration)}/test`, { json: {} });
        const r = out.result;
        if (r.ok) toast('Connection OK', `${r.integration}: ${r.detail}`, 'ok');
        else toast('Connection failed', `${r.integration} (${r.state}): ${r.detail}`, 'err');
      } catch (err) {
        toast('Test failed', errMsg(err), 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  $$('[data-toggle-integration]', root).forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.toggleIntegration;
      const next = input.checked;
      // Optimistic UI, revert on failure.
      input.disabled = true;
      try {
        // Toggle only that one flag: merge with current toggles from the panel.
        const current = {};
        $$('[data-toggle-integration]', root).forEach((el) => {
          current[el.dataset.toggleIntegration] = el.checked;
        });
        current[key] = next;
        await api('PUT', '/api/settings', { json: { updates: { integration_toggles: current } } });
        toast(next ? 'Integration enabled' : 'Integration disabled', key);
        renderSystem(root, ctx);
      } catch (err) {
        input.checked = !next;
        toast('Toggle failed', errMsg(err), 'err');
      } finally {
        input.disabled = false;
      }
    });
  });

  // ---- Phase 11B: provider onboarding verification (owner only) ----
  $$('[data-onboard-integration]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Verifying…';
      try {
        const out = await api('POST', `/api/integrations/${encodeURIComponent(btn.dataset.onboardIntegration)}/onboard`, { json: {} });
        const rec = out.record;
        if (rec.state === 'verified') toast('Provider verified', `${rec.integration}: ${out.probe?.detail ?? 'Connection OK'}`, 'ok');
        else toast(`Verification ${rec.state}`, `${rec.integration}: ${out.probe?.detail ?? 'Probe did not pass'}`, rec.state === 'pending' ? 'warn' : 'err');
        renderSystem(root, ctx);
      } catch (err) {
        toast('Verification failed', errMsg(err), 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  // ---- Phase 11B: suppression review decisions (owner only) ----
  const reviewDecision = async (suppressionId, decision) => {
    const isLift = decision === 'lifted';
    const input = await promptDialog({
      title: isLift ? 'Lift this suppression?' : 'Keep this suppression?',
      desc: isLift
        ? 'The lead will become contactable again. Record why the new opt-in evidence justifies lifting — this is written to the audit trail and cannot be undone silently.'
        : 'The suppression stays active. Record why the lift request is being declined.',
      danger: isLift,
      submitLabel: isLift ? 'Lift suppression' : 'Keep suppressed',
      fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }],
    });
    if (!input) return;
    try {
      await api('POST', `/api/suppression/${encodeURIComponent(suppressionId)}/review`, {
        json: { decision, reason: input.reason },
      });
      toast(isLift ? 'Suppression lifted' : 'Suppression kept', isLift ? 'The lead is contactable again (other gates still apply).' : 'The do-not-contact record remains active.');
      renderSystem(root, ctx);
    } catch (err) {
      toast('Decision failed', errMsg(err), 'err');
    }
  };
  $$('[data-lift-suppression]', root).forEach((btn) =>
    btn.addEventListener('click', () => reviewDecision(btn.dataset.liftSuppression, 'lifted')),
  );
  $$('[data-keep-suppression]', root).forEach((btn) =>
    btn.addEventListener('click', () => reviewDecision(btn.dataset.keepSuppression, 'kept')),
  );

  $$('[data-revoke]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Revoke all sessions?',
        body: '<p>That user must sign in again everywhere.</p>',
        confirmLabel: 'Revoke',
      });
      if (!ok) return;
      try {
        await api('POST', `/api/auth/users/${encodeURIComponent(btn.dataset.revoke)}/revoke-sessions`);
        toast('Sessions revoked');
        renderSystem(root, ctx);
      } catch (err) {
        toast('Failed', errMsg(err), 'err');
      }
    });
  });

  const addBtn = $('[data-action=adduser]', root);
  if (addBtn) addBtn.addEventListener('click', async () => {
    const input = await promptDialog({
      title: 'Add user', submitLabel: 'Create user',
      fields: [
        { name: 'displayName', label: 'Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'text', required: true },
        { name: 'password', label: 'Password', type: 'text', required: true },
        { name: 'role', label: 'Role', type: 'select', value: 'staff', options: [{ value: 'staff', label: 'Staff' }, { value: 'owner', label: 'Owner' }] },
      ],
    });
    if (!input) return;
    try {
      await api('POST', '/api/auth/users', { json: input });
      toast('User created');
      renderSystem(root, ctx);
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });

  const pw = $('[data-changepw]', root);
  if (pw) pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/auth/change-password', {
        json: { currentPassword: pw.elements.currentPassword.value, newPassword: pw.elements.newPassword.value },
      });
      toast('Password changed', 'Other sessions were signed out.');
      pw.reset();
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });
}
