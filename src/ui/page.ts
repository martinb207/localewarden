/**
 * The interface page: one HTML document with inline CSS and JS, no dependencies. All data is
 * inserted with textContent (translations contain HTML; it must never be interpreted here).
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>localewarden</title>
<style>
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1f23; --muted:#646a73; --line:#e3e3df; --accent:#1f7a52; --accent-weak:#e4f3eb; --warn:#9a6700; --warn-weak:#fff4d6; --err:#b42318; --err-weak:#fde8e7; }
@media (prefers-color-scheme: dark) { :root { --bg:#111316; --panel:#181b20; --text:#e6e8eb; --muted:#9aa1ab; --line:#2a2f37; --accent:#4cc38a; --accent-weak:#163325; --warn:#e3b341; --warn-weak:#33290f; --err:#ff7b72; --err-weak:#3a1717; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; gap:24px; padding:12px 20px; background:var(--panel); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; }
nav { display:flex; gap:4px; flex-wrap:wrap; }
nav button { border:0; background:none; color:var(--muted); padding:6px 10px; border-radius:6px; cursor:pointer; font:inherit; }
nav button[aria-selected=true] { background:var(--accent-weak); color:var(--accent); font-weight:600; }
main { padding:20px; max-width:1200px; margin:0 auto; }
section[hidden] { display:none; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
select, input, textarea, .btn { font:inherit; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
.btn { cursor:pointer; }
.btn.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
.btn:disabled { opacity:.5; cursor:default; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:12px; }
td.num { text-align:right; font-variant-numeric:tabular-nums; }
.bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; min-width:80px; }
.bar > i { display:block; height:100%; background:var(--accent); }
.tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:12px; background:var(--line); color:var(--muted); white-space:nowrap; }
.tag.missing, .tag.error { background:var(--err-weak); color:var(--err); }
.tag.pending-review, .tag.warning { background:var(--warn-weak); color:var(--warn); }
.tag.approved, .tag.translated { background:var(--accent-weak); color:var(--accent); }
.text { white-space:pre-wrap; word-break:break-word; max-width:460px; }
.muted { color:var(--muted); }
textarea { width:100%; min-height:70px; }
pre.log { background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px; max-height:420px; overflow:auto; white-space:pre-wrap; font-size:12px; }
.error-box { color:var(--err); }
details.panel > summary { cursor:pointer; font-weight:600; display:flex; gap:12px; align-items:center; list-style:none; }
details.panel > summary::-webkit-details-marker { display:none; }
details.panel > summary::before { content:'▸'; color:var(--muted); }
details.panel[open] > summary::before { content:'▾'; }
details.panel > summary .bar { flex:0 0 160px; }
details.panel table { margin-top:12px; }
col.c-lang { width:90px; } col.c-num { width:130px; } col.c-review { width:170px; }
</style>
</head>
<body>
<header>
  <h1>localewarden</h1>
  <nav role="tablist">
    <button role="tab" data-tab="overview" aria-selected="true">Overview</button>
    <button role="tab" data-tab="strings" aria-selected="false">Strings</button>
    <button role="tab" data-tab="findings" aria-selected="false">Check</button>
    <button role="tab" data-tab="review" aria-selected="false">Review</button>
    <button role="tab" data-tab="run" aria-selected="false">Run</button>
  </nav>
  <span id="busy" class="muted"></span>
</header>
<main>
  <section id="overview">
    <div class="panel"><div id="budget" class="muted"></div></div>
    <div id="groups"></div>
  </section>

  <section id="strings" hidden>
    <div class="panel">
      <div class="row">
        <select id="s-group" aria-label="Group"></select>
        <select id="s-lang" aria-label="Language"></select>
        <select id="s-only" aria-label="Show">
          <option value="">All strings</option><option value="missing">Missing</option><option value="pending-review">Hand edits to review</option>
        </select>
        <input id="s-q" placeholder="Search key, source or translation" size="32">
        <button class="btn" id="s-load">Show</button>
        <span id="s-count" class="muted"></span>
      </div>
      <table><thead><tr><th>Key</th><th>Source</th><th>Translation</th><th>Status</th><th></th></tr></thead><tbody id="s-rows"></tbody></table>
    </div>
  </section>

  <section id="findings" hidden>
    <div class="panel">
      <div class="row">
        <button class="btn primary" id="f-run">Run check</button>
        <select id="f-lang" aria-label="Language"><option value="">All languages</option></select>
        <select id="f-check" aria-label="Check"><option value="">All checks</option></select>
        <span id="f-count" class="muted"></span>
      </div>
      <table><thead><tr><th>Lang</th><th>Check</th><th>Key</th><th>Translation</th><th>Note</th></tr></thead><tbody id="f-rows"></tbody></table>
    </div>
  </section>

  <section id="review" hidden>
    <div class="panel">
      <div class="row"><label><input type="checkbox" id="r-all"> include approved</label><span id="r-count" class="muted"></span></div>
      <table><thead><tr><th>Lang</th><th>Key</th><th>Translation</th><th>Reason</th><th></th></tr></thead><tbody id="r-rows"></tbody></table>
    </div>
  </section>

  <section id="run" hidden>
    <div class="panel">
      <div class="row">
        <select id="j-mode" aria-label="Mode">
          <option value="dry-run">Dry run (no API calls)</option>
          <option value="translate">Translate new and changed strings</option>
          <option value="fix-flagged">Fix what the check flags</option>
        </select>
        <select id="j-group" aria-label="Group"><option value="">All groups</option></select>
        <input id="j-langs" placeholder="Languages, e.g. de,fr (empty = all)" size="28">
        <button class="btn primary" id="j-start">Start</button>
      </div>
      <p class="muted">Translating uses your API key and costs tokens. Start with a dry run.</p>
      <pre class="log" id="j-log"></pre>
      <div id="j-summary"></div>
    </div>
  </section>
</main>
<script>
(() => {
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = id => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v; else if (k === 'text') node.textContent = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v);
    }
    for (const c of children) node.append(c);
    return node;
  };
  async function api(path, body) {
    const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'X-Localewarden-Token': token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error || res.statusText);
    return data;
  }
  const report = e => alert(e.message);

  // Tabs
  for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('nav button')) o.setAttribute('aria-selected', String(o === b));
    for (const s of document.querySelectorAll('main section')) s.hidden = s.id !== b.dataset.tab;
    if (b.dataset.tab === 'review') loadReview().catch(report);
  });

  let status = null;
  async function loadStatus() {
    status = await api('/api/status');
    const u = status.usage, l = status.limits;
    $('budget').textContent = 'Tokens today: ' + (u ? u.tokens.toLocaleString('en') : 0) + (l.dailyTokenBudget ? ' of ' + l.dailyTokenBudget.toLocaleString('en') + ' (daily budget)' : '') + ' · per run: ' + l.maxTokensPerRun.toLocaleString('en');
    const box = $('groups'); box.replaceChildren();
    for (const g of status.groups) {
      const rows = g.languages.map(x => el('tr', {},
        el('td', { text: x.lang }),
        el('td', { class: 'num', text: x.translated + ' / ' + x.strings }),
        el('td', {}, (() => { const b = el('div', { class: 'bar' }); b.append(el('i', { style: 'width:' + (x.strings ? Math.round(100 * x.translated / x.strings) : 100) + '%' })); return b; })()),
        el('td', { class: 'num', text: x.pendingReview ? String(x.pendingReview) : '' })));
      const total = g.languages.reduce((a, x) => a + x.strings, 0), done = g.languages.reduce((a, x) => a + x.translated, 0);
      const pct = total ? Math.floor(1000 * done / total) / 10 : 100;
      const pending = g.languages.reduce((a, x) => a + x.pendingReview, 0);
      const bar = el('div', { class: 'bar' }); bar.append(el('i', { style: 'width:' + pct + '%' }));
      const details = el('details', { class: 'panel' },
        el('summary', {}, el('span', { text: (g.name || 'Project') }), bar, el('span', { class: 'muted', text: pct + '% · ' + g.languages.length + ' languages · ' + g.files + ' file(s) · source ' + g.sourceLanguage + (pending ? ' · ' + pending + ' to review' : '') })),
        el('table', {}, el('colgroup', {}, el('col', { class: 'c-lang' }), el('col', { class: 'c-num' }), el('col', {}), el('col', { class: 'c-review' })),
          el('thead', {}, el('tr', {}, el('th', { text: 'Language' }), el('th', { text: 'Translated' }), el('th', { text: '' }), el('th', { text: 'Hand edits to review' }))), el('tbody', {}, ...rows)));
      if (status.groups.length === 1) details.open = true;
      box.append(details);
    }
    const groupOptions = sel => { sel.replaceChildren(...status.groups.map((g, i) => el('option', { value: g.name || '', text: g.name || 'Project' }))); };
    groupOptions($('s-group'));
    $('j-group').replaceChildren(el('option', { value: '', text: 'All groups' }), ...status.groups.filter(g => g.name).map(g => el('option', { value: g.name, text: g.name })));
    fillLangs();
    const langs = [...new Set(status.groups.flatMap(g => g.languages.map(x => x.lang)))];
    $('f-lang').replaceChildren(el('option', { value: '', text: 'All languages' }), ...langs.map(x => el('option', { value: x, text: x })));
    $('busy').textContent = status.job && status.job.running ? 'Running: ' + status.job.kind : '';
  }
  function fillLangs() {
    const g = status.groups.find(x => (x.name || '') === $('s-group').value) || status.groups[0];
    $('s-lang').replaceChildren(...g.languages.map(x => el('option', { value: x.lang, text: x.lang })));
  }
  $('s-group').addEventListener('change', fillLangs);

  // Strings
  async function loadStrings() {
    const p = new URLSearchParams({ group: $('s-group').value, lang: $('s-lang').value, q: $('s-q').value, only: $('s-only').value, limit: '300' });
    const data = await api('/api/strings?' + p);
    $('s-count').textContent = data.rows.length + ' of ' + data.total + ' shown';
    $('s-rows').replaceChildren(...data.rows.map(r => {
      const cell = el('td', { class: 'text', text: r.text ?? '' });
      const edit = el('button', { class: 'btn', text: 'Edit' });
      if (r.status === 'not-text') edit.disabled = true;
      edit.addEventListener('click', () => {
        const area = el('textarea', {}); area.value = r.text ?? '';
        const save = el('button', { class: 'btn primary', text: 'Save' });
        save.addEventListener('click', async () => {
          try { const out = await api('/api/strings', { group: r.group, lang: $('s-lang').value, file: r.file, key: r.key, value: area.value }); cell.replaceChildren(document.createTextNode(out.text)); tag.className = 'tag approved'; tag.textContent = 'approved'; edit.disabled = false; }
          catch (e) { report(e); }
        });
        cell.replaceChildren(area, save); edit.disabled = true;
      });
      const tag = el('span', { class: 'tag ' + r.status, text: r.status });
      return el('tr', {}, el('td', { class: 'muted', text: r.key }), el('td', { class: 'text', text: r.source }), cell, el('td', {}, tag), el('td', {}, edit));
    }));
  }
  $('s-load').addEventListener('click', () => loadStrings().catch(report));
  $('s-q').addEventListener('keydown', e => { if (e.key === 'Enter') loadStrings().catch(report); });

  // Findings
  async function loadFindings() {
    const p = new URLSearchParams({ lang: $('f-lang').value, check: $('f-check').value, limit: '300' });
    const data = await api('/api/findings?' + p);
    if (!data.checked) { $('f-count').textContent = 'Not checked yet.'; return; }
    $('f-count').textContent = data.total + ' finding(s)' + (data.total > data.rows.length ? ', first ' + data.rows.length + ' shown' : '');
    const checks = new Set([...$('f-check').options].map(o => o.value));
    for (const r of data.rows) if (!checks.has(r.check)) { checks.add(r.check); $('f-check').append(el('option', { value: r.check, text: r.check })); }
    $('f-rows').replaceChildren(...data.rows.map(r => el('tr', {}, el('td', { text: r.lang }), el('td', {}, el('span', { class: 'tag ' + r.severity, text: r.check })), el('td', { class: 'muted', text: r.key }), el('td', { class: 'text', text: r.text }), el('td', { class: 'text muted', text: r.note || '' }))));
  }
  $('f-run').addEventListener('click', async () => { try { await api('/api/check', {}); await follow(); await loadFindings(); } catch (e) { report(e); } });
  $('f-lang').addEventListener('change', () => loadFindings().catch(report));
  $('f-check').addEventListener('change', () => loadFindings().catch(report));

  // Review
  async function loadReview() {
    const rows = await api('/api/review' + ($('r-all').checked ? '?all=1' : ''));
    $('r-count').textContent = rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies');
    $('r-rows').replaceChildren(...rows.map(r => {
      const sel = r.lang + ':' + r.key;
      const act = (action, label) => { const b = el('button', { class: 'btn', text: label }); b.addEventListener('click', async () => { try { await api('/api/review', { action, selectors: [sel] }); await loadReview(); } catch (e) { report(e); } }); return b; };
      return el('tr', {}, el('td', { text: r.lang }), el('td', { class: 'muted', text: r.key }), el('td', { class: 'text', text: r.value ?? '' }),
        el('td', {}, el('span', { class: 'tag ' + (r.status === 'pending' ? 'pending-review' : 'approved'), text: r.status + ' · ' + r.reason })),
        el('td', {}, ...(r.status === 'pending' ? [act('approve', 'Approve'), ' '] : []), act('release', 'Hand back')));
    }));
  }
  $('r-all').addEventListener('change', () => loadReview().catch(report));

  // Runs
  async function follow() {
    let from = 0;
    $('j-log').textContent = '';
    for (;;) {
      const job = await api('/api/job?from=' + from);
      if (!job) return;
      if (job.lines.length) { $('j-log').textContent += job.lines.join('\\n') + '\\n'; from = job.lineCount; $('j-log').scrollTop = 1e9; }
      $('busy').textContent = job.running ? 'Running: ' + job.kind : '';
      if (!job.running) {
        if (job.error) $('j-summary').replaceChildren(el('p', { class: 'error-box', text: job.error }));
        else if (job.summary) {
          const s = job.summary;
          const done = Object.entries(s.languages).map(([l, x]) => l + ': ' + (s.dryRun ? x.planned + ' to translate' : x.translated + ' translated, ' + x.revised + ' revised, ' + x.failed + ' failed')).join(' · ');
          $('j-summary').replaceChildren(el('p', { text: (s.dryRun ? 'Dry run. ' : '') + s.requests + ' request(s), ' + s.tokens.toLocaleString('en') + ' tokens, ' + s.filesWritten.length + ' file(s) written.' + (s.stopReason ? ' Stopped: ' + s.stopReason : '') }), el('p', { class: 'muted', text: done }));
        }
        await loadStatus();
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  $('j-start').addEventListener('click', async () => {
    const mode = $('j-mode').value;
    if (mode !== 'dry-run' && !confirm('This calls the API and costs tokens. Start?')) return;
    try {
      $('j-summary').replaceChildren();
      await api('/api/run', { mode, groups: $('j-group').value ? [$('j-group').value] : [], languages: $('j-langs').value.split(',').map(s => s.trim()).filter(Boolean) });
      await follow();
    } catch (e) { report(e); }
  });

  loadStatus().catch(report);
})();
</script>
</body>
</html>`;
