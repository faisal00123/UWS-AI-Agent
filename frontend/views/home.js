/**
 * Login screen + dashboard home (operating state, guards, system snapshot).
 */
import {
  $, api, esc, errMsg, toast, confirmDialog, promptDialog, promptReauth,
  fmtDateTime, tableHtml, sevBadge, titleCase,
} from '../lib.js';

export function renderLogin(root, { onSuccess }) {
  root.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="logo">
          <div class="name">UWS AI Sales Agent</div>
          <div class="sub">Universal Web Solutions — operations console</div>
        </div>
        <form>
          <label class="field"><span>Email</span>
            <input type="email" name="email" autocomplete="username" required/>
          </label>
          <label class="field"><span>Password</span>
            <input type="password" name="password" autocomplete="current-password" required/>
          </label>
          <p class="small hidden" data-err style="color:var(--danger)"></p>
          <button type="submit" class="btn primary block">Sign in</button>
        </form>
        <p class="small muted" style="margin-top:14px">
          Outreach is disabled until the owner activates it. Restarting the
          service pauses all outbound activity.
        </p>
      </div>
    </div>`;

  const form = $('form', root);
  const errEl = $('[data-err]', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.classList.add('hidden');
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      await api('POST', '/api/auth/login', {
        json: { email: form.elements.email.value, password: form.elements.password.value },
        retry: false,
      });
      onSuccess();
    } catch (err) {
      errEl.textContent = errMsg(err);
      errEl.classList.remove('hidden');
      btn.disabled = false;
    }
  });
}

function stateBanner(state, summary) {
  if (state.emergency_stop) {
    return `<div class="banner danger">
      <div><strong>EMERGENCY STOP is active.</strong>
        <div class="small">${esc(summary?.reason ?? '')}</div>
        <div class="small muted">Triggered ${esc(fmtDateTime(state.emergency_stop_at))} by ${esc(state.emergency_stop_by ?? 'unknown')}.</div>
      </div>
      <div class="btn-row" data-state-actions></div>
    </div>`;
  }
  if (state.paused) {
    return `<div class="banner warn">
      <div><strong>Paused — manual owner resume required.</strong>
        <div class="small">${esc(summary?.reason ?? '')}</div>
        <div class="small muted">The system starts paused after every restart and never auto-resumes outbound activity.</div>
      </div>
      <div class="btn-row" data-state-actions></div>
    </div>`;
  }
  if (state.mode === 'live') {
    return `<div class="banner danger">
      <div><strong>LIVE mode.</strong> Real customers can be contacted.
        <div class="small muted">${esc(summary?.reason ?? '')}</div>
      </div>
      <div class="btn-row" data-state-actions></div>
    </div>`;
  }
  return `<div class="banner info">
    <div><strong>Simulation mode.</strong> Actions are simulated and never contact real customers.
      <div class="small muted">${esc(summary?.reason ?? '')}</div>
    </div>
    <div class="btn-row" data-state-actions></div>
  </div>`;
}

function resumeChecksHtml(evaluation) {
  if (!evaluation || !Array.isArray(evaluation.checks) || evaluation.checks.length === 0) return '';
  const rows = evaluation.checks.map(
    (c) => `<tr>
      <td>${c.ok ? '<span class="badge ok">pass</span>' : c.required ? '<span class="badge danger">fail</span>' : '<span class="badge warn">note</span>'}</td>
      <td>${esc(c.label)}${c.required ? '' : ' <span class="muted small">(informational)</span>'}</td>
      <td class="muted small">${esc(c.detail ?? '')}</td>
    </tr>`,
  );
  return `<div class="card">
    <div class="card-head"><h2>Resume readiness</h2>
      <span class="badge ${evaluation.canResume ? 'ok' : 'danger'}">${evaluation.canResume ? 'ready' : 'blocked'}</span>
    </div>
    ${tableHtml({ head: ['', 'Check', 'Detail'], rows, empty: 'No checks recorded.' })}
  </div>`;
}

export async function renderDashboard(root, ctx) {
  root.innerHTML = `<div class="loading"><span class="spinner"></span> Loading operating state…</div>`;

  let data;
  let system;
  try {
    [data, system] = await Promise.all([
      api('GET', '/api/state'),
      api('GET', '/api/system').catch(() => null),
    ]);
  } catch (err) {
    root.innerHTML = `<div class="banner danger"><div><strong>Failed to load.</strong> ${esc(errMsg(err))}</div></div>`;
    return;
  }

  const { state, summary, resume } = data;
  ctx.cachedState = state;

  const isOwner = ctx.user?.role === 'owner';

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="desc">Operating state, safeguards and system health at a glance.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="refresh">Refresh</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    ${stateBanner(state, summary)}
    <div class="grid cols-4">
      <div class="stat"><div class="label">Mode</div><div class="value sm">${esc(titleCase(state.mode))}</div>
        <div class="hint">${state.mode === 'simulation' ? 'No real contact happens' : 'Real outreach is possible'}</div></div>
      <div class="stat"><div class="label">Outreach</div><div class="value sm">${summary.outreach_enabled ? 'Enabled' : 'Blocked'}</div>
        <div class="hint">${esc(summary.reason)}</div></div>
      <div class="stat"><div class="label">Restarts</div><div class="value sm">${esc(state.restart_count)}</div>
        <div class="hint">Last update ${esc(fmtDateTime(state.updated_at))}</div></div>
      <div class="stat"><div class="label">Provider</div><div class="value sm">${system ? esc(system.database?.ok ? 'DB ok' : 'DB degraded') : '—'}</div>
        <div class="hint">${system ? `Node ${esc(system.node)} · up ${esc(Math.round(system.uptime_seconds ?? system.uptimeSeconds ?? 0))}s` : 'System endpoint unavailable'}</div></div>
    </div>
    <div data-resume>${resumeChecksHtml(resume)}</div>
    <div data-system></div>
    <div data-incidents></div>`;

  // State action buttons (owner: resume / mode; everyone: stop).
  const actions = $('[data-state-actions]', root);
  const refresh = () => renderDashboard(root, ctx);

  if (isOwner) {
    if (state.emergency_stop || state.paused) {
      const b = document.createElement('button');
      b.className = 'btn success sm';
      b.textContent = 'Resume outreach';
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Resume outreach?',
          danger: true,
          confirmLabel: 'Resume (owner only)',
          body: `<p>All safety checks are re-evaluated before outreach continues. Review the readiness table below first.</p>
            ${resumeChecksHtml(resume)}`,
        });
        if (!ok) return;
        try {
          await api('POST', '/api/state/resume', { json: { clearEmergencyStop: true } });
          toast('Resumed', 'Outreach may continue.');
          refresh();
        } catch (err) {
          if (err.code !== 'reauth_required') toast('Resume failed', errMsg(err), 'err');
        }
      });
      actions.appendChild(b);
    }
    const modeBtn = document.createElement('button');
    modeBtn.className = state.mode === 'live' ? 'btn sm' : 'btn primary sm';
    modeBtn.textContent = state.mode === 'live' ? 'Switch to simulation' : 'Switch to LIVE';
    modeBtn.addEventListener('click', async () => {
      if (state.mode === 'live') {
        const ok = await confirmDialog({
          title: 'Return to simulation mode?',
          body: '<p>All outbound activity reverts to simulation. This is always safe.</p>',
          confirmLabel: 'Switch to simulation',
        });
        if (!ok) return;
        try {
          await api('POST', '/api/state/mode', { json: { mode: 'simulation' } });
          toast('Mode changed', 'Simulation mode active.');
          refresh();
        } catch (err) {
          toast('Failed', errMsg(err), 'err');
        }
        return;
      }
      const ok = await confirmDialog({
        title: 'Activate LIVE mode?',
        danger: true,
        confirmLabel: 'Continue',
        body: `<p>In live mode the system may place real calls and send real WhatsApp
          messages to customers, subject to the daily limits, calling window,
          consent rules and the suppression list.</p>
          <p class="muted small">You will be asked to type a confirmation phrase and to
          confirm your password. Live mode also requires a VERIFIED telephony provider
          (Run provider verification on the System page first). Review the
          settings (limits, budget, calling hours) before activating.</p>`,
      });
      if (!ok) return;
      // Phase 11B: typed confirmation — the phrase must be entered exactly, so
      // no stray click or scripted form can enable live outreach.
      const typed = await promptDialog({
        title: 'Type GO LIVE to confirm',
        desc: 'This enables real outreach. Type GO LIVE in capital letters to confirm you understand.',
        danger: true,
        submitLabel: 'Enable live mode',
        fields: [{ name: 'confirmation', label: 'Confirmation phrase', type: 'text', required: true, placeholder: 'GO LIVE' }],
      });
      if (!typed) return;
      if (typed.confirmation !== 'GO LIVE') {
        toast('Confirmation did not match', 'Type GO LIVE exactly (capital letters). Nothing was changed.', 'err');
        return;
      }
      try {
        await api('POST', '/api/state/mode', { json: { mode: 'live', confirmation: 'GO LIVE' } });
        toast('Mode changed', 'LIVE mode active — real outreach is possible.', 'warn');
        refresh();
      } catch (err) {
        if (err.code !== 'reauth_required') toast('Failed', errMsg(err), 'err');
      }
    });
    actions.appendChild(modeBtn);
  }

  // System panel (providers + recent jobs).
  if (system) {
    const provHtml = (system.providers ?? [])
      .map(
        (p) => `<div class="stat">
          <div class="label">${esc(p.label ?? p.key)}</div>
          <div class="value sm">${esc(titleCase(p.state))}</div>
          <div class="hint">${p.state === 'configured' ? 'Ready' : (p.missing ?? []).length ? `Missing: ${esc((p.missing ?? []).join(', '))}` : 'Not configured'}</div>
        </div>`,
      )
      .join('');
    const jobs = system.recent_jobs ?? system.recentJobs ?? [];
    const jobRows = (jobs ?? []).map(
      (j) => `<tr>
        <td>${esc(j.job_name)}</td>
        <td>${j.status === 'ok' ? '<span class="badge ok">ok</span>' : j.status === 'noop' ? '<span class="badge muted">noop</span>' : `<span class="badge danger">${esc(j.status)}</span>`}</td>
        <td class="muted small">${esc(fmtDateTime(j.started_at))}</td>
        <td class="muted small">${esc(j.error ?? '')}</td>
      </tr>`,
    );
    $('[data-system]', root).innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Integrations</h2>
          <span class="muted small">Credentials are never shown here — run <code>npm run doctor</code> for details.</span></div>
        <div class="grid cols-3">${provHtml || '<span class="muted">No providers reported.</span>'}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Recent background jobs</h2></div>
        ${tableHtml({ head: ['Job', 'Status', 'Started', 'Error'], rows: jobRows, empty: 'No jobs have run yet.' })}
      </div>`;
  }

  // Open incidents.
  const incidents = system?.incidents ?? [];
  if (incidents.length) {
    const rows = incidents.map(
      (i) => `<tr>
        <td>${sevBadge(i.severity)}</td>
        <td>${esc(i.title)}<div class="muted small">${esc(i.component ?? '')}</div></td>
        <td class="muted small">${esc(fmtDateTime(i.detected_at))}</td>
      </tr>`,
    );
    $('[data-incidents]', root).innerHTML = `
      <div class="card"><div class="card-head"><h2>Open incidents</h2></div>
      ${tableHtml({ head: ['Severity', 'Incident', 'Detected'], rows, empty: 'No open incidents.' })}</div>`;
  }

  $('[data-action=refresh]', root).addEventListener('click', refresh);
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(refresh));
}

export function bindStateActions(ctx) {
  // Reusable emergency-stop flow shared by the shell and the dashboard.
  ctx.requestStop = async (after) => {
    const input = await promptDialog({
      title: 'Emergency stop — all outreach',
      danger: true,
      submitLabel: 'STOP EVERYTHING',
      desc: 'Halts every outbound channel immediately. Only the owner can resume, after re-authentication.',
      fields: [{ name: 'reason', label: 'Reason (recorded in the audit trail)', type: 'text', required: true, placeholder: 'e.g. incorrect claims in AI script' }],
    });
    if (!input || !input.reason || input.reason.trim().length < 3) {
      if (input) toast('Not stopped', 'A reason of at least 3 characters is required.', 'warn');
      return false;
    }
    try {
      await api('POST', '/api/state/emergency-stop', { json: { reason: input.reason.trim() } });
      toast('STOPPED', 'All outreach is halted. Owner resume required.', 'warn');
      if (after) after();
      return true;
    } catch (err) {
      toast('Stop failed', errMsg(err), 'err');
      return false;
    }
  };
}

export { promptReauth };
