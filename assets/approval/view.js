// Invoice approval tab: the crew log jobs, the automation drafts, checks and routes the invoices,
// and the bookkeeper and approver each work their own queue. The role switch decides what shows.
import { all, one } from '../db.js';
import { $, esc, money, plain, fmtDate, beat, parseAmountInput, changeTracker, pipeline, renderAudit } from '../ui.js';
import { JOB_SAMPLES } from './samples.js';
import { logJob, checksFor, approve, sendBack, resubmit, clearDuplicate, voidInvoice, normalisePo } from './rules.js';

let ctx; // shared with the other tab: { db, busy, show }
const diffKeys = changeTracker();
const steps = pipeline($('#a-pipeline'));

const state = {
  role: 'crew',
  focus: null, // the invoice the workflow strip follows: the one last logged or acted on
  sample: 'routine',
  policy: { limit: 5000 },
};
const job = { customerId: '', po: '', description: '', hours: '', materials: '' };

const ROLE_NOTE = {
  crew: 'The crew log completed work. They see their jobs and hours, never rates, invoice amounts or customer balances.',
  bookkeeper: 'The bookkeeper sees every invoice and fixes what the checks catch, but cannot approve.',
  approver: 'The approver decides on invoices the policy will not send on its own, but cannot change amounts.',
};

const STAGE = {
  draft: ['pill-neutral', 'Draft'],
  fix: ['pill-warn', 'With bookkeeper'],
  approval: ['pill-info', 'Awaiting approval'],
  approved: ['pill-ok', 'Approved'],
  sent: ['pill-neutral', 'Sent'],
  part_paid: ['pill-warn', 'Part-paid'],
  paid: ['pill-ok', 'Paid'],
  void: ['pill-neutral', 'Void'],
};

// What the crew are told about billing: progress only, no money.
const CREW_STATE = {
  draft: ['pill-neutral', 'In review'],
  fix: ['pill-neutral', 'In review'],
  approval: ['pill-neutral', 'In review'],
  approved: ['pill-info', 'Invoiced'],
  sent: ['pill-info', 'Invoiced'],
  part_paid: ['pill-info', 'Invoiced'],
  paid: ['pill-ok', 'Paid'],
  void: ['pill-neutral', 'Not billed'],
};

const pill = ([cls, label]) => `<span class="pill ${cls}">${esc(label)}</span>`;

// ---------- role views ----------

function renderRoles() {
  const counts = one(ctx.db, `SELECT count(*) FILTER (WHERE stage = 'fix') AS fix, count(*) FILTER (WHERE stage = 'approval') AS approval FROM invoices`);
  for (const b of document.querySelectorAll('#roles [data-role]')) {
    b.setAttribute('aria-pressed', String(b.dataset.role === state.role));
    const badge = b.querySelector('[data-count]');
    if (badge) {
      const n = counts[badge.dataset.count];
      badge.textContent = n;
      badge.hidden = !n;
    }
  }
  $('#role-note').textContent = ROLE_NOTE[state.role];
  for (const panel of document.querySelectorAll('#view-approval [data-roles]')) {
    panel.hidden = !panel.dataset.roles.split(' ').includes(state.role);
  }
}

function jobLine(r) {
  const materials = r.materials_cents ? ` + ${money(r.materials_cents / 100)} materials` : '';
  return `${esc(r.job_id)} · ${esc(r.description)} · ${r.hours}&nbsp;h × ${money(r.rate_cents / 100)}${materials}`;
}

