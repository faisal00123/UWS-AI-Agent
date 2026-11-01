/**
 * Leads board: filtered list, CSV/XLSX import (preview → commit), new lead.
 */
import {
  $, $$, api, esc, errMsg, toast, promptDialog, confirmDialog, bandBadge, stageBadge, eligBadge,
  fmtDateTime, fmtBytes, tableHtml, STAGES, titleCase, label,
} from '../lib.js';

const state = {
  q: '',
  stage: '',
  eligibility: '',
  needsReview: false,
  duplicatesOnly: false,
  sort: 'score',
  order: 'desc',
  page: 1,
  pageSize: 25,
};

function querystring() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.stage) p.set('stage', state.stage);
  if (state.eligibility) p.set('eligibility', state.eligibility);
  if (state.needsReview) p.set('needsReview', 'true');
  if (state.duplicatesOnly) p.set('duplicatesOnly', 'true');
  p.set('sort', state.sort);
  p.set('order', state.order);
  p.set('page', String(state.page));
  p.set('pageSize', String(state.pageSize));
  return p.toString();
}

function importPreviewHtml(preview) {
  const rows = (preview.rows ?? []).slice(0, 200).map((r) => {
    const status =
      r.status === 'imported' ? '<span class="badge ok">imported</span>'
      : r.status === 'merged' ? '<span class="badge info">merged</span>'
      : r.status === 'needs_review' ? '<span class="badge warn">needs review</span>'
      : '<span class="badge danger">rejected</span>';
    const dup = r.duplicate
      ? `<span class="muted small">${esc(r.duplicate.strategy)} · ${esc(r.duplicate.score)}${r.duplicate.autoMerge ? ' · auto-merge' : ''}</span>`
      : '';
    return `<tr>
      <td class="muted small">${esc(r.line)}</td>
      <td>${esc(r.name ?? r.candidate?.displayName ?? r.raw?.name ?? '')}</td>
      <td>${status} ${dup}</td>
      <td class="small">${(r.problems ?? []).map(esc).join('; ')}</td>
    </tr>`;
  });
  return `
    <div class="grid cols-4" style="margin-bottom:12px">
      <div class="stat"><div class="label">Rows</div><div class="value sm">${esc(preview.totalRows)}</div></div>
      <div class="stat"><div class="label">Will import</div><div class="value sm">${esc(preview.imported)}</div></div>
      <div class="stat"><div class="label">Merged</div><div class="value sm">${esc(preview.merged)}</div></div>
      <div class="stat"><div class="label">Needs review</div><div class="value sm">${esc(preview.needsReview)}</div></div>
    </div>
    ${(preview.unmappedHeaders ?? []).length
      ? `<p class="small muted">Unmapped headers (ignored): ${esc((preview.unmappedHeaders ?? []).join(', '))}</p>`
      : ''}
    ${(preview.parseErrors ?? []).length
      ? `<div class="banner warn"><div><strong>Parse problems</strong>
          <ul class="small">${(preview.parseErrors ?? []).map((e) => `<li>Line ${esc(e.line)}: ${esc(e.message)}</li>`).join('')}</ul>
        </div></div>`
      : ''}
    ${tableHtml({
      head: ['Line', 'Name', 'Outcome', 'Problems'],
      rows,
      empty: 'No rows found in this file.',
    })}`;
}

