/**
 * Follow-up board (cross-lead), duplicate review queue, portfolio library
 * and the notifications inbox.
 */
import {
  $, $$, api, esc, errMsg, toast, promptDialog, confirmDialog, decisionBadge,
  fmtDateTime, tableHtml, titleCase, label, sevBadge, FOLLOWUP_STATUSES, pick,
} from '../lib.js';

/* ------------------------------------------------------------- pipeline --- */

export async function renderPipeline(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Pipeline</h1><p class="desc">Every follow-up task across all leads, with due status and blockers.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="evaluate">Re-check due tasks</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    <div class="card tight">
      <form class="inline-form" data-filters>
        <label class="field"><span>Status</span>
          <select name="status">
            <option value="">All active + recent</option>
            ${FOLLOWUP_STATUSES.map((s) => `<option value="${esc(s)}">${esc(titleCase(s))}</option>`).join('')}
          </select></label>
        <button type="submit" class="btn primary">Apply</button>
      </form>
    </div>
    <div data-list></div>`;

  const list = $('[data-list]', root);

  const load = async (status) => {
    list.innerHTML = `<div class="loading"><span class="spinner"></span> Loading follow-ups…</div>`;
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (status) params.set('status', status);
      const res = await api('GET', `/api/followups?${params}`);
      const rows = (res.items ?? []).map((t) => `<tr>
        <td>${esc(t.title)}<div class="muted small">${esc(label(t.type))}${t.channel ? ` · ${esc(label(t.channel))}` : ''}${t.requestedByCustomer ? ' · customer-requested' : ''}</div></td>
        <td class="small nowrap">${esc(fmtDateTime(t.scheduledFor ?? t.scheduled_for))}</td>
        <td>${t.status === 'completed' ? '<span class="badge ok">completed</span>'
          : t.status === 'due' ? '<span class="badge warn">due</span>'
          : t.status === 'blocked' ? '<span class="badge danger">blocked</span>'
          : t.status === 'missed' ? '<span class="badge danger">missed</span>'
          : t.status === 'cancelled' ? '<span class="badge muted">cancelled</span>'
          : `<span class="badge info">${esc(t.status)}</span>`}</td>
        <td class="small muted">${esc(t.blockedReason ?? t.blocked_reason ?? t.cancelReason ?? t.cancel_reason ?? '')}</td>
        <td class="nowrap">
          <a class="btn sm" href="#/leads/${esc(t.businessId ?? t.business_id)}">Open lead</a>
          ${(t.status === 'due' || t.status === 'scheduled')
            ? `<button class="btn sm ghost" data-cancel="${esc(t.id)}">Cancel</button>` : ''}
        </td>
      </tr>`);
      list.innerHTML = tableHtml({
        head: ['Task', 'Scheduled', 'Status', 'Blocked / cancel reason', ''],
        rows,
        empty: 'No follow-ups with this filter.',
      });
      $$('[data-cancel]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const input = await promptDialog({
            title: 'Cancel follow-up', danger: true, submitLabel: 'Cancel task',
            fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true }],
          });
          if (!input) return;
          try {
            await api('POST', `/api/followups/${encodeURIComponent(btn.dataset.cancel)}/cancel`, { json: { reason: input.reason } });
            toast('Task cancelled');
            load(status);
          } catch (err) {
            toast('Failed', errMsg(err), 'err');
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="banner danger"><div><strong>Failed to load follow-ups.</strong> ${esc(errMsg(err))}</div></div>`;
    }
  };

  $('[data-filters]', root).addEventListener('submit', (e) => {
    e.preventDefault();
    load(e.target.elements.status.value);
  });
  $('[data-action=evaluate]', root).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const res = await api('POST', '/api/followups/evaluate-due', { json: {} });
      const items = res.items ?? [];
      const blocked = items.filter((x) => x.decision === 'blocked').length;
      toast('Due tasks re-checked', `${items.length} evaluated, ${blocked} blocked with reasons recorded.`);
      load($('[name=status]', root).value);
    } catch (err) {
      toast('Evaluation failed', errMsg(err), 'err');
      e.target.disabled = false;
    }
  });
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderPipeline(root, ctx)));

  await load('');
}

/* ----------------------------------------------------------- duplicates --- */

