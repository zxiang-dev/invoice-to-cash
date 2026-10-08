// Two tabs over one in-browser database: invoices are approved and sent in the first,
// and the payments for them are matched in the second. Each tab's code loads when first opened.
import { createDb } from './db.js';
import { $, esc } from './ui.js';

const VIEWS = {
  approval: () => import('./approval/view.js'),
  matching: () => import('./matching/view.js'),
};
const loaded = {}; // name -> Promise of the mounted module

const ctx = {
  db: null,
  busy: false, // a tab is mid-animation; Reset waits
  show,
};
let active = 'approval';

function view(name) {
  loaded[name] ??= VIEWS[name]().then((mod) => {
    mod.mount(ctx);
    return mod;
  });
  return loaded[name];
}

// Switch tab, re-rendering it from the database so changes made in the other tab show up.
async function show(name) {
  active = name;
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  for (const key of Object.keys(VIEWS)) $(`#view-${key}`).hidden = key !== name;
  const mod = await view(name);
  if (ctx.db && active === name) mod.refresh();
  return mod;
}

function setStatus(cls, text) {
  $('#db-status').className = `db-status ${cls}`;
  $('#db-status').innerHTML = `<span class="dot"></span><span class="status-text">${esc(text)}</span>`;
}

async function boot() {
  setStatus('', 'Loading…');
  try {
    ctx.db = await createDb();
    setStatus('ready', 'Ready');
    (await view(active)).refresh();
  } catch (err) {
    console.error(err);
    setStatus('failed', `Could not load: ${err.message}`);
  }
}

async function reset() {
  if (ctx.busy) return;
  ctx.db?.close();
  ctx.db = null;
  for (const mod of await Promise.all(Object.values(loaded))) mod.reset();
  await boot();
}

$('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) show(tab.dataset.view);
});
$('#reset').addEventListener('click', reset);
show(active);
boot();
