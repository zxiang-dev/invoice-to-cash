// Payment matching tab: a remittance email is read, each line matched to a sent invoice,
// certain matches posted, and the rest queued for a reviewer.
import { all, one } from '../db.js';
import { $, esc, money, plain, fmtDate, beat, parseAmountInput, changeTracker, pipeline, renderAudit } from '../ui.js';
import { parseRemittance } from './parser.js';
import { PRESETS, composeRemittance } from './samples.js';
import { processRemittance, resolveException, journalFor, isPosted, alnum, ACTIONS, KINDS } from './rules.js';

const EXTRACTION_EMPTY = $('#extraction').textContent;

let ctx; // shared with the other tab: { db, busy, show }
const diffKeys = changeTracker();
const steps = pipeline($('#pipeline'));

const state = {
  policy: { tolerance: 5, autoFuzzy: false },
  preset: 'clean',
  last: null, // { parsed, result }
};

// ---------- renderers ----------

const STATUS_CLASS = {
  Open: 'pill-neutral',
  Overdue: 'pill-bad',
  'Part-paid': 'pill-warn',
  Disputed: 'pill-violet',
  Paid: 'pill-ok',
  'Closed (adj.)': 'pill-ok',
};

function renderLedger() {
  const rows = all(ctx.db, `SELECT * FROM invoice_status ORDER BY id`);
  const changed = diffKeys('ledger', rows, (r) => r.id, (r) => `${r.balance}|${r.status}|${r.due_date}`);
  const body = rows
    .map((r) => {
      const dpd = r.days_past_due;
      const due = r.balance > 0 && dpd > 0 ? `<span class="late">${dpd}d late</span>` : `<span class="muted">${fmtDate(r.due_date)}</span>`;
      return `<tr class="${changed.has(r.id) ? 'flash' : ''}">
        <td class="mono">${esc(r.id)}</td>
        <td><span class="cust">${esc(r.customer)}</span><span class="po mono">${esc(r.po ?? '')}</span></td>
        <td>${due}</td>
        <td class="num">${money(r.amount)}</td>
        <td class="num strong">${r.balance > 0 ? money(r.balance) : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${STATUS_CLASS[r.status] ?? 'pill-neutral'}">${esc(r.status)}</span></td>
      </tr>`;
    })
    .join('');
  $('#ledger').innerHTML = `<thead><tr><th>Invoice</th><th>Customer / PO</th><th>Due</th><th class="num">Amount</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>${body}</tbody>`;
}

function renderReview() {
  const rows = all(
    ctx.db,
    `SELECT e.id, e.kind, e.suggested_invoice_id, e.amount_cents / 100.0 AS amount, e.detail, e.status, e.resolution,
            p.ref AS payment_ref, c.name AS customer
       FROM exceptions e
       LEFT JOIN payments p ON p.id = e.payment_id
       LEFT JOIN customers c ON c.id = p.customer_id
      ORDER BY e.id DESC`
  );
  const open = rows.filter((r) => r.status === 'open');
  const done = rows.filter((r) => r.status !== 'open');
  const changed = diffKeys('review', open, (r) => r.id, (r) => r.status);
  $('#review-count').textContent = open.length;
  $('#review-count').classList.toggle('badge-hot', open.length > 0);

  const cards = open
    .map((e) => {
      const buttons = (ACTIONS[e.kind] ?? [])
        .map((a) => {
          const label = typeof a.label === 'function' ? a.label(e) : a.label;
          return `<button type="button" class="btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}" data-exc="${e.id}" data-action="${a.id}">${esc(label)}</button>`;
        })
        .join('');
      return `<article class="exc exc-${e.kind} ${changed.has(e.id) ? 'flash' : ''}">
        <div class="exc-top"><span class="exc-kind">${esc(KINDS[e.kind] ?? e.kind)}</span>${e.amount != null ? `<span class="exc-amt mono">${money(e.amount)}</span>` : ''}</div>
        <div class="exc-meta">${esc(e.customer ?? 'Unidentified payer')} · <span class="mono">${esc(e.payment_ref ?? '')}</span></div>
        <p class="exc-detail">${esc(e.detail)}</p>
        <div class="exc-actions">${buttons}</div>
      </article>`;
    })
    .join('');

  const empty = `<div class="empty ok-empty">${done.length ? 'All clear. Nothing waiting for a decision.' : 'Nothing to review.'}</div>`;
  const resolved = done.length
    ? `<details class="resolved"><summary>${done.length} resolved</summary><ul>${done
        .map((e) => `<li><span class="exc-kind-sm">${esc(KINDS[e.kind] ?? e.kind)}</span> ${esc(e.resolution ?? '')}</li>`)
        .join('')}</ul></details>`
    : '';
  $('#review').innerHTML = (open.length ? cards : empty) + resolved;
}