export async function renderDuplicates(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Duplicates</h1><p class="desc">Uncertain matches awaiting an explicit decision. Merging never deletes data.</p></div>
      <div class="btn-row"><button class="btn" data-action="refresh">Refresh</button></div>
    </div>
    <div data-list></div>`;

  const list = $('[data-list]', root);
  const load = async () => {
    list.innerHTML = `<div class="loading"><span class="spinner"></span> Loading candidates…</div>`;
    try {
      const res = await api('GET', '/api/duplicates?status=pending&pageSize=50');
      const rows = (res.items ?? []).map((r) => {
        const score = Number(pick(r, 'match_score', 'matchScore') ?? 0);
        const strategy = pick(r, 'match_strategy', 'matchStrategy') ?? 'fuzzy';
        const a = pick(r, 'name_a', 'nameA') ?? '';
        const b = pick(r, 'name_b', 'nameB') ?? '';
        const idA = pick(r, 'business_id_a', 'businessIdA');
        const idB = pick(r, 'business_id_b', 'businessIdB');
        return `<tr>
          <td><strong>${esc(a)}</strong><div class="muted small mono">${esc(idA)}</div></td>
          <td><strong>${esc(b)}</strong><div class="muted small mono">${esc(idB)}</div></td>
          <td class="right mono">${score.toFixed(2)}<div class="muted small">${esc(strategy)}</div></td>
          <td class="nowrap">
            <button class="btn sm primary" data-merge="${esc(r.id)}">Merge</button>
            <button class="btn sm" data-reject="${esc(r.id)}">Not a duplicate</button>
          </td>
        </tr>`;
      });
      list.innerHTML = tableHtml({
        head: ['Lead A', 'Lead B', 'Confidence', 'Decision'],
        rows,
        empty: 'No pending duplicates — imports merged cleanly or were rejected at the door.',
      });
      $$('[data-merge]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Merge these leads?',
            confirmLabel: 'Merge',
            body: '<p>One record survives; every conflicting field is recorded in the merge history. Nothing is deleted.</p>',
          });
          if (!ok) return;
          try {
            await api('POST', `/api/duplicates/${encodeURIComponent(btn.dataset.merge)}/decision`, { json: { decision: 'merge' } });
            toast('Merged');
            load();
          } catch (err) {
            toast('Merge failed', errMsg(err), 'err');
          }
        });
      });
      $$('[data-reject]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const input = await promptDialog({
            title: 'Not a duplicate', submitLabel: 'Keep both',
            fields: [{ name: 'note', label: 'Note (why are they different?)', type: 'text' }],
          });
          if (!input) return;
          try {
            await api('POST', `/api/duplicates/${encodeURIComponent(btn.dataset.reject)}/decision`, {
              json: { decision: 'not_duplicate', note: input.note || undefined },
            });
            toast('Marked as distinct');
            load();
          } catch (err) {
            toast('Failed', errMsg(err), 'err');
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="banner danger"><div><strong>Failed to load.</strong> ${esc(errMsg(err))}</div></div>`;
    }
  };
  $('[data-action=refresh]', root).addEventListener('click', load);
  await load();
}

/* ------------------------------------------------------------ portfolio --- */

export async function renderPortfolio(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Portfolio</h1><p class="desc">Items shared with prospects. Two-key rule: an item is shareable only when it is both verified and approved.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="new">New item</button>
        <button class="btn danger" data-action="stop">STOP ALL</button>
      </div>
    </div>
    <div data-list></div>`;

  const isOwner = ctx.user?.role === 'owner';
  const list = $('[data-list]', root);

  const load = async () => {
    list.innerHTML = `<div class="loading"><span class="spinner"></span> Loading portfolio…</div>`;
    try {
      const res = await api('GET', '/api/portfolio');
      const rows = (res.items ?? []).map((it) => {
        const verified = Boolean(pick(it, 'verified'));
        const approved = Boolean(pick(it, 'is_approved', 'isApproved'));
        const shareable = verified && approved;
        return `<tr>
          <td><strong>${esc(it.title)}</strong>
            <div class="muted small">${esc(it.description ?? '')}</div>
            ${pick(it, 'url') ? `<a class="small" href="${esc(pick(it, 'url'))}" target="_blank" rel="noopener noreferrer">${esc(pick(it, 'url'))}</a>` : ''}</td>
          <td>${shareable ? '<span class="badge ok">shareable</span>' : '<span class="badge muted">not shareable</span>'}</td>
          <td>${verified ? '<span class="badge info">verified</span>' : '<span class="badge warn">unverified</span>'}
            <div class="muted small">${esc(pick(it, 'verification_note', 'verificationNote') ?? '')}</div></td>
          <td>${approved ? '<span class="badge info">approved</span>' : '<span class="badge warn">unapproved</span>'}</td>
          <td class="nowrap">
            ${isOwner ? `
              <button class="btn sm" data-verify="${esc(it.id)}" data-to="${verified ? '0' : '1'}">${verified ? 'Unverify' : 'Verify'}</button>
              <button class="btn sm" data-approve="${esc(it.id)}" data-to="${approved ? '0' : '1'}">${approved ? 'Unapprove' : 'Approve'}</button>` : '<span class="muted small">owner only</span>'}
          </td>
        </tr>`;
      });
      list.innerHTML = tableHtml({
        head: ['Item', 'Shareable', 'Verification', 'Approval', ''],
        rows,
        empty: 'No portfolio items yet. Unverified items are never sent to customers.',
      });

      $$('[data-verify]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const to = btn.dataset.to === '1';
          let note;
          if (to) {
            const input = await promptDialog({
              title: 'Verify item', submitLabel: 'Mark verified',
              desc: 'Verification records that you have personally checked the claim/link. Un-verifying also revokes approval.',
              fields: [{ name: 'note', label: 'What did you check?', type: 'textarea', required: true }],
            });
            if (!input) return;
            note = input.note;
          }
          try {
            await api('POST', `/api/portfolio/${encodeURIComponent(btn.dataset.verify)}/verify`, { json: { verified: to, note } });
            toast(to ? 'Verified' : 'Verification removed (approval also revoked)');
            load();
          } catch (err) {
            toast('Failed', errMsg(err), 'err');
          }
        });
      });
      $$('[data-approve]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const to = btn.dataset.to === '1';
          if (to) {
            const ok = await confirmDialog({
              title: 'Approve for sharing?',
              confirmLabel: 'Approve',
              body: '<p>Approved + verified items may be sent to customers. Only the owner can approve.</p>',
            });
            if (!ok) return;
          }
          try {
            await api('POST', `/api/portfolio/${encodeURIComponent(btn.dataset.approve)}/approve`, { json: { approved: to } });
            toast(to ? 'Approved' : 'Approval removed');
            load();
          } catch (err) {
            toast('Failed', errMsg(err), 'err');
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="banner danger"><div><strong>Failed to load.</strong> ${esc(errMsg(err))}</div></div>`;
    }
  };

  $('[data-action=new]', root).addEventListener('click', async () => {
    const input = await promptDialog({
      title: 'New portfolio item',
      desc: 'New items start unverified and unapproved — they cannot be shared until both keys are set.',
      submitLabel: 'Create',
      fields: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'url', label: 'URL', type: 'text', placeholder: 'https://…' },
        { name: 'serviceKey', label: 'Service key', type: 'text', placeholder: 'e.g. web_design' },
      ],
    });
    if (!input || !input.title) return;
    try {
      await api('POST', '/api/portfolio', { json: input });
      toast('Item created', 'Unverified and unapproved.');
      load();
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });
  $('[data-action=stop]', root).addEventListener('click', () => ctx.requestStop(() => renderPortfolio(root, ctx)));

  await load();
}