async function runImport(root) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.xlsx,text/csv';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes('sheet');
    try {
      let preview;
      let commit;
      if (isXlsx) {
        const buf = await file.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const json = { format: 'xlsx', filename: file.name, base64: btoa(bin) };
        preview = await api('POST', '/api/leads/import/preview', { json });
        commit = async () => api('POST', '/api/leads/import', { json });
      } else {
        const text = await file.text();
        const raw = { raw: text, contentType: 'text/csv' };
        preview = await api('POST', '/api/leads/import/preview', raw);
        commit = async () => api('POST', '/api/leads/import', raw);
      }

      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `<div class="modal wide">
        <div class="modal-head"><h2>Import preview — ${esc(file.name)} (${esc(fmtBytes(file.size))})</h2>
          <button class="btn sm ghost" data-close>✕</button></div>
        <div data-preview>${importPreviewHtml(preview)}</div>
        <div class="modal-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn primary" data-commit ${preview.totalRows === 0 ? 'disabled' : ''}>Commit import</button>
        </div>
      </div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      $('[data-close]', back).addEventListener('click', close);
      $('[data-cancel]', back).addEventListener('click', close);
      $('[data-commit]', back).addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const result = await commit();
          close();
          toast('Import committed',
            `${result.imported} imported, ${result.merged} merged, ${result.needsReview} need review, ${result.rejected} rejected.`);
          state.page = 1;
          renderList(root);
        } catch (err) {
          toast('Import failed', errMsg(err), 'err');
          e.target.disabled = false;
        }
      });
    } catch (err) {
      toast('Preview failed', errMsg(err), 'err');
    }
  });
  input.click();
}

async function newLead(root) {
  const input = await promptDialog({
    title: 'Add a lead manually',
    submitLabel: 'Create lead',
    fields: [
      { name: 'displayName', label: 'Business name', type: 'text', required: true },
      { name: 'websiteUrl', label: 'Website URL', type: 'text', placeholder: 'https://…' },
      { name: 'phoneE164', label: 'Phone (E.164)', type: 'text', placeholder: '+92…' },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'city', label: 'City', type: 'text' },
      { name: 'category', label: 'Category', type: 'text', placeholder: 'e.g. restaurant' },
      { name: 'contactPersonName', label: 'Contact person', type: 'text' },
      { name: 'requirements', label: 'Requirements / notes', type: 'textarea' },
    ],
  });
  if (!input) return;
  try {
    const payload = {};
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' && v.trim() !== '') payload[k] = v.trim();
    }
    if (!payload.displayName) {
      toast('Not created', 'A business name is required.', 'warn');
      return;
    }
    const result = await api('POST', '/api/leads', { json: payload });
    toast('Lead created', payload.displayName);
    state.page = 1;
    renderList(root);
    return result;
  } catch (err) {
    toast('Create failed', errMsg(err), 'err');
  }
}

async function renderList(root) {
  const container = $('[data-list]', root);
  container.innerHTML = `<div class="loading"><span class="spinner"></span> Loading leads…</div>`;
  try {
    const res = await api('GET', `/api/leads?${querystring()}`);
    const rows = (res.items ?? []).map((l) => `<tr class="clickable" data-id="${esc(l.id)}">
      <td><strong>${esc(l.displayName)}</strong>
        <div class="muted small">${esc(l.city ?? '')}${l.city && l.category ? ' · ' : ''}${esc(l.category ?? '')}</div></td>
      <td>${stageBadge(l.stage)}</td>
      <td>${l.score === null ? '<span class="muted">—</span>' : `${esc(l.score)} ${bandBadge(l.scoreBand)}`}</td>
      <td>${eligBadge(l.eligibilityState)}</td>
      <td class="small">${esc(l.phoneE164 ?? l.email ?? '—')}</td>
      <td class="muted small nowrap">${esc(fmtDateTime(l.updatedAt))}</td>
    </tr>`);
    const total = res.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / (res.pageSize || state.pageSize)));
    container.innerHTML = `
      ${tableHtml({ head: ['Business', 'Stage', 'Score', 'Eligibility', 'Contact', 'Updated'], rows, empty: 'No leads match these filters.' })}
      <div class="pager">
        <span class="muted small">${total} lead${total === 1 ? '' : 's'} · page ${res.page ?? 1} of ${pages}</span>
        <button class="btn sm" data-prev ${(res.page ?? 1) <= 1 ? 'disabled' : ''}>← Prev</button>
        <button class="btn sm" data-next ${(res.page ?? 1) >= pages ? 'disabled' : ''}>Next →</button>
      </div>`;
    const prev = $('[data-prev]', container);
    const next = $('[data-next]', container);
    if (prev) prev.addEventListener('click', () => { state.page -= 1; renderList(root); });
    if (next) next.addEventListener('click', () => { state.page += 1; renderList(root); });
    $$('tr.clickable', container).forEach((tr) => {
      tr.addEventListener('click', () => { location.hash = `#/leads/${tr.dataset.id}`; });
    });
  } catch (err) {
    container.innerHTML = `<div class="banner danger"><div><strong>Failed to load leads.</strong> ${esc(errMsg(err))}</div></div>`;
  }
}

