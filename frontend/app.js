/**
 * UWS AI Sales Agent — dashboard entry point.
 *
 * Hash router + persistent shell (sidebar, topbar with the operating-state
 * badge and the always-visible STOP button). Views live in ./views/*.
 *
 * CSP: script-src 'self' — no inline scripts, no inline event handler
 * attributes. All interactivity is bound with addEventListener.
 */
import {
  $, $$, api, esc, errMsg, toast, setReauthPrompt, promptReauth,
} from './lib.js';
import { renderLogin, renderDashboard, bindStateActions } from './views/home.js';
import { renderLeads } from './views/leads.js';
import { renderLead } from './views/lead.js';
import { renderPipeline, renderDuplicates, renderPortfolio, renderNotifications } from './views/ops.js';
import { renderReports, renderBackups, renderSettings, renderSystem } from './views/owner.js';

const app = $('#app');

/* --------------------------------------------------------------- state --- */

const ctx = {
  user: null,
  params: [],
  requestStop: async () => false,
  cachedState: null,
};

setReauthPrompt((message) => promptReauth(message));

document.addEventListener('uws:unauthenticated', () => {
  if (ctx.user) {
    ctx.user = null;
    toast('Signed out', 'Your session expired. Please sign in again.', 'warn');
    location.hash = '#/login';
  }
});

/* --------------------------------------------------------------- shell --- */

const NAV_OWNER = [
  ['#/reports', 'reports', 'Reports'],
  ['#/backups', 'backups', 'Backups'],
  ['#/settings', 'settings', 'Settings'],
];
const NAV_ALL = [
  ['#/dashboard', 'dashboard', 'Dashboard'],
  ['#/leads', 'leads', 'Leads'],
  ['#/pipeline', 'pipeline', 'Pipeline'],
  ['#/duplicates', 'duplicates', 'Duplicates'],
  ['#/portfolio', 'portfolio', 'Portfolio'],
  ['#/notifications', 'notifications', 'Notifications'],
];

function shellHtml() {
  const owner = ctx.user?.role === 'owner';
  const links = [...NAV_ALL, ...(owner ? NAV_OWNER : []), ['#/system', 'system', 'System']]
    .map(([href, key, text]) => `<a href="${href}" data-nav="${key}">${esc(text)}</a>`)
    .join('');
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">UWS AI Sales Agent<span class="sub">Universal Web Solutions</span></div>
        <nav class="nav" data-nav-root>${links}</nav>
        <div style="margin-top:auto;padding-top:16px">
          <div class="nav-section">Session</div>
          <div class="small muted" style="padding:0 10px 8px">${esc(ctx.user?.displayName ?? '')}<br/>${esc(ctx.user?.role ?? '')}</div>
          <button class="btn sm block" data-action="logout">Sign out</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div data-state-badge class="small muted">…</div>
          <div class="btn-row">
            <button class="btn danger sm" data-action="stop">STOP ALL</button>
          </div>
        </header>
        <div class="content" id="view"></div>
      </div>
    </div>`;
}

async function refreshStateBadge() {
  const el = $('[data-state-badge]');
  if (!el) return;
  try {
    const s = await api('GET', '/api/state');
    ctx.cachedState = s.state;
    const st = s.state;
    const badge = st.emergency_stop
      ? '<span class="badge danger">EMERGENCY STOP</span>'
      : st.paused
        ? '<span class="badge warn">paused</span>'
        : st.mode === 'live'
          ? '<span class="badge danger">LIVE</span>'
          : '<span class="badge info">simulation</span>';
    el.innerHTML = `${badge} <span class="muted">${esc(s.summary?.reason ?? '')}</span>`;
  } catch {
    el.innerHTML = '<span class="badge muted">state unavailable</span>';
  }
}

/* -------------------------------------------------------------- router --- */

const ROUTES = {
  dashboard: renderDashboard,
  leads: renderLeads,
  pipeline: renderPipeline,
  duplicates: renderDuplicates,
  portfolio: renderPortfolio,
  notifications: renderNotifications,
  reports: renderReports,
  backups: renderBackups,
  settings: renderSettings,
  system: renderSystem,
};

let renderToken = 0;

async function route() {
  if (!ctx.user) {
    renderLogin(app, {
      onSuccess: async () => {
        try {
          const me = await api('GET', '/api/auth/me');
          ctx.user = me.user;
        } catch {
          /* the uws:unauthenticated handler deals with this */
        }
        location.hash = '#/dashboard';
        await route();
      },
    });
    return;
  }

  const token = ++renderToken;
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...params] = hash.split('/').filter(Boolean);
  const key = name && (ROUTES[name] || name === 'leads') ? name : 'dashboard';

  // Lead detail: #/leads/:id[/tab]
  if (key === 'leads' && params[0]) {
    ctx.params = params;
    const view = $('#view');
    await renderLead(view, ctx, params[0]);
    markNav('leads');
    return;
  }

  // Shell is rendered once; only swap the content area.
  if (!$('.shell')) {
    app.innerHTML = shellHtml();
    $('[data-action=logout]').addEventListener('click', async () => {
      try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ }
      ctx.user = null;
      location.hash = '#/login';
      await route();
    });
    $('[data-action=stop]').addEventListener('click', () => ctx.requestStop(refreshStateBadge));
    bindStateActions(ctx);
  }

  markNav(key);
  const view = $('#view');
  if (token !== renderToken) return;
  await ROUTES[key](view, ctx);
  if (token !== renderToken) return;
  refreshStateBadge();
}

function markNav(key) {
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

window.addEventListener('hashchange', () => route());

/* ------------------------------------------------------------- bootstrap - */

(async () => {
  bindStateActions(ctx);
  try {
    const me = await api('GET', '/api/auth/me');
    ctx.user = me.user;
  } catch {
    ctx.user = null;
    if (!location.hash || location.hash === '#/') location.hash = '#/login';
  }
  await route();
})();