/* -------------------------------------------------------- notifications --- */

export async function renderNotifications(root, ctx) {
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Notifications</h1><p class="desc">Operational alerts delivered to every configured destination.</p></div>
      <div class="btn-row">
        <button class="btn" data-action="readall">Mark all read</button>
        <button class="btn" data-action="refresh">Refresh</button>
      </div>
    </div>
    <div class="card tight">
      <form class="inline-form" data-filters>
        <label class="field"><span>Status</span>
          <select name="status">
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </select></label>
        <label class="field"><span>Channel</span>
          <select name="channel">
            <option value="">All</option>
            <option value="dashboard">Dashboard</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="sms">SMS</option>
          </select></label>
        <label class="field"><span>&nbsp;</span>
          <label class="small"><input type="checkbox" name="unread" checked/> Unread only</label></label>
        <button type="submit" class="btn primary">Apply</button>
      </form>
    </div>
    <div data-list></div>`;

  const list = $('[data-list]', root);
  const load = async (f) => {
    list.innerHTML = `<div class="loading"><span class="spinner"></span> Loading notifications…</div>`;
    try {
      const p = new URLSearchParams({ limit: '100' });
      if (f.status) p.set('status', f.status);
      if (f.channel) p.set('channel', f.channel);
      if (f.unread) p.set('unread', '1');
      const res = await api('GET', `/api/notifications?${p}`);
      const rows = (res.items ?? []).map((n) => `<tr class="${n.readAt ? '' : 'clickable'}">
        <td style="width:90px">${sevBadge(n.severity)}</td>
        <td><strong>${esc(n.title)}</strong>
          <div class="small">${esc(n.body)}</div>
          ${n.errorDetail ? `<div class="muted small">Error: ${esc(n.errorDetail)}</div>` : ''}</td>
        <td class="small">${esc(label(n.channel))}<div class="muted small">${esc(label(n.status))}</div></td>
        <td class="muted small nowrap">${esc(fmtDateTime(n.createdAt))}</td>
        <td class="nowrap">${n.readAt ? '<span class="muted small">read</span>' : `<button class="btn sm" data-read="${esc(n.id)}">Mark read</button>`}</td>
      </tr>`);
      list.innerHTML = `
        <p class="muted small">${res.unread ?? 0} unread</p>
        ${tableHtml({ head: ['', 'Notification', 'Channel', 'When', ''], rows, empty: 'No notifications.' })}`;
      $$('[data-read]', list).forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api('POST', `/api/notifications/${encodeURIComponent(btn.dataset.read)}/read`);
            load(f);
          } catch (err) {
            toast('Failed', errMsg(err), 'err');
          }
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="banner danger"><div><strong>Failed to load.</strong> ${esc(errMsg(err))}</div></div>`;
    }
  };

  const readFilters = () => ({
    status: $('[name=status]', root).value,
    channel: $('[name=channel]', root).value,
    unread: $('[name=unread]', root).checked,
  });
  $('[data-filters]', root).addEventListener('submit', (e) => { e.preventDefault(); load(readFilters()); });
  $('[data-action=readall]', root).addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/notifications/read-all');
      toast('All read', `${res.updated} notification(s) marked read.`);
      load(readFilters());
    } catch (err) {
      toast('Failed', errMsg(err), 'err');
    }
  });
  $('[data-action=refresh]', root).addEventListener('click', () => load(readFilters()));

  await load(readFilters());
}

export { decisionBadge };