export async function renderLeads(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p class="desc">Discovered and imported Pakistani businesses, scored and deduplicated.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="discover">Discover (OpenStreetMap)</button>
        <button class="btn" data-action="import">Import CSV / Excel</button>
        <button class="btn primary" data-action="new">New lead</button>
      </div>
    </div>
    <div class="card tight">
      <form class="inline-form" data-filters>
        <label class="field"><span>Search</span>
          <input type="search" name="q" value="${esc(state.q)}" placeholder="name, city, phone…"/></label>
        <label class="field"><span>Stage</span>
          <select name="stage">
            <option value="">All stages</option>
            ${STAGES.map((s) => `<option value="${esc(s)}" ${state.stage === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}
          </select></label>
        <label class="field"><span>Eligibility</span>
          <select name="eligibility">
            <option value="">Any</option>
            ${['eligible', 'ineligible', 'needs_review'].map((s) => `<option value="${esc(s)}" ${state.eligibility === s ? 'selected' : ''}>${esc(titleCase(s))}</option>`).join('')}
          </select></label>
        <label class="field"><span>Sort</span>
          <select name="sort">
            ${[['score', 'Score'], ['discovered_at', 'Discovered'], ['name', 'Name'], ['stage', 'Stage']]
              .map(([v, l]) => `<option value="${esc(v)}" ${state.sort === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Order</span>
          <select name="order">
            <option value="desc" ${state.order === 'desc' ? 'selected' : ''}>Desc</option>
            <option value="asc" ${state.order === 'asc' ? 'selected' : ''}>Asc</option>
          </select></label>
        <label class="field"><span>&nbsp;</span>
          <span class="btn-row">
            <label class="small"><input type="checkbox" name="needsReview" ${state.needsReview ? 'checked' : ''}/> Needs review</label>
            <label class="small"><input type="checkbox" name="duplicatesOnly" ${state.duplicatesOnly ? 'checked' : ''}/> Duplicates only</label>
          </span></label>
        <button type="submit" class="btn primary">Apply</button>
      </form>
    </div>
    <div data-list></div>`;

  $('[data-filters]', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    state.q = f.elements.q.value.trim();
    state.stage = f.elements.stage.value;
    state.eligibility = f.elements.eligibility.value;
    state.sort = f.elements.sort.value;
    state.order = f.elements.order.value;
    state.needsReview = f.elements.needsReview.checked;
    state.duplicatesOnly = f.elements.duplicatesOnly.checked;
    state.page = 1;
    renderList(root);
  });
  $('[data-action=import]', root).addEventListener('click', () => runImport(root));
  $('[data-action=new]', root).addEventListener('click', () => newLead(root));

  // Phase 12: lead discovery run (OpenStreetMap/Overpass — free, public data).
  $('[data-action=discover]', root).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Discover leads on OpenStreetMap?',
      body: `<p>Searches public OpenStreetMap data (free Overpass API, no customer is contacted)
        for the categories and cities configured in the discovery policy, then creates leads
        through the normal import pipeline — duplicates are detected and merged automatically.</p>
        <p class="muted small">Works in simulation mode. Coverage in Pakistan is good for named
        businesses with a published phone, and thinner than commercial directories.</p>`,
      confirmLabel: 'Run discovery',
    });
    if (!ok) return;
    try {
      const out = await api('POST', '/api/discovery/run', { json: {} });
      const r = out.run;
      const cityErrors = (r.cityResults ?? []).filter((c) => c.error);
      toast(
        'Discovery finished',
        `${r.hits} hit(s): ${r.created} new, ${r.pendingReview} need review, ${r.merged} merged` +
          `${cityErrors.length ? `, ${cityErrors.length} city error(s)` : ''}.`,
        r.created > 0 ? 'ok' : 'warn',
      );
      await renderList(root);
    } catch (err) {
      toast('Discovery failed', errMsg(err), 'err');
    }
  });

  await renderList(root);
}

export { label };