const OUTCOME = {
  applied: ['pill-ok', 'Auto-applied'],
  flagged: ['pill-warn', 'Applied · flagged'],
  held: ['pill-bad', 'Held for review'],
  reviewed: ['pill-info', 'Reviewed'],
};

// Lines and ledger entry for the remittance processed last.
function renderPayment() {
  const r = state.last?.result;
  if (r?.status !== 'processed') {
    $('#lines').innerHTML = '';
    $('#journal').innerHTML = '';
    return;
  }
  const rows = all(
    ctx.db,
    `SELECT id, ref_text, amount_cents / 100.0 AS amount, note, matched_invoice_id, rule, outcome
       FROM remittance_lines WHERE payment_id = ? ORDER BY line_no`,
    [r.paymentId]
  );
  const changed = diffKeys('lines', rows, (l) => l.id, (l) => `${l.outcome}|${l.matched_invoice_id}`);
  const body = rows
    .map((l) => {
      const [cls, label] = OUTCOME[l.outcome] ?? ['pill-neutral', l.outcome];
      return `<tr class="${changed.has(l.id) ? 'flash' : ''}">
        <td class="mono">${esc(l.ref_text)}${l.note ? `<span class="line-note">${esc(l.note)}</span>` : ''}</td>
        <td class="num">${money(l.amount)}</td>
        <td><span class="rule">${esc(l.rule)}</span></td>
        <td class="mono">${l.matched_invoice_id ? '→ ' + esc(l.matched_invoice_id) : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${cls}">${label}</span></td>
      </tr>`;
    })
    .join('');
  $('#lines').innerHTML = `<div class="table-wrap"><table class="grid compact"><thead><tr><th>Line reference</th><th class="num">Paid</th><th>Rule</th><th>Invoice</th><th>Result</th></tr></thead><tbody>${body}</tbody></table></div>`;

  const journal = journalFor(ctx.db, r.paymentId);
  const jChanged = diffKeys('journal', journal, (l) => l.account + l.memo, (l) => `${l.debit}|${l.credit}`);
  $('#journal').innerHTML = `<h3 class="sub-head">Ledger entry</h3>
    <div class="table-wrap"><table class="grid compact journal">
      <thead><tr><th>Account</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
      <tbody>${journal
        .map(
          (l) => `<tr class="${jChanged.has(l.account + l.memo) ? 'flash' : ''}">
            <td class="${l.credit ? 'indent' : ''}">${esc(l.account)}</td>
            <td class="muted">${esc(l.memo)}</td>
            <td class="num">${l.debit ? money(l.debit) : ''}</td>
            <td class="num">${l.credit ? money(l.credit) : ''}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table></div>`;
}

function renderExtraction() {
  const el = $('#extraction');
  if (!state.last) return;
  const { parsed, result } = state.last;
  if (result.status === 'duplicate') {
    el.className = 'banner banner-bad';
    el.innerHTML = `<strong>Duplicate blocked.</strong> Payment <span class="mono">${esc(result.ref)}</span> was already posted, so nothing was applied.
      <div class="banner-actions"><button type="button" class="btn btn-sm btn-ghost" id="as-new">Process as a new payment</button></div>`;
    return;
  }
  if (result.status === 'empty') {
    el.className = 'banner banner-warn';
    el.innerHTML = '<strong>No remittance lines found.</strong> A line needs an invoice or PO number with an amount, or an amount written with cents like <span class="mono">1,234.00</span>. The email was filed for a person to read.';
    return;
  }
  el.className = 'fields';
  const warn = parsed.warnings.length ? `<ul class="warnings">${parsed.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  el.innerHTML = `<dl>
      <div><dt>Payer</dt><dd>${result.payer ? esc(result.payer.name) : '<span class="bad-text">Unidentified</span>'}${result.payerHow ? `<span class="muted small"> via ${esc(result.payerHow)}</span>` : ''}</dd></div>
      <div><dt>Payment ref</dt><dd class="mono">${esc(result.ref)}</dd></div>
      <div><dt>Paid</dt><dd>${parsed.paidDate ? fmtDate(parsed.paidDate) : '<span class="muted">not stated</span>'}</dd></div>
      <div><dt>Amount</dt><dd class="mono">${money(result.amount)}</dd></div>
    </dl>${warn}`;
}

function renderReporting() {
  const k = one(ctx.db, `SELECT * FROM kpis`);
  const stp = k.lines_total ? Math.round((100 * k.lines_auto) / k.lines_total) + '%' : '—';
  const overduePct = k.ar_total > 0 ? Math.round((100 * k.ar_overdue) / k.ar_total) : 0;
  const tiles = [
    ['ar', 'Open receivables', money(k.ar_total), ''],
    ['od', 'Overdue', money(k.ar_overdue), `${overduePct}% of open`],
    ['un', 'Unapplied cash', money(k.unapplied), k.unapplied > 0 ? 'held, not guessed' : ''],
    ['stp', 'Straight-through', stp, k.lines_total ? `${k.lines_auto} of ${k.lines_total} lines needed no person` : 'no remittances yet'],
    ['ex', 'Waiting on review', String(k.open_exceptions), k.open_exceptions ? 'exceptions open' : 'queue empty'],
  ];
  const kChanged = diffKeys('kpis', tiles, (t) => t[0], (t) => t[2]);
  $('#kpis').innerHTML = tiles
    .map(([key, label, val, sub]) => `<div class="kpi ${kChanged.has(key) ? 'flash' : ''}"><span class="kpi-label">${label}</span><span class="kpi-val">${val}</span><span class="kpi-sub">${sub}</span></div>`)
    .join('');

  const a = one(ctx.db, `SELECT * FROM ar_aging`);
  const buckets = [
    ['current', 'Not yet due', a.current],
    ['d1_30', '1–30 days', a.d1_30],
    ['d31_60', '31–60 days', a.d31_60],
    ['d61_90', '61–90 days', a.d61_90],
    ['d90_plus', '90+ days', a.d90_plus],
  ];
  const max = Math.max(...buckets.map((b) => b[2]), 1);
  const aChanged = diffKeys('aging', buckets, (b) => b[0], (b) => String(b[2]));
  $('#aging').innerHTML = buckets
    .map(
      ([key, label, v]) => `<div class="age-row ${aChanged.has(key) ? 'flash' : ''}">
        <span class="age-label">${label}</span>
        <span class="age-track"><span class="age-bar age-${key}" style="width:${(100 * v) / max}%"></span></span>
        <span class="age-val mono">${money(v)}</span>
      </div>`
    )
    .join('');

  const cash = all(ctx.db, `SELECT id, ref, customer, unapplied FROM payment_status WHERE unapplied > 0.004 ORDER BY id DESC`);
  const cChanged = diffKeys('unapplied', cash, (r) => r.id, (r) => String(r.unapplied));
  $('#unapplied').innerHTML = cash.length
    ? `<ul class="cash-list">${cash
        .map(
          (r) => `<li class="${cChanged.has(r.id) ? 'flash' : ''}"><span><span class="mono">${esc(r.ref)}</span> <span class="muted">· ${esc(r.customer ?? 'Unidentified')}</span></span><span class="mono strong">${money(r.unapplied)}</span></li>`
        )
        .join('')}</ul>`
    : '<p class="muted small">None. Every dollar received is applied to an invoice.</p>';
}

// Every panel reads straight from the database, so one refresh after any write keeps them in
// step, including writes made in the other tab.
export function refresh() {
  renderLedger();
  renderReview();
  renderPayment();
  renderReporting();
  renderAudit(ctx.db, $('#audit'), diffKeys);
  refreshCustomLookups();
  if (!custom.ref) {
    resetCustom();
    if (state.preset === 'custom') renderCustom();
  }
  $('#process').disabled = ctx.busy;
}

// ---------- workflow ----------

async function runProcess() {
  if (ctx.busy || !ctx.db) return;
  const isCustom = state.preset === 'custom';
  const text = isCustom ? customText() : $('#remittance').value;
  if (text == null) return;
  ctx.busy = true;
  $('#process').disabled = true;
  try {
    steps.reset();
    steps.set('inbox', 'active', 'Email received');
    await beat(350);
    steps.set('inbox', 'done');

    steps.set('extract', 'active', 'Reading…');
    await beat(450);
    const parsed = parseRemittance(text);
    steps.set('extract', parsed.lines.length ? (parsed.warnings.length ? 'warn' : 'done') : 'bad',
      parsed.lines.length ? `${parsed.lines.length} line${parsed.lines.length > 1 ? 's' : ''} read` : 'No lines found');

    steps.set('match', 'active', 'Matching…');
    await beat(450);
    const result = processRemittance(ctx.db, text, parsed, state.policy);
    state.last = { parsed, result };
    // Each custom payment gets the next reference, so trying again is never blocked as a duplicate.
    if (isCustom && result.status === 'processed') setCustomRef(nextPayRef());
    renderExtraction();
    refresh();

    if (result.status === 'duplicate') {
      steps.set('match', 'bad', 'Duplicate blocked');
      for (const s of ['review', 'post', 'report']) steps.set(s, 'skip', 'Skipped');
      return;
    }
    if (result.status === 'empty') {
      steps.set('match', 'skip', 'Nothing to match');
      steps.set('review', 'warn', 'Filed for a person');
      for (const s of ['post', 'report']) steps.set(s, 'skip', 'Skipped');
      return;
    }

    const needsReview = result.flagged + result.held;
    steps.set('match', needsReview ? 'warn' : 'done', `${result.auto} auto · ${needsReview} flagged`);
    await beat(400);
    steps.set('review', needsReview ? 'warn' : 'done', needsReview ? `${needsReview} to decide` : 'Nothing to review');
    await beat(400);
    steps.set('post', result.applied > 0 ? 'done' : 'skip', result.applied > 0 ? `${money(result.applied)} applied` : 'Nothing posted');
    await beat(400);
    steps.set('report', 'done', 'Receivables updated');
  } catch (err) {
    console.error(err);
    steps.set('match', 'bad', 'Error');
    $('#extraction').className = 'banner banner-bad';
    $('#extraction').textContent = err.message;
  } finally {
    ctx.busy = false;
    $('#process').disabled = false;
  }
}

// ---------- inbox ----------

const CUSTOM_HINT = 'Choose who paid and what they paid against. Try a mistyped invoice number, a partial amount, or several lines.';

function selectPreset(id) {
  state.preset = id;
  const isCustom = id === 'custom';
  $('#remittance').hidden = isCustom;
  $('#custom').hidden = !isCustom;
  if (isCustom) {
    // An untouched form may point at an invoice a sample has since paid, so start it afresh.
    if (ctx.db && !custom.edited) resetCustom();
    renderCustom();
    $('#preset-hint').textContent = CUSTOM_HINT;
  } else {
    const p = PRESETS.find((x) => x.id === id);
    $('#remittance').value = p.text();
    $('#preset-hint').textContent = p.hint;
  }
  for (const b of document.querySelectorAll('#presets .chip')) b.setAttribute('aria-pressed', String(b.dataset.preset === id));
}

function buildPresets() {
  $('#presets').innerHTML =
    PRESETS.map((p) => `<button type="button" class="chip" data-preset="${p.id}">${esc(p.label)}</button>`).join('') +
    `<button type="button" class="chip chip-dashed" data-preset="custom">Custom payment</button>`;
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (b) selectPreset(b.dataset.preset);
  });
  $('#remittance').addEventListener('input', () => {
    for (const b of document.querySelectorAll('#presets .chip')) b.setAttribute('aria-pressed', 'false');
    $('#preset-hint').textContent = 'Edited. Process it to see how the rules respond.';
    state.preset = 'edited';
  });
}