function checkList(checks) {
  return `<ul class="checks">${checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${esc(c.text)}</li>`).join('')}</ul>`;
}

const QUEUE_SQL = `SELECT p.*, j.description, j.hours, j.rate_cents, j.materials_cents
                     FROM invoice_pipeline p LEFT JOIN jobs j ON j.id = p.job_id
                    WHERE p.stage = ? ORDER BY p.id`;

function renderJobs() {
  const rows = all(
    ctx.db,
    `SELECT j.id, c.name AS customer, j.po, j.description, j.hours, j.done_date,
            (SELECT p.state FROM invoice_pipeline p WHERE p.job_id = j.id ORDER BY p.id DESC LIMIT 1) AS state
       FROM jobs j JOIN customers c ON c.id = j.customer_id
      ORDER BY j.id DESC`
  );
  const changed = diffKeys('jobs', rows, (r) => r.id, (r) => r.state);
  $('#my-jobs').innerHTML = `<thead><tr><th>Job</th><th>Customer / PO</th><th>Work</th><th class="num">Hours</th><th>Billing</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr class="${changed.has(r.id) ? 'flash' : ''}">
          <td class="mono">${esc(r.id)}<span class="line-note">${fmtDate(r.done_date)}</span></td>
          <td><span class="cust">${esc(r.customer)}</span><span class="po mono">${esc(r.po ?? 'no PO')}</span></td>
          <td>${esc(r.description)}</td>
          <td class="num">${r.hours}</td>
          <td>${pill(CREW_STATE[r.state] ?? ['pill-neutral', 'In review'])}</td>
        </tr>`
      )
      .join('')}</tbody>`;
}

function renderFixQueue() {
  const rows = all(ctx.db, QUEUE_SQL, ['fix']);
  const changed = diffKeys('fix', rows, (r) => r.id, (r) => r.note + r.amount);
  $('#fix-queue').innerHTML = rows.length
    ? rows
        .map((r) => {
          const { checks, failed, poLeft } = checksFor(ctx.db, r.id);
          const dup = failed.find((f) => f.kind === 'duplicate');
          const meta = `<div class="exc-meta">${esc(r.id)} · ${esc(r.customer)} · <span class="mono">${esc(r.po ?? 'no PO')}</span></div>`;
          if (dup) {
            return `<article class="exc exc-bad ${changed.has(r.id) ? 'flash' : ''}">
              <div class="exc-top"><span class="exc-kind">Possible duplicate</span><span class="exc-amt mono">${money(r.amount)}</span></div>
              ${meta}
              <p class="exc-detail">${jobLine(r)}</p>
              ${checkList(checks)}
              <div class="exc-actions">
                <button type="button" class="btn btn-sm btn-primary" data-act="void" data-id="${r.id}">Void invoice</button>
                <button type="button" class="btn btn-sm btn-ghost" data-act="not-dup" data-id="${r.id}">Not a duplicate</button>
              </div>
            </article>`;
          }
          const usePo = failed.some((f) => f.kind === 'amount') && poLeft > 0
            ? `<button type="button" class="link-btn" data-act="use-po" data-value="${plain(poLeft)}">Use what is left on the PO (${money(poLeft)})</button>`
            : '';
          return `<article class="exc ${changed.has(r.id) ? 'flash' : ''}">
            <div class="exc-top"><span class="exc-kind">Returned for a fix</span><span class="exc-amt mono">${money(r.amount)}</span></div>
            ${meta}
            <p class="exc-detail">${esc(r.note)}</p>
            <p class="exc-detail">${r.job_id ? jobLine(r) : ''}</p>
            <div class="fix-row">
              <label class="field">Invoice amount<input class="mono fix-amt" inputmode="decimal" value="${plain(r.amount)}" autocomplete="off"></label>
              ${usePo}
            </div>
            <div class="exc-actions">
              <button type="button" class="btn btn-sm btn-primary" data-act="resubmit" data-id="${r.id}">Resubmit</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="void" data-id="${r.id}">Void invoice</button>
            </div>
          </article>`;
        })
        .join('')
    : '<div class="empty ok-empty">Nothing to fix.</div>';
}

