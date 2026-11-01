/**
 * Shared utilities for the UWS dashboard SPA: escaping, formatting, the API
 * layer (CSRF + reauth retry), and the toast/modal primitives.
 *
 * CSP constraints: no inline scripts or inline event handler attributes, so
 * every interactive element is bound through addEventListener or the
 * delegated [data-action] dispatcher in app.js.
 */

/* ------------------------------------------------------------ utilities -- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape text for safe interpolation into HTML (and quoted attributes). */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Read a readable cookie value (uws_csrf is deliberately not httpOnly). */
export function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Fetch the first present, non-null value among candidate key names.
 *  Backend rows may be snake_case or camelCase depending on the endpoint. */
export function pick(obj, ...names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return null;
}

export const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const label = (s) => String(s ?? '').replace(/_/g, ' ');
export const titleCase = (s) => label(s).replace(/\b\w/g, (c) => c.toUpperCase());

export function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1048576).toFixed(1)} MB`;
  return `${(num / 1073741824).toFixed(2)} GB`;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function fmtMoney(minor, currency) {
  if (minor === null || minor === undefined) return '—';
  const v = Number(minor);
  if (!Number.isFinite(v)) return '—';
  return `${(v / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

/** Local ISO string (no timezone) for datetime-local inputs. */
export function toLocalInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ----------------------------------------------------------------- api --- */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

let reauthPromptFn = null;
/** Registered by app.js to avoid a circular import. */
export function setReauthPrompt(fn) {
  reauthPromptFn = fn;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Core fetch wrapper.
 *   api('GET',  '/api/state')
 *   api('POST', '/api/state/emergency-stop', { json: { reason } })
 *   api('POST', '/api/leads/import', { raw: csvText, contentType: 'text/csv' })
 *
 * Handles: CSRF header, JSON encoding, typed errors, and a single
 * prompt-and-retry round for `reauth_required` responses.
 */
export async function api(method, path, opts = {}) {
  const { json, raw, contentType, retry = true } = opts;
  const headers = { accept: 'application/json' };
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (raw !== undefined) {
    headers['content-type'] = contentType || 'text/csv';
    body = raw;
  }
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    headers['x-csrf-token'] = readCookie('uws_csrf') || '';
  }

  let res;
  try {
    res = await fetch(path, { method: method.toUpperCase(), headers, body, credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, 'network_error', err instanceof Error ? err.message : 'Network request failed');
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    const err = new ApiError(res.status, e.code || `http_${res.status}`, e.message || `Request failed (${res.status})`, e.details);
    if (err.code === 'reauth_required' && retry && reauthPromptFn) {
      const ok = await reauthPromptFn(err.message);
      if (ok) return api(method, path, { ...opts, retry: false });
    }
    if (err.code === 'unauthenticated') {
      document.dispatchEvent(new CustomEvent('uws:unauthenticated'));
    }
    throw err;
  }
  return data;
}

/** Human-readable error message for toasts. */
export function errMsg(err) {
  if (err instanceof ApiError) {
    let m = err.message;
    if (err.details && typeof err.details === 'object') {
      const d = err.details;
      if (typeof d.rejected === 'string') m += ` — ${d.rejected}`;
      else if (Array.isArray(d.rejected) && d.rejected.length) m += ` — ${d.rejected.map((r) => r.message ?? JSON.stringify(r)).join('; ')}`;
      else if (typeof d.reason === 'string') m += ` — ${d.reason}`;
    }
    return m;
  }
  return err instanceof Error ? err.message : String(err);
}

/* --------------------------------------------------------------- toast --- */

export function toast(title, msg, kind = 'ok') {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${msg ? `<div class="t-msg">${esc(msg)}</div>` : ''}`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 9000 : 4500);
}

/* --------------------------------------------------------------- modal --- */

/** Open a modal; returns the backdrop element. closeOnEscape defaults true. */
export function openModal(html, opts = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ${opts.wide ? 'wide' : ''}">${html}</div>`;
  document.body.appendChild(back);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back && opts.dismissible !== false) back.remove();
  });
  if (opts.dismissible !== false) {
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') back.remove();
    });
  }
  const closer = $('[data-close]', back);
  if (closer) closer.addEventListener('click', () => back.remove());
  return back;
}