// ---------- custom payment form ----------

const custom = { payerId: null, ref: null, lines: [], edited: false };
let invoiceCache = [];

// The lowest unused reference of a series.
function firstFree(make, start) {
  for (let n = start; ; n++) if (!isPosted(ctx.db, make(n))) return make(n);
}
// PAY-1001, PAY-1002, … for custom payments.
const nextPayRef = () => firstFree((n) => `PAY-${n}`, 1001);
// TRX-55120-R2, -R3, … for a blocked sample sent again as a new payment.
const resendRef = (ref) => firstFree((n) => `${ref.replace(/-R\d+$/, '')}-R${n}`, 2);

function setCustomRef(ref) {
  custom.ref = ref;
  const input = $('#c-ref');
  if (input) input.value = ref;
}

// Start with something that works: the first open invoice, paid in full.
function resetCustom() {
  custom.edited = false;
  const first = invoiceCache.find((i) => i.balance > 0);
  custom.payerId = first?.customer_id ?? null;
  custom.ref = nextPayRef();
  custom.lines = [{ ref: first?.id ?? '', amount: first ? plain(first.balance) : '', note: '' }];
}

function lookup(ref) {
  const key = alnum(ref);
  if (!key) return null;
  const inv = invoiceCache.find((i) => alnum(i.id) === key);
  if (inv) return { inv, via: 'invoice' };
  const byPo = invoiceCache.find((i) => i.po && alnum(i.po) === key);
  return byPo ? { inv: byPo, via: 'PO' } : null;
}

