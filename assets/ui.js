// DOM helpers shared by both tabs.
import { all, money } from './db.js';

export { money };

export const $ = (sel) => document.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// Amount typed by a person: "$2,350", "2350.5" and "2350" all read as dollars.
export const parseAmountInput = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

// An amount as it is written into an input: 2350.00.
export const plain = (n) => n.toFixed(2);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const beat = (ms) => (reducedMotion ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

// Remembers each list's rows from the last render, so the rows that changed can flash.
export function changeTracker() {
  let seen = {};
  const diff = (panel, rows, keyFn, sigFn) => {
    const prev = seen[panel];
    const next = new Map(rows.map((r) => [keyFn(r), sigFn(r)]));
    seen[panel] = next;
    if (!prev) return new Set();
    const changed = new Set();
    for (const [k, sig] of next) if (prev.get(k) !== sig) changed.add(k);
    return changed;
  };
  diff.clear = () => {
    seen = {};
  };
  return diff;
}

// The numbered workflow strip at the top of a tab.
export function pipeline(el) {
  const names = [...el.querySelectorAll('[data-step]')].map((li) => li.dataset.step);
  const set = (step, status, text) => {
    const li = el.querySelector(`[data-step="${step}"]`);
    li.className = status ? `is-${status}` : '';
    if (text != null) li.querySelector('.pl-sub').textContent = text;
  };
  const reset = (firstText = '—') => names.forEach((s, i) => set(s, '', i === 0 ? firstText : '—'));
  return { set, reset };
}

const ACTOR_CLASS = {
  automation: 'actor-auto',
  reviewer: 'actor-rev',
  approver: 'actor-rev',
  bookkeeper: 'actor-book',
  crew: 'actor-crew',
};

// Both tabs write to one audit log.
export function renderAudit(db, el, diff) {
  const rows = all(db, `SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 60`);
  const changed = diff('audit', rows, (r) => r.id, () => '1');
  el.innerHTML = rows
    .map((r) => {
      const t = new Date(r.at).toLocaleTimeString('en-GB', { hour12: false });
      return `<li class="${changed.has(r.id) ? 'flash' : ''}">
        <span class="audit-time mono">${t}</span>
        <span class="actor ${ACTOR_CLASS[r.actor] ?? ''}">${esc(r.actor)}</span>
        <span class="audit-body"><span class="audit-action mono">${esc(r.action)}</span> ${esc(r.detail)}</span>
      </li>`;
    })
    .join('');
}