function renderApprovalQueue() {
  const rows = all(ctx.db, QUEUE_SQL, ['approval']);
  const changed = diffKeys('approval', rows, (r) => r.id, (r) => r.note + r.amount);
  $('#approval-queue').innerHTML = rows.length
    ? rows
        .map((r) => {
          const { checks, failed } = checksFor(ctx.db, r.id);
          const limit = r.amount > state.policy.limit
            ? [{ ok: false, text: `Above the ${money(state.policy.limit)} auto-approve limit` }]
            : [];
          // The limit is read live, so raising it can leave an invoice here that would now pass.
          const title = failed.length ? 'Check failed' : limit.length ? 'Above auto-approve limit' : 'Within the new limit';
          return `<article class="exc ${failed.length ? '' : 'exc-info'} ${changed.has(r.id) ? 'flash' : ''}">
            <div class="exc-top"><span class="exc-kind">${title}</span><span class="exc-amt mono">${money(r.amount)}</span></div>
            <div class="exc-meta">${esc(r.id)} · ${esc(r.customer)} · <span class="mono">${esc(r.po ?? 'no PO')}</span></div>
            <p class="exc-detail">${r.job_id ? jobLine(r) : ''}</p>
            ${checkList([...checks, ...limit])}
            <div class="exc-actions">
              <button type="button" class="btn btn-sm ${failed.length ? 'btn-ghost' : 'btn-primary'}" data-act="approve" data-id="${r.id}">Approve and send</button>
              <button type="button" class="btn btn-sm ${failed.length ? 'btn-primary' : 'btn-ghost'}" data-act="return" data-id="${r.id}">Return to bookkeeper</button>
            </div>
          </article>`;
        })
        .join('')
    : '<div class="empty ok-empty">Nothing waiting for approval.</div>';
}

function renderRegister() {
  const rows = all(ctx.db, `SELECT * FROM invoice_pipeline ORDER BY id DESC`);
  const changed = diffKeys('register', rows, (r) => r.id, (r) => `${r.state}|${r.amount}`);
  $('#register').innerHTML = `<thead><tr><th>Invoice</th><th>Customer / PO</th><th class="num">Amount</th><th>Checks</th><th>Stage</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        let checks = '<span class="muted">—</span>';
        if (r.job_id && r.state !== 'void') {
          const { failed } = checksFor(ctx.db, r.id);
          checks = failed.length
            ? failed.map((f) => `<span class="bad-text">${esc(f.short)}</span>`).join('<br>')
            : '<span class="ok-text">Passed</span>';
        }
        return `<tr class="${changed.has(r.id) ? 'flash' : ''} ${r.state === 'void' ? 'is-void' : ''}">
          <td class="mono">${esc(r.id)}</td>
          <td><span class="cust">${esc(r.customer)}</span><span class="po mono">${esc(r.po ?? 'no PO')}</span></td>
          <td class="num">${money(r.amount)}</td>
          <td class="small">${checks}</td>
          <td>${pill(STAGE[r.state])}</td>
        </tr>`;
      })
      .join('')}</tbody>`;
}

// ---------- workflow strip and next-step hint ----------

function focusRow() {
  return state.focus ? one(ctx.db, `SELECT * FROM invoice_pipeline WHERE id = ?`, [state.focus]) : null;
}

function renderPipeline(inv) {
  if (!inv) return;
  const { failed } = checksFor(ctx.db, inv.id);
  const s = inv.state;
  const out = ['sent', 'part_paid', 'paid'].includes(s);
  steps.set('job', 'done', inv.job_id);
  steps.set('draft', 'done', `${inv.id} drafted`);
  steps.set('check', failed.length ? 'warn' : 'done', failed.length ? failed.map((f) => f.short).join(' · ') : 'All checks passed');
  if (s === 'void') steps.set('approve', 'bad', 'Voided');
  else if (s === 'fix') steps.set('approve', 'warn', 'With the bookkeeper');
  else if (s === 'approval') steps.set('approve', 'warn', 'Waiting for the approver');
  else steps.set('approve', 'done', inv.approved_by === 'automation' ? 'Auto-approved' : 'Approved');
  steps.set('send', out ? 'done' : s === 'void' ? 'skip' : '', out ? 'Emailed to customer' : '—');
  if (s === 'paid') steps.set('paid', 'done', 'Paid in full');
  else if (s === 'part_paid') steps.set('paid', 'warn', 'Part-paid');
  else steps.set('paid', s === 'void' ? 'skip' : '', out ? 'Awaiting payment' : '—');
}