export function closeModals() {
  $$('.modal-backdrop').forEach((m) => m.remove());
}

/** Promise-based confirm dialog. Resolves true when confirmed. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const back = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn sm ghost" data-close>✕</button></div>
      <div>${body ?? ''}</div>
      <div class="modal-actions">
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirmLabel)}</button>
      </div>`);
    $('[data-cancel]', back).addEventListener('click', () => {
      back.remove();
      resolve(false);
    });
    $('[data-ok]', back).addEventListener('click', () => {
      back.remove();
      resolve(true);
    });
  });
}

/**
 * Promise-based prompt dialog with simple fields.
 * fields: [{ name, label, type ('text'|'textarea'|'select'|'checkbox'|'number'|'datetime-local'),
 *            value, options:[{value,label}], required, placeholder }]
 * Resolves { name: value } or null on cancel.
 */
export function promptDialog({ title, desc, fields, submitLabel = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const body = fields
      .map((f) => {
        const id = `pf_${f.name}`;
        if (f.type === 'textarea') {
          return `<label class="field" for="${id}"><span>${esc(f.label)}</span><textarea id="${id}" name="${esc(f.name)}" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea></label>`;
        }
        if (f.type === 'select') {
          const opts = (f.options ?? [])
            .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`)
            .join('');
          return `<label class="field" for="${id}"><span>${esc(f.label)}</span><select id="${id}" name="${esc(f.name)}">${opts}</select></label>`;
        }
        if (f.type === 'checkbox') {
          return `<label class="field" for="${id}"><span><input type="checkbox" id="${id}" name="${esc(f.name)}" ${f.value ? 'checked' : ''}/> ${esc(f.label)}</span></label>`;
        }
        const t = f.type || 'text';
        return `<label class="field" for="${id}"><span>${esc(f.label)}</span><input type="${esc(t)}" id="${id}" name="${esc(f.name)}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" ${f.required ? 'required' : ''}/></label>`;
      })
      .join('');

    const back = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="btn sm ghost" data-close>✕</button></div>
      ${desc ? `<p class="muted small">${esc(desc)}</p>` : ''}
      <form class="prompt-form">
        ${body}
        <div class="modal-actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(submitLabel)}</button>
        </div>
      </form>`);

    const form = $('form', back);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const input = form.elements[f.name];
        if (!input) continue;
        if (f.type === 'checkbox') out[f.name] = input.checked;
        else if (f.type === 'number') out[f.name] = input.value === '' ? null : Number(input.value);
        else out[f.name] = input.value;
      }
      back.remove();
      resolve(out);
    });
    $('[data-cancel]', back).addEventListener('click', () => {
      back.remove();
      resolve(null);
    });
  });
}

/** Password re-authentication modal; resolves true when granted. */
export function promptReauth(message) {
  return new Promise((resolve) => {
    const back = openModal(`
      <div class="modal-head"><h2>Confirm your identity</h2><button class="btn sm ghost" data-close>✕</button></div>
      <p class="muted small">${esc(message || 'This action requires your password.')}</p>
      <form>
        <label class="field"><span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required/>
        </label>
        <p class="small hidden" data-err style="color:var(--danger)"></p>
        <div class="modal-actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="submit" class="btn primary">Confirm</button>
        </div>
      </form>`);
    const form = $('form', back);
    const errEl = $('[data-err]', back);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = form.elements.password.value;
      try {
        await api('POST', '/api/auth/reauth', { json: { password }, retry: false });
        back.remove();
        resolve(true);
      } catch (err) {
        errEl.textContent = errMsg(err);
        errEl.classList.remove('hidden');
      }
    });
    $('[data-cancel]', back).addEventListener('click', () => {
      back.remove();
      resolve(false);
    });
  });
}

