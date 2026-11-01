/**
 * Lead detail: overview, website analysis, explainable score, eligibility,
 * CRM timeline/follow-ups, outreach ledger and suppression controls.
 */
import {
  $, $$, api, esc, errMsg, toast, promptDialog, confirmDialog, bandBadge, stageBadge,
  eligBadge, decisionBadge, factorStateBadge, fmtDateTime, fmtDuration, tableHtml,
  STAGES, STAGES_REQUIRING_EVIDENCE, INTERACTION_KINDS, INTERACTION_DIRECTIONS,
  FOLLOWUP_TYPES, CHANNELS, SUPPRESSION_REASONS, titleCase, label, dash, pick,
} from '../lib.js';

const TABS = ['overview', 'analysis', 'score', 'pipeline', 'outreach', 'suppression'];

let activeTab = 'overview';

function kv(rows) {
  const html = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  return html ? `<dl class="kv">${html}</dl>` : '<p class="muted">Nothing recorded.</p>';
}

function businessRows(b) {
  return [
    ['Business', b.display_name],
    ['Category', b.category],
    ['City', b.city],
    ['Address', b.address],
    ['Website', b.website_url],
    ['Phone', b.phone_e164],
    ['WhatsApp', b.whatsapp_e164],
    ['Email', b.email],
    ['Contact person', b.contact_person_name],
    ['Stage', titleCase(b.stage)],
    ['Interest level', b.interest_level],
    ['Qualification', b.qualification_status],
    ['Duplicate status', b.duplicate_status],
    ['Source', b.source_type],
    ['Discovered', fmtDateTime(b.discovered_at)],
    ['Updated', fmtDateTime(b.updated_at)],
  ];
}

/* ----------------------------------------------------------- overview --- */

function overviewTab(d) {
  const sources = (d.sources ?? []).map(
    (s) => `<tr><td>${esc(s.source_type ?? s.platform ?? '')}</td>
      <td class="small">${esc(s.source_url ?? '')}</td>
      <td class="muted small">${esc(fmtDateTime(s.discovered_at ?? s.created_at))}</td></tr>`,
  );
  const contacts = (d.contactPoints ?? []).map(
    (c) => `<tr><td>${esc(label(c.kind ?? c.type ?? 'contact'))}</td>
      <td>${esc(c.value ?? '')}</td>
      <td>${c.is_primary ? '<span class="badge info">primary</span>' : ''}${c.verified_at ? '<span class="badge ok">verified</span>' : ''}</td></tr>`,
  );
  const verifications = (d.fieldVerifications ?? []).map(
    (v) => `<tr><td>${esc(label(v.field_name ?? v.field ?? ''))}</td>
      <td>${esc(label(v.state ?? v.verification_state ?? ''))}</td>
      <td class="small">${esc(v.evidence ?? '')}</td>
      <td class="muted small">${esc(fmtDateTime(v.verified_at ?? v.created_at))}</td></tr>`,
  );
  return `
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h2>Business record</h2></div>${kv(businessRows(d.business))}</div>
      <div class="card"><div class="card-head"><h2>Contact points</h2></div>
        ${tableHtml({ head: ['Kind', 'Value', 'Flags'], rows: contacts, empty: 'No contact points recorded.' })}</div>
    </div>
    <div class="card"><div class="card-head"><h2>Per-field verification</h2>
      <span class="muted small">Evidence that each field is real — not an overall "verified" flag.</span></div>
      ${tableHtml({ head: ['Field', 'State', 'Evidence', 'When'], rows: verifications, empty: 'No field verifications yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Sources</h2></div>
      ${tableHtml({ head: ['Source', 'URL', 'Discovered'], rows: sources, empty: 'No sources recorded.' })}</div>`;
}

/* ------------------------------------------------------------ analysis --- */