function renderNudge(inv) {
  const el = $('#nudge');
  let html = '';
  if (inv?.state === 'fix' && state.role !== 'bookkeeper') {
    html = `${esc(inv.id)} is with the bookkeeper. <button type="button" class="btn btn-sm btn-ghost" data-role="bookkeeper">View as bookkeeper</button>`;
  } else if (inv?.state === 'approval' && state.role !== 'approver') {
    html = `${esc(inv.id)} is waiting for the approver. <button type="button" class="btn btn-sm btn-ghost" data-role="approver">View as approver</button>`;
  } else if (inv && ['sent', 'part_paid'].includes(inv.state)) {
    html = `${esc(inv.id)} has been emailed to ${esc(inv.customer)}. <button type="button" class="btn btn-sm btn-ghost" data-pay="${esc(inv.id)}">Record its payment in Payment matching →</button>`;
  } else if (inv?.state === 'paid') {
    html = `${esc(inv.id)} is paid in full.`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}

// ---------- crew form ----------

function writeForm() {
  $('#j-customer').value = job.customerId;
  $('#j-po').value = job.po;
  $('#j-desc').value = job.description;
  $('#j-hours').value = job.hours;
  $('#j-materials').value = job.materials;
}

function selectSample(id) {
  const sample = JOB_SAMPLES.find((x) => x.id === id);
  state.sample = id;
  Object.assign(job, sample.job);
  for (const b of document.querySelectorAll('#job-samples .chip')) b.setAttribute('aria-pressed', String(b.dataset.sample === id));
  $('#job-hint').textContent = sample.hint;
  writeForm();
  if (ctx?.db) refreshFormLookups();
}

// The crew see what a PO is for, not what it is worth.
function poHint() {
  const po = normalisePo(job.po);
  if (!po) return '<span class="warn-text">No purchase order: the invoice will need an approver.</span>';
  const row = one(ctx.db, `SELECT p.customer_id, p.description, c.name AS customer FROM purchase_orders p JOIN customers c ON c.id = p.customer_id WHERE p.po = ?`, [po]);
  if (!row) return '<span class="warn-text">Not a PO on file: the invoice will need an approver.</span>';
  if (row.customer_id !== job.customerId) return `<span class="warn-text">${esc(po)} belongs to ${esc(row.customer)}.</span>`;
  return `${esc(po)} · ${esc(row.description ?? 'purchase order on file')}`;
}

function refreshFormLookups() {
  const select = $('#j-customer');
  if (!select.options.length) {
    select.innerHTML = all(ctx.db, 'SELECT id, name FROM customers ORDER BY name')
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
      .join('');
    writeForm();
  }
  $('#po-list').innerHTML = all(ctx.db, `SELECT po, description FROM po_status WHERE customer_id = ? AND remaining > 0 ORDER BY po`, [job.customerId])
    .map((p) => `<option value="${esc(p.po)}">${esc(p.description ?? '')}</option>`)
    .join('');
  $('#j-po-hint').innerHTML = poHint();
}

function formError(msg) {
  $('#job-hint').innerHTML = `<span class="warn-text">${esc(msg)}</span>`;
}

async function runLog() {
  if (ctx.busy || !ctx.db) return;
  const hours = parseAmountInput(job.hours);
  const materials = parseAmountInput(job.materials) ?? 0;
  if (!job.description.trim()) return formError('Describe the work that was done.');
  if (!hours) return formError('Enter the hours worked.');
  ctx.busy = true;
  $('#log-job').disabled = true;
  try {
    steps.reset();
    steps.set('job', 'active', 'Logging…');
    await beat(350);
    const r = logJob(ctx.db, { ...job, description: job.description.trim(), hours, materials }, state.policy);
    state.focus = r.invoiceId;
    steps.set('job', 'done', r.jobId);
    steps.set('draft', 'active', 'Drafting…');
    await beat(400);
    steps.set('draft', 'done', `${r.invoiceId} drafted`);
    steps.set('check', 'active', 'Checking…');
    await beat(450);
    refresh();
  } catch (err) {
    console.error(err);
    steps.set('job', 'bad', 'Error');
    formError(err.message);
  } finally {
    ctx.busy = false;
    $('#log-job').disabled = false;
  }
}

// ---------- queue actions ----------

function act(button) {
  const id = button.dataset.id;
  const card = button.closest('.exc');
  try {
    if (button.dataset.act === 'approve') approve(ctx.db, id);
    else if (button.dataset.act === 'return') sendBack(ctx.db, id);
    else if (button.dataset.act === 'void') voidInvoice(ctx.db, id);
    else if (button.dataset.act === 'not-dup') clearDuplicate(ctx.db, id, state.policy);
    else if (button.dataset.act === 'resubmit') {
      const amount = parseAmountInput(card.querySelector('.fix-amt').value);
      if (!amount) return card.querySelector('.fix-amt').focus();
      resubmit(ctx.db, id, amount, state.policy);
    }
    state.focus = id;
  } catch (err) {
    console.error(err);
    alert(err.message);
  }
  refresh();
}

// ---------- lifecycle ----------

export function refresh() {
  const inv = focusRow();
  renderRoles();
  renderPipeline(inv);
  renderNudge(inv);
  renderJobs();
  renderFixQueue();
  renderApprovalQueue();
  renderRegister();
  renderAudit(ctx.db, $('#a-audit'), diffKeys);
  refreshFormLookups();
  $('#log-job').disabled = ctx.busy;
}

export function reset() {
  diffKeys.clear();
  state.focus = null;
  selectSample(state.sample);
  steps.reset('Waiting');
  $('#nudge').hidden = true;
  $('#log-job').disabled = true;
}

function setRole(role) {
  state.role = role;
  refresh();
}

export function mount(shared) {
  ctx = shared;
  $('#job-samples').innerHTML = JOB_SAMPLES.map((s) => `<button type="button" class="chip" data-sample="${s.id}">${esc(s.label)}</button>`).join('');
  $('#job-samples').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) selectSample(b.dataset.sample);
  });
  selectSample(state.sample);

  const fields = { 'j-customer': 'customerId', 'j-po': 'po', 'j-desc': 'description', 'j-hours': 'hours', 'j-materials': 'materials' };
  $('#job-form').addEventListener('input', (e) => {
    const key = fields[e.target.id];
    if (!key) return;
    job[key] = e.target.value;
    for (const b of document.querySelectorAll('#job-samples .chip')) b.setAttribute('aria-pressed', 'false');
    $('#job-hint').textContent = 'Your own job. Log it to see where the invoice goes.';
    if (ctx.db) refreshFormLookups();
  });
  $('#log-job').addEventListener('click', runLog);

  $('#roles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (b && ctx.db) setRole(b.dataset.role);
  });
  $('#nudge').addEventListener('click', async (e) => {
    const roleBtn = e.target.closest('[data-role]');
    if (roleBtn) return setRole(roleBtn.dataset.role);
    const payBtn = e.target.closest('[data-pay]');
    if (payBtn) {
      const matching = await ctx.show('matching');
      matching.preparePayment(payBtn.dataset.pay);
      window.scrollTo({ top: 0 });
    }
  });
  $('#view-approval').addEventListener('click', (e) => {
    const fill = e.target.closest('[data-act="use-po"]');
    if (fill) {
      fill.closest('.exc').querySelector('.fix-amt').value = fill.dataset.value;
      return;
    }
    const b = e.target.closest('button[data-act]');
    if (b && !ctx.busy && ctx.db) act(b);
  });
  $('#limit').addEventListener('input', (e) => {
    state.policy.limit = Math.max(0, parseFloat(e.target.value) || 0);
    if (ctx.db) renderApprovalQueue();
  });
}
