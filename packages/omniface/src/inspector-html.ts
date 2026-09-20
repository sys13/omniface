/** The inspector web page served by `omniface dev` at /_omniface. Reads /_omniface/inspect.json. */
export function inspectorHtml(appName: string): string {
  const title = `${appName.replace(/[<>&"]/g, '')} · facet inspector`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { --bg:#fbfbfa; --panel:#ffffff; --ink:#1c1c1a; --muted:#6b6b66; --line:#e6e5e1; --accent:#3b5bdb; --code:#f4f3f0; --warn:#b54708; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --panel:#1c1c1a; --ink:#ecebe7; --muted:#9a9993; --line:#2e2d2a; --accent:#8da2fb; --code:#23221f; --warn:#f5a25d; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
header h1 { font-size:16px; margin:0; }
header span { color:var(--muted); }
main { display:grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 52px); }
nav { border-right:1px solid var(--line); padding:8px; overflow:auto; }
nav button { display:block; width:100%; text-align:left; background:none; border:0; color:var(--ink); padding:6px 10px; border-radius:6px; font:13px ui-monospace, monospace; cursor:pointer; }
nav button[aria-current=true] { background:var(--code); color:var(--accent); }
nav small { color:var(--muted); font-family: ui-sans-serif, system-ui; }
section { padding:20px; overflow:auto; }
h2 { margin:0 0 4px; font:600 18px ui-monospace, monospace; }
.desc { color:var(--muted); margin:0 0 12px; }
.chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
.chip { border:1px solid var(--line); border-radius:999px; padding:1px 8px; font-size:12px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:12px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; min-width:0; }
.card h3 { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
pre { margin:0; background:var(--code); padding:10px; border-radius:6px; overflow:auto; font:12px/1.5 ui-monospace, monospace; white-space:pre; }
.off { color:var(--muted); font-style:italic; }
.pipeline { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.stage { border:1px solid var(--line); border-radius:6px; padding:4px 8px; font-size:12px; }
.stage b { display:block; font:11px ui-monospace, monospace; color:var(--muted); font-weight:400; }
.stage.empty { opacity:.45; }
.warn { color:var(--warn); }
@media (max-width: 720px) { main { grid-template-columns: 1fr; } nav { border-right:0; border-bottom:1px solid var(--line); max-height:200px; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header><h1 id="app">${title}</h1><span id="meta"></span></header>
<main><nav id="ops" aria-label="Operations"></nav><section id="detail"></section></main>
<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
const block = (title, body) => '<div class="card"><h3>' + title + '</h3>' + body + '</div>';
const pre = (text) => '<pre>' + esc(text) + '</pre>';
const off = (why) => '<p class="off">' + why + '</p>';
let data;
function show(id) {
  const op = data.ops.find((o) => o.id === id);
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.id === id));
  const traits = Object.entries(op.traits).map(([k, v]) => '<span class="chip">' + esc(v === true ? k : k + ': ' + v) + '</span>').join('');
  const mcp = op.mcp ? (op.mcp.group ? '<p>Part of grouped tool <b>' + esc(op.mcp.group) + '</b></p>' : '') + pre(JSON.stringify(op.mcp.tool, null, 2)) : off('Not exposed on MCP');
  const stages = op.pipeline.stages.map((s) => '<div class="stage' + (s.plugins.length ? '' : ' empty') + '"><b>' + s.stage + '</b>' + (s.plugins.map(esc).join(', ') || '—') + '</div>').join('<span>→</span>');
  document.getElementById('detail').innerHTML =
    '<h2>' + esc(op.id) + '</h2><p class="desc">' + esc(op.description || '') + (op.source !== 'app' ? ' · from ' + esc(op.source) : '') + '</p>' +
    '<div class="chips">' + (traits || '<span class="chip">no traits</span>') + '</div>' +
    '<div class="grid">' +
      block('REST', op.rest ? pre(op.rest.curl) : off('Not exposed on REST')) +
      block('SDK', op.sdk ? pre(op.sdk.snippet) : off('Not in the SDK')) +
      block('CLI', op.cli ? pre(op.cli.snippet) : off('Not in the CLI')) +
      block('MCP', mcp) +
      block('Pipeline' + (op.pipeline.wraps.length ? ' · wrapped by ' + esc(op.pipeline.wraps.join(', ')) : ''), '<div class="pipeline">' + stages + '</div>') +
      block('Input schema', pre(JSON.stringify(op.input, null, 2))) +
      block('Output schema', pre(JSON.stringify(op.output, null, 2))) +
    '</div>';
  history.replaceState(null, '', '#' + id);
}
fetch('/_omniface/inspect.json').then((r) => r.json()).then((d) => {
  data = d;
  const warn = d.mcpToolCount > 15 ? ' · <span class="warn">' + d.mcpToolCount + ' MCP tools (consider grouping)</span>' : ' · ' + d.mcpToolCount + ' MCP tools';
  document.getElementById('meta').innerHTML = 'v' + esc(d.version) + ' · plugins: ' + esc(d.plugins.join(', ') || 'none') + warn;
  document.getElementById('ops').innerHTML = d.ops.map((o) => '<button data-id="' + esc(o.id) + '">' + esc(o.id) + (o.source !== 'app' ? ' <small>plugin</small>' : '') + '</button>').join('');
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.id)));
  const initial = decodeURIComponent(location.hash.slice(1));
  if (d.ops.length) show(d.ops.some((o) => o.id === initial) ? initial : d.ops[0].id);
});
</script>
</body>
</html>`
}