function analysisTab(d, id, ctx) {
  const items = (d.analyses ?? []).map((a) => {
    let facts = {};
    try { facts = JSON.parse(a.facts_json ?? '{}'); } catch { facts = {}; }
    const reach = a.reachability ?? a.fetch_state ?? a.status ?? '';
    return `<div class="card">
      <div class="card-head">
        <h2>${esc(titleCase(reach))} <span class="muted small">${esc(fmtDateTime(a.fetched_at ?? a.created_at))}</span></h2>
        ${a.http_status ? `<span class="badge ${a.http_status < 400 ? 'ok' : 'warn'}">HTTP ${esc(a.http_status)}</span>` : ''}
      </div>
      ${kv([
        ['URL', a.url ?? a.website_url],
        ['Reachability', reach],
        ['HTTP status', a.http_status],
        ['Fetch error', a.fetch_error],
        ['Analysis error', a.error ?? a.analysis_error],
      ])}
      <details ${Object.keys(facts).length ? 'open' : ''}>
        <summary class="muted small">Extracted facts (${Object.keys(facts).length})</summary>
        <pre class="pre" style="margin-top:8px">${esc(JSON.stringify(facts, null, 2))}</pre>
      </details>
      ${a.not_measured_json ? `<details><summary class="muted small">Explicitly NOT measured</summary>
        <pre class="pre" style="margin-top:8px">${esc(a.not_measured_json)}</pre></details>` : ''}
    </div>`;
  }).join('');

  return `
    <div class="card tight"><div class="btn-row">
      <button class="btn primary" data-action="analyze">Analyze website now</button>
      <span class="muted small">An unreachable site is a real finding, not an error — it is recorded as such.</span>
    </div></div>
    ${items || '<div class="empty">No analysis yet. Run one to measure the website.</div>'}`;
}

/* --------------------------------------------------------------- score --- */