function lineHint(line) {
  if (!line.ref.trim()) return '<span class="muted">No reference: the payment can only be matched on amount.</span>';
  const hit = lookup(line.ref);
  if (!hit) return '<span class="warn-text">Not an exact invoice or PO number. The look-alike and amount rules will try to find it.</span>';
  const { inv, via } = hit;
  const parts = [`${esc(inv.id)}${via === 'PO' ? ` (via ${esc(inv.po)})` : ''} · ${esc(inv.customer)}`];
  if (inv.balance > 0) {
    parts.push(`${money(inv.balance)} open`);
    parts.push(`<button type="button" class="link-btn" data-fill="${inv.balance}">Pay in full</button>`);
  } else {
    parts.push('<span class="warn-text">already paid</span>');
  }
  if (custom.payerId && inv.customer_id !== custom.payerId) parts.push('<span class="warn-text">belongs to another customer</span>');
  return parts.join(' · ');
}

function renderCustomTotal() {
  const total = custom.lines.reduce((s, l) => s + (parseAmountInput(l.amount) ?? 0), 0);
  const el = $('#c-total');
  if (el) el.textContent = money(total);
}

function renderCustom() {
  const box = $('#custom');
  if (!ctx.db) {
    box.innerHTML = '<p class="muted small">Loading…</p>';
    return;
  }
  const customers = all(ctx.db, 'SELECT id, name FROM customers ORDER BY name');
  box.innerHTML = `
    <div class="c-top">
      <label class="field"><span>Payer</span>
        <select id="c-payer">${customers.map((c) => `<option value="${c.id}" ${c.id === custom.payerId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>Payment ref</span><input id="c-ref" class="mono" value="${esc(custom.ref)}" autocomplete="off"></label>
    </div>
    <div class="c-lines">
      <div class="c-head" aria-hidden="true"><span>Invoice or PO</span><span>Amount paid</span><span>Note</span><span></span></div>
      ${custom.lines
        .map(
          (l, i) => `<div class="c-line" data-i="${i}">
            <input class="c-inv mono" list="open-invoices" value="${esc(l.ref)}" placeholder="INV-1042" aria-label="Invoice or PO, line ${i + 1}" autocomplete="off">
            <input class="c-amt mono" inputmode="decimal" value="${esc(l.amount)}" placeholder="0.00" aria-label="Amount paid, line ${i + 1}" autocomplete="off">
            <input class="c-note" value="${esc(l.note)}" placeholder="optional" aria-label="Note, line ${i + 1}" autocomplete="off">
            <button type="button" class="c-del" aria-label="Remove line ${i + 1}" ${custom.lines.length === 1 ? 'disabled' : ''}>×</button>
            <div class="c-hint">${lineHint(l)}</div>
          </div>`
        )
        .join('')}
    </div>
    <div class="c-foot">
      <button type="button" class="btn btn-ghost btn-sm" id="c-add">+ Add line</button>
      <span class="c-sum">Total paid <strong class="mono" id="c-total"></strong></span>
    </div>`;
  renderCustomTotal();
}

function updateCustomHints() {
  document.querySelectorAll('#custom .c-line').forEach((row) => {
    row.querySelector('.c-hint').innerHTML = lineHint(custom.lines[row.dataset.i]);
  });
}

// Open invoices for the reference autocomplete, and fresh balances for the line hints.
function refreshCustomLookups() {
  invoiceCache = all(ctx.db, 'SELECT id, po, customer_id, customer, balance FROM invoice_status ORDER BY id');
  $('#open-invoices').innerHTML = invoiceCache
    .filter((i) => i.balance > 0)
    .map((i) => `<option value="${i.id}">${esc(i.customer)} · ${money(i.balance)} open</option>`)
    .join('');
  if (state.preset === 'custom') updateCustomHints();
}

// The remittance email for the form, or null (with a message) when there is nothing to send.
function customText() {
  const lines = custom.lines
    .map((l) => ({ ref: l.ref.trim(), amount: parseAmountInput(l.amount), note: l.note.trim() }))
    .filter((l) => l.amount);
  if (!lines.length) {
    $('#preset-hint').innerHTML = '<span class="warn-text">Enter an amount on at least one line.</span>';
    return null;
  }
  const ref = (custom.ref || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || nextPayRef();
  setCustomRef(ref);
  $('#preset-hint').textContent = CUSTOM_HINT;
  const payer = one(ctx.db, 'SELECT * FROM customers WHERE id = ?', [custom.payerId]);
  return composeRemittance({ payer, ref, lines });
}

function bindCustom() {
  const box = $('#custom');
  box.addEventListener('input', (e) => {
    custom.edited = true;
    const row = e.target.closest('.c-line');
    if (e.target.id === 'c-ref') custom.ref = e.target.value;
    if (!row) return;
    const line = custom.lines[row.dataset.i];
    if (e.target.classList.contains('c-inv')) line.ref = e.target.value;
    if (e.target.classList.contains('c-amt')) line.amount = e.target.value;
    if (e.target.classList.contains('c-note')) line.note = e.target.value;
    row.querySelector('.c-hint').innerHTML = lineHint(line);
    renderCustomTotal();
  });
  box.addEventListener('change', (e) => {
    if (e.target.id === 'c-payer') {
      custom.edited = true;
      custom.payerId = e.target.value;
      updateCustomHints();
    }
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-fill], #c-add, .c-del')) custom.edited = true;
    const fill = e.target.closest('[data-fill]');
    if (fill) {
      const row = fill.closest('.c-line');
      custom.lines[row.dataset.i].amount = plain(Number(fill.dataset.fill));
      row.querySelector('.c-amt').value = custom.lines[row.dataset.i].amount;
      renderCustomTotal();
      return;
    }
    if (e.target.closest('#c-add')) {
      custom.lines.push({ ref: '', amount: '', note: '' });
      renderCustom();
      box.querySelector('.c-line:last-child .c-inv').focus();
      return;
    }
    const del = e.target.closest('.c-del');
    if (del && custom.lines.length > 1) {
      custom.lines.splice(Number(del.closest('.c-line').dataset.i), 1);
      renderCustom();
    }
  });
}

// A blocked duplicate can be re-sent under a fresh reference in one click.
function processAsNew() {
  const old = state.last?.result?.ref;
  if (!old || ctx.busy) return;
  if (state.preset === 'custom') {
    setCustomRef(nextPayRef());
  } else {
    const fresh = resendRef(old);
    const ta = $('#remittance');
    const re = new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    ta.value = ta.value.search(re) >= 0 ? ta.value.replace(re, fresh) : `Payment ref: ${fresh}\n${ta.value}`;
  }
  runProcess();
}

// ---------- lifecycle ----------

// Called from the approval tab: open the custom form ready to record payment of one invoice.
export function preparePayment(invoiceId) {
  const inv = one(ctx.db, 'SELECT id, customer_id, balance FROM invoice_status WHERE id = ?', [invoiceId]);
  if (!inv) return;
  selectPreset('custom');
  custom.payerId = inv.customer_id;
  custom.ref = nextPayRef();
  custom.lines = [{ ref: inv.id, amount: plain(Math.max(inv.balance, 0)), note: '' }];
  custom.edited = true;
  renderCustom();
  $('#preset-hint').textContent = `Ready to record the payment for ${inv.id}. Change anything you like, then process it.`;
}

// Forget everything tied to the old database; refresh() rebuilds it once the new one loads.
export function reset() {
  diffKeys.clear();
  state.last = null;
  custom.ref = null;
  $('#extraction').className = 'empty';
  $('#extraction').textContent = EXTRACTION_EMPTY;
  $('#lines').innerHTML = '';
  $('#journal').innerHTML = '';
  steps.reset('Waiting');
  $('#process').disabled = true;
}

export function mount(shared) {
  ctx = shared;
  buildPresets();
  bindCustom();
  selectPreset('clean');

  $('#process').addEventListener('click', runProcess);
  $('#extraction').addEventListener('click', (e) => {
    if (e.target.closest('#as-new')) processAsNew();
  });
  $('#tolerance').addEventListener('input', (e) => {
    state.policy.tolerance = Math.max(0, parseFloat(e.target.value) || 0);
  });
  $('#autofuzzy').addEventListener('change', (e) => {
    state.policy.autoFuzzy = e.target.checked;
  });
  $('#review').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-exc]');
    if (!b || ctx.busy) return;
    try {
      resolveException(ctx.db, Number(b.dataset.exc), b.dataset.action);
    } catch (err) {
      console.error(err);
      alert(err.message);
    }
    refresh();
  });
}