/* -------------------------------------------------------------- badges --- */

const BAND_CLASS = { very_high: 'ok', high: 'info', medium: 'warn', low: 'muted' };
const STAGE_CLASS = { won: 'ok', lost: 'danger', qualified: 'purple', interested: 'purple' };

export function bandBadge(band) {
  if (!band) return '<span class="badge muted">unscored</span>';
  return `<span class="badge ${BAND_CLASS[band] ?? ''}">${esc(label(band))}</span>`;
}

export function stageBadge(stage) {
  return `<span class="badge ${STAGE_CLASS[stage] ?? 'info'}">${esc(label(stage))}</span>`;
}

const ELIG_CLASS = { eligible: 'ok', ineligible: 'danger', needs_review: 'warn' };
export function eligBadge(state) {
  if (!state) return '<span class="badge muted">unknown</span>';
  return `<span class="badge ${ELIG_CLASS[state] ?? 'muted'}">${esc(label(state))}</span>`;
}

const SEV_CLASS = { critical: 'danger', warning: 'warn', info: 'info', error: 'danger' };
export function sevBadge(sev) {
  return `<span class="badge ${SEV_CLASS[sev] ?? 'muted'}">${esc(label(sev))}</span>`;
}

const DECISION_CLASS = { allowed: 'ok', blocked: 'danger', pass: 'ok', fail: 'danger', skip: 'muted' };
export function decisionBadge(decision) {
  if (!decision) return '<span class="badge muted">—</span>';
  return `<span class="badge ${DECISION_CLASS[decision] ?? 'muted'}">${esc(label(decision))}</span>`;
}

/** Factor state: measured facts vs stated vs estimates vs unknown. */
const FACTOR_STATE_CLASS = { measured: 'ok', stated: 'info', estimated: 'warn', unknown: 'muted' };
export function factorStateBadge(state) {
  return `<span class="badge ${FACTOR_STATE_CLASS[state] ?? 'muted'}">${esc(label(state ?? 'unknown'))}</span>`;
}

/** Interaction kinds that represent real contact with the customer. */
export const CONTACT_KINDS = new Set(['call', 'whatsapp_message', 'whatsapp_call', 'email', 'meeting']);

export const STAGES = [
  'new_lead', 'website_analyzed', 'eligible_to_contact', 'call_attempted', 'contacted',
  'interested', 'qualified', 'meeting_callback', 'proposal_sent', 'negotiation', 'won', 'lost',
];
export const STAGES_REQUIRING_EVIDENCE = new Set(['contacted', 'interested', 'qualified']);

export const INTERACTION_KINDS = [
  'call', 'whatsapp_message', 'whatsapp_call', 'email', 'meeting', 'note',
  'followup', 'import', 'analysis', 'system', 'score', 'consent',
];
export const INTERACTION_DIRECTIONS = ['inbound', 'outbound', 'internal'];

export const FOLLOWUP_TYPES = ['callback', 'meeting', 'followup_call', 'followup_message', 'task', 'human_handoff'];
export const FOLLOWUP_STATUSES = ['scheduled', 'due', 'running', 'completed', 'cancelled', 'blocked', 'failed', 'missed'];
export const CHANNELS = ['call', 'whatsapp_message', 'whatsapp_call', 'email'];

export const SUPPRESSION_REASONS = [
  'opt_out', 'do_not_contact', 'refused', 'invalid_number', 'legal', 'customer_request', 'owner_manual', 'unreachable_permanent',
];

/** Small table helper: { head: [..], rows: [html], empty: 'message' }. */
export function tableHtml({ head, rows, empty }) {
  if (!rows || rows.length === 0) {
    return `<div class="empty">${esc(empty ?? 'Nothing here yet.')}</div>`;
  }
  return `<div class="table-wrap"><table>
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}