function scoreTab(d) {
  const entries = d.scores ?? [];
  if (!entries.length) return '<div class="empty">No score computed yet.</div>';
  return entries.map(({ score, factors }) => {
    const bandClass = { very_high: 'band-A', high: 'band-B', medium: 'band-C', low: 'band-D' }[score.band] ?? '';
    const maxAbs = Math.max(1, ...(factors ?? []).map((f) => Math.abs(Number(f.points) || 0)));
    const factorRows = (factors ?? []).map((f) => {
      const pts = Number(f.points) || 0;
      const pct = Math.min(100, Math.round((Math.abs(pts) / maxAbs) * 100));
      return `<tr>
        <td>${esc(f.label)}<div class="muted small mono">${esc(f.code)}</div></td>
        <td class="right mono">${pts >= 0 ? '+' : ''}${pts.toFixed(1)}</td>
        <td class="muted small right mono">w=${esc(f.weight)}</td>
        <td>${factorStateBadge(f.state)}</td>
        <td class="small">${esc(f.raw_value === 'unknown' ? 'unknown' : String(f.raw_value))}</td>
        <td class="small muted">${esc(f.evidence ?? '')}</td>
        <td style="min-width:90px"><div class="bar" style="height:6px;background:var(--bg-alt);border-radius:4px;overflow:hidden">
          <i style="display:block;height:100%;width:${pct}%;background:${pts >= 0 ? 'var(--ok)' : 'var(--danger)'}"></i></div></td>
      </tr>`;
    });
    return `<div class="card">
      <div class="card-head">
        <div style="display:flex;align-items:center;gap:14px">
          <span class="score-ring ${bandClass}">${esc(score.score)}</span>
          <div><h2 style="margin:0">${esc(titleCase(score.band))}</h2>
            <span class="muted small">model ${esc(score.model_version)} · ${esc(fmtDateTime(score.computed_at))}</span></div>
        </div>
        ${bandBadge(score.band)}
      </div>
      <p>${esc(score.summary)}</p>
      ${tableHtml({
        head: ['Factor', 'Points', 'Weight', 'Evidence state', 'Observed', 'Note', ''],
        rows: factorRows,
        empty: 'No factors recorded.',
      })}
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------- eligibility --- */

function eligibilityTab(d, id, ctx) {
  const checks = (d.eligibility ?? []).map((e) => {
    let reasons = [];
    try { reasons = JSON.parse(e.reasons_json ?? '[]'); } catch { reasons = []; }
    const reasonList = Array.isArray(reasons) && reasons.length
      ? `<ul class="small muted" style="margin:4px 0 0 18px">${reasons.map((r) => `<li>${esc(typeof r === 'string' ? r : (r.detail ?? JSON.stringify(r)))}</li>`).join('')}</ul>`
      : '';
    return `<tr>
      <td>${esc(label(e.channel))}</td>
      <td>${eligBadge(e.decision)}</td>
      <td class="small">${esc(e.decision_reason ?? '')}${reasonList}</td>
      <td class="muted small">${esc(fmtDateTime(e.evaluated_at ?? e.created_at))}</td>
    </tr>`;
  });
  return `
    <div class="card tight"><div class="btn-row">
      ${CHANNELS.map((c) => `<button class="btn sm" data-action="eligibility" data-channel="${esc(c)}">Evaluate ${esc(label(c))}</button>`).join('')}
      <span class="muted small">Re-evaluates consent, suppression, channel enablement and evidence, and stores the decision.</span>
    </div></div>
    ${tableHtml({ head: ['Channel', 'Decision', 'Reasons', 'Evaluated'], rows: checks, empty: 'No eligibility checks yet.' })}`;
}

/* ------------------------------------------------------------- pipeline --- */

function pipelineTab(d, id, ctx) {
  const timeline = (d.interactions ?? []).map((i) => `<li>
    <div class="t-head">
      <span class="badge ${i.kind === 'consent' ? 'ok' : i.kind === 'note' ? 'muted' : 'info'}">${esc(label(i.kind))}</span>
      ${i.direction ? `<span class="muted small">${esc(label(i.direction))}</span>` : ''}
      ${i.simulation ? '<span class="badge warn">simulated</span>' : ''}
      ${i.outcome ? `<span class="muted small">${esc(i.outcome)}</span>` : ''}
    </div>
    <div class="t-body">${esc(i.summary)}</div>
    <div class="t-meta">${esc(fmtDateTime(i.created_at))}</div>
  </li>`).join('');

  const taskRows = (d.followups ?? []).map((t) => `<tr>
    <td>${esc(t.title)}<div class="muted small">${esc(label(t.type))}${t.channel ? ` · ${esc(label(t.channel))}` : ''}</div></td>
    <td class="small nowrap">${esc(fmtDateTime(t.scheduled_for))}</td>
    <td>${t.status === 'completed' ? '<span class="badge ok">completed</span>'
      : t.status === 'due' ? '<span class="badge warn">due</span>'
      : t.status === 'blocked' ? '<span class="badge danger">blocked</span>'
      : t.status === 'cancelled' ? '<span class="badge muted">cancelled</span>'
      : `<span class="badge info">${esc(t.status)}</span>`}</td>
    <td class="small muted">${esc(t.blocked_reason ?? t.cancel_reason ?? '')}</td>
    <td class="nowrap">
      ${t.status === 'due' || t.status === 'scheduled'
        ? `<button class="btn sm" data-action="run-task" data-task="${esc(t.id)}">Run (simulated)</button>
           <button class="btn sm ghost" data-action="cancel-task" data-task="${esc(t.id)}">Cancel</button>`
        : ''}
    </td>
  </tr>`);

  const stageRows = (d.stageHistory ?? []).map((h) => `<tr>
    <td>${esc(titleCase(h.from_stage ?? h.from ?? ''))} → <strong>${esc(titleCase(h.to_stage ?? h.to ?? ''))}</strong></td>
    <td class="small">${esc(h.reason ?? '')}</td>
    <td class="muted small">${esc(h.actor_label ?? h.actor ?? '')}</td>
    <td class="muted small">${esc(fmtDateTime(h.created_at))}</td>
  </tr>`);

  const currentStage = pick(d.business, 'stage');
  const stageOptions = STAGES.filter((s) => s !== currentStage)
    .map((s) => `<option value="${esc(s)}">${esc(titleCase(s))}</option>`).join('');

  return `
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h2>Advance stage</h2></div>
        <p class="muted small">Customer-facing stages (contacted / interested / qualified) require a real
        contact interaction as evidence. Only the owner can confirm a conversion (won).</p>
        <form data-advance>
          <label class="field"><span>New stage</span><select name="toStage">${stageOptions}</select></label>
          <label class="field"><span>Reason</span><input type="text" name="reason" required placeholder="why this stage change is justified"/></label>
          <label class="field"><span>Evidence (contact summary — recorded as an interaction)</span>
            <textarea name="evidence" placeholder="what the customer actually said/did"></textarea></label>
          <label class="field"><span>Direction</span>
            <select name="direction">${INTERACTION_DIRECTIONS.map((x) => `<option value="${esc(x)}" ${x === 'outbound' ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <button type="submit" class="btn primary">Advance</button>
        </form>
      </div>
      <div class="card"><div class="card-head"><h2>Record an interaction</h2></div>
        <form data-interaction>
          <label class="field"><span>Kind</span>
            <select name="kind">${INTERACTION_KINDS.map((k) => `<option value="${esc(k)}" ${k === 'note' ? 'selected' : ''}>${esc(label(k))}</option>`).join('')}</select></label>
          <label class="field"><span>Direction</span>
            <select name="direction">${INTERACTION_DIRECTIONS.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select></label>
          <label class="field"><span>Summary</span><textarea name="summary" required></textarea></label>
          <label class="field"><span>Outcome</span><input type="text" name="outcome" placeholder="e.g. interested, callback requested"/></label>
          <button type="submit" class="btn">Record</button>
        </form>
      </div>
    </div>
    <div class="card"><div class="card-head"><h2>Timeline</h2>
      <span class="muted small">Simulated actions are marked and never count as customer contact.</span></div>
      <ul class="timeline">${timeline || '<li class="muted">No interactions yet.</li>'}</ul>
    </div>
    <div class="card"><div class="card-head"><h2>Follow-ups</h2>
      <button class="btn sm" data-action="schedule">Schedule follow-up</button></div>
      ${tableHtml({ head: ['Task', 'Scheduled', 'Status', 'Notes', ''], rows: taskRows, empty: 'No follow-ups scheduled.' })}</div>
    <div class="card"><div class="card-head"><h2>Stage history</h2></div>
      ${tableHtml({ head: ['Transition', 'Reason', 'By', 'When'], rows: stageRows, empty: 'No stage changes yet.' })}</div>`;
}

/* ------------------------------------------------------------- outreach --- */

function outreachTab(d, id, ctx) {
  const attempts = (d.calls ?? []).map((c) => `<tr>
    <td class="small nowrap">${esc(fmtDateTime(c.created_at))}</td>
    <td>${c.simulation ? '<span class="badge warn">simulated</span>' : '<span class="badge danger">live</span>'}</td>
    <td>${esc(label(c.status))}</td>
    <td>${esc(label(c.outcome))}</td>
    <td class="right">${c.duration_seconds !== null && c.duration_seconds !== undefined ? esc(fmtDuration(c.duration_seconds)) : '—'}</td>
    <td class="muted small">${esc(c.scenario ?? c.transcript_summary ?? '')}</td>
  </tr>`);
  const messages = (d.messages ?? []).map((m) => `<tr>
    <td class="small nowrap">${esc(fmtDateTime(m.created_at))}</td>
    <td>${esc(label(m.channel ?? m.direction ?? ''))}</td>
    <td>${m.simulation ? '<span class="badge warn">simulated</span>' : '<span class="badge danger">live</span>'}</td>
    <td>${esc(label(m.status))}</td>
    <td class="small">${esc(m.body_preview ?? m.preview ?? '')}</td>
  </tr>`);

  return `
    <div class="card tight"><div class="btn-row">
      <button class="btn primary" data-action="call">Place call (goes through every guard)</button>
      <button class="btn" data-action="share">Share portfolio</button>
      <span class="muted small">Blocked attempts are recorded with the exact reason — nothing is silently dropped.</span>
    </div></div>
    <div class="card"><div class="card-head"><h2>Calls</h2></div>
      ${tableHtml({ head: ['When', 'Mode', 'Status', 'Outcome', 'Duration', 'Detail'], rows: attempts, empty: 'No calls yet.' })}</div>
    <div class="card"><div class="card-head"><h2>Messages</h2></div>
      ${tableHtml({ head: ['When', 'Channel', 'Mode', 'Status', 'Preview'], rows: messages, empty: 'No messages yet.' })}</div>`;
}

/* ---------------------------------------------------------- suppression --- */

function suppressionTab(d, id, ctx) {
  const rows = (d.suppression ?? []).map((s) => `<tr>
    <td>${esc(label(s.scope))}</td>
    <td><span class="badge danger">${esc(label(s.reason))}</span></td>
    <td class="small">${esc(s.evidence ?? '')}</td>
    <td>${s.permanent ? '<span class="badge muted">permanent</span>' : `<span class="muted small">until ${esc(fmtDateTime(s.until ?? s.expires_at))}</span>`}</td>
    <td class="muted small">${esc(fmtDateTime(s.created_at))}</td>
  </tr>`);
  return `
    <div class="card tight"><div class="btn-row">
      <button class="btn danger" data-action="suppress">Add to suppression list</button>
      <span class="muted small">Suppression is permanent by default and overrides every other rule.</span>
    </div></div>
    ${tableHtml({ head: ['Scope', 'Reason', 'Evidence', 'Duration', 'Added'], rows, empty: 'Not suppressed — this lead may be contacted if every other rule allows it.' })}`;
}

/* ---------------------------------------------------------- main view --- */

export async function renderLead(root, ctx, id) {
  activeTab = TABS.includes(ctx.params?.[1]) ? ctx.params[1] : activeTab;
  root.innerHTML = `<div class="loading"><span class="spinner"></span> Loading lead…</div>`;

  let d;
  try {
    d = await api('GET', `/api/leads/${encodeURIComponent(id)}`);
  } catch (err) {
    root.innerHTML = `<div class="banner danger"><div><strong>Failed to load lead.</strong> ${esc(errMsg(err))}</div></div>`;
    return;
  }
  ctx.cachedLead = d;

  const b = d.business;
  const latestScore = (d.scores ?? [])[0]?.score ?? null;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <p class="small muted" style="margin:0"><a href="#/leads">← Back to leads</a></p>
        <h1>${esc(b.display_name)}</h1>
        <div class="btn-row" style="margin-top:6px">
          ${stageBadge(b.stage)}
          ${latestScore ? `<span class="badge">score ${esc(latestScore.score)} ${bandBadge(latestScore.band)}</span>` : ''}
          ${b.website_url ? `<a class="muted small" href="${esc(b.website_url)}" target="_blank" rel="noopener noreferrer">${esc(b.website_url)}</a>` : ''}
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" data-action="edit">Edit fields</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    <div class="tabs">
      ${TABS.map((t) => `<button data-tab="${esc(t)}" class="${t === activeTab ? 'active' : ''}">${esc(titleCase(t))}</button>`).join('')}
    </div>
    <div data-tabbody></div>`;

  const body = $('[data-tabbody]', root);

  const paint = () => {
    if (activeTab === 'overview') body.innerHTML = overviewTab(d);
    else if (activeTab === 'analysis') body.innerHTML = analysisTab(d, id, ctx);
    else if (activeTab === 'score') body.innerHTML = scoreTab(d);
    else if (activeTab === 'pipeline') body.innerHTML = pipelineTab(d, id, ctx);
    else if (activeTab === 'outreach') body.innerHTML = outreachTab(d, id, ctx);
    else if (activeTab === 'suppression') body.innerHTML = suppressionTab(d, id, ctx);
    bindTab(body, id, ctx, () => renderLead(root, ctx, id));
  };

  $$('[data-tab]', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      $$('[data-tab]', root).forEach((x) => x.classList.toggle('active', x === btn));
      paint();
    });
  });
  $('[data-action=edit]', root).addEventListener('click', () => editLead(d, () => renderLead(root, ctx, id)));
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderLead(root, ctx, id)));

  paint();
}

async function editLead(d, after) {
  const b = d.business;
  const input = await promptDialog({
    title: `Edit ${b.display_name}`,
    submitLabel: 'Save changes',
    fields: [
      { name: 'displayName', label: 'Business name', type: 'text', value: b.display_name ?? '' },
      { name: 'category', label: 'Category', type: 'text', value: b.category ?? '' },
      { name: 'city', label: 'City', type: 'text', value: b.city ?? '' },
      { name: 'websiteUrl', label: 'Website URL', type: 'text', value: b.website_url ?? '' },
      { name: 'phoneE164', label: 'Phone (E.164)', type: 'text', value: b.phone_e164 ?? '' },
      { name: 'email', label: 'Email', type: 'text', value: b.email ?? '' },
      { name: 'contactPersonName', label: 'Contact person', type: 'text', value: b.contact_person_name ?? '' },
    ],
  });
  if (!input) return;
  const fieldMap = {
    displayName: 'display_name', category: 'category', city: 'city', websiteUrl: 'website_url',
    phoneE164: 'phone_e164', email: 'email', contactPersonName: 'contact_person_name',
  };
  const updates = Object.entries(input)
    .filter(([k]) => fieldMap[k])
    .map(([k, v]) => ({ field: fieldMap[k], value: v === '' ? null : v }));
  if (!updates.length) return;
  try {
    await api('PATCH', `/api/leads/${encodeURIComponent(b.id)}`, { json: { updates } });
    toast('Saved', 'Lead fields updated.');
    after();
  } catch (err) {
    toast('Save failed', errMsg(err), 'err');
  }
}

function bindTab(body, id, ctx, reload) {
  const act = (name) => $(`[data-action="${name}"]`, body);

  // analysis
  const analyze = act('analyze');
  if (analyze) analyze.addEventListener('click', async () => {
    analyze.disabled = true;
    try {
      const rec = await api('POST', `/api/leads/${encodeURIComponent(id)}/analyze`);
      toast('Analysis recorded', `Reachability: ${titleCase(rec.reachability ?? rec.status ?? 'done')}.`);
      reload();
    } catch (err) {
      toast('Analysis failed', errMsg(err), 'err');
      analyze.disabled = false;
    }
  });

  // eligibility
  $$('[data-action="eligibility"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api('POST', `/api/leads/${encodeURIComponent(id)}/eligibility`, { json: { channel: btn.dataset.channel } });
        toast('Decision stored', `${titleCase(btn.dataset.channel)}: ${titleCase(res.decision ?? 'done')}.`);
        reload();
      } catch (err) {
        toast('Evaluation failed', errMsg(err), 'err');
        btn.disabled = false;
      }
    });
  });

  // pipeline: advance stage
  const advance = $('[data-advance]', body);
  if (advance) advance.addEventListener('submit', async (e) => {
    e.preventDefault();
    const toStage = advance.elements.toStage.value;
    const reason = advance.elements.reason.value.trim();
    const evidence = advance.elements.evidence.value.trim();
    if (STAGES_REQUIRING_EVIDENCE.has(toStage) && !evidence) {
      toast('Evidence required', `Moving to "${titleCase(toStage)}" requires a contact interaction summary.`, 'warn');
      return;
    }
    if (toStage === 'won' && ctx.user?.role !== 'owner') {
      toast('Owner only', 'Only the owner may confirm a conversion.', 'warn');
      return;
    }
    try {
      await api('POST', `/api/leads/${encodeURIComponent(id)}/advance`, {
        json: {
          toStage,
          reason,
          interaction: evidence ? { kind: 'call', direction: advance.elements.direction.value, summary: evidence } : undefined,
        },
      });
      toast('Stage advanced', `${titleCase(toStage)}.`);
      reload();
    } catch (err) {
      toast('Advance failed', errMsg(err), 'err');
    }
  });

  // pipeline: record interaction
  const inter = $('[data-interaction]', body);
  if (inter) inter.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/leads/${encodeURIComponent(id)}/interactions`, {
        json: {
          kind: inter.elements.kind.value,
          direction: inter.elements.direction.value,
          summary: inter.elements.summary.value.trim(),
          outcome: inter.elements.outcome.value.trim() || undefined,
        },
      });
      toast('Interaction recorded');
      reload();
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });

  // pipeline: schedule follow-up
  const schedule = act('schedule');
  if (schedule) schedule.addEventListener('click', async () => {
    const input = await promptDialog({
      title: 'Schedule a follow-up',
      submitLabel: 'Schedule',
      fields: [
        { name: 'type', label: 'Type', type: 'select', value: 'callback', options: FOLLOWUP_TYPES.map((t) => ({ value: t, label: titleCase(t) })) },
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'scheduledFor', label: 'When', type: 'datetime-local', value: (() => { const d = new Date(Date.now() + 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T09:00`; })() },
        { name: 'channel', label: 'Channel', type: 'select', value: 'call', options: [{ value: '', label: 'Manual (no channel)' }, ...CHANNELS.map((c) => ({ value: c, label: titleCase(c) }))] },
        { name: 'notes', label: 'Notes', type: 'textarea' },
        { name: 'requestedByCustomer', label: 'Requested by the customer (respects their chosen time)', type: 'checkbox', value: false },
      ],
    });
    if (!input || !input.title) return;
    try {
      await api('POST', `/api/leads/${encodeURIComponent(id)}/followups`, {
        json: {
          type: input.type,
          title: input.title,
          scheduledFor: new Date(input.scheduledFor).toISOString(),
          channel: input.channel || null,
          notes: input.notes || undefined,
          requestedByCustomer: input.requestedByCustomer,
        },
      });
      toast('Follow-up scheduled');
      reload();
    } catch (err) {
      toast('Scheduling failed', errMsg(err), 'err');
    }
  });

  // pipeline: run/cancel a task (simulated)
  $$('[data-action="run-task"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await api('POST', `/api/leads/${encodeURIComponent(id)}/call`, {
          json: { purpose: 'followup', taskId: btn.dataset.task },
        });
        if (res.decision === 'blocked') {
          toast('Blocked', res.attempt?.blocked_reason ?? res.attempt?.blockedReason ?? 'The guard refused this action.', 'warn');
        } else {
          toast('Simulated call completed', `Outcome: ${titleCase(res.call?.outcome ?? 'unknown')}. No real contact.`);
        }
        reload();
      } catch (err) {
        toast('Failed', errMsg(err), 'err');
        btn.disabled = false;
      }
    });
  });
  $$('[data-action="cancel-task"]', body).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = await promptDialog({
        title: 'Cancel follow-up',
        danger: true,
        submitLabel: 'Cancel task',
        fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }],
      });
      if (!input) return;
      try {
        await api('POST', `/api/followups/${encodeURIComponent(btn.dataset.task)}/cancel`, { json: { reason: input.reason } });
        toast('Task cancelled');
        reload();
      } catch (err) {
        toast('Failed', errMsg(err), 'err');
      }
    });
  });

  // outreach: call + share
  const call = act('call');
  if (call) call.addEventListener('click', async () => {
    call.disabled = true;
    try {
      const res = await api('POST', `/api/leads/${encodeURIComponent(id)}/call`, { json: { purpose: 'callback' } });
      if (res.decision === 'blocked') {
        const a = res.attempt ?? {};
        toast('Call blocked by a safeguard',
          `${a.blocked_code ?? a.blockedReason ?? 'blocked'}: ${a.blocked_reason ?? a.blockedReason ?? ''}`, 'warn');
      } else {
        toast('Call placed (simulated)', `Scenario: ${titleCase(res.call?.scenario ?? 'n/a')} · outcome ${titleCase(res.call?.outcome ?? 'n/a')}.`);
      }
      reload();
    } catch (err) {
      toast('Call failed', errMsg(err), 'err');
      call.disabled = false;
    }
  });
  const share = act('share');
  if (share) share.addEventListener('click', async () => {
    share.disabled = true;
    try {
      const res = await api('POST', `/api/leads/${encodeURIComponent(id)}/portfolio/share`, { json: {} });
      if (res.decision === 'blocked') {
        toast('Share blocked', res.attempt?.blocked_reason ?? res.attempt?.blockedReason ?? 'Guard refused.', 'warn');
      } else {
        toast('Portfolio shared (simulated)', `${(res.sent ?? res.itemIds ?? []).length || '—'} item(s).`);
      }
      reload();
    } catch (err) {
      toast('Share failed', errMsg(err), 'err');
      share.disabled = false;
    }
  });

  // suppression
  const suppress = act('suppress');
  if (suppress) suppress.addEventListener('click', async () => {
    const input = await promptDialog({
      title: 'Suppress this lead',
      desc: 'Suppression overrides every other eligibility rule and is permanent unless an end date is set.',
      danger: true,
      submitLabel: 'Suppress',
      fields: [
        { name: 'scope', label: 'Scope', type: 'select', value: 'business', options: ['business', 'phone', 'whatsapp', 'email'].map((s) => ({ value: s, label: titleCase(s) })) },
        { name: 'reason', label: 'Reason', type: 'select', value: 'opt_out', options: SUPPRESSION_REASONS.map((r) => ({ value: r, label: titleCase(r) })) },
        { name: 'evidence', label: 'Evidence (what did the customer say?)', type: 'textarea' },
        { name: 'permanent', label: 'Permanent', type: 'checkbox', value: true },
      ],
    });
    if (!input) return;
    try {
      await api('POST', `/api/leads/${encodeURIComponent(id)}/suppression`, {
        json: { scope: input.scope, reason: input.reason, evidence: input.evidence || undefined, permanent: input.permanent },
      });
      toast('Suppressed', 'This lead will not be contacted.', 'warn');
      reload();
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });
}

export { confirmDialog };
