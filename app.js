// Mendix Marketplace MX11 Compatibility Scanner — Frontend

let db = null;
let dbLayer = null;

// Public (redacted) build flag — injected into scan-meta.js by pkg/publish.
// The public report is deep-link-only: recipients get direct links to the
// components they own, so the browse surface (sidebar nav, dashboard, list and
// issue views, back-to-list links) is hidden and blocked routes show a notice.
const IS_PUBLIC_REPORT = window.PUBLIC_REPORT === true;

// The component-detail Experiments tab is hidden by default. It appears only
// when the URL carries the `showExperiments` param — which the Experiments-page
// list rows attach, so the tab shows when you navigate in from there (or when
// the param is added to the URL by hand).
let _showExperiments = false;
// Optional `selectedTab` URL param — preselects a component-detail tab on load.
let _selectedTab = null;

// =============================================================================
// Routing
// =============================================================================

function parseHash() {
  const raw = (window.location.hash || '').replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const segments = (path || '').split('/').filter(Boolean);
  const view = segments[0] || 'dashboard';
  let id = segments.length > 1 ? decodeURIComponent(segments.slice(1).join('/')) : null;
  const params = {};
  if (query) new URLSearchParams(query).forEach((v, k) => params[k] = v);
  return { view, id, params };
}

function buildHash({ view, id, params } = {}) {
  const v = view || 'dashboard';
  let path = v === 'dashboard' ? '/' : '/' + v;
  if (id) path += '/' + encodeURIComponent(id);
  const qs = new URLSearchParams(params || {}).toString();
  return qs ? `${path}?${qs}` : path;
}

function navigateTo(view, id, params) {
  history.pushState(null, '', '#' + buildHash({ view, id, params }));
  applyHash();
}

// Views reachable in the public (deep-link-only) build — detail pages of the
// component a recipient was linked to, plus their widget/module subpages. All
// list/aggregate views (dashboard, components, widgets, modules, starter apps,
// issues, teams, experiments) are browse surface and stay blocked.
const PUBLIC_VIEWS = { component: 1, widget: 1, module: 1 };

// Landing shown in the public build for any blocked or unknown route (including
// the bare report URL with no hash).
function renderPublicLanding() {
  document.getElementById('dashboard-view').innerHTML = `
    <div class="flex items-center justify-center h-full p-8">
      <div class="text-center max-w-md">
        <h2 class="text-lg font-semibold text-white mb-2">MX11 Compatibility Report</h2>
        <p class="text-sm text-gray-400">This report is accessed through direct component links.
          Open the link you received to view the compatibility details for your component.</p>
      </div>
    </div>`;
  showView('dashboard-view');
}

function applyHash() {
  if (!dbLayer) return;
  const { view, id, params } = parseHash();
  if (IS_PUBLIC_REPORT && !(PUBLIC_VIEWS[view] && id)) { renderPublicLanding(); return; }
  _showExperiments = params.showExperiments === '1' || params.showExperiments === 'true';
  _selectedTab = params.selectedTab || null;

  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const navKey = { component: 'components', widget: 'widgets', module: 'modules', issue: 'issues' }[view] || view;
  const link = document.querySelector(`[data-view="${navKey}"]`);
  if (link) link.classList.add('active');

  // List views restore their filter state from URL params so a copied link
  // reproduces the exact filtered view. Non-list views leave filters untouched.
  const LIST_VIEWS = { components: 1, widgets: 1, modules: 1, 'starter-apps': 1, experiments: 1 };
  if (LIST_VIEWS[view]) _applyCompFilterParams(params);
  // The packaging pages keep their own (much smaller) filter state.
  if (PACKAGING_PAGES[view]) _pkgApplyParams(params);

  switch (view) {
    case 'dashboard':     renderDashboard(); break;
    case 'components':    renderComponents(); break;
    case 'component':     id ? renderComponentDetail(id) : renderComponents(); break;
    case 'widgets':       renderComponentCategory('widgets'); break;
    case 'widget':        id ? renderWidgetDetail(id) : renderComponentCategory('widgets'); break;
    case 'modules':       renderComponentCategory('modules'); break;
    case 'module':        id ? renderModuleDetail(id) : renderComponentCategory('modules'); break;
    case 'starter-apps':  renderComponentCategory('starter-apps'); break;
    case 'experiments':   renderComponentCategory('experiments'); break;
    case 'addons':        renderPackagingPage('addons'); break;
    case 'extensions':    renderPackagingPage('extensions'); break;
    case 'solutions':     renderPackagingPage('solutions'); break;
    case 'teams':         renderTeams(); break;
    case 'issues':        renderIssues(); break;
    case 'issue':         id ? renderIssueDetail(id) : renderIssues(); break;
    default:              renderDashboard();
  }
}

// --- Shareable filter state <-> URL params -----------------------------------
//
// The Components (and category) views keep their filter state in the global
// `componentFilters`. To make a filtered view shareable, that state is mirrored
// into the URL hash query and restored on load. Encoding keeps links readable:
// arrays are comma-joined; column filters use `key:v1|v2` groups joined by `;`.

const _FILTER_PARAM_KEYS = ['q', 'pub', 'types', 'support', 'status', 'teams', 'deps', 'sort', 'cols'];

function _compFiltersToParams() {
  const p = {};
  const f = componentFilters;
  if ((f.search || '').trim())     p.q = f.search.trim();
  if (f.publisher)                 p.pub = f.publisher;
  if (f.contentTypes.length)       p.types = f.contentTypes.join(',');
  if (f.supportTypes.length)       p.support = f.supportTypes.join(',');
  if (f.statuses && f.statuses.length) p.status = f.statuses.join(',');
  if (f.teams && f.teams.length)   p.teams = f.teams.join(',');
  if (f.moduleDeps && f.moduleDeps.length) p.deps = f.moduleDeps.join(',');
  if (f.sortBy)                    p.sort = `${f.sortBy}:${f.sortDir || 'desc'}`;
  const cols = Object.entries(f.columnFilters).filter(([, v]) => v && v.length);
  if (cols.length) p.cols = cols.map(([k, v]) => `${k}:${v.join('|')}`).join(';');
  return p;
}

// Restore filter state from URL params. When no filter params are present, apply
// the default Support selection (everything except Deprecated) as on a fresh load.
function _applyCompFilterParams(params) {
  const has = _FILTER_PARAM_KEYS.some(k => params[k] != null);
  const f = componentFilters;
  f.search        = params.q || '';
  f.publisher     = params.pub || null;
  f.contentTypes  = params.types   ? params.types.split(',')   : [];
  f.statuses      = params.status  ? params.status.split(',')  : [];
  f.teams         = params.teams   ? params.teams.split(',')   : [];
  f.moduleDeps    = params.deps    ? params.deps.split(',')    : [];
  if (params.support) {
    f.supportTypes = params.support.split(',');
  } else if (!has) {
    _applySupportDefault();
  } else {
    f.supportTypes = [];
  }
  if (params.sort) {
    const [by, dir] = params.sort.split(':');
    f.sortBy = by || null; f.sortDir = dir === 'asc' ? 'asc' : 'desc';
  } else {
    f.sortBy = null; f.sortDir = 'desc';
  }
  f.columnFilters = {};
  if (params.cols) {
    for (const group of params.cols.split(';')) {
      const [k, vals] = group.split(':');
      if (k && vals) f.columnFilters[k] = vals.split('|');
    }
  }
}

// Mirror the current filter state into the URL without triggering a re-render.
// Preserves the active view/id and any non-filter params (e.g. selectedTab).
function _syncFiltersToURL() {
  const { view, id, params } = parseHash();
  for (const k of _FILTER_PARAM_KEYS) delete params[k];
  Object.assign(params, _compFiltersToParams());
  history.replaceState(null, '', '#' + buildHash({ view, id, params }));
}

function setupNav() {
  document.querySelectorAll('.nav-link').forEach(link => {
    const view = link.dataset.view;
    link.href = '#' + buildHash({ view });
    link.addEventListener('click', e => { e.preventDefault(); navigateTo(view); });
  });
}

// =============================================================================
// Init
// =============================================================================

function initApp() {
  if (!dbLayer) { showError('Failed to load compatibility data.'); return; }
  _applySupportDefault();
  // Snapshot history is optional and must fail soft. initApp() runs inside the
  // DB-load try/catch in webapp.html, so anything thrown here surfaces as
  // "Failed to load compatibility data." and takes down the whole report —
  // including component detail pages that do not use history at all.
  try {
    _tInit();
  } catch (err) {
    console.error('Snapshot history unavailable, continuing without trends:', err);
    TREND.ready = false;
  }
  renderScanDate();
  setupNav();
  // Public build: no browsing — remove the entire sidebar nav.
  if (IS_PUBLIC_REPORT) {
    const aside = document.querySelector('aside');
    if (aside) aside.remove();
  }
  // Reveal the Teams nav item only when the DB carries internal ownership data.
  if (dbLayer.getDistinctTeams().length > 0) {
    const navTeams = document.getElementById('nav-teams');
    if (navTeams) navTeams.classList.remove('hidden');
  }
  // Reveal the packaging nav items only when the DB carries packaging analysis
  // (databases written before it exists have no distribution_type column).
  if (dbLayer.hasPackagingData()) {
    document.querySelectorAll('[data-nav-packaging]').forEach(el => el.classList.remove('hidden'));
  }
  // Reveal the Experiments nav item only when the DB carries experimental findings.
  // The public (redacted) build empties those tables, so this stays hidden there.
  if (dbLayer.hasExperimentData()) {
    const navExp = document.getElementById('nav-experiments');
    if (navExp) navExp.classList.remove('hidden');
  }
  document.getElementById('loading-view').classList.replace('active', 'hidden');
  document.getElementById('dashboard-view').classList.replace('hidden', 'active');
  window.addEventListener('hashchange', applyHash);
  // Close publisher dropdown + filter comboboxes on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#pub-drop-container')) {
      const d = document.getElementById('pub-dropdown');
      if (d) d.classList.add('hidden');
    }
    if (!e.target.closest('.filter-combo')) {
      document.querySelectorAll('.filter-combo-panel').forEach(p => p.classList.add('hidden'));
      _openCombo = null;
    }
  });
  applyHash();
}

document.addEventListener('DOMContentLoaded', () => { if (db) initApp(); });

function showView(id) {
  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
  const el = document.getElementById(id);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
}

function showError(msg) {
  const el = document.getElementById('loading-view');
  if (el) el.innerHTML = `<div class="text-center p-8"><p class="text-gray-400">${msg}</p></div>`;
}

// =============================================================================
// Utilities
// =============================================================================

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Render a value as a single-quoted JS string literal that is also safe inside a
// double-quoted HTML attribute (e.g. onclick="fn('...')"). Escapes backslashes,
// single quotes, and HTML-sensitive characters.
function jsStr(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + "'";
}

function badge(label, colorClass, title = '') {
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colorClass}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
}

function supportBadge(supportType) {
  const map = {
    'Platform':   'bg-blue-500/10 text-blue-400 border-blue-500/20',
    'Community':  'bg-purple-500/10 text-purple-400 border-purple-500/20',
    'Partner':    'bg-orange-500/10 text-orange-400 border-orange-500/20',
    'Deprecated': 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return badge(supportType || '—', map[supportType] || 'bg-gray-500/10 text-gray-500 border-gray-500/20');
}

function contentTypeBadge(ct) {
  const map = {
    'Widget':            'bg-teal-500/10 text-teal-400 border-teal-500/20',
    'Module':            'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
    'Starter App':       'bg-green-500/10 text-green-400 border-green-500/20',
    'Solution':          'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    'Industry Template': 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    'Sample':            'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    'Theme':             'bg-pink-500/10 text-pink-400 border-pink-500/20',
  };
  return badge(ct || '—', map[ct] || 'bg-gray-500/10 text-gray-500 border-gray-500/20');
}

function widgetTypeBadge(type) {
  if (type === 'React') return badge('React', 'bg-green-500/10 text-green-400 border-green-500/20');
  if (type === 'Dojo')  return badge('Dojo',  'bg-red-500/10 text-red-400 border-red-500/20');
  return badge(type || '?', 'bg-gray-500/10 text-gray-500 border-gray-500/20');
}

function statusBadge(broken_always, breaks116, issueCount) {
  if (broken_always)      return badge('Broken',     'bg-red-500/10 text-red-400 border-red-500/20');
  if (breaks116)          return badge('Breaking',   'bg-red-500/10 text-red-400 border-red-500/20');
  if (issueCount > 0)     return badge('Warning',    'bg-amber-500/10 text-amber-400 border-amber-500/20');
  return                         badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20');
}

// Overall compatibility status of a component, collapsing every facet into one of
// breaking / warning / compatible. Drives both the status badge and the visible
// Status filter in the component-list filter bar.
function componentOverallStatus(c) {
  if (c.broken_always_count > 0 || c.breaks116_count > 0 || c.breaking_module_count > 0) return 'breaking';
  if (c.warning_widget_count > 0 || c.total_module_finding_count > 0) return 'warning';
  return 'compatible';
}

function componentStatusBadge(c) {
  if (c.broken_always_count > 0 || c.breaks116_count > 0 || c.breaking_module_count > 0)
    return badge('Breaking', 'bg-red-500/10 text-red-400 border-red-500/20');
  if (c.warning_widget_count > 0 || c.total_module_finding_count > 0)
    return badge('Warning', 'bg-amber-500/10 text-amber-400 border-amber-500/20');
  if (c.scan_error)
    return badge('Scan Error', 'bg-amber-500/10 text-amber-400 border-amber-500/20', c.scan_error);
  return badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20');
}

function reactBadge(ready) {
  return ready
    ? badge('React Ready', 'bg-green-500/10 text-green-400 border-green-500/20')
    : badge('Not React Ready', 'bg-gray-500/10 text-gray-500 border-gray-500/20');
}

function parseFindings(raw) {
  if (!raw) return [];
  return raw.split(',').filter(Boolean).map(f => {
    const parts = f.split('|');
    return { rule: parts[0] || '', category: parts[1] || '', matchCount: parseInt(parts[2]) || 0 };
  });
}

function findingCategoryColor(cat) {
  if (cat === 'removed-always' || cat === 'react19-breaking') return ['bg-red-500/10', 'text-red-400'];
  if (cat === 'react-client-only' || cat === 'dojo-widget')   return ['bg-red-500/10', 'text-red-400'];
  if (cat === 'behavior-change')                               return ['bg-amber-500/10', 'text-amber-400'];
  return ['bg-gray-500/10', 'text-gray-400'];
}

function findingBadges(rawFindings) {
  const findings = parseFindings(rawFindings);
  if (!findings.length) return '<span class="text-gray-600 text-xs">—</span>';
  return findings.map(f => {
    const [bg, text] = findingCategoryColor(f.category);
    const cnt = f.matchCount > 0 ? ` <span class="opacity-60">(${f.matchCount})</span>` : '';
    return `<span class="inline-block px-2 py-0.5 ${bg} ${text} text-xs rounded border border-current/20 mr-1 mb-1">${esc(f.rule)}${cnt}</span>`;
  }).join('');
}

function parseModuleFindings(raw) {
  if (!raw) return [];
  return raw.split('\x1e').filter(Boolean).map(f => {
    const p = f.split('|');
    return { rule: p[0]||'', category: p[1]||'', matchCount: parseInt(p[2])||0, certain: p[3]==='1', description: p[4]||'', docUrl: p[5]||'' };
  });
}

function javaFindingBadges(findings) {
  if (!findings || !findings.length) return '<span class="text-gray-600 text-xs">—</span>';
  return findings.map(f => {
    const isCertain = f.certain && (f.category === 'removed-class' || f.category === 'removed-method' || f.category === 'removed-api');
    const [bg, text] = isCertain ? ['bg-red-500/10', 'text-red-400'] : ['bg-amber-500/10', 'text-amber-400'];
    const cnt = f.matchCount > 0 ? ` <span class="opacity-60">(${f.matchCount})</span>` : '';
    return `<span class="inline-block px-2 py-0.5 ${bg} ${text} text-xs rounded border border-current/20 mr-1 mb-1">${esc(f.rule)}${cnt}</span>`;
  }).join('');
}

function card(content) {
  return `<div class="bg-dark-surface rounded-lg border border-dark-border overflow-hidden">${content}</div>`;
}

// Render the "last scanned" timestamp in the sidebar footer. window.SCAN_DATE is
// stamped into db-embedded.js at report-generation time (RFC3339 UTC).
function renderScanDate() {
  const el = document.getElementById('scan-date');
  if (!el) return;
  const raw = window.SCAN_DATE;
  if (!raw) { el.textContent = ''; return; }
  const d = new Date(raw);
  if (isNaN(d.getTime())) { el.textContent = ''; return; }
  const when = d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  el.innerHTML = `<span class="block text-gray-600">Last scanned</span>${esc(when)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return esc(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return esc(dateStr); }
}

function th(label) {
  return `<th class="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider align-middle">${label}</th>`;
}

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

function _dojoWidgetCount(c) {
  return ((dbLayer.getComponentFacetData().byId[c.id]) || {}).dojoWidgets || 0;
}

// A standalone widget package can always be imported into Mendix 11 (and Dojo
// widgets are still supported there), so the min-version support bands below don't
// apply to it. A package that bundles widgets inside a module still counts as a module.
function _isStandaloneWidget(c) { return c.content_type === 'Widget'; }

// Min Mendix version support band (modules & apps, not standalone widgets):
//   unsupported    — < 9.24 LTS, no longer supported by Mendix              (red)
//   not-importable — 9.24–10.20, supported but not directly importable to 11 (amber)
//   ok             — ≥ 10.21, importable into Mendix 11                      (green)
//   na             — standalone widget, or no declared min version          (neutral)
function mxVersionBand(c) {
  if (_isStandaloneWidget(c) || !c.min_mx_version) return 'na';
  if (dbLayer.compareVersions(c.min_mx_version, '9.24.0') < 0) return 'unsupported';
  if (dbLayer.compareVersions(c.min_mx_version, '10.21.0') < 0) return 'not-importable';
  return 'ok';
}

// Distinct model-inspected Mendix versions (from the MPR _MetaData), parsed from the
// component's GROUP_CONCAT. Empty when the package has no module or the DB predates
// the model_mx_version column (i.e. before a re-scan captures it).
function _modelVersions(c) {
  return (c.model_mx_versions || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Marketplace-vs-model version mismatch: any module built in a Mendix version that
// differs from the marketplace-declared minimum. Returns the offending values, or null.
// Compares only at the min_mx_version's precision: min_mx_version is 3-part ("10.24.8")
// while a model version carries a 4th build component ("10.24.8.80126"), so a full
// compare would flag every module. Truncate the model version to the same number of
// components before comparing.
function versionMismatch(c) {
  if (!c.min_mx_version) return null;
  const models = _modelVersions(c);
  if (!models.length) return null;
  const prec = c.min_mx_version.split('.').length;
  const atPrec = v => v.split('.').slice(0, prec).join('.');
  const diff = models.filter(mv => dbLayer.compareVersions(atPrec(mv), c.min_mx_version) !== 0);
  return diff.length ? { marketplace: c.min_mx_version, models } : null;
}

const MX_BAND_META = {
  unsupported:      { cls: 'bg-red-500/10 text-red-400 border-red-500/20',       tip: 'Built on a Mendix version older than 9.24 LTS — no longer supported by Mendix' },
  'not-importable': { cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20', tip: 'Supported, but not directly importable into Mendix 11 (modules need 10.21+)' },
  ok:               { cls: 'bg-green-500/10 text-green-400 border-green-500/20',  tip: 'Mendix 10.21+ — directly importable into Mendix 11' },
  na:               { cls: 'bg-gray-500/10 text-gray-500 border-gray-500/20',     tip: 'Standalone widget — importable into any Mendix 11 project' },
};

// Amber triangle warning icon with a tooltip — used inline next to a badge when the
// component has a caveat (version mismatch, React widgets hitting old client APIs, …).
function _warnIcon(tip) {
  return `<span class="inline-flex align-middle ml-1 text-amber-400 cursor-help" title="${esc(tip)}">
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
  </span>`;
}

function _versionWarnIcon(mm) {
  return _warnIcon(`Version mismatch — Marketplace declares minimum Mendix ${mm.marketplace}, but the model was built in ${mm.models.join(', ')}. The published metadata may be inaccurate.`);
}

// "Min Mx" cell: the declared minimum version, coloured by support band, with a
// warning icon when it disagrees with the model-inspected version.
function minMxCell(c) {
  if (!c.min_mx_version) return '<span class="text-gray-600 text-xs">—</span>';
  const m = MX_BAND_META[mxVersionBand(c)] || MX_BAND_META.na;
  const mm = versionMismatch(c);
  return `${badge(c.min_mx_version, m.cls, m.tip)}${mm ? _versionWarnIcon(mm) : ''}`;
}

// Synthetic "health" issues — quality/compatibility problems that aren't code-rule
// findings (so they have no row in findings/java_findings) but still need action.
// This registry is the single source of truth shared by the per-row health badge
// (computeHealthIssues) and the Issues catalog (buildIssueCatalog), so the two can
// never disagree about which components have which health issue.
//   predicate(c) — component HAS the issue (encodes its own applicability domain)
//   domain(c)    — component is in scope for the issue (the detail-page denominator)
//   scopeNoun    — what the denominator counts, for the "X of Y …" line
//   label(c)     — per-component sentence for the badge tooltip
// `appliesTo` (the content types a check touches) is derived empirically from the
// affected set in buildIssueCatalog, so it stays accurate without being restated.
const HEALTH_CHECKS = [
  {
    key: 'mx-unsupported', title: 'Built on an unsupported Mendix version', severity: 'breaking', kind: 'packaging',
    facets: ['mx11'], scopeNoun: 'module/app packages',
    description: 'Minimum Mendix version is older than 9.24 LTS, which is no longer supported by Mendix.',
    domain: c => !_isStandaloneWidget(c) && !!c.min_mx_version,
    predicate: c => mxVersionBand(c) === 'unsupported',
    label: c => `Built on Mendix ${c.min_mx_version} — older than 9.24 LTS, no longer supported by Mendix`,
  },
  {
    key: 'mx-not-importable', title: 'Not directly importable into Mendix 11', severity: 'possible', kind: 'packaging',
    facets: ['mx11'], scopeNoun: 'module/app packages',
    description: 'Minimum Mendix version is 9.24–10.20: supported by Mendix, but not directly importable into Mendix 11 (modules need 10.21+).',
    domain: c => !_isStandaloneWidget(c) && !!c.min_mx_version,
    predicate: c => mxVersionBand(c) === 'not-importable',
    label: c => `Built on Mendix ${c.min_mx_version} — supported, but not directly importable into Mendix 11 (needs 10.21+)`,
  },
  {
    key: 'version-mismatch', title: 'Marketplace vs model version mismatch', severity: 'possible', kind: 'packaging',
    facets: [], scopeNoun: 'inspectable packages',
    description: 'The minimum Mendix version published on the Marketplace differs from the version the model was actually built in — the published metadata may be inaccurate.',
    domain: c => _modelVersions(c).length > 0,
    predicate: c => !!versionMismatch(c),
    label: c => { const m = versionMismatch(c); return m ? `Marketplace declares min Mendix ${m.marketplace}, but model built in ${m.models.join(', ')}` : 'Version mismatch'; },
  },
  {
    key: 'stale', title: 'Stale — not updated in over a year', severity: 'quality', kind: 'maintenance',
    facets: [], scopeNoun: 'packages',
    description: 'Last published more than a year ago — may no longer be maintained.',
    domain: () => true,
    predicate: c => { const d = c.last_publish_date || c.changed_date; return !!d && new Date(d).getTime() < Date.now() - ONE_YEAR_MS; },
    label: c => `Stale — last updated ${formatDate(c.last_publish_date || c.changed_date)}`,
  },
  {
    key: 'unmanaged-deps', title: 'Unmanaged Java dependencies', severity: 'quality', kind: 'packaging',
    facets: [], scopeNoun: 'packages with userlib JARs',
    description: 'Module(s) ship JARs in userlib/ without a module-dependencies.json — dependencies are not managed.',
    domain: c => (c.userlib_module_count || 0) > 0,
    predicate: c => (c.unmanaged_dep_count || 0) > 0,
    label: c => `${c.unmanaged_dep_count} module(s) with unmanaged Java dependencies (JARs in userlib/ without module-dependencies.json)`,
  },
  {
    key: 'starter-old-mx', title: 'Starter app built on Mendix < 10', severity: 'quality', kind: 'maintenance',
    facets: [], scopeNoun: 'starter apps',
    description: 'Starter app built on a Mendix version below 10 — should be rebuilt on Mendix 11 (Mx10 acceptable).',
    domain: c => c.content_type === 'Starter App',
    predicate: c => { if (c.content_type !== 'Starter App') return false; const major = parseInt((c.min_mx_version || '').split('.')[0]) || 0; return !!c.min_mx_version && major > 0 && major < 10; },
    label: c => `Starter app: built on Mendix ${parseInt((c.min_mx_version || '').split('.')[0]) || 0} — should be rebuilt on Mendix 11 (Mx10 acceptable)`,
  },
  {
    key: 'starter-no-react', title: 'Starter app not React Client ready', severity: 'possible', kind: 'frontend',
    facets: ['react-client'], scopeNoun: 'starter apps',
    description: 'Starter app is not marked React Client ready.',
    domain: c => c.content_type === 'Starter App',
    predicate: c => c.content_type === 'Starter App' && !c.react_client_ready,
    label: () => 'Starter app: not React Client ready',
  },
  {
    key: 'starter-dojo', title: 'Starter app contains Dojo widgets', severity: 'breaking', kind: 'frontend',
    facets: ['react-client'], scopeNoun: 'starter apps',
    description: 'Starter app bundles Dojo widgets — incompatible with the React client / Mendix 12.',
    domain: c => c.content_type === 'Starter App',
    predicate: c => c.content_type === 'Starter App' && _dojoWidgetCount(c) > 0,
    label: c => `Starter app: contains ${_dojoWidgetCount(c)} Dojo widget(s) — incompatible with React client / Mendix 12`,
  },
  {
    key: 'starter-no-mpr-v2', title: 'Starter app may use legacy mpr_v1 format', severity: 'quality', kind: 'maintenance',
    facets: [], scopeNoun: 'starter apps',
    description: 'Starter app min version < 9.24.0 — may not use the mpr_v2 model format.',
    domain: c => c.content_type === 'Starter App',
    predicate: c => c.content_type === 'Starter App' && !!c.min_mx_version && dbLayer.compareVersions(c.min_mx_version, '9.24.0') < 0,
    label: () => 'Starter app: may not use mpr_v2 format (min version < 9.24.0)',
  },
];
const HEALTH_CHECK_BY_KEY = Object.fromEntries(HEALTH_CHECKS.map(h => [h.key, h]));

// Health warnings for a component row (non-compatibility quality issues), derived
// from the shared HEALTH_CHECKS registry.
function computeHealthIssues(c) {
  if (c.support_type === 'Deprecated') return [];
  return HEALTH_CHECKS.filter(h => h.predicate(c)).map(h => ({ title: h.label(c), type: h.key }));
}

function healthWarningBadge(c) {
  const issues = computeHealthIssues(c);
  if (!issues.length) return '';
  const title = issues.map(i => i.title).join('\n');
  return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded text-xs ml-1 cursor-help" title="${esc(title)}">
    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
    </svg>${issues.length > 1 ? issues.length : ''}</span>`;
}

// =============================================================================
// Dashboard trends — snapshot history
//
// Read from the report database itself: pkg/history writes snapshot_rollups /
// snapshot_changes / snapshot_movers during the scan, and every published
// report carries the whole series forward. Older databases predate those
// tables, so this degrades to today's snapshot alone.
//
// The model: under a chosen criterion every applicable component is in exactly
// one of four states — passing, possible issue, failing-but-deprecated, or
// failing-and-live. Deprecation is a RESOLUTION, not a removal: it stops
// customers being steered into content that would block their upgrade. So
// "resolved = fixed + deprecated", and the headline is open failures — failing
// AND still installable.
// =============================================================================

// Display metadata for the criteria. pkg/facets.Criteria is the source of truth
// for which criteria EXIST; this only supplies labels. Any key found in the data
// but missing here still renders, using its raw key — so adding a criterion in
// Go never silently drops it from the UI.
const CRITERION_LABELS = {
  'mx10':         { label: 'Mendix 10 compatible',      short: 'Mx10',         group: 'Compatibility' },
  'mx11':         { label: 'Mendix 11 compatible',      short: 'Mx11',         group: 'Compatibility' },
  'react-client': { label: 'React Client compatible',   short: 'React Client', group: 'Compatibility' },
  'new-string':   { label: 'New string handling',       short: 'New String',   group: 'Compatibility' },
  'mx12':         { label: 'Mendix 12+ ready',          short: 'Mx12+',        group: 'Compatibility' },
  'managed-deps': { label: 'Managed Java dependencies', short: 'Managed deps', group: 'Health' },
  'importable':   { label: 'Importable into Mendix 11', short: 'Importable',   group: 'Health' },
  'maintained':   { label: 'Actively maintained',       short: 'Maintained',   group: 'Health' },
};
const CRITERION_ORDER = Object.keys(CRITERION_LABELS);

const TREND = {
  ready: false,
  criteria: [],
  segments: [],
  snapshots: [],
  state: { criterion: 'mx11', days: 7, measure: 'count', view: 'chart', movers: 'fixed', content: [], support: [] },
};

function _tInit() {
  if (!dbLayer || !dbLayer.hasSnapshotHistory()) return false;
  const snaps = dbLayer.getSnapshots();
  const rollups = dbLayer.getSnapshotRollups();
  if (snaps.length < 2 || !rollups.length) return false;

  // Intern segments locally; the DB stores them as plain strings per row.
  const segIndex = new Map();
  TREND.segments = [];
  const segId = (c, s) => {
    const key = `${c} ${s}`;
    if (!segIndex.has(key)) { segIndex.set(key, TREND.segments.length); TREND.segments.push([c, s]); }
    return segIndex.get(key);
  };

  const critKeys = [...new Set(rollups.map(r => r.criterion))];
  critKeys.sort((a, b) => {
    const ia = CRITERION_ORDER.indexOf(a), ib = CRITERION_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  TREND.criteria = critKeys.map(key => ({
    key,
    label: (CRITERION_LABELS[key] || {}).label || key,
    short: (CRITERION_LABELS[key] || {}).short || key,
    group: (CRITERION_LABELS[key] || {}).group || 'Other',
  }));
  const critIdx = Object.fromEntries(critKeys.map((k, i) => [k, i]));

  // Reshape into the row form the chart code consumes:
  // [criterionIdx, segmentIdx, components, pass, possible, open, contained, na,
  //  downloads, dlPass, dlPossible, dlOpen, dlContained]
  const bySnapshot = new Map(snaps.map(s => [s.id, []]));
  for (const r of rollups) {
    const rows = bySnapshot.get(r.snapshot_id);
    if (!rows) continue;
    rows.push([critIdx[r.criterion], segId(r.content_type, r.support_type),
      r.components, r.pass, r.possible, r.open_fail, r.dep_fail, r.not_appl,
      r.downloads, r.dl_pass, r.dl_possible, r.dl_open_fail, r.dl_dep_fail,
      r.open_fail_mx11_ready || 0, r.dl_open_fail_mx11_ready || 0]);
  }

  const changesBy = new Map(snaps.map(s => [s.id, []]));
  for (const c of dbLayer.getSnapshotChanges()) {
    const list = changesBy.get(c.snapshot_id);
    if (list) list.push({ k: c.criterion, fixed: c.fixed, deprecated: c.deprecated, regressed: c.regressed,
      reclassified: c.reclassified, arrived: c.arrived, departed: c.departed });
  }
  const moversBy = new Map(snaps.map(s => [s.id, []]));
  for (const m of dbLayer.getSnapshotMovers()) {
    const list = moversBy.get(m.snapshot_id);
    if (list) list.push({ k: m.criterion, id: m.marketplace_id, name: m.name, pub: m.publisher,
      c: m.content_type, s: m.support_type, dl: m.downloads, kind: m.kind, result: m.result_status || '' });
  }

  TREND.snapshots = snaps.map(s => ({
    t: Date.parse(s.scanned_at),
    rows: bySnapshot.get(s.id) || [],
    changes: changesBy.get(s.id) || [],
    movers: moversBy.get(s.id) || [],
    moversOmitted: s.movers_omitted || 0,
  })).filter(s => !isNaN(s.t)).sort((a, b) => a.t - b.t);

  TREND.contentTypes = [...new Set(TREND.segments.map(s => s[0]))].sort();
  TREND.supportTypes = [...new Set(TREND.segments.map(s => s[1]))].sort();
  if (!TREND.criteria.some(c => c.key === TREND.state.criterion)) {
    TREND.state.criterion = (TREND.criteria[0] || {}).key;
  }
  TREND.ready = TREND.criteria.length > 0 && TREND.snapshots.length >= 2;
  return TREND.ready;
}

const _tCrit = () => TREND.criteria.find(c => c.key === TREND.state.criterion) || TREND.criteria[0];
const _tNum = n => Math.round(n).toLocaleString('en-US');
const _tDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const _tCSS = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const _SVGNS = 'http://www.w3.org/2000/svg';
const _tEl = (tag, attrs = {}) => {
  const n = document.createElementNS(_SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

// Which interned segments survive the content/support filters.
function _tAllowedSegments() {
  const { content, support } = TREND.state;
  return TREND.segments.map(([c, s]) =>
    (!content.length || content.includes(c)) && (!support.length || support.includes(s)));
}

const _tSeriesCache = new Map();
function _tCacheKey(critKey) {
  return `${critKey}|${TREND.state.content.join(',')}|${TREND.state.support.join(',')}`;
}

// Per-snapshot totals for one criterion over the segments in scope.
function _tSeries(critKey) {
  const ck = _tCacheKey(critKey);
  if (_tSeriesCache.has(ck)) return _tSeriesCache.get(ck);
  const ci = TREND.criteria.findIndex(c => c.key === critKey);
  const allow = _tAllowedSegments();
  const out = TREND.snapshots.map(s => {
    const a = { t: s.t, comps: 0, pass: 0, possible: 0, open: 0, contained: 0, na: 0,
                dl: 0, dlPass: 0, dlPossible: 0, dlOpen: 0, dlContained: 0,
                claimsMx11: 0, dlClaimsMx11: 0 };
    for (const r of s.rows) {
      if (r[0] !== ci || !allow[r[1]]) continue;
      a.comps += r[2]; a.pass += r[3]; a.possible += r[4]; a.open += r[5]; a.contained += r[6]; a.na += r[7];
      a.dl += r[8]; a.dlPass += r[9]; a.dlPossible += r[10]; a.dlOpen += r[11]; a.dlContained += r[12];
      a.claimsMx11 += r[13] || 0; a.dlClaimsMx11 += r[14] || 0;
    }
    // An unresolved failure splits into two different problems. A component that
    // only supports Mx10 or older BLOCKS an upgrade: a team adopts it today and
    // finds out months later that it pins them below Mendix 11. One that
    // advertises Mendix 11 support and fails anyway is broken right now for
    // anyone who believed the listing.
    a.blockers = Math.max(0, a.open - a.claimsMx11);
    a.dlBlockers = Math.max(0, a.dlOpen - a.dlClaimsMx11);
    a.applicable = a.comps - a.na;
    // Downloads carry no NA bucket of their own; the applicable download base is
    // exactly the four states summed.
    a.dlApplicable = a.dlPass + a.dlPossible + a.dlOpen + a.dlContained;
    return a;
  });
  _tSeriesCache.set(ck, out);
  return out;
}

// Bands under the current weight toggle.
function _tBands(p) {
  return TREND.state.measure === 'usage'
    ? { pass: p.dlPass, possible: p.dlPossible, contained: p.dlContained, open: p.dlOpen, total: p.dlApplicable }
    : { pass: p.pass, possible: p.possible, contained: p.contained, open: p.open, total: p.applicable };
}

const _T_BANDS = [
  { k: 'open',      name: 'Failing · live',       cvar: '--open' },
  { k: 'contained', name: 'Failing · deprecated', cvar: '--contained' },
  { k: 'possible',  name: 'Possible issue',       cvar: '--possible' },
  { k: 'pass',      name: 'Passing',              cvar: '--pass' },
];

// Index of the snapshot to compare against. Snapshots are NOT evenly spaced —
// a pipeline can be skipped for days — so the period resolves by timestamp and
// picks the newest snapshot at or before the cutoff, never a fixed offset.
function _tPeriodStart() {
  const S = TREND.snapshots;
  if (TREND.state.days === 'all') return 0;
  const cutoff = S[S.length - 1].t - TREND.state.days * 86400000;
  // Nearest to the cutoff, either side. Taking the newest at-or-before instead
  // meant a scan four minutes past the cutoff was skipped for the one a day
  // earlier, and a 7-day request reported "8 days" — technically honest, but it
  // reads as a bug when the scans are plainly daily.
  let idx = 0, best = Infinity;
  for (let i = 0; i < S.length - 1; i++) {
    const d = Math.abs(S[i].t - cutoff);
    if (d < best) { best = d; idx = i; }
  }
  return idx;
}

// Actual span covered, which can exceed the requested period when snapshots are
// missing. Reporting "7 days" over a 13-day gap would be a lie.
function _tPeriodSpanDays() {
  const S = TREND.snapshots;
  return Math.max(1, Math.round((S[S.length - 1].t - S[_tPeriodStart()].t) / 86400000));
}

// Sum the per-snapshot transitions across the comparison window.
function _tChanges(critKey) {
  const start = _tPeriodStart();
  const agg = { fixed: 0, deprecated: 0, regressed: 0, reclassified: 0, arrived: 0, departed: 0 };
  for (let i = start + 1; i < TREND.snapshots.length; i++) {
    for (const c of (TREND.snapshots[i].changes || [])) {
      if (c.k !== critKey) continue;
      for (const k in agg) agg[k] += c[k] || 0;
    }
  }
  return agg;
}

// Named component transitions in the window, newest first, most-downloaded
// first within a snapshot. Deduped so one component appears once.
function _tMovers(critKey, kind) {
  const start = _tPeriodStart();
  const { content, support } = TREND.state;
  const seen = new Set(), out = [];
  let omitted = 0;
  for (let i = TREND.snapshots.length - 1; i > start; i--) {
    const s = TREND.snapshots[i];
    omitted += s.moversOmitted || 0;
    for (const m of (s.movers || [])) {
      if (m.k !== critKey || m.kind !== kind) continue;
      if (content.length && !content.includes(m.c)) continue;
      if (support.length && !support.includes(m.s)) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ ...m, when: s.t });
    }
  }
  return { movers: out, omitted };
}

const _tTip = () => document.getElementById('viz-tip');
function _tShowTip(html, x, y) {
  const tip = _tTip();
  if (!tip) return;
  tip.innerHTML = html;
  tip.style.opacity = '1';
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(8, x + 14)) + 'px';
  tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
}
function _tHideTip() { const tip = _tTip(); if (tip) tip.style.opacity = '0'; }

// Arrow + sign + word, so direction never rides on colour alone.
function _tDelta(v, goodIsUp) {
  if (!v) return '<span class="text-gray-500">no change</span>';
  const good = goodIsUp ? v > 0 : v < 0;
  const col = good ? _tCSS('--pass') : _tCSS('--open');
  return `<span class="tnum" style="color:${col}">${v > 0 ? '▲' : '▼'} ${v > 0 ? '+' : '−'}${_tNum(Math.abs(v))}</span>`;
}

// Draw into a host at its measured width, and redraw whenever that width
// changes. Tailwind is loaded from a CDN at runtime, so on first paint the grid
// classes may still have no CSS and every cell measures the full container
// width — a one-shot clientWidth read bakes that mistake in permanently. The
// observer also covers window resizes and the sidebar appearing.
const _tResizeObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        if (!e.target._tDraw || w <= 0 || w === e.target._tWidth) continue;
        e.target._tWidth = w;
        e.target._tDraw(w);
      }
    })
  : null;

function _tAutoDraw(host, draw) {
  if (!host) return;
  host._tDraw = draw;
  const w = Math.round(host.getBoundingClientRect().width);
  host._tWidth = w;
  if (w > 0) draw(w);
  if (_tResizeObserver) _tResizeObserver.observe(host);
}

// fixedW pins the width (for hosts that are not full-bleed, like the hero
// sparkline sitting next to flexible text); otherwise the host is measured and
// observed.
function _tSparkline(host, values, color, h, fixedW) {
  if (!host || !values.length) return;
  if (fixedW) { _tDrawSparkline(host, values, color, fixedW, h); return; }
  host.style.overflow = 'hidden';
  _tAutoDraw(host, w => _tDrawSparkline(host, values, color, w, h));
}

function _tDrawSparkline(host, values, color, w, h) {
  host.innerHTML = '';
  const svg = _tEl('svg', { width: w, height: h, class: 'viz-svg', 'aria-hidden': 'true' });
  const min = Math.min(...values), max = Math.max(...values), rng = (max - min) || 1;
  const X = i => (i / Math.max(1, values.length - 1)) * (w - 6) + 3;
  const Y = v => h - 5 - ((v - min) / rng) * (h - 10);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  svg.appendChild(_tEl('path', { d: `${d} L${X(values.length - 1)},${h} L${X(0)},${h} Z`, fill: color, 'fill-opacity': '.09' }));
  svg.appendChild(_tEl('path', { d, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.appendChild(_tEl('circle', { cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 4, fill: color, stroke: _tCSS('--viz-surface'), 'stroke-width': '2' }));
  host.appendChild(svg);
}

// -----------------------------------------------------------------------------
// Trends markup
// -----------------------------------------------------------------------------

function _tSectionHTML() {
  if (!TREND.ready) {
    return `<div class="bg-dark-surface rounded-lg border border-dark-border px-5 py-4 mb-6">
      <p class="text-sm text-gray-400">Trend data not available yet.</p>
      <p class="text-xs text-gray-500 mt-1">This report carries fewer than two snapshots. A scan run with
      <code class="text-gray-400">--history-archive</code> carries the series forward from the previously published report;
      <code class="text-gray-400">mx-scanner history --repo &lt;snapshot-archive&gt;</code> rebuilds it from the full archive.</p>
    </div>`;
  }
  const groups = [...new Set(TREND.criteria.map(c => c.group))];
  return `
    <div class="flex flex-wrap items-center gap-x-7 gap-y-3 mb-6 pb-5 border-b border-dark-border">
      <div class="flex items-center gap-2.5">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-medium">Criterion</span>
        <select class="crit" id="t-criterion">
          ${groups.map(g => `<optgroup label="${esc(g)}">
            ${TREND.criteria.filter(c => c.group === g).map(c =>
              `<option value="${esc(c.key)}"${c.key === TREND.state.criterion ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}
          </optgroup>`).join('')}
        </select>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-medium">Compare over</span>
        <div class="seg" id="t-period">
          ${[1, 7, 14, 30, 90].map(d => `<button data-v="${d}"${d === TREND.state.days ? ' class="on"' : ''}>${d}d</button>`).join('')}<button data-v="all"${TREND.state.days === 'all' ? ' class="on"' : ''}>All</button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-medium">Weight</span>
        <div class="seg" id="t-measure">
          <button data-v="count"${TREND.state.measure === 'count' ? ' class="on"' : ''}>Per component</button
          ><button data-v="usage"${TREND.state.measure === 'usage' ? ' class="on"' : ''}>By downloads</button>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-medium">Content type</span>
        <div id="t-combo-content"></div>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 uppercase tracking-wider font-medium">Support type</span>
        <div id="t-combo-support"></div>
      </div>
      <div id="t-scope" class="text-xs text-gray-500 basis-full"></div>
    </div>

    <div id="t-empty" class="hidden bg-dark-surface rounded-lg border border-dark-border px-5 py-12 text-center mb-6">
      <p class="text-sm text-gray-400" id="t-empty-msg"></p>
      <button id="t-reset" class="mt-3 text-xs text-mx-blue hover:underline">Clear filters</button>
    </div>

    <div id="t-body">
      <div class="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        <div class="lg:col-span-2 bg-dark-surface rounded-lg border border-dark-border p-5">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="text-xs font-medium text-gray-500 uppercase tracking-wider">Upgrade blockers</p>
              <div class="flex items-baseline gap-3 mt-2">
                <span id="t-hero" class="text-[52px] leading-none font-semibold text-white tnum"></span>
                <span id="t-hero-delta" class="text-sm font-medium"></span>
              </div>
              <p id="t-hero-sub" class="text-xs text-gray-500 mt-2"></p>
            </div>
            <div class="flex-shrink-0 pt-1"><div id="t-hero-spark"></div></div>
          </div>
        </div>
        <div class="bg-dark-surface rounded-lg border border-dark-border p-4">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wider">Already broken on Mx11</p>
          <div class="flex items-baseline gap-2 mt-1.5">
            <span id="t-claims" class="text-3xl font-semibold text-white tnum"></span>
            <span id="t-claims-delta" class="text-xs font-medium"></span>
          </div>
          <p id="t-claims-sub" class="text-xs text-gray-500 mt-1"></p>
          <div id="t-claims-spark" class="mt-2.5"></div>
        </div>
        <div class="bg-dark-surface rounded-lg border border-dark-border p-4">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wider">Resolved in period</p>
          <div class="flex items-baseline gap-2 mt-1.5">
            <span id="t-resolved" class="text-3xl font-semibold text-white tnum"></span>
            <span id="t-resolved-note" class="text-xs text-gray-500"></span>
          </div>
          <p id="t-resolved-sub" class="text-xs text-gray-500 mt-1"></p>
          <div id="t-resolved-split" class="mt-2.5"></div>
          <p id="t-contained" class="text-xs text-gray-500 mt-2 pt-2 border-t border-dark-border"></p>
        </div>
      </div>

      <div class="bg-dark-surface rounded-lg border border-dark-border mb-6">
        <div class="px-5 py-4 border-b border-dark-border flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 class="text-sm font-semibold text-white" id="t-chart-title"></h3>
            <p class="text-xs text-gray-500 mt-0.5" id="t-chart-sub"></p>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-3.5 text-xs" id="t-legend"></div>
            <div class="seg" id="t-view">
              <button data-v="chart"${TREND.state.view === 'chart' ? ' class="on"' : ''}>Chart</button
              ><button data-v="table"${TREND.state.view === 'table' ? ' class="on"' : ''}>Table</button>
            </div>
          </div>
        </div>
        <div class="p-5">
          <div id="t-chart"></div>
          <div id="t-table" class="hidden max-h-96 overflow-y-auto"></div>
          <div id="t-rule-legend" class="mt-3 flex flex-wrap gap-x-6 gap-y-1.5"></div>
        </div>
      </div>

      <div class="mb-6">
        <div class="flex items-baseline gap-2 mb-3">
          <h3 class="text-sm font-semibold text-white">All criteria</h3>
          <span class="text-xs text-gray-500">Unresolved failures per criterion — click a card to scope the dashboard to it.</span>
        </div>
        <div id="t-cards" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        <div class="lg:col-span-2 bg-dark-surface rounded-lg border border-dark-border">
          <div class="px-5 py-4 border-b border-dark-border">
            <h3 class="text-sm font-semibold text-white">What actually changed</h3>
            <p class="text-xs text-gray-500 mt-0.5" id="t-wf-sub"></p>
          </div>
          <div class="p-5"><div id="t-waterfall"></div></div>
        </div>
        <div class="lg:col-span-3 bg-dark-surface rounded-lg border border-dark-border">
          <div class="px-5 py-4 border-b border-dark-border flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 class="text-sm font-semibold text-white">Movers</h3>
              <p class="text-xs text-gray-500 mt-0.5" id="t-movers-sub"></p>
            </div>
            <div class="seg" id="t-movers-kind">
              <button data-v="fixed" class="on">Fixed</button
              ><button data-v="deprecated">Deprecated</button
              ><button data-v="regressed">Newly failing</button
              ><button data-v="reclassified">Reclassified</button>
            </div>
          </div>
          <div id="t-movers"></div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
        <div class="lg:col-span-3 bg-dark-surface rounded-lg border border-dark-border">
          <div class="px-5 py-4 border-b border-dark-border">
            <h3 class="text-sm font-semibold text-white">Chase these first</h3>
            <p class="text-xs text-gray-500 mt-0.5" id="t-worst-sub"></p>
          </div>
          <div id="t-worst"></div>
        </div>
        <div class="lg:col-span-2 bg-dark-surface rounded-lg border border-dark-border">
          <div class="px-5 py-4 border-b border-dark-border">
            <h3 class="text-sm font-semibold text-white">Where it concentrates</h3>
            <p class="text-xs text-gray-500 mt-0.5" id="t-conc-sub"></p>
          </div>
          <div id="t-conc"></div>
        </div>
      </div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Trends rendering
// -----------------------------------------------------------------------------

function _tRenderScope() {
  const allow = _tAllowedSegments();
  const { content, support } = TREND.state;
  const last = TREND.snapshots[TREND.snapshots.length - 1];
  let comps = 0, dl = 0;
  const ci = 0; // any criterion covers every segment; counts are criterion-independent
  for (const r of last.rows) if (r[0] === ci && allow[r[1]]) { comps += r[2]; dl += r[8]; }
  const total = last.rows.filter(r => r[0] === ci).reduce((a, r) => a + r[2], 0);
  const el = document.getElementById('t-scope');
  if (!el) return;
  const filtered = content.length || support.length;
  el.innerHTML = filtered
    ? `Scoped to <span class="text-gray-300">${esc(content.join(', ') || 'all content types')}</span> ·
       <span class="text-gray-300">${esc(support.join(', ') || 'all support types')}</span> —
       <span class="text-gray-300 tnum">${_tNum(comps)}</span> of ${_tNum(total)} components,
       <span class="text-gray-300 tnum">${_tNum(dl)}</span> downloads.
       <button id="t-scope-reset" class="text-mx-blue hover:underline ml-1">Reset</button>`
    : `${_tNum(TREND.snapshots.length)} snapshots from ${_tDate(TREND.snapshots[0].t)} to ${_tDate(last.t)} ·
       all <span class="text-gray-300 tnum">${_tNum(total)}</span> components in scope.`;
  const reset = document.getElementById('t-scope-reset');
  if (reset) reset.addEventListener('click', () => { TREND.state.content = []; TREND.state.support = []; _tRedrawCombos(); _tRender(); });
}

function _tRenderKPIs() {
  const c = _tCrit(), s = _tSeries(c.key);
  const last = s[s.length - 1], first = s[_tPeriodStart()];
  const span = _tPeriodSpanDays();
  const usage = TREND.state.measure === 'usage';
  const unit = usage ? 'downloads' : 'components';
  const val = (p, k) => usage ? p['dl' + k[0].toUpperCase() + k.slice(1)] : p[k];

  // Headline is the upgrade blockers, not the raw failure count. A component
  // that fails and only supports Mx10 or older is the actual harm: a team adopts
  // it today and discovers months later that it pins them below Mendix 11.
  const blockNow = val(last, 'blockers'), blockThen = val(first, 'blockers');
  document.getElementById('t-hero').textContent = _tNum(blockNow);
  document.getElementById('t-hero-delta').innerHTML =
    `${_tDelta(blockNow - blockThen, false)} <span class="text-gray-500">vs ${span} day${span === 1 ? '' : 's'} ago</span>`;
  document.getElementById('t-hero-sub').innerHTML =
    `${usage ? 'Downloads on components that fail' : 'Components that fail'} <span class="text-gray-400">${esc(c.label)}</span>,
     are still published, and support only Mendix 10 or older. A team adopting one today is pinned below Mendix 11 until it is fixed.`;
  _tSparkline(document.getElementById('t-hero-spark'), s.map(p => val(p, 'blockers')), _tCSS('--open'), 52, 140);

  // The other half of the same failure: it advertises Mendix 11 and fails anyway.
  const claimNow = val(last, 'claimsMx11'), claimThen = val(first, 'claimsMx11');
  document.getElementById('t-claims').textContent = _tNum(claimNow);
  document.getElementById('t-claims-delta').innerHTML = _tDelta(claimNow - claimThen, false);
  document.getElementById('t-claims-sub').innerHTML =
    `advertise Mendix 11 support and still fail <span class="text-gray-400">${esc(c.short)}</span> — broken now for anyone who believed the listing`;
  _tSparkline(document.getElementById('t-claims-spark'), s.map(p => val(p, 'claimsMx11')), _tCSS('--open'), 34);

  const ch = _tChanges(c.key);
  const resolved = ch.fixed + ch.deprecated;
  document.getElementById('t-resolved').textContent = _tNum(resolved);
  document.getElementById('t-resolved-note').textContent = `in ${span} day${span === 1 ? '' : 's'}`;
  document.getElementById('t-resolved-sub').innerHTML =
    `<span class="tnum" style="color:${_tCSS('--pass')}">${_tNum(ch.fixed)} fixed</span> ·
     <span class="tnum" style="color:${_tCSS('--contained')}">${_tNum(ch.deprecated)} deprecated</span>`;
  const denom = Math.max(1, resolved);
  document.getElementById('t-resolved-split').innerHTML = `
    <div class="flex h-2.5 rounded-sm overflow-hidden" style="background:#ffffff0d">
      <div style="width:${100 * ch.fixed / denom}%;background:${_tCSS('--pass')}"></div>
      <div style="width:2px;background:${_tCSS('--viz-surface')}"></div>
      <div style="width:${100 * ch.deprecated / denom}%;background:${_tCSS('--contained')}"></div>
    </div>`;
  // Deprecation stops new adoption; it does not unblock teams that already
  // installed the component. Say so rather than let it read as a clean fix.
  document.getElementById('t-contained').innerHTML =
    `<span class="tnum" style="color:${_tCSS('--contained')}">${_tNum(last.contained)}</span> contained by deprecation —
     no longer offered, but teams already on them stay blocked until they migrate off.`;

  document.getElementById('t-chart-title').textContent = `${c.label} — status over time`;
  const shown = s.length - _tPeriodStart();
  document.getElementById('t-chart-sub').textContent = TREND.state.days === 'all'
    ? `All ${_tNum(s.length)} scans, ${_tDate(s[0].t)} to ${_tDate(last.t)}.`
    : `${_tNum(shown)} scan${shown === 1 ? '' : 's'} over the last ${span} day${span === 1 ? '' : 's'}.`;
  document.getElementById('t-legend').innerHTML = _T_BANDS
    .filter(b => s.some(p => _tBands(p)[b.k] > 0)).slice().reverse()
    .map(b => `<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${_tCSS(b.cvar)}"></span><span class="text-gray-400">${b.name}</span></span>`)
    .join('');
  document.getElementById('t-wf-sub').textContent = `Unresolved failures, decomposed over the last ${span} day${span === 1 ? '' : 's'}`;
}

// Main chart: 100% stacked area over a real time axis (snapshots are irregular,
// so an index axis would misplace every gap), plus a containment strip re-based
// on the failing population — where deprecated failures are ~1% of the catalog
// they are a hairline in the chart above, but a legible share of the failures.
function _tRenderChart() {
  _tAutoDraw(document.getElementById('t-chart'), w => _tDrawChart(w));
}

function _tDrawChart(W) {
  const host = document.getElementById('t-chart');
  if (!host) return;
  host.innerHTML = '';
  // Scoped to the selected period, like everything else on the page. "All" is
  // in the period control for when the full series is what you want.
  const c = _tCrit(), offset = _tPeriodStart(), rows = _tSeries(c.key).slice(offset);
  const H = 314, PAD = { t: 14, r: 74, b: 56, l: 44 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const X = t => PAD.l + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
  const Y = p => PAD.t + ih - (p / 100) * ih;

  const svg = _tEl('svg', { width: W, height: H, class: 'viz-svg', role: 'img',
    'aria-label': `Share of applicable components passing, possibly affected, failing but deprecated, or failing and live, for ${c.label}` });

  [0, 25, 50, 75, 100].forEach(p => {
    svg.appendChild(_tEl('line', { x1: PAD.l, x2: PAD.l + iw, y1: Y(p), y2: Y(p), stroke: _tCSS('--viz-grid'), 'stroke-width': '1' }));
    const t = _tEl('text', { x: PAD.l - 8, y: Y(p) + 4, 'text-anchor': 'end', fill: _tCSS('--viz-muted'), 'font-size': '11' });
    t.textContent = p + '%'; svg.appendChild(t);
  });

  const active = _T_BANDS.filter(b => rows.some(p => _tBands(p)[b.k] > 0));
  const cum = rows.map(() => 0);
  active.forEach((b, bi) => {
    const lower = cum.slice();
    rows.forEach((p, i) => { const v = _tBands(p); cum[i] += v.total ? 100 * v[b.k] / v.total : 0; });
    const up = rows.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(cum[i]).toFixed(1)}`).join(' ');
    const down = rows.map((p, i) => `L${X(rows[rows.length - 1 - i].t).toFixed(1)},${Y(lower[rows.length - 1 - i]).toFixed(1)}`).join(' ');
    // Large fills stay muted; a saturated block at this size reads loud.
    svg.appendChild(_tEl('path', { d: `${up} ${down} Z`, fill: _tCSS(b.cvar), 'fill-opacity': '0.58' }));
    // 2px surface gap does the separating — never a stroke around the mark.
    if (bi < active.length - 1) svg.appendChild(_tEl('path', { d: up, fill: 'none', stroke: _tCSS('--viz-surface'), 'stroke-width': '2' }));
    b._share = cum[cum.length - 1] - lower[lower.length - 1];
    b._mid = (cum[cum.length - 1] + lower[lower.length - 1]) / 2;
  });
  // Direct-label selectively: only bands with room for the text.
  active.forEach(b => {
    if (b._share < 6) return;
    const t = _tEl('text', { x: PAD.l + iw + 8, y: Y(b._mid) + 4, fill: _tCSS('--viz-ink'), 'font-size': '11', 'font-weight': '500' });
    t.textContent = b._share.toFixed(1) + '%'; svg.appendChild(t);
  });

  svg.appendChild(_tEl('line', { x1: PAD.l, x2: PAD.l + iw, y1: Y(0), y2: Y(0), stroke: _tCSS('--viz-axis'), 'stroke-width': '1' }));

  // Label by pixel spacing, not by index: on a time axis a run of daily scans
  // after a two-week gap sits almost on top of itself, and every-nth-index
  // labelling would print them overlapping.
  const MIN_LABEL_GAP = 68;
  let lastLabelX = -Infinity;
  const labelled = new Set([rows.length - 1]);
  rows.forEach((p, i) => {
    if (i === rows.length - 1) return;
    if (X(p.t) - lastLabelX < MIN_LABEL_GAP) return;
    if (X(rows[rows.length - 1].t) - X(p.t) < MIN_LABEL_GAP) return; // keep clear of the pinned last label
    lastLabelX = X(p.t);
    labelled.add(i);
  });
  rows.forEach((p, i) => {
    if (!labelled.has(i)) return;
    const t = _tEl('text', { x: X(p.t), y: H - 10, 'text-anchor': 'middle', fill: _tCSS('--viz-muted'), 'font-size': '11' });
    t.textContent = _tDate(p.t); svg.appendChild(t);
  });
  // A tick per snapshot, so irregular scan cadence is visible rather than implied.
  rows.forEach(p => svg.appendChild(_tEl('line', { x1: X(p.t), x2: X(p.t), y1: Y(0), y2: Y(0) + 4, stroke: _tCSS('--viz-axis'), 'stroke-width': '1' })));

  // Scanner-rule changes. A snapshot with a non-zero "reclassified" count is one
  // where components changed verdict WITHOUT publishing a new version — the
  // ecosystem did not move, our rules did. Marking them on the axis is what stops
  // a step in the line being read as progress. Derived from the data, so it needs
  // no hand-maintained list of rule edits.
  const rawEvents = [];
  rows.forEach((p, i) => {
    const n = (TREND.snapshots[offset + i].changes || []).find(x => x.k === c.key);
    if (n && n.reclassified) rawEvents.push({ delta: n.reclassified, t: p.t });
  });
  // Rule edits land in bursts — several scans in one afternoon — and at this
  // scale their markers overlap into an unreadable smear of letters. Merge any
  // that fall within a marker's width of each other and sum the effect, so one
  // glyph means one episode rather than one scan.
  const MARKER_GAP = 18;
  const ruleEvents = [];
  for (const ev of rawEvents) {
    const prev = ruleEvents[ruleEvents.length - 1];
    if (prev && X(ev.t) - X(prev.t) < MARKER_GAP) {
      prev.delta += ev.delta;
      prev.merged++;
      prev.until = ev.t;
    } else {
      ruleEvents.push({ ...ev, merged: 1, until: ev.t });
    }
  }
  ruleEvents.forEach((ev, k) => {
    const mx = X(ev.t);
    svg.appendChild(_tEl('line', { x1: mx, x2: mx, y1: PAD.t, y2: Y(0), stroke: _tCSS('--viz-muted'), 'stroke-width': '1', 'stroke-opacity': '.55' }));
    const g = _tEl('g', { style: 'cursor:help' });
    g.appendChild(_tEl('path', { d: `M${mx},${Y(0) + 3} l-5,8 l10,0 Z`, fill: _tCSS('--viz-ink') }));
    const lb = _tEl('text', { x: mx, y: Y(0) + 21, 'text-anchor': 'middle', fill: _tCSS('--viz-ink'), 'font-size': '9', 'font-weight': '700' });
    lb.textContent = String.fromCharCode(65 + (k % 26));
    g.appendChild(lb);
    g.appendChild(_tEl('rect', { x: mx - 12, y: Y(0), width: 24, height: 26, fill: 'transparent' }));
    const when = ev.merged > 1
      ? `${_tDate(ev.until) !== _tDate(ev.t) ? `${_tDate(ev.t)} – ${_tDate(ev.until)}` : _tDate(ev.t)}, ${ev.merged} scans`
      : _tDate(ev.t);
    g.addEventListener('mousemove', e => _tShowTip(
      `<div class="v" style="font-weight:600;margin-bottom:2px">Scanner rule change ${String.fromCharCode(65 + (k % 26))}</div>
       <div class="k" style="margin-bottom:4px">${when}</div>
       <div class="k" style="max-width:250px">${_tNum(Math.abs(ev.delta))} component${Math.abs(ev.delta) === 1 ? '' : 's'}
       changed verdict without publishing a new version — the components did not change, our rules did.</div>
       <div style="margin-top:6px;padding-top:5px;border-top:1px solid #30363D" class="k">Effect
       <span class="v">${ev.delta > 0 ? '+' : '−'}${_tNum(Math.abs(ev.delta))}</span> unresolved — excluded from progress</div>`,
      e.clientX, e.clientY));
    g.addEventListener('mouseleave', _tHideTip);
    svg.appendChild(g);
  });

  const cross = _tEl('line', { y1: PAD.t, y2: Y(0), stroke: _tCSS('--viz-ink'), 'stroke-width': '1', 'stroke-opacity': '0', 'pointer-events': 'none' });
  svg.appendChild(cross);
  const hit = _tEl('rect', { x: PAD.l, y: PAD.t, width: iw, height: ih, fill: 'transparent' });
  const nearest = clientX => {
    const bx = svg.getBoundingClientRect();
    const want = t0 + ((clientX - bx.left - PAD.l) / iw) * (t1 - t0);
    let best = 0;
    rows.forEach((p, i) => { if (Math.abs(p.t - want) < Math.abs(rows[best].t - want)) best = i; });
    return best;
  };
  hit.addEventListener('mousemove', e => {
    const p = rows[nearest(e.clientX)], v = _tBands(p);
    cross.setAttribute('x1', X(p.t)); cross.setAttribute('x2', X(p.t)); cross.setAttribute('stroke-opacity', '.45');
    const line = b => `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:${_tCSS(b.cvar)};display:inline-block"></span><span class="k">${b.name}</span></span>
        <span class="v">${_tNum(v[b.k])} <span class="k">${v.total ? (100 * v[b.k] / v.total).toFixed(1) : '0.0'}%</span></span></div>`;
    _tShowTip(`<div class="v" style="font-weight:600;margin-bottom:5px">${_tDate(p.t)}</div>
      ${_T_BANDS.filter(b => v[b.k] > 0).map(line).join('')}
      <div style="margin-top:5px;padding-top:5px;border-top:1px solid #30363D;display:flex;justify-content:space-between;gap:10px">
        <span class="k">Applicable ${TREND.state.measure === 'usage' ? 'downloads' : 'components'}</span><span class="v">${_tNum(v.total)}</span></div>`,
      e.clientX, e.clientY);
  });
  hit.addEventListener('mouseleave', () => { _tHideTip(); cross.setAttribute('stroke-opacity', '0'); });
  svg.appendChild(hit);
  host.appendChild(svg);

  // Containment strip.
  const SH = 78, sTop = 18, sh = SH - sTop - 4;
  const s2 = _tEl('svg', { width: W, height: SH, class: 'viz-svg', role: 'img',
    'aria-label': 'Of the components failing this criterion, the share contained by deprecation versus still unresolved' });
  const cap = _tEl('text', { x: PAD.l, y: 11, fill: _tCSS('--viz-muted'), 'font-size': '10', 'letter-spacing': '.04em' });
  cap.textContent = 'OF THOSE FAILING — CONTAINED BY DEPRECATION vs STILL UNRESOLVED';
  s2.appendChild(cap);
  const failing = rows.map(p => { const v = _tBands(p); return { c: v.contained, o: v.open, tot: v.contained + v.open }; });
  const SY = pc => sTop + sh - (pc / 100) * sh;
  const depTop = failing.map(f => f.tot ? 100 * f.c / f.tot : 0);
  s2.appendChild(_tEl('rect', { x: PAD.l, y: sTop, width: iw, height: sh, fill: _tCSS('--open'), 'fill-opacity': '0.58' }));
  const upPath = depTop.map((pc, i) => `${i ? 'L' : 'M'}${X(rows[i].t).toFixed(1)},${SY(pc).toFixed(1)}`).join(' ');
  s2.appendChild(_tEl('path', { d: `${upPath} L${X(t1)},${SY(0)} L${X(t0)},${SY(0)} Z`, fill: _tCSS('--contained'), 'fill-opacity': '0.85' }));
  s2.appendChild(_tEl('path', { d: upPath, fill: 'none', stroke: _tCSS('--viz-surface'), 'stroke-width': '2' }));
  const et = _tEl('text', { x: PAD.l + iw + 8, y: sTop + sh / 2 + 4, fill: _tCSS('--viz-ink'), 'font-size': '11', 'font-weight': '500', class: 'tnum' });
  et.textContent = (depTop[depTop.length - 1] || 0).toFixed(1) + '%';
  s2.appendChild(et);
  const sHit = _tEl('rect', { x: PAD.l, y: sTop, width: iw, height: sh, fill: 'transparent' });
  sHit.addEventListener('mousemove', e => {
    const i = nearest(e.clientX), f = failing[i];
    _tShowTip(`<div class="v" style="font-weight:600;margin-bottom:5px">${_tDate(rows[i].t)}</div>
      <div style="display:flex;justify-content:space-between;gap:14px"><span class="k">Failing, total</span><span class="v">${_tNum(f.tot)}</span></div>
      <div style="display:flex;justify-content:space-between;gap:14px"><span class="k">— contained</span><span class="v">${_tNum(f.c)} · ${(f.tot ? 100 * f.c / f.tot : 0).toFixed(1)}%</span></div>
      <div style="display:flex;justify-content:space-between;gap:14px"><span class="k">— still unresolved</span><span class="v">${_tNum(f.o)}</span></div>`,
      e.clientX, e.clientY);
  });
  sHit.addEventListener('mouseleave', _tHideTip);
  s2.appendChild(sHit);
  host.appendChild(s2);

  const legend = document.getElementById('t-rule-legend');
  if (legend) {
    legend.innerHTML = ruleEvents.length
      ? ruleEvents.map((ev, k) => `<span class="inline-flex items-start gap-2 text-xs text-gray-500">
          <span class="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-gray-700 text-gray-200 text-[9px] font-bold flex-shrink-0 mt-px">${String.fromCharCode(65 + (k % 26))}</span>
          <span>${ev.merged > 1 && _tDate(ev.until) !== _tDate(ev.t) ? `${_tDate(ev.t)}–${_tDate(ev.until)}` : _tDate(ev.t)} — <span class="text-gray-400">scanner rule change</span>
          <span class="text-gray-600 tnum">(${ev.delta > 0 ? '+' : '−'}${_tNum(Math.abs(ev.delta))} unresolved, not the ecosystem)</span></span></span>`).join('')
      : '<span class="text-xs text-gray-600">No scanner-rule changes affected this criterion in the recorded history.</span>';
  }
}

function _tRenderTable() {
  const host = document.getElementById('t-table');
  if (!host) return;
  const c = _tCrit(), rows = _tSeries(c.key).slice(_tPeriodStart()).reverse();
  const cols = _T_BANDS.filter(b => rows.some(p => _tBands(p)[b.k] > 0));
  const unit = TREND.state.measure === 'usage' ? 'downloads' : 'components';
  host.innerHTML = `
    <table class="viz-table min-w-full text-sm"><thead class="sticky top-0 bg-dark-surface"><tr class="text-left">
      ${['Snapshot', ...cols.map(b => b.name), `Applicable ${unit}`, 'Resolved %'].map(h =>
        `<th class="px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-dark-border whitespace-nowrap">${h}</th>`).join('')}
    </tr></thead><tbody class="divide-y divide-dark-border">
      ${rows.map(p => { const v = _tBands(p); return `
        <tr class="hover:bg-dark-hover">
          <td class="px-3 py-1.5 text-gray-300 whitespace-nowrap">${_tDate(p.t)}</td>
          ${cols.map(b => `<td class="px-3 py-1.5 text-gray-400">${_tNum(v[b.k])}</td>`).join('')}
          <td class="px-3 py-1.5 text-gray-400">${_tNum(v.total)}</td>
          <td class="px-3 py-1.5 text-white font-medium">${v.total ? (100 * (v.total - v.open) / v.total).toFixed(1) : '—'}%</td>
        </tr>`; }).join('')}
    </tbody></table>`;
}

function _tRenderCards() {
  const host = document.getElementById('t-cards');
  if (!host) return;
  const start = _tPeriodStart();
  host.innerHTML = TREND.criteria.map(c => {
    const s = _tSeries(c.key), last = s[s.length - 1], first = s[start];
    const na = last.applicable === 0;
    return `<div class="crit-card bg-dark-surface rounded-lg p-3.5 border border-dark-border hover:border-blue-500/40 cursor-pointer transition-colors ${c.key === TREND.state.criterion ? 'on' : ''}" data-crit="${esc(c.key)}">
      <div class="flex items-start justify-between gap-2">
        <p class="text-xs font-medium text-gray-400 uppercase tracking-wider leading-tight">${esc(c.short)}</p>
        <span class="text-[10px] text-gray-600 uppercase tracking-wider flex-shrink-0">${esc(c.group)}</span>
      </div>
      ${na
        ? `<div class="mt-1.5"><span class="text-2xl font-semibold text-gray-600">—</span></div>
           <p class="text-xs text-gray-600 mt-0.5">not applicable in this scope</p><div class="h-[34px] mt-2"></div>
           <p class="text-xs text-gray-700 mt-1.5">&nbsp;</p>`
        : `<div class="flex items-baseline gap-2 mt-1.5">
             <span class="text-2xl font-semibold text-white tnum">${_tNum(last.open)}</span>
             <span class="text-xs">${_tDelta(last.open - first.open, false)}</span>
           </div>
           <p class="text-xs text-gray-600 mt-0.5">unresolved of ${_tNum(last.applicable)} applicable</p>
           <div class="mt-2" data-spark="${esc(c.key)}"></div>
           <p class="text-xs mt-1.5" style="color:var(--contained)">${_tNum(last.contained)} contained by deprecation</p>`}
    </div>`;
  }).join('');
  TREND.criteria.forEach(c => {
    const box = host.querySelector(`[data-spark="${CSS.escape(c.key)}"]`);
    if (!box) return;
    // Each card auto-scales: these are different measures on very different
    // bases, so a shared scale would flatten most of them. The exact number
    // above carries the magnitude; the line carries the shape.
    _tSparkline(box, _tSeries(c.key).map(p => p.open), '#0595DB', 34);
  });
  host.querySelectorAll('[data-crit]').forEach(n => n.addEventListener('click', () => {
    TREND.state.criterion = n.dataset.crit;
    const sel = document.getElementById('t-criterion');
    if (sel) sel.value = TREND.state.criterion;
    _tRender();
  }));
}

// Balances as text, movement as diverging bars. A zero-anchored column chart
// renders a 3-component step against a base of 190 as an invisible sliver at
// every short period, and truncating the axis to fix that would misstate the
// totals — so the two facts get different marks.
function _tRenderWaterfall() {
  _tAutoDraw(document.getElementById('t-waterfall'), w => _tDrawWaterfall(w));
}

function _tDrawWaterfall(W) {
  const host = document.getElementById('t-waterfall');
  if (!host) return;
  host.innerHTML = '';
  const c = _tCrit(), s = _tSeries(c.key), ch = _tChanges(c.key);
  const start = s[_tPeriodStart()].open, end = s[s.length - 1].open;

  const steps = [
    { label: 'Reclassified', v: ch.reclassified, kind: 'neutral',
      note: 'Status changed with no new published version — the component did not move, our scanner rules did. Never counted as progress.' },
    { label: 'Fixed', v: -ch.fixed, kind: 'pass',
      note: 'The maintainer published a new version that clears the criterion.' },
    { label: 'Deprecated', v: -ch.deprecated, kind: 'contained',
      note: 'Still failing, but marked deprecated — customers are no longer steered into installing it. Counts as resolved.' },
    { label: 'Newly failing', v: ch.regressed + ch.arrived, kind: 'open',
      note: 'A new version introduced the problem, or a component arrived already failing.' },
    { label: 'Left catalog', v: -ch.departed, kind: 'contained',
      note: 'Failing components withdrawn from the marketplace entirely.' },
  ].filter(x => x.v !== 0 || x.kind === 'pass' || x.kind === 'contained');

  host.insertAdjacentHTML('beforeend', `
    <div class="flex items-baseline gap-3 mb-4 pb-3 border-b border-dark-border">
      <div><div class="text-xs text-gray-500 uppercase tracking-wider">Unresolved then</div>
        <div class="text-xl font-semibold text-gray-400 tnum mt-0.5">${_tNum(start)}</div></div>
      <svg width="22" height="12" class="self-end mb-1.5" aria-hidden="true"><path d="M0,6 L16,6 M11,2 L16,6 L11,10" fill="none" stroke="${_tCSS('--viz-muted')}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div><div class="text-xs text-gray-500 uppercase tracking-wider">Unresolved now</div>
        <div class="text-xl font-semibold text-white tnum mt-0.5">${_tNum(end)}</div></div>
      <div class="ml-auto text-right"><div class="text-xs text-gray-500 uppercase tracking-wider">Net</div>
        <div class="text-xl font-semibold tnum mt-0.5">${_tDelta(end - start, false)}</div></div>
    </div>`);

  const GUT = 48, rowH = 46;
  const H = steps.length * rowH + 26, zeroX = W / 2;
  const maxAbs = Math.max(1, ...steps.map(x => Math.abs(x.v)));
  const scale = ((W / 2) - GUT) / maxAbs;

  const svg = _tEl('svg', { width: W, height: H, class: 'viz-svg', role: 'img',
    'aria-label': 'Forces that moved the unresolved-failure count: improvements left of the zero line, regressions right' });
  const defs = _tEl('defs');
  defs.innerHTML = `<pattern id="tWfHatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" fill="#333b47"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7b8494" stroke-width="2"/></pattern>`;
  svg.appendChild(defs);
  const fillOf = k => k === 'pass' ? _tCSS('--pass') : k === 'contained' ? _tCSS('--contained') : k === 'open' ? _tCSS('--open') : 'url(#tWfHatch)';
  const inkOf = k => k === 'pass' ? _tCSS('--pass') : k === 'contained' ? _tCSS('--contained') : k === 'open' ? _tCSS('--open') : _tCSS('--viz-ink');

  steps.forEach((x, i) => {
    const y = i * rowH + 6;
    const lt = _tEl('text', { x: 0, y: y + 10, fill: _tCSS('--viz-ink'), 'font-size': '11' });
    lt.textContent = x.label; svg.appendChild(lt);

    const w = Math.abs(x.v) * scale;
    const bx = x.v < 0 ? zeroX - w : zeroX;
    const bar = _tEl('rect', { x: bx, y: y + 18, width: Math.max(w, 2), height: 14, rx: 4, fill: fillOf(x.kind), style: 'cursor:help' });
    bar.addEventListener('mousemove', e => _tShowTip(
      `<div class="v" style="font-weight:600">${x.label}</div><div class="k" style="max-width:235px;margin-top:3px">${x.note}</div>
       <div style="margin-top:5px" class="k">Effect on open failures <span class="v">${x.v > 0 ? '+' : x.v < 0 ? '−' : '±'}${_tNum(Math.abs(x.v))}</span></div>`,
      e.clientX, e.clientY));
    bar.addEventListener('mouseleave', _tHideTip);
    svg.appendChild(bar);

    // Values live in the reserved gutter, so they can never run off the canvas.
    const vt = _tEl('text', { x: x.v < 0 ? bx - 7 : bx + Math.max(w, 2) + 7, y: y + 29,
      'text-anchor': x.v < 0 ? 'end' : 'start', fill: inkOf(x.kind), 'font-size': '11', 'font-weight': '600', class: 'tnum' });
    vt.textContent = (x.v > 0 ? '+' : x.v < 0 ? '−' : '±') + _tNum(Math.abs(x.v));
    svg.appendChild(vt);
  });

  svg.appendChild(_tEl('line', { x1: zeroX, x2: zeroX, y1: 2, y2: steps.length * rowH + 2, stroke: _tCSS('--viz-axis'), 'stroke-width': '1' }));
  const cl = _tEl('text', { x: zeroX - 8, y: H - 4, 'text-anchor': 'end', fill: _tCSS('--viz-muted'), 'font-size': '10' });
  cl.textContent = '← fewer unresolved'; svg.appendChild(cl);
  const cr = _tEl('text', { x: zeroX + 8, y: H - 4, fill: _tCSS('--viz-muted'), 'font-size': '10' });
  cr.textContent = 'more unresolved →'; svg.appendChild(cr);
  host.appendChild(svg);

  const resolved = ch.fixed + ch.deprecated;
  host.insertAdjacentHTML('beforeend', `
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mb-2 mt-3">
      <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:var(--pass)"></span><span class="text-gray-400">Fixed</span></span>
      <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:var(--contained)"></span><span class="text-gray-400">Deprecated / withdrawn</span></span>
      <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:var(--open)"></span><span class="text-gray-400">Newly failing</span></span>
      <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:#333b47;background-image:repeating-linear-gradient(45deg,#7b8494 0 2px,transparent 2px 6px)"></span><span class="text-gray-400">Not the ecosystem</span></span>
    </div>
    <p class="text-xs text-gray-500 leading-relaxed border-t border-dark-border pt-3">
      ${resolved
        ? `<span class="text-gray-300 font-medium tnum">${_tNum(resolved)}</span> resolved by maintainers —
           <span class="tnum" style="color:${_tCSS('--pass')}">${_tNum(ch.fixed)} fixed</span>,
           <span class="tnum" style="color:${_tCSS('--contained')}">${_tNum(ch.deprecated)} deprecated</span>.`
        : 'No maintainer resolutions in this window.'}
      ${ch.reclassified
        ? ` A scanner-rule change moved a further <span class="tnum text-gray-400">${_tNum(Math.abs(ch.reclassified))}</span> — excluded from that figure.`
        : ''}
    </p>`);
}

function _tRenderMovers() {
  const host = document.getElementById('t-movers');
  if (!host) return;
  const c = _tCrit(), kind = TREND.state.movers;
  const meta = {
    fixed:        { col: _tCSS('--pass'),      icon: '↑', verb: `now passes ${c.short}`, word: 'Fixed' },
    deprecated:   { col: _tCSS('--contained'), icon: '⊘', verb: `deprecated — still fails ${c.short}`, word: 'Deprecated' },
    regressed:    { col: _tCSS('--open'),      icon: '↓', verb: `now fails ${c.short}`, word: 'Newly failing' },
    reclassified: { col: _tCSS('--viz-ink'),   icon: '≈', verb: 'verdict changed, version did not', word: 'Reclassified' },
  }[kind];
  // "Unresolved" means CONFIRMED breakage, so a component can leave that set by
  // dropping to an uncertain finding rather than by passing outright. Saying
  // "now passes" there contradicts its own detail page, which still shows a
  // possible issue — so say what actually happened.
  const verbFor = m => (kind === 'fixed' && m.result === 'warning')
    ? { text: `no longer breaking ${c.short}`, col: _tCSS('--possible'),
        title: `Dropped from a confirmed break to a possible issue — the detail page still shows a warning for ${c.label}.` }
    : { text: meta.verb, col: meta.col, title: '' };
  const { movers, omitted } = _tMovers(c.key, kind);
  const span = _tPeriodSpanDays();
  document.getElementById('t-movers-sub').textContent = `Components whose ${c.label} status changed — last ${span} day${span === 1 ? '' : 's'}`;

  if (!movers.length) {
    host.innerHTML = `<p class="px-5 py-10 text-sm text-gray-500 text-center">No ${meta.word.toLowerCase()} components in this window.</p>`;
    return;
  }
  const badge = s => `<span class="inline-block px-1.5 py-0.5 border text-xs rounded ${s === 'Platform' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-gray-500/10 text-gray-400 border-gray-500/20'}">${esc(s)}</span>`;
  host.innerHTML = `
    <table class="viz-table min-w-full"><tbody class="divide-y divide-dark-border">
      ${movers.slice(0, 12).map(m => `
        <tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="navigateTo('component', '${esc(m.id)}')">
          <td class="pl-5 pr-2 py-2.5 w-6"><span style="color:${meta.col}" title="${meta.word}">${meta.icon}</span></td>
          <td class="px-2 py-2.5">
            <div class="text-sm font-medium text-white">${esc(m.name)}</div>
            <div class="flex items-center gap-1.5 mt-1">${badge(m.s)}<span class="text-xs text-gray-500">${esc(m.c)} · ${esc(m.pub || '')}</span></div>
          </td>
          <td class="px-2 py-2.5">${(v => `<span class="inline-block px-1.5 py-0.5 border text-xs rounded"
            style="color:${v.col};border-color:${v.col}33;background:${v.col}14"${v.title ? ` title="${esc(v.title)}"` : ''}>${v.text}</span>`)(verbFor(m))}</td>
          <td class="px-2 py-2.5 text-right whitespace-nowrap"><div class="text-sm text-gray-300 tnum">${_tNum(m.dl)}</div><div class="text-xs text-gray-500">downloads</div></td>
          <td class="pr-5 pl-2 py-2.5 text-right text-xs text-gray-500 whitespace-nowrap">${_tDate(m.when)}</td>
        </tr>`).join('')}
    </tbody></table>
    <p class="px-5 py-3 text-xs text-gray-600 border-t border-dark-border">
      ${movers.length > 12 ? `Showing 12 of ${_tNum(movers.length)}. ` : ''}
      ${kind === 'deprecated' ? 'Deprecation counts as resolved — the component still fails, but it is no longer offered to customers.'
        : kind === 'reclassified' ? 'These flipped without a new published version, so the change came from our scanner, not the marketplace.'
        : kind === 'fixed' ? `A newly published version cleared the confirmed break.${movers.some(m => m.result === 'warning') ? ' Amber rows dropped to a possible issue rather than passing outright.' : ''}`
        : 'Arrived failing, or a new version introduced the problem.'}
      ${omitted ? ` ${_tNum(omitted)} further transition${omitted === 1 ? ' was' : 's were'} recorded in aggregate but not listed individually.` : ''}
    </p>`;
}

// Components that fail the selected criterion right now, ranked by reach, so the
// list answers "who do I chase first". Component-level (from the live database)
// rather than from the rollups, which only carry counts — and it follows the
// criterion and both filters like everything else on the page.
function _tUnresolvedComponents() {
  if (!dbLayer) return [];
  const key = _tCrit().key;
  const { content, support } = TREND.state;
  return dbLayer.getComponents()
    .filter(c => {
      if (c.support_type === 'Deprecated') return false;                   // contained, not open
      if (content.length && !content.includes(c.content_type || 'Unknown')) return false;
      if (support.length && !support.includes(c.support_type || 'Unknown')) return false;
      const fs = componentFacetStatus(c)[key];
      return fs && fs.status === 'breaking';
    })
    .sort((a, b) => (b.download_count || 0) - (a.download_count || 0));
}

// Does this component advertise Mendix 11 support? Mirrors facets.DeclaresMx11:
// a failure here is broken NOW, not a future upgrade blocker.
function _tDeclaresMx11(c) {
  const major = parseInt((c.min_mx_version || '').split('.')[0]) || 0;
  return major >= 11 || !!c.react_client_ready;
}

function _tRenderWorst() {
  const host = document.getElementById('t-worst');
  if (!host) return;
  const c = _tCrit(), list = _tUnresolvedComponents();
  document.getElementById('t-worst-sub').innerHTML =
    `Still published and failing <span class="text-gray-400">${esc(c.label)}</span>, ranked by downloads`;
  if (!list.length) {
    host.innerHTML = '<p class="px-5 py-10 text-sm text-gray-500 text-center">Nothing unresolved in this scope.</p>';
    return;
  }
  host.innerHTML = `
    <table class="viz-table min-w-full"><tbody class="divide-y divide-dark-border">
      ${list.slice(0, 10).map(m => {
        const claims = _tDeclaresMx11(m);
        const tag = claims
          ? `<span class="inline-block px-1.5 py-0.5 border text-xs rounded whitespace-nowrap" style="color:${_tCSS('--open')};border-color:${_tCSS('--open')}33;background:${_tCSS('--open')}14" title="Advertises Mendix 11 support and fails anyway">broken on Mx11</span>`
          : `<span class="inline-block px-1.5 py-0.5 border text-xs rounded whitespace-nowrap" style="color:${_tCSS('--possible')};border-color:${_tCSS('--possible')}33;background:${_tCSS('--possible')}14" title="Supports only Mendix 10 or older; adopting it now blocks a later upgrade">blocks upgrade</span>`;
        return `<tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="navigateTo('component', '${esc(m.marketplace_id)}')">
          <td class="pl-5 pr-2 py-2.5">
            <div class="text-sm font-medium text-white">${esc(m.name)}</div>
            <div class="flex items-center gap-1.5 mt-1">${supportBadge(m.support_type)}<span class="text-xs text-gray-500">${esc(m.content_type || '')}${m.publisher ? ' · ' + esc(m.publisher) : ''}</span></div>
          </td>
          <td class="px-2 py-2.5">${tag}</td>
          <td class="pr-5 pl-2 py-2.5 text-right whitespace-nowrap">
            <div class="text-sm text-gray-300 tnum">${_tNum(m.download_count || 0)}</div>
            <div class="text-xs text-gray-500">downloads</div>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table>
    <p class="px-5 py-3 text-xs text-gray-600 border-t border-dark-border">
      Showing ${Math.min(10, list.length)} of <span class="tnum">${_tNum(list.length)}</span>.
      Click through for the findings behind each verdict.</p>`;
}

// Which content-type × support-type segments carry the failures, as a rate not
// just a count — a segment of 24 components with 24 failures matters more than
// one of 800 with 60. Clicking a row scopes the whole dashboard to it.
function _tRenderConcentration() {
  const host = document.getElementById('t-conc');
  if (!host) return;
  const c = _tCrit(), s = _tSeries(c.key), last = TREND.snapshots[TREND.snapshots.length - 1];
  const ci = TREND.criteria.findIndex(x => x.key === c.key);
  const allow = _tAllowedSegments();
  document.getElementById('t-conc-sub').innerHTML =
    `Share of each segment failing <span class="text-gray-400">${esc(c.short)}</span> and still published`;

  const rows = [];
  for (const r of last.rows) {
    if (r[0] !== ci || !allow[r[1]]) continue;
    const applicable = r[2] - r[7];
    if (applicable <= 0 || r[5] <= 0) continue;
    rows.push({ seg: TREND.segments[r[1]], applicable, open: r[5], rate: r[5] / applicable });
  }
  if (!rows.length) {
    host.innerHTML = '<p class="px-5 py-10 text-sm text-gray-500 text-center">Nothing unresolved in this scope.</p>';
    return;
  }
  // Rank by how many are unresolved, not by rate: a segment of 2 components
  // with 2 failures is 100% and tells you nothing, while 60 failures out of 800
  // is where the work actually is. The bar still shows the rate as context.
  rows.sort((a, b) => b.open - a.open || b.rate - a.rate);
  const shown = rows.slice(0, 8);
  host.innerHTML = `
    <table class="viz-table min-w-full"><tbody class="divide-y divide-dark-border">
      ${shown.map(r => `
        <tr class="hover:bg-dark-hover cursor-pointer" data-content="${esc(r.seg[0])}" data-support="${esc(r.seg[1])}"
            title="Scope the dashboard to ${esc(r.seg[0])} · ${esc(r.seg[1])}">
          <td class="pl-5 pr-2 py-2.5">
            <div class="text-sm text-white">${esc(r.seg[0])}</div>
            <div class="text-xs text-gray-500">${esc(r.seg[1])}</div>
          </td>
          <td class="px-2 py-2.5 w-20">
            <div class="h-2 rounded-sm overflow-hidden" style="background:#ffffff0d">
              <div class="h-full" style="width:${(r.rate * 100).toFixed(1)}%;background:${_tCSS('--open')}"></div>
            </div>
          </td>
          <td class="pr-5 pl-2 py-2.5 text-right whitespace-nowrap">
            <div class="text-sm text-white tnum">${(r.rate * 100).toFixed(0)}%</div>
            <div class="text-xs text-gray-500 tnum">${_tNum(r.open)} of ${_tNum(r.applicable)}</div>
          </td>
        </tr>`).join('')}
    </tbody></table>
    ${rows.length > shown.length ? `<p class="px-5 py-3 text-xs text-gray-600 border-t border-dark-border">Showing the ${shown.length} largest of ${rows.length} segments. Click a row to scope to it.</p>` : '<p class="px-5 py-3 text-xs text-gray-600 border-t border-dark-border">Click a row to scope the dashboard to it.</p>'}`;
  host.querySelectorAll('[data-content]').forEach(n => n.addEventListener('click', () => {
    TREND.state.content = [n.dataset.content];
    TREND.state.support = [n.dataset.support];
    _tSeriesCache.clear(); _tRedrawCombos(); _tRender();
  }));
}

// Multi-select combobox mirroring the Components-view filters. Option counts are
// live against the OTHER filter, so a choice's yield is visible before making it.
function _tCombo(hostId, key, options) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const other = key === 'content' ? 'support' : 'content';
  const dim = key === 'content' ? 0 : 1, otherDim = key === 'content' ? 1 : 0;
  const allLabel = key === 'content' ? 'All content types' : 'All support types';
  const last = TREND.snapshots[TREND.snapshots.length - 1];

  const countFor = opt => {
    let n = 0;
    TREND.segments.forEach((seg, si) => {
      if (seg[dim] !== opt) return;
      if (TREND.state[other].length && !TREND.state[other].includes(seg[otherDim])) return;
      for (const r of last.rows) if (r[0] === 0 && r[1] === si) n += r[2];
    });
    return n;
  };
  const label = () => {
    const sel = TREND.state[key];
    return !sel.length ? allLabel : sel.length === 1 ? sel[0] : `${sel.length} selected`;
  };
  host.dataset.combo = key;
  host.dataset.open = host.dataset.open || '0';
  host._draw = () => {
    const open = host.dataset.open === '1';
    host.innerHTML = `
      <div class="relative">
        <button class="combo-btn ${TREND.state[key].length ? 'active' : ''}" data-toggle>
          <span>${esc(label())}</span>
          <svg class="w-3.5 h-3.5 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 9l6 6 6-6"/></svg>
        </button>
        ${open ? `<div class="combo-panel">
          <div class="flex items-center justify-between px-3 py-2 border-b border-dark-border">
            <span class="text-xs text-gray-500 uppercase tracking-wider">${allLabel}</span>
            <button class="text-xs text-mx-blue hover:underline" data-clear>Clear</button>
          </div>
          <div class="max-h-64 overflow-y-auto py-1">
            ${options.map(o => {
              const n = countFor(o), on = TREND.state[key].includes(o);
              return `<label class="combo-opt ${n ? '' : 'opacity-40'}">
                <input type="checkbox" data-opt="${esc(o)}" ${on ? 'checked' : ''} ${n ? '' : 'disabled'}>
                <span class="flex-1">${esc(o)}</span><span class="tnum text-xs text-gray-500">${_tNum(n)}</span></label>`;
            }).join('')}
          </div></div>` : ''}
      </div>`;
    host.querySelector('[data-toggle]').addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = host.dataset.open === '1';
      document.querySelectorAll('[data-combo]').forEach(h => h.dataset.open = '0');
      host.dataset.open = wasOpen ? '0' : '1';
      _tRedrawCombos();
    });
    host.querySelectorAll('[data-opt]').forEach(cb => cb.addEventListener('change', e => {
      e.stopPropagation();
      const v = cb.dataset.opt;
      TREND.state[key] = cb.checked ? [...TREND.state[key], v] : TREND.state[key].filter(x => x !== v);
      _tSeriesCache.clear();
      _tRedrawCombos(); _tRender();
    }));
    const clr = host.querySelector('[data-clear]');
    if (clr) clr.addEventListener('click', e => {
      e.stopPropagation();
      TREND.state[key] = [];
      _tSeriesCache.clear();
      _tRedrawCombos(); _tRender();
    });
    const panel = host.querySelector('.combo-panel');
    if (panel) panel.addEventListener('click', e => e.stopPropagation());
  };
  host._draw();
}
function _tRedrawCombos() { document.querySelectorAll('[data-combo]').forEach(h => h._draw && h._draw()); }

let _tOutsideClickBound = false;
function _tBindOutsideClick() {
  if (_tOutsideClickBound) return;
  _tOutsideClickBound = true;
  document.addEventListener('click', () => {
    const anyOpen = [...document.querySelectorAll('[data-combo]')].some(h => h.dataset.open === '1');
    if (anyOpen) {
      document.querySelectorAll('[data-combo]').forEach(h => h.dataset.open = '0');
      _tRedrawCombos();
    }
  });
}

function _tRender() {
  if (!TREND.ready || !document.getElementById('t-body')) return;
  _tSeriesCache.clear();
  _tRenderScope();

  const anySegments = _tAllowedSegments().some(Boolean);
  const applicable = anySegments ? _tSeries(_tCrit().key)[TREND.snapshots.length - 1].applicable : 0;
  const empty = !anySegments || applicable === 0;
  document.getElementById('t-empty').classList.toggle('hidden', !empty);
  document.getElementById('t-body').classList.toggle('hidden', empty);
  if (empty) {
    document.getElementById('t-empty-msg').innerHTML = anySegments
      ? `<span class="text-gray-300">${esc(_tCrit().label)}</span> cannot be assessed on any component in this scope.`
      : 'No components match this combination of content type and support type.';
    return;
  }

  _tRenderKPIs();
  const chart = document.getElementById('t-chart'), table = document.getElementById('t-table');
  if (TREND.state.view === 'chart') { _tRenderChart(); chart.classList.remove('hidden'); table.classList.add('hidden'); }
  else { _tRenderTable(); chart.classList.add('hidden'); table.classList.remove('hidden'); }
  _tRenderCards(); _tRenderWaterfall(); _tRenderMovers(); _tRenderWorst(); _tRenderConcentration();
}

function _tMount() {
  if (!TREND.ready) return;
  const seg = (id, key, cast = v => v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      [...b.parentElement.children].forEach(x => x.classList.toggle('on', x === b));
      TREND.state[key] = cast(b.dataset.v);
      _tRender();
    });
  };
  seg('t-period', 'days', v => v === 'all' ? 'all' : Number(v));
  seg('t-measure', 'measure');
  seg('t-view', 'view');
  seg('t-movers-kind', 'movers');
  const sel = document.getElementById('t-criterion');
  if (sel) sel.addEventListener('change', () => { TREND.state.criterion = sel.value; _tRender(); });
  const reset = document.getElementById('t-reset');
  if (reset) reset.addEventListener('click', () => {
    TREND.state.content = []; TREND.state.support = [];
    _tSeriesCache.clear(); _tRedrawCombos(); _tRender();
  });

  _tCombo('t-combo-content', 'content', TREND.contentTypes);
  _tCombo('t-combo-support', 'support', TREND.supportTypes);
  _tBindOutsideClick();
  _tRender();

  clearTimeout(TREND._resizeTimer);
  if (!TREND._resizeBound) {
    TREND._resizeBound = true;
    window.addEventListener('resize', () => {
      clearTimeout(TREND._resizeTimer);
      TREND._resizeTimer = setTimeout(() => { if (document.getElementById('t-body')) _tRender(); }, 150);
    });
  }
}

// =============================================================================
// Dashboard
// =============================================================================

function renderDashboard() {
  // Everything on this page answers to the criterion, period and filters. The
  // old snapshot-only sections were removed rather than left below: the facet
  // cards duplicated the criteria cards, the health tiles became criteria, the
  // content-type table became a filter, and "top offenders" ignored the
  // criterion entirely — which is exactly the inconsistency that made the page
  // confusing to read.
  document.getElementById('dashboard-view').innerHTML = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">Dashboard</h2>
        <p class="text-gray-400 text-sm mt-1">Marketplace curation — a component is <span class="text-gray-300">resolved</span> when it is fixed <em>or</em> deprecated. Both stop it blocking somebody's upgrade.</p>
      </div>
      ${_tSectionHTML()}
    </div>`;
  showView('dashboard-view');
  // Mount after the view is visible — the SVG charts size themselves from
  // clientWidth, which is 0 while the container is still display:none.
  _tMount();
}

// =============================================================================
// Components view
// =============================================================================

// columnFilters: { <columnFilterKey>: [<status>, ...] } — per badge-column status filter.
// statuses: overall-status filter (breaking/warning/compatible), driven by the visible Status combobox.
let componentFilters = { contentTypes: [], supportTypes: [], statuses: [], columnFilters: {}, search: '', publisher: null, sortBy: null, sortDir: 'desc', moduleDeps: [], teams: [] };
let _searchDebounceTimer = null;
let _openCombo = null;          // id of the filter/header-filter panel to keep open across re-renders
let _supportDefaultApplied = false;

// =============================================================================
// Compatibility facets
// =============================================================================

const FACET_DEFS = [
  { key: 'mx10',         label: 'Mx10',         full: 'Mendix 10 compatible' },
  { key: 'mx11',         label: 'Mx11',         full: 'Mendix 11 compatible' },
  { key: 'react-client', label: 'React Client', full: 'React Client compatible' },
  { key: 'new-string',   label: 'New String',   full: 'New string handling compatible' },
  { key: 'mx12',         label: 'Mx12+',        full: 'Mendix 12+ ready' },
];
const FACET_BY_KEY = Object.fromEntries(FACET_DEFS.map(d => [d.key, d]));

// Experimental facets — not-yet-finalized signals surfaced only on the Experiments
// page. Kept OUT of FACET_DEFS so they never appear in the finalized facet columns,
// dashboard summary cards, or the detail-page facet matrix. Their finding rows are
// also excluded from every finalized rollup in db-layer.js.
// `surface` controls applicability (when a component reads N/A for the facet):
//   'module' — needs a Java module (the check can't apply without one)
//   'js'     — needs JS to scan (widget JS or JS-action JS); applies to widget-only
//              packages too, so it must NOT be gated on Java modules.
const EXPERIMENT_FACET_DEFS = [
  { key: 'experiment-javax', label: 'javax.*', full: 'Imports javax.servlet / javax.websocket (Java migration candidate)', surface: 'module' },
  { key: 'experiment-mendixsso', label: 'MendixSSO', full: 'References the MendixSSO module (dependency or bundled module)', surface: 'module' },
  { key: 'experiment-mx-global', label: 'mx.*', full: 'Uses the global `mx` client object (bare mx.data / mx.ui / …) — import-based client API migration candidate', surface: 'js' },
  { key: 'experiment-window-mx-global', label: 'window.mx', full: 'Uses the global `mx` client object via window.mx — import-based client API migration candidate', surface: 'js' },
];
const EXPERIMENT_FACET_BY_KEY = Object.fromEntries(EXPERIMENT_FACET_DEFS.map(d => [d.key, d]));

function _statusRank(s) { return s === 'breaking' ? 3 : s === 'warning' ? 2 : s === 'compatible' ? 1 : 0; }
function _worseStatus(a, b) { return _statusRank(b) > _statusRank(a) ? b : a; }

// Memoized per component id — the embedded DB and its derivation inputs are static,
// so each component's facet status only needs to be computed once per session.
const _facetStatusCache = {};

// Resolves the 4-state status (breaking | warning | compatible | na) for every
// facet of a component, folding finding counts (from db-layer facet data) together
// with non-finding signals (Dojo widgets, min version, content type). Key rules:
//   - Breakage propagates forward: anything broken on Mx10 is also broken on Mx11
//     and Mx12; anything broken on Mx11 is also broken on Mx12.
//   - Mx10 is N/A for components with no Java modules, and for anything built on
//     Mendix 11+ (assessing Mx10 compatibility makes no sense there).
//   - Module packages need min version 10.21.0+ to import directly into Mx11, so a
//     module built on Mx9 / an un-importable Mx10 is never marked Mx11-compatible.
//     Standalone widget packages can always be imported, so this gate excludes them.
//   - Mx12 is derived: the Dojo client is gone and new string behavior is mandatory,
//     and today's deprecations become removals — so Mx12 readiness = React-Client +
//     New-String + no deprecations, on top of forward-propagated Mx11 status.
function componentFacetStatus(c) {
  if (_facetStatusCache[c.id]) return _facetStatusCache[c.id];
  const data = (dbLayer.getComponentFacetData().byId[c.id]) || { facets: {}, dojoWidgets: 0, moduleDeps: [] };
  const cnt = k => data.facets[k] || { certain: 0, uncertain: 0 };
  const stat = (counts, applicable = true) => {
    if (!applicable) return 'na';
    if (counts.certain > 0) return 'breaking';
    if (counts.uncertain > 0) return 'warning';
    return 'compatible';
  };
  const minMajor = parseInt((c.min_mx_version || '').split('.')[0]) || 0;
  const hasModules = (c.module_count || 0) > 0;
  // Module package (import rules apply) vs standalone widget (always importable).
  const isModuleType = c.content_type === 'Module' || (hasModules && c.content_type !== 'Widget');
  const notImportableTo11 = isModuleType && !!c.min_mx_version && dbLayer.compareVersions(c.min_mx_version, '10.21.0') < 0;

  // mx10 — breaks only from Java APIs removed in Mendix 10. Widgets (and modules with
  // no removed-in-10 APIs) have no reason to break on Mx10, so they are compatible.
  // Only thing built on Mx11+ is N/A: it can't run on Mx10 regardless.
  const mx10Applicable = minMajor < 11;
  const mx10Note = !mx10Applicable ? 'built on Mendix 11+' : '';
  const mx10 = stat(cnt('mx10'), mx10Applicable);

  // mx11 — own findings, plus Mx10 breakage propagates forward, plus the import gate.
  let mx11 = stat(cnt('mx11'));
  if (mx10 !== 'na') mx11 = _worseStatus(mx11, mx10);
  if (notImportableTo11 && mx11 === 'compatible') mx11 = 'warning';
  const mx11Note = notImportableTo11 ? 'requires Mendix 10.21+ to import into Mx11' : '';

  let react = stat(cnt('react-client'));
  if ((data.dojoWidgets || 0) > 0) react = _worseStatus(react, 'breaking');
  const newString = stat(cnt('new-string'));           // behavioral, best-effort

  let mx12 = 'compatible';
  mx12 = _worseStatus(mx12, react === 'na' ? 'compatible' : react);
  mx12 = _worseStatus(mx12, newString === 'na' ? 'compatible' : newString);
  const dep = cnt('mx12'); // Java deprecations are tagged mx12
  if (dep.certain > 0 || dep.uncertain > 0) mx12 = _worseStatus(mx12, 'breaking');
  mx12 = _worseStatus(mx12, mx11); // forward propagation (incl. Mx10 → Mx11 → Mx12)

  const result = {
    'mx10':         { status: mx10, ...cnt('mx10'), note: mx10Note },
    'mx11':         { status: mx11, ...cnt('mx11'), note: mx11Note },
    'react-client': { status: react, ...cnt('react-client'), dojoWidgets: data.dojoWidgets || 0 },
    'new-string':   { status: newString, ...cnt('new-string') },
    'mx12':         { status: mx12, ...dep },
    _moduleDeps:    data.moduleDeps || [],
  };

  // Health criteria — the same three pkg/facets computes, so the dashboard can
  // rank components under ANY criterion the trends offer, not just the five
  // compatibility facets. Keys match pkg/facets.Criteria exactly; they are
  // deliberately NOT in FACET_DEFS, so they never appear as facet columns.
  const _na = 'na';
  result['managed-deps'] = { status: !hasModules ? _na : ((c.unmanaged_dep_count || 0) > 0 ? 'breaking' : 'compatible'), certain: 0, uncertain: 0 };
  result['importable'] = { status: !isModuleType || !c.min_mx_version ? _na : (notImportableTo11 ? 'breaking' : 'compatible'), certain: 0, uncertain: 0 };
  const _lastActivity = c.last_publish_date || c.changed_date;
  const _yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
  const _t = _lastActivity ? new Date(_lastActivity).getTime() : NaN;
  result['maintained'] = { status: isNaN(_t) ? _na : (_t < _yearAgo ? 'breaking' : 'compatible'), certain: 0, uncertain: 0 };

  // Experimental facets — kept separate from the finalized ones above. A hit reads
  // as a neutral "flagged" warning; otherwise compatible when the check can apply,
  // else N/A. Applicability depends on the check's surface: 'module' checks need a
  // Java module; 'js' checks need JS to scan (widgets always have JS; modules only
  // if they ship js). These never feed the overall status / breaking counts.
  const hasWidgets = (c.widget_count || 0) > 0;
  const hasScannedJS = hasWidgets || (c.js_module_count || 0) > 0;
  for (const d of EXPERIMENT_FACET_DEFS) {
    const counts = cnt(d.key);
    const applicable = d.surface === 'js' ? hasScannedJS : hasModules;
    let status;
    if (!applicable) status = 'na';
    else if (counts.certain > 0 || counts.uncertain > 0) status = 'warning';
    else status = 'compatible';
    result[d.key] = { status, ...counts };
  }

  _facetStatusCache[c.id] = result;
  return result;
}

function facetBadge(status, tooltip = '') {
  const map = {
    breaking:   ['✗', 'bg-red-500/10 text-red-400 border-red-500/20'],
    warning:    ['!', 'bg-amber-500/10 text-amber-400 border-amber-500/20'],
    compatible: ['✓', 'bg-green-500/10 text-green-400 border-green-500/20'],
    na:         ['–', 'bg-gray-500/10 text-gray-600 border-gray-500/20'],
  };
  const [sym, cls] = map[status] || map.na;
  return `<span class="inline-flex items-center justify-center w-6 h-6 rounded border text-xs font-semibold ${cls}"${tooltip ? ` title="${esc(tooltip)}"` : ''}>${sym}</span>`;
}

function _facetTooltip(def, fs) {
  const parts = [];
  if (fs.status === 'na') {
    parts.push('not applicable');
  } else if (fs.status === 'breaking') {
    if (fs.certain > 0) parts.push(`${fs.certain} breaking finding${fs.certain !== 1 ? 's' : ''}`);
    if (fs.dojoWidgets > 0) parts.push(`${fs.dojoWidgets} Dojo widget${fs.dojoWidgets !== 1 ? 's' : ''}`);
    if (!parts.length) parts.push('breaking');
  } else if (fs.status === 'warning') {
    if (fs.uncertain > 0) parts.push(`${fs.uncertain} possible issue${fs.uncertain !== 1 ? 's' : ''}`);
  } else {
    parts.push('no issues found');
  }
  if (fs.note) parts.push(fs.note);
  return `${def.full}: ${parts.join(' — ')}`;
}

function facetTd(ctx, key) {
  const def = FACET_BY_KEY[key];
  return facetBadge(ctx[key].status, _facetTooltip(def, ctx[key]));
}

// Badge cell for an experimental facet (Experiments page). Reuses the 4-state badge
// but with a neutral, migration-oriented tooltip.
function expFacetTd(ctx, key) {
  const def = EXPERIMENT_FACET_BY_KEY[key];
  const fs = ctx[key] || { status: 'na', certain: 0, uncertain: 0 };
  let tip;
  if (fs.status === 'na') tip = `${def.full}: not applicable`;
  else if (fs.status === 'warning') {
    const n = (fs.certain || 0) + (fs.uncertain || 0);
    tip = `${def.full}: flagged in ${n} place${n !== 1 ? 's' : ''}`;
  } else tip = `${def.full}: not found`;
  return facetBadge(fs.status, tip);
}

// Detail-page facet box — fully colored background, icon top-left, label + detail.
function _facetBox(full, status, statusLabel, detail, actions) {
  const bgMap = { breaking: 'bg-red-500/10 border-red-500/20', warning: 'bg-amber-500/10 border-amber-500/20', compatible: 'bg-green-500/10 border-green-500/20', na: 'bg-gray-500/10 border-gray-500/20' };
  const textMap = { breaking: 'text-red-400', warning: 'text-amber-400', compatible: 'text-green-400', na: 'text-gray-500' };
  const mutedMap = { breaking: 'text-red-400/70', warning: 'text-amber-400/70', compatible: 'text-green-400/70', na: 'text-gray-500/70' };
  const iconMap = { breaking: '✗', warning: '!', compatible: '✓', na: '–' };
  return `<div class="relative flex flex-col px-4 py-4 rounded border ${bgMap[status] || bgMap.na} flex-1 min-w-[8rem]">
    <span class="absolute top-3 left-3 text-lg font-bold leading-none ${textMap[status] || textMap.na}">${iconMap[status] || '–'}</span>
    <span class="text-sm ${mutedMap[status] || mutedMap.na} text-center">${full}</span>
    <span class="text-lg font-semibold ${textMap[status] || textMap.na} text-center mt-1">${statusLabel}</span>
    ${detail ? `<span class="text-sm ${mutedMap[status] || mutedMap.na} text-center mt-1">${detail}</span>` : ''}
    ${actions ? `<div class="mt-2.5 flex flex-wrap justify-center gap-1.5">${actions}</div>` : ''}
  </div>`;
}

// Detail line for a compatibility facet: summarizes finding counts + notes.
function _facetDetail(d, f) {
  const parts = [];
  if (f.certain > 0) parts.push(`${f.certain} breaking`);
  if (f.uncertain > 0) parts.push(`${f.uncertain} possible`);
  if (f.dojoWidgets > 0) parts.push(`${f.dojoWidgets} Dojo widget${f.dojoWidgets !== 1 ? 's' : ''}`);
  if (f.note) parts.push(f.note);
  return parts.length ? esc(parts.join(' · ')) : '';
}

function _facetActionBtn(label, count, tab, status) {
  const countStr = count > 0 ? ` (${count})` : '';
  const colorMap = { breaking: 'text-red-400/70 hover:text-red-400', warning: 'text-amber-400/70 hover:text-amber-400', compatible: 'text-green-400/70 hover:text-green-400', na: 'text-gray-500/70 hover:text-gray-500' };
  const cls = colorMap[status] || colorMap.na;
  return `<button onclick="setComponentDetailTab('${tab}')" class="text-xs ${cls} transition-colors">${label}${countStr} &rarr;</button>`;
}

// Per-component compatibility facet matrix (the 5 core facets).
function facetMatrix(comp) {
  const fs = componentFacetStatus(comp);
  const labels = { breaking: 'Breaking', warning: 'Possible issues', compatible: 'Compatible', na: 'N/A' };
  const hasWidgets = (comp.widget_count || 0) > 0;
  const internalId = comp.internal_id || comp.id;
  const javaFindings = dbLayer.getComponentJavaFindings(internalId);

  // Count Java findings per facet (derived from category, same logic as Go's FacetsForJavaCategory)
  const javaPerFacet = { 'mx10': 0, 'mx11': 0, 'mx12': 0 };
  for (const jf of javaFindings) {
    const cat = jf.category || '';
    if (cat.includes('mx10')) javaPerFacet['mx10']++;
    else if (cat.includes('deprecated')) javaPerFacet['mx12']++;
    else javaPerFacet['mx11']++;
  }

  // Widget findings per facet: total facet count minus Java count for that facet
  const widgetIssuesOnFacet = key => {
    const total = (fs[key].certain || 0) + (fs[key].uncertain || 0) + (fs[key].dojoWidgets || 0);
    return total - (javaPerFacet[key] || 0);
  };

  const cells = FACET_DEFS.map(d => {
    const f = fs[d.key];
    let actions = '';
    if (f.status === 'breaking' || f.status === 'warning') {
      const btns = [];
      const javaOnFacet = javaPerFacet[d.key] || 0;
      const widgetOnFacet = widgetIssuesOnFacet(d.key);

      if (d.key === 'react-client' || d.key === 'new-string') {
        if (hasWidgets && widgetOnFacet > 0)
          btns.push(_facetActionBtn('Widgets', widgetOnFacet, 'widgets', f.status));
      } else {
        if (javaOnFacet > 0)
          btns.push(_facetActionBtn('Java Issues', javaOnFacet, 'java', f.status));
        if (hasWidgets && widgetOnFacet > 0)
          btns.push(_facetActionBtn('Widgets', widgetOnFacet, 'widgets', f.status));
      }
      actions = btns.join('');
    }
    const note = f.note ? esc(f.note) : '';
    return _facetBox(esc(d.full), f.status, labels[f.status], note, actions);
  }).join('');
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">${cells}</div>`;
}

// Component health boxes (Built on / Managed deps / Dojo-free / Last updated).
function _healthBoxes(comp) {
  const fs = componentFacetStatus(comp);
  const boxes = [];

  // Built on — version colored by importability into Mx11.
  const v = comp.min_mx_version;
  if (v) {
    const parts = v.split('.').map(p => parseInt(p) || 0);
    const vNum = parts[0] * 1000 + (parts[1] || 0);
    let [status, hint] = vNum >= 10021
      ? ['compatible', 'importable into Mx11']
      : vNum >= 9024
      ? ['warning', 'needs upgrade to 10.21+ before importing into Mx11']
      : ['breaking', 'older than 9.24 LTS, no longer supported'];
    const mm = versionMismatch(comp);
    if (mm) {
      if (status === 'compatible') status = 'warning';
      hint += (hint ? ' · ' : '') + 'model built in ' + mm.models.join(', ');
    }
    boxes.push(_facetBox('Built on Mendix', status, esc(v), hint));
  }

  // Managed deps
  const ms = managedStatus(comp);
  if (ms !== 'na') {
    const [status] = MANAGED_BADGE[ms];
    const label = { compatible: 'All managed', warning: 'Partially managed', breaking: 'Unmanaged' }[status] || '';
    const detail = ms === 'unmanaged' ? 'JARs without module-dependencies.json'
                 : ms === 'partial' ? 'Some modules not declaring deps'
                 : '';
    boxes.push(_facetBox('Managed deps', status, label, esc(detail)));
  }

  // Dojo-free
  if ((comp.widget_count || 0) > 0) {
    const dojo = fs['react-client'].dojoWidgets || 0;
    const total = comp.widget_count || 0;
    const status = dojo > 0 ? 'breaking' : 'compatible';
    const label = dojo > 0 ? `${dojo} of ${total} Dojo` : 'No Dojo widgets';
    const detail = dojo > 0 ? 'incompatible with React client' : `all ${total} are React`;
    boxes.push(_facetBox('Dojo-free', status, label, esc(detail)));
  }

  // Maintenance — outcome-focused: stale/aging/active.
  const updated = comp.last_publish_date || comp.changed_date;
  if (updated) {
    const months = (Date.now() - new Date(updated).getTime()) / (30 * 24 * 3600 * 1000);
    const [status, label] = months >= 12
      ? ['breaking', 'Likely stale']
      : months >= 6
      ? ['warning', 'Aging']
      : ['compatible', 'Active'];
    const detail = `last updated ${formatDate(updated)}`;
    boxes.push(_facetBox('Maintenance', status, label, detail));
  }

  return boxes.length ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">${boxes.join('')}</div>` : '';
}

// Inline facet tags for a comma-joined facets string (used on the Issues view to
// make the rule→facet association visible).
function facetTags(facetsStr) {
  const keys = (facetsStr || '').split(',').filter(Boolean);
  if (!keys.length) return '<span class="text-gray-600 text-xs">—</span>';
  return keys.map(k => {
    const d = FACET_BY_KEY[k];
    return `<span class="inline-block px-1.5 py-0.5 bg-blue-500/10 text-blue-300 border border-blue-500/20 text-xs rounded mr-1 mb-1" title="${esc(d ? d.full : k)}">${esc(d ? d.label : k)}</span>`;
  }).join('');
}

// "Built on" assessment (mainly for starter apps): Mx11 best, Mx10 acceptable, <10 issue.
function builtOnCell(c) {
  const v = c.min_mx_version;
  if (!v) return '<span class="text-gray-600 text-xs">—</span>';
  const major = parseInt(v.split('.')[0]) || 0;
  if (major >= 11) return badge('Mx' + major, 'bg-green-500/10 text-green-400 border-green-500/20', 'Built on Mendix 11+ — ideal');
  if (major === 10) return badge('Mx10', 'bg-amber-500/10 text-amber-400 border-amber-500/20', 'Built on Mendix 10 — acceptable, rebuild on 11 preferred');
  return badge('Mx' + major, 'bg-red-500/10 text-red-400 border-red-500/20', 'Built on Mendix ' + major + ' — should be rebuilt on Mendix 11');
}

function dominantWidgetTypeCell(c, ctx) {
  const rc = ctx['react-client'];
  const dojo = rc.dojoWidgets || 0;
  const total = c.widget_count || 0;
  if (total === 0) return '<span class="text-gray-600 text-xs">—</span>';
  if (dojo === 0)     return widgetTypeBadge('React') + _reactApiWarnIcon(rc);
  if (dojo >= total)  return widgetTypeBadge('Dojo');
  return badge(`Mixed (${dojo} Dojo)`, 'bg-amber-500/10 text-amber-400 border-amber-500/20', `${dojo} of ${total} widgets are Dojo-based`) + _reactApiWarnIcon(rc);
}

// Warning icon shown next to a React label when its widgets use client APIs removed
// or changed in the React client. Mirrors the version-mismatch icon on "Min Mx".
function _reactApiWarnIcon(rc) {
  if ((rc.certain || 0) > 0)
    return _warnIcon(`React widget${rc.certain !== 1 ? 's' : ''} use ${rc.certain} client API${rc.certain !== 1 ? 's' : ''} removed or broken in the React client.`);
  if ((rc.uncertain || 0) > 0)
    return _warnIcon(`React widget${rc.uncertain !== 1 ? 's' : ''} use ${rc.uncertain} client API${rc.uncertain !== 1 ? 's' : ''} that may break in the React client.`);
  return '';
}

function dojoFreeCell(ctx) {
  const dojo = ctx['react-client'].dojoWidgets || 0;
  return dojo > 0
    ? badge('✗ ' + dojo, 'bg-red-500/10 text-red-400 border-red-500/20', `${dojo} Dojo widget(s) — removed in the React client / Mx12`)
    : badge('✓', 'bg-green-500/10 text-green-400 border-green-500/20', 'No Dojo widgets');
}

// Managed-dependency status of a component (also used by the filter):
//   managed   — has userlib JARs, all modules declare managed dependencies
//   partial   — some modules managed, some not
//   unmanaged — has userlib JARs but none managed
//   na        — no Java JAR dependencies
function managedStatus(c) {
  const userlib = c.userlib_module_count || 0;
  if ((c.module_count || 0) === 0 || userlib === 0) return 'na';
  if ((c.unmanaged_dep_count || 0) === 0) return 'managed';
  if ((c.managed_dep_module_count || 0) === 0) return 'unmanaged';
  return 'partial';
}

const MANAGED_BADGE = {
  managed:   ['compatible', 'all managed'],
  partial:   ['warning',    'partially managed'],
  unmanaged: ['breaking',   'unmanaged — JARs in userlib/ without module-dependencies.json'],
  na:        ['na',         'no Java JAR dependencies'],
};

function managedDepsCell(c) {
  const [status, note] = MANAGED_BADGE[managedStatus(c)];
  return facetBadge(status, 'Managed dependencies: ' + note);
}

function moduleDepsCell(c, ctx) {
  const deps = (ctx && ctx._moduleDeps) || [];
  if (!deps.length) return '<span class="text-gray-600 text-xs">—</span>';
  return deps.map(d => `<span class="inline-block px-1.5 py-0.5 bg-gray-500/10 text-gray-300 border border-gray-500/20 text-xs rounded mr-1 mb-0.5">${esc(d)}</span>`).join('');
}

function javaIssuesCell(c) {
  if ((c.module_count || 0) === 0) return '<span class="text-gray-600 text-xs">—</span>';
  if ((c.breaking_module_count || 0) > 0)        return badge(c.breaking_module_count + ' breaking', 'bg-red-500/10 text-red-400 border-red-500/20');
  if ((c.total_module_finding_count || 0) > 0)   return badge(c.total_module_finding_count + ' possible', 'bg-amber-500/10 text-amber-400 border-amber-500/20');
  return badge('✓ clean', 'bg-green-500/10 text-green-400 border-green-500/20');
}

// Last-updated freshness badge: <6mo green, 6–12mo amber, 12+ red (possibly
// unmaintained); deprecated components show a neutral grey box.
function lastUpdatedCell(c) {
  if (c.support_type === 'Deprecated')
    return badge('Deprecated', 'bg-gray-500/10 text-gray-500 border-gray-500/20', 'Deprecated — not expected to be maintained');
  const d = c.last_publish_date || c.changed_date;
  if (!d) return '<span class="text-gray-600 text-xs">—</span>';
  const months = (Date.now() - new Date(d).getTime()) / (30 * 24 * 3600 * 1000);
  const cls = months < 6 ? 'bg-green-500/10 text-green-400 border-green-500/20'
            : months < 12 ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
            : 'bg-red-500/10 text-red-400 border-red-500/20';
  const tip = months >= 12 ? 'Last updated over a year ago — may no longer be maintained'
            : months >= 6 ? 'Last updated 6–12 months ago'
            : 'Updated within the last 6 months';
  return badge(formatDate(d), cls, tip);
}

// Per-badge-column status filtering. Each badge column declares a filterKey
// (its state key) and a filterOpts group (the dropdown's options/labels).
const COLUMN_FILTER_OPTS = {
  facet: [
    { value: 'compatible', label: 'Compatible' },
    { value: 'warning',    label: 'Possible issue' },
    { value: 'breaking',   label: 'Breaking' },
    { value: 'na',         label: 'N/A' },
  ],
  managed: [
    { value: 'compatible', label: 'Managed' },
    { value: 'warning',    label: 'Partially managed' },
    { value: 'breaking',   label: 'Unmanaged' },
    { value: 'na',         label: 'No Java deps' },
  ],
  dojofree: [
    { value: 'compatible', label: 'Dojo-free' },
    { value: 'breaking',   label: 'Has Dojo widgets' },
  ],
  experiment: [
    { value: 'warning',    label: 'Flagged' },
    { value: 'compatible', label: 'Clear' },
    { value: 'na',         label: 'N/A' },
  ],
};

// Normalized status of a badge column for a component (4-state facet vocabulary).
function _columnStatus(c, key) {
  if (key === 'managed') return MANAGED_BADGE[managedStatus(c)][0];
  const fs = componentFacetStatus(c);
  if (key === 'dojofree') return (fs['react-client'].dojoWidgets > 0) ? 'breaking' : 'compatible';
  return fs[key] ? fs[key].status : 'na';
}

// Column registry. Each column renders inner cell HTML; the row builder wraps it in
// a <td>. `ctx` is the precomputed componentFacetStatus(c) for the row. Badge columns
// declare filterKey/filterOpts to drive their clickable header filter.
const COMPONENT_COLUMNS = {
  name:        { label: 'Name', sortKey: 'name', render: c => `<div class="text-sm font-medium text-white">${esc(c.name)}</div>${c.publisher ? `<div class="text-xs text-gray-500 mt-0.5">${esc(c.publisher)}</div>` : ''}` },
  type:        { label: 'Type', render: c => contentTypeBadge(c.content_type) },
  support:     { label: 'Support', render: c => supportBadge(c.support_type) },
  minmx:       { label: 'Min Mx', sortKey: 'min_mx_version', render: c => minMxCell(c) },
  builton:     { label: 'Built on', sortKey: 'min_mx_version', render: c => builtOnCell(c) },
  widgettype:  { label: 'Widget type', render: (c, ctx) => dominantWidgetTypeCell(c, ctx) },
  facet_mx10:  { label: 'Mx10', badge: true, filterKey: 'mx10', filterOpts: 'facet', render: (c, ctx) => facetTd(ctx, 'mx10') },
  facet_mx11:  { label: 'Mx11', badge: true, filterKey: 'mx11', filterOpts: 'facet', render: (c, ctx) => facetTd(ctx, 'mx11') },
  facet_mx12:  { label: 'Mx12+', badge: true, filterKey: 'mx12', filterOpts: 'facet', render: (c, ctx) => facetTd(ctx, 'mx12') },
  facet_react: { label: 'React Client', badge: true, filterKey: 'react-client', filterOpts: 'facet', render: (c, ctx) => facetTd(ctx, 'react-client') },
  facet_newstring: { label: 'New String', badge: true, filterKey: 'new-string', filterOpts: 'facet', render: (c, ctx) => facetTd(ctx, 'new-string') },
  exp_javax:   { label: 'javax.*', badge: true, filterKey: 'experiment-javax', filterOpts: 'experiment', render: (c, ctx) => expFacetTd(ctx, 'experiment-javax') },
  exp_mendixsso: { label: 'MendixSSO', badge: true, filterKey: 'experiment-mendixsso', filterOpts: 'experiment', render: (c, ctx) => expFacetTd(ctx, 'experiment-mendixsso') },
  exp_mxglobal: { label: 'mx.*', badge: true, filterKey: 'experiment-mx-global', filterOpts: 'experiment', render: (c, ctx) => expFacetTd(ctx, 'experiment-mx-global') },
  exp_windowmx: { label: 'window.mx', badge: true, filterKey: 'experiment-window-mx-global', filterOpts: 'experiment', render: (c, ctx) => expFacetTd(ctx, 'experiment-window-mx-global') },
  dojofree:    { label: 'Dojo-free', badge: true, filterKey: 'dojofree', filterOpts: 'dojofree', render: (c, ctx) => dojoFreeCell(ctx) },
  managed:     { label: 'Managed deps', badge: true, filterKey: 'managed', filterOpts: 'managed', render: c => managedDepsCell(c) },
  moduledeps:  { label: 'Module deps', sortKey: 'moduledeps_count', render: (c, ctx) => moduleDepsCell(c, ctx) },
  widgets:     { label: 'Widgets', sortKey: 'widget_count', render: c => `<span class="text-sm text-gray-300">${c.widget_count || 0}</span>` },
  modules:     { label: 'Modules', sortKey: 'module_count', render: c => `<span class="text-sm text-gray-300">${c.module_count || 0}</span>` },
  java:        { label: 'Java issues', render: c => javaIssuesCell(c) },
  downloads:   { label: 'Downloads', sortKey: 'download_count', render: c => `<span class="text-sm text-gray-400">${c.download_count > 0 ? c.download_count.toLocaleString() : '—'}</span>` },
  prodapps:    { label: 'Prod apps', sortKey: 'prod_apps_mx10', render: c => c.prod_apps_mx10 > 0 ? `<span class="text-sm text-white" title="Mx10: ${c.prod_apps_mx10}${c.prod_apps_mx9 ? ' · Mx9: ' + c.prod_apps_mx9 : ''}">${c.prod_apps_mx10.toLocaleString()}</span>` : '<span class="text-gray-600 text-xs">—</span>' },
  updated:     { label: 'Last updated', sortKey: 'last_publish_date', render: c => lastUpdatedCell(c) },
  health:      { label: '', render: c => healthWarningBadge(c) },
};

const VIEW_CONFIGS = {
  'components':   { containerId: 'components-view', title: 'Components', noun: 'Marketplace package', contentType: null, showTypeFilter: true,
    blurb: 'Every public Marketplace package we scanned — widgets, modules, starter apps and more. Use the Type filter to narrow to one kind, or click any status column header (Mx11, React Client…) to show only rows with that result.',
    columns: ['name', 'type', 'support', 'minmx', 'facet_mx10', 'facet_mx11', 'facet_mx12', 'facet_react', 'facet_newstring', 'managed', 'downloads', 'prodapps', 'updated'] },
  'widgets':      { containerId: 'widgets-view', title: 'Widgets', noun: 'widget package', contentType: 'Widget', showTypeFilter: false,
    blurb: 'Standalone pluggable/custom widget packages published to the Marketplace (widgets bundled inside a module appear under that module, not here). The Widget type column shows whether each is React- or Dojo-based.',
    columns: ['name', 'support', 'widgettype', 'facet_mx10', 'facet_mx11', 'facet_mx12', 'facet_react', 'facet_newstring', 'downloads', 'prodapps', 'updated'] },
  'modules':      { containerId: 'modules-view', title: 'Modules', noun: 'module package', contentType: 'Module', showTypeFilter: false,
    blurb: 'Marketplace module packages (.mpz) — including any widgets and Java code they bundle. Managed deps and Module deps show how their Java dependencies are declared.',
    columns: ['name', 'support', 'minmx', 'facet_mx10', 'facet_mx11', 'facet_mx12', 'facet_react', 'facet_newstring', 'managed', 'moduledeps', 'downloads', 'prodapps', 'updated'] },
  'starter-apps': { containerId: 'starter-apps-view', title: 'Starter Apps', noun: 'starter app', contentType: 'Starter App', showTypeFilter: false,
    blurb: 'Full starter/example apps from the Marketplace. Dojo-free flags whether an app still ships any Dojo-based widgets, which are incompatible with the Mendix 11 React client.',
    columns: ['name', 'support', 'minmx', 'facet_mx10', 'facet_mx11', 'facet_mx12', 'facet_react', 'facet_newstring', 'dojofree', 'downloads', 'updated'] },
  'experiments':  { containerId: 'experiments-view', title: 'Experiments', noun: 'Marketplace package', contentType: null, showTypeFilter: true,
    blurb: 'Experimental, not-yet-finalized checks — a preview surface for signals we are still validating, kept separate from the finalized compatibility facets. Currently: which packages import javax.servlet / javax.websocket (flagged for the Runtime Core Java API migration); which reference the MendixSSO module (a dependency on it or a package that bundles it); and which use the global `mx` client object — bare mx.* or via window.mx — flagged for the future import-based client API migration. These are heads-ups, not Mendix 11 breaks. Click a row for details.',
    columns: ['name', 'type', 'support', 'minmx', 'exp_javax', 'exp_mendixsso', 'exp_mxglobal', 'exp_windowmx', 'downloads', 'updated'] },
};

// Whether the loaded dataset carries any production-usage figures. The public
// (redacted) build zeroes prod_apps_* for every component, so the "Prod apps"
// column would be an entirely empty "—" column — hide it in that case. Memoized
// since the embedded DB is static.
let _hasProdAppsData = null;
function hasProdAppsData() {
  if (_hasProdAppsData === null) {
    _hasProdAppsData = dbLayer.getComponents().some(c => (c.prod_apps_mx10 || 0) > 0 || (c.prod_apps_mx9 || 0) > 0);
  }
  return _hasProdAppsData;
}

// Columns actually shown for a view: drops data-driven columns that have no data
// in the current dataset (e.g. "prodapps" in the redacted public build).
function _effectiveColumns(cfg) {
  if (hasProdAppsData()) return cfg.columns;
  return cfg.columns.filter(key => key !== 'prodapps');
}

function _buildListRows(components, cfg) {
  const columns = _effectiveColumns(cfg);
  // Rows on the Experiments page carry showExperiments so the detail-page
  // Experiments tab is visible when you drill in from here.
  return components.map(c => {
    const ctx = componentFacetStatus(c);
    const cells = columns.map(key => {
      const col = COMPONENT_COLUMNS[key];
      const cls = col.badge ? 'px-1 py-3 text-center w-16' : 'px-4 py-3';
      return `<td class="${cls}">${col.render(c, ctx)}</td>`;
    }).join('');
    const onclick = _currentListView === 'experiments'
      ? `navigateTo('component','${c.marketplace_id}',{showExperiments:'1',selectedTab:'experiments'})`
      : `navigateTo('component','${c.marketplace_id}')`;
    return `<tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="${onclick}">${cells}</tr>`;
  }).join('');
}

// Incremental row rendering: render the first chunk immediately and append the
// rest in batches as the user scrolls near the bottom, so we never build/insert
// thousands of <tr> at once. The embedded DB is static; rows never change in place.
const LIST_CHUNK = 80;
let _incr = null;          // { components, cfg, cursor }
let _incrObserver = null;

function _renderListRows(tbody, components, cfg) {
  if (_incrObserver) { _incrObserver.disconnect(); _incrObserver = null; }
  if (!components.length) {
    tbody.innerHTML = `<tr><td colspan="${_effectiveColumns(cfg).length}" class="px-4 py-8 text-center text-gray-500">No ${esc(cfg.noun)}s match filters</td></tr>`;
    _incr = null;
    return;
  }
  _incr = { components, cfg, cursor: 0 };
  tbody.innerHTML = '';
  _appendListChunk(tbody);
}

function _appendListChunk(tbody) {
  if (!_incr) return;
  const { components, cfg, cursor } = _incr;
  const slice = components.slice(cursor, cursor + LIST_CHUNK);
  const sentinel = tbody.querySelector('#comp-sentinel');
  if (sentinel) sentinel.remove();
  tbody.insertAdjacentHTML('beforeend', _buildListRows(slice, cfg));
  _incr.cursor += slice.length;
  if (_incr.cursor < components.length) {
    tbody.insertAdjacentHTML('beforeend',
      `<tr id="comp-sentinel"><td colspan="${_effectiveColumns(cfg).length}" class="py-4 text-center text-gray-600 text-xs">Loading ${components.length - _incr.cursor} more…</td></tr>`);
    const s = document.getElementById('comp-sentinel');
    const root = tbody.closest('main') || null;
    _incrObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { _incrObserver.disconnect(); _appendListChunk(tbody); }
    }, { root, rootMargin: '400px' });
    _incrObserver.observe(s);
  }
}

let _currentListView = 'components';

function renderComponents()            { renderComponentList('components'); }
function renderComponentCategory(view) { renderComponentList(view); }
function _rerenderList()               { _syncFiltersToURL(); renderComponentList(_currentListView); }

// Shared filtering + sorting pipeline used by every component list view.
// All filtering is done in JS over the cached unfiltered getComponents() result.
function _filteredComponents(cfg) {
  let components = dbLayer.getComponents(); // cached, unfiltered
  // Content type: category views fix it; the master view uses the Type filter.
  if (cfg.contentType) components = components.filter(c => c.content_type === cfg.contentType);
  else if (componentFilters.contentTypes.length) components = components.filter(c => componentFilters.contentTypes.includes(c.content_type));
  if (componentFilters.supportTypes.length) components = components.filter(c => componentFilters.supportTypes.includes(c.support_type));
  if (componentFilters.statuses && componentFilters.statuses.length)
    components = components.filter(c => componentFilters.statuses.includes(componentOverallStatus(c)));

  const q = (componentFilters.search || '').trim().toLowerCase();
  if (q) components = components.filter(c => (c.name || '').toLowerCase().includes(q));
  if (componentFilters.publisher) components = components.filter(c => c.publisher === componentFilters.publisher);
  if (componentFilters.teams && componentFilters.teams.length)
    components = components.filter(c => componentFilters.teams.includes(c.owning_team));
  const cfm = componentFilters.columnFilters;
  const activeCols = Object.keys(cfm).filter(k => cfm[k] && cfm[k].length);
  if (activeCols.length) {
    components = components.filter(c => activeCols.every(k => cfm[k].includes(_columnStatus(c, k))));
  }
  if (componentFilters.moduleDeps && componentFilters.moduleDeps.length) {
    components = components.filter(c => {
      const ctx = componentFacetStatus(c);
      const deps = (ctx && ctx._moduleDeps) || [];
      return componentFilters.moduleDeps.every(d => deps.includes(d));
    });
  }
  if (componentFilters.sortBy) {
    const key = componentFilters.sortBy, dir = componentFilters.sortDir === 'asc' ? 1 : -1;
    // Columns whose values are dotted version strings — must sort numerically per
    // component, not lexicographically (else "10.x" sorts before "9.x").
    const VERSION_KEYS = { min_mx_version: 1 };
    components = [...components].sort((a, b) => {
      if (key === 'moduledeps_count') {
        const ad = ((componentFacetStatus(a)._moduleDeps) || []).length;
        const bd = ((componentFacetStatus(b)._moduleDeps) || []).length;
        return dir * (ad - bd);
      }
      if (VERSION_KEYS[key]) {
        // Empty versions sort last regardless of direction.
        const av = a[key] || '', bv = b[key] || '';
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return dir * dbLayer.compareVersions(av, bv);
      }
      const av = a[key] ?? 0, bv = b[key] ?? 0;
      if (typeof av === 'number') return dir * (av - bv);
      return dir * String(av).localeCompare(String(bv));
    });
  }
  return components;
}

function _anyCompFilter() {
  const cols = Object.values(componentFilters.columnFilters).some(a => a && a.length);
  return !!componentFilters.publisher || !!(componentFilters.search || '').trim()
    || componentFilters.contentTypes.length > 0 || componentFilters.supportTypes.length > 0
    || (componentFilters.statuses && componentFilters.statuses.length > 0)
    || (componentFilters.moduleDeps && componentFilters.moduleDeps.length > 0)
    || (componentFilters.teams && componentFilters.teams.length > 0) || cols;
}

function _clearAllBtn() {
  return _anyCompFilter()
    ? `<button onclick="clearCompFilters()" class="text-xs text-gray-500 hover:text-gray-200 px-2 py-1 rounded border border-dark-border hover:border-gray-500 transition-colors">Clear all</button>`
    : '';
}

// Generic multiselect combobox for enum filters (no search box).
function _comboFilter({ id, allLabel, selLabel, items, selected, onToggle }) {
  const active = selected.length > 0;
  const btnLabel = active ? `${selLabel}: ${selected.length}` : allLabel;
  const list = items.map(it => {
    const sel = selected.includes(it.value);
    return `<button onclick="${onToggle}('${esc(String(it.value))}')"
              class="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm ${sel ? 'text-white' : 'text-gray-300'} hover:bg-dark-hover transition-colors">
        <span class="w-4 h-4 flex-shrink-0 flex items-center justify-center rounded border text-[10px] ${sel ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-600 text-transparent'}">✓</span>
        <span class="truncate">${esc(it.label)}</span>
      </button>`;
  }).join('');
  return `<div class="relative filter-combo">
    <button onclick="event.stopPropagation(); _toggleCombo('${id}')"
            class="flex items-center gap-2 px-3 py-1.5 bg-dark-surface border ${active ? 'border-blue-500/50 text-white' : 'border-dark-border text-gray-400'} rounded text-sm hover:border-blue-500/30 transition-colors">
      <span class="whitespace-nowrap">${esc(btnLabel)}</span>
      <svg class="w-3 h-3 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </button>
    <div id="${id}" class="filter-combo-panel hidden absolute top-full left-0 mt-1 min-w-48 bg-dark-surface border border-dark-border rounded-lg shadow-2xl z-50 overflow-hidden">
      <div class="max-h-64 overflow-y-auto py-1">${list}</div>
    </div>
  </div>`;
}

function _toggleCombo(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  document.querySelectorAll('.filter-combo-panel').forEach(p => p.classList.add('hidden'));
  const pub = document.getElementById('pub-dropdown'); if (pub) pub.classList.add('hidden');
  panel.classList.toggle('hidden', !opening);
  _openCombo = opening ? id : null;
}

function _toggleArr(key, value) {
  const arr = componentFilters[key];
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  _rerenderList();
}
function toggleTypeFilter(v)    { _openCombo = 'combo-type';    _toggleArr('contentTypes', v); }
function toggleSupportFilter(v) { _openCombo = 'combo-support'; _toggleArr('supportTypes', v); }
function toggleStatusFilter(v)  { _openCombo = 'combo-status';  _toggleArr('statuses', v); }
function toggleTeamFilter(v)    { _openCombo = 'combo-team';    _toggleArr('teams', v); }

// Per-column header status filter.
function toggleColumnFilter(key, value) {
  _openCombo = 'colf-' + key;
  const cf = componentFilters.columnFilters;
  const arr = cf[key] || (cf[key] = []);
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  _rerenderList();
}

// Clickable <th> for a badge column: opens a status-filter dropdown for that column.
function _badgeTh(col) {
  const fk = col.filterKey;
  const sel = componentFilters.columnFilters[fk] || [];
  const active = sel.length > 0;
  const opts = COLUMN_FILTER_OPTS[col.filterOpts] || [];
  const id = 'colf-' + fk;
  const items = opts.map(o => {
    const s = sel.includes(o.value);
    return `<button onclick="toggleColumnFilter('${fk}','${o.value}')"
              class="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm ${s ? 'text-white' : 'text-gray-300'} hover:bg-dark-hover transition-colors">
        <span class="w-4 h-4 flex-shrink-0 flex items-center justify-center rounded border text-[10px] ${s ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-600 text-transparent'}">✓</span>
        <span class="whitespace-nowrap">${esc(o.label)}</span>
      </button>`;
  }).join('');
  return `<th class="px-1 py-3 w-16 align-middle">
    <div class="relative filter-combo flex justify-center">
      <button onclick="event.stopPropagation(); _toggleCombo('${id}')"
              class="text-xs font-medium ${active ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'} uppercase tracking-wider text-center leading-tight">
        ${col.label}${active ? '<span class="text-blue-400"> •</span>' : ''}
      </button>
      <div id="${id}" class="filter-combo-panel hidden absolute top-full left-1/2 -translate-x-1/2 mt-1 min-w-40 bg-dark-surface border border-dark-border rounded-lg shadow-2xl z-50 overflow-hidden normal-case">
        <div class="py-1">${items}</div>
      </div>
    </div>
  </th>`;
}

function renderComponentList(view) {
  const cfg = VIEW_CONFIGS[view];
  if (!cfg) { renderComponentList('components'); return; }
  _currentListView = view;

  const components = _filteredComponents(cfg);

  // Count line / publisher list are scoped to this view's content type.
  const scope = cfg.contentType
    ? dbLayer.getComponents().filter(c => c.content_type === cfg.contentType)
    : dbLayer.getComponents();
  const total = scope.length;

  const contentTypes = dbLayer.getDistinctContentTypes().map(r => r.content_type).filter(Boolean);
  const supportTypes = dbLayer.getDistinctSupportTypes().map(r => r.support_type).filter(Boolean);
  const publishers   = [...new Set(scope.map(c => c.publisher).filter(Boolean))].sort();

  const q = (componentFilters.search || '').trim().toLowerCase();
  const pubLabel = componentFilters.publisher || 'All Publishers';
  const pubActive = !!componentFilters.publisher;
  const pubItems  = [{ value: null, label: 'All Publishers' }, ...publishers.map(p => ({ value: p, label: p }))]
    .map(p => `<button data-pub="${esc(p.value||'')}" onclick="setPubFilter(${p.value?`'${esc(p.value)}'`:'null'})"
                  class="w-full text-left px-3 py-1.5 text-sm ${componentFilters.publisher===p.value?'text-white bg-blue-500/10':'text-gray-300 hover:bg-dark-hover'} transition-colors">
        ${p.value ? esc(p.label) : `<span class="text-gray-400">All Publishers</span>`}
      </button>`).join('');

  const pubDropdown = `
    <div class="relative" id="pub-drop-container">
      <button onclick="event.stopPropagation(); togglePubDropdown()"
              class="flex items-center gap-2 px-3 py-1.5 bg-dark-surface border ${pubActive?'border-blue-500/50 text-white':'border-dark-border text-gray-400'} rounded text-sm hover:border-blue-500/30 transition-colors min-w-36">
        <svg class="w-3.5 h-3.5 flex-shrink-0 ${pubActive?'text-blue-400':'text-gray-500'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>
        </svg>
        <span class="flex-1 truncate text-sm">${esc(pubLabel)}</span>
        <svg class="w-3 h-3 flex-shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div id="pub-dropdown" class="hidden absolute top-full left-0 mt-1 w-64 bg-dark-surface border border-dark-border rounded-lg shadow-2xl z-50 overflow-hidden">
        <div class="p-2 border-b border-dark-border">
          <input id="pub-search" type="text" placeholder="Search publishers…" oninput="filterPubListUI(this.value)"
                 class="w-full px-2 py-1.5 bg-dark-bg text-sm text-white placeholder-gray-600 rounded border border-dark-border focus:outline-none focus:border-blue-500/50"/>
        </div>
        <div id="pub-list" class="max-h-56 overflow-y-auto py-1">${pubItems}</div>
      </div>
    </div>`;

  function _sortTh(label, key) {
    const active = componentFilters.sortBy === key;
    const asc    = active && componentFilters.sortDir === 'asc';
    const nextDir = active ? (asc ? 'desc' : 'asc') : 'desc';
    const arrowPath = active && asc ? 'M5 15l7-7 7 7' : active ? 'M19 9l-7 7-7-7' : 'M8 9l4-4 4 4M8 15l4 4 4-4';
    return `<th onclick="setComponentSort('${key}','${nextDir}')"
                class="px-4 py-3 text-left text-xs font-medium ${active?'text-blue-400':'text-gray-400 hover:text-gray-200'} uppercase tracking-wider cursor-pointer select-none align-middle">
      <div class="flex items-center gap-1">
        ${label}
        <svg class="w-3 h-3 ${active?'opacity-100':'opacity-30'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${arrowPath}"/>
        </svg>
      </div>
    </th>`;
  }

  const typeCombo = cfg.showTypeFilter ? _comboFilter({
    id: 'combo-type', allLabel: 'All types', selLabel: 'Types',
    items: contentTypes.map(ct => ({ value: ct, label: ct })),
    selected: componentFilters.contentTypes, onToggle: 'toggleTypeFilter',
  }) : '';
  const supportCombo = _comboFilter({
    id: 'combo-support', allLabel: 'All support', selLabel: 'Support',
    items: supportTypes.map(st => ({ value: st, label: st })),
    selected: componentFilters.supportTypes, onToggle: 'toggleSupportFilter',
  });
  const statusCombo = _comboFilter({
    id: 'combo-status', allLabel: 'All statuses', selLabel: 'Status',
    items: [
      { value: 'breaking',   label: 'Breaking' },
      { value: 'warning',    label: 'Possible issue' },
      { value: 'compatible', label: 'Compatible' },
    ],
    selected: componentFilters.statuses, onToggle: 'toggleStatusFilter',
  });
  // Owning-team filter — only shown when the DB carries internal ownership.
  const teamNames = dbLayer.getDistinctTeams().map(r => r.team).filter(Boolean);
  const teamCombo = teamNames.length ? _comboFilter({
    id: 'combo-team', allLabel: 'All teams', selLabel: 'Teams',
    items: teamNames.map(t => ({ value: t, label: t })),
    selected: componentFilters.teams, onToggle: 'toggleTeamFilter',
  }) : '';
  let moduleDepCombo = '';
  if (view === 'modules') {
    const allDeps = new Set();
    for (const c of scope) {
      const ctx = componentFacetStatus(c);
      for (const d of (ctx._moduleDeps || [])) allDeps.add(d);
    }
    const depItems = [...allDeps].sort().map(d => ({ value: d, label: d }));
    moduleDepCombo = _comboFilter({
      id: 'combo-moduledeps', allLabel: 'All module deps', selLabel: 'Deps',
      items: depItems, selected: componentFilters.moduleDeps, onToggle: 'toggleModuleDepFilter',
    });
  }

  const filterBar = `
    <div class="flex items-center gap-2 flex-wrap mb-4">
      <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/>
        </svg>
        <input id="comp-search" type="text" placeholder="Search…" value="${esc(q)}" oninput="setComponentFilter('search',this.value)"
               class="pl-9 pr-3 py-1.5 w-56 bg-dark-surface border border-dark-border rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50"/>
      </div>
      ${pubDropdown}
      ${typeCombo}
      ${supportCombo}
      ${statusCombo}
      ${teamCombo}
      ${moduleDepCombo}
      <span class="text-xs text-gray-600 ml-1">Tip: click a column header (Mx11, React Client…) to filter by that column</span>
      <span id="comp-clear-wrap" class="ml-auto">${_clearAllBtn()}</span>
    </div>`;

  const headCells = _effectiveColumns(cfg).map(key => {
    const col = COMPONENT_COLUMNS[key];
    if (col.badge) return _badgeTh(col);
    return col.sortKey ? _sortTh(col.label, col.sortKey) : th(col.label);
  }).join('');

  const countStr = components.length === total ? `${total.toLocaleString()}` : `${components.length.toLocaleString()} of ${total.toLocaleString()}`;

  const container = document.getElementById(cfg.containerId);
  container.innerHTML = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">${esc(cfg.title)}</h2>
        ${cfg.blurb ? `<p class="text-gray-500 text-sm mt-1.5 max-w-3xl leading-relaxed">${esc(cfg.blurb)}</p>` : ''}
        <p id="comp-count" class="text-gray-400 text-sm mt-1">${countStr} ${esc(cfg.noun)}${total !== 1 ? 's' : ''} scanned</p>
      </div>
      ${filterBar}
      ${card(`
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>${headCells}</tr></thead>
          <tbody id="comp-tbody" class="divide-y divide-dark-border"></tbody>
        </table>`)}
    </div>`;
  _renderListRows(container.querySelector('#comp-tbody'), components, cfg);
  showView(cfg.containerId);
  // Keep the active filter combobox open across the re-render it triggered.
  if (_openCombo) { const p = document.getElementById(_openCombo); if (p) p.classList.remove('hidden'); }
}

// Lightweight in-place refresh used while typing in the search box.
function _refreshComponentResults() {
  const cfg = VIEW_CONFIGS[_currentListView];
  if (!cfg) return;
  const container = document.getElementById(cfg.containerId);
  if (!container) return;
  const components = _filteredComponents(cfg);
  const total = (cfg.contentType
    ? dbLayer.getComponents().filter(c => c.content_type === cfg.contentType)
    : dbLayer.getComponents()).length;
  const countStr = components.length === total ? `${total.toLocaleString()}` : `${components.length.toLocaleString()} of ${total.toLocaleString()}`;
  const countEl = container.querySelector('#comp-count');
  if (countEl) countEl.textContent = `${countStr} ${cfg.noun}${total !== 1 ? 's' : ''} scanned`;
  const tbody = container.querySelector('#comp-tbody');
  if (tbody) _renderListRows(tbody, components, cfg);
  const clearWrap = container.querySelector('#comp-clear-wrap');
  if (clearWrap) clearWrap.innerHTML = _clearAllBtn();
}

function setComponentFilter(key, value) {
  componentFilters[key] = value;
  if (key === 'search' && document.getElementById('comp-tbody')) {
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => { _syncFiltersToURL(); _refreshComponentResults(); }, 150);
  } else {
    _rerenderList();
  }
}

function setComponentSort(key, dir) {
  componentFilters.sortBy = key; componentFilters.sortDir = dir;
  _rerenderList();
}

function setPubFilter(pub) {
  componentFilters.publisher = pub;
  const d = document.getElementById('pub-dropdown');
  if (d) d.classList.add('hidden');
  _rerenderList();
}

function togglePubDropdown() {
  const d = document.getElementById('pub-dropdown');
  if (!d) return;
  const opening = d.classList.contains('hidden');
  d.classList.toggle('hidden', !opening);
  if (opening) {
    const inp = document.getElementById('pub-search');
    if (inp) { inp.value = ''; filterPubListUI(''); inp.focus(); }
  }
}

function filterPubListUI(val) {
  const list = document.getElementById('pub-list');
  if (!list) return;
  const q = val.toLowerCase();
  list.querySelectorAll('[data-pub]').forEach(btn => {
    btn.style.display = !q || btn.dataset.pub.toLowerCase().includes(q) ? '' : 'none';
  });
}

// Default Support selection: everything present except Deprecated.
function _applySupportDefault() {
  const types = dbLayer.getDistinctSupportTypes().map(r => r.support_type).filter(Boolean);
  componentFilters.supportTypes = types.filter(s => s !== 'Deprecated');
  _supportDefaultApplied = true;
}

function clearCompFilters() {
  componentFilters.search        = '';
  componentFilters.publisher     = null;
  componentFilters.contentTypes  = [];
  componentFilters.statuses      = [];
  componentFilters.columnFilters = {};
  componentFilters.moduleDeps    = [];
  componentFilters.teams         = [];
  _applySupportDefault();
  _openCombo = null;
  _rerenderList();
}

function toggleModuleDepFilter(dep) {
  _openCombo = 'combo-moduledeps';
  const arr = componentFilters.moduleDeps;
  const i = arr.indexOf(dep);
  if (i >= 0) arr.splice(i, 1); else arr.push(dep);
  _rerenderList();
}


// =============================================================================
// Component detail
// =============================================================================

let _compDetailId  = null;
let _compDetailTab = 'overview';

// Java source viewer state for the current component detail page.
// _javaSources: "moduleId\x1ffilePath" → source text (only files with findings)
// _javaFindingLines: same key → Set of 1-indexed line numbers to highlight
let _javaSources      = {};
let _javaFindingLines = {};
// JS-action source viewer state, same shape/keying as the Java one above.
let _jsSources      = {};
let _jsFindingLines = {};

function buildVersionHistoryPanel(versions) {
  if (!versions || versions.length === 0) {
    return `<div class="text-center py-10 text-gray-500 text-sm">No version history available for this component.</div>`;
  }

  // Group by major Mendix version from min_supported_mendix_version (e.g. "10.3.0" → 10).
  // Versions without a value go into a dedicated "Unknown" bucket.
  const parseMajor = v => {
    const n = parseInt((v || '').split('.')[0]);
    return isNaN(n) ? null : n;
  };

  const groups = new Map(); // major (number|null) → version rows
  versions.forEach(v => {
    const key = parseMajor(v.min_supported_mendix_version);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  });

  // Sort group keys descending: numeric majors first (11, 10, 9…), then null.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  });

  // The globally-latest version (first entry in the original sorted array).
  const latestVersionNumber = versions[0].version_number;

  const tableFor = rows => {
    const rowHtml = rows.map(v => {
      const isLatest = v.version_number === latestVersionNumber;
      const latestBadge = isLatest
        ? `<span class="ml-1.5 px-1.5 py-0.5 text-xs bg-blue-500/15 text-blue-400 border border-blue-500/25 rounded-sm">latest</span>`
        : '';
      return `
        <tr class="hover:bg-dark-hover/50 transition-colors">
          <td class="px-4 py-2.5 text-sm font-mono text-white whitespace-nowrap">${esc(v.version_number)}${latestBadge}</td>
          <td class="px-4 py-2.5 text-sm text-gray-300">${esc(v.name || '—')}</td>
          <td class="px-4 py-2.5 text-xs text-gray-400 font-mono whitespace-nowrap">${esc(v.min_supported_mendix_version || '—')}</td>
          <td class="px-4 py-2.5 text-xs text-gray-400 whitespace-nowrap">${formatDate(v.publication_date)}</td>
        </tr>`;
    }).join('');
    return `<table class="min-w-full">
      <thead class="bg-dark-bg/50"><tr>${th('Version')}${th('Name')}${th('Min Mendix')}${th('Published')}</tr></thead>
      <tbody class="divide-y divide-dark-border">${rowHtml}</tbody>
    </table>`;
  };

  // Single group — render plain table (no group headers needed).
  if (sortedKeys.length === 1) {
    return card(tableFor(groups.get(sortedKeys[0])));
  }

  // Multiple groups — render a section header per major version.
  const sections = sortedKeys.map(key => {
    const label = key !== null ? `Mendix ${key}` : 'Unknown min version';
    const count = groups.get(key).length;
    return `
      <div>
        <div class="px-4 py-2 bg-dark-bg/70 border-b border-dark-border flex items-center gap-2">
          <span class="text-xs font-semibold text-gray-300 uppercase tracking-wide">${esc(label)}</span>
          <span class="text-xs text-gray-500">${count} version${count !== 1 ? 's' : ''}</span>
        </div>
        ${tableFor(groups.get(key))}
      </div>`;
  }).join('');

  return card(`<div class="divide-y divide-dark-border">${sections}</div>`);
}

const _TAB_ON  = 'px-5 py-2.5 text-sm font-medium text-white border-b-2 border-blue-500 -mb-px transition-colors';
const _TAB_OFF = 'px-5 py-2.5 text-sm font-medium text-gray-400 border-b-2 border-transparent -mb-px hover:text-gray-200 transition-colors';

function setComponentDetailTab(tab) {
  _compDetailTab = tab;
  _selectedTab = tab;
  // Reflect the open tab in the URL (selectedTab param) without re-rendering,
  // preserving the current view/id and any other params (e.g. showExperiments).
  const { view, id, params } = parseHash();
  params.selectedTab = tab;
  history.replaceState(null, '', '#' + buildHash({ view, id, params }));
  document.querySelectorAll('[data-comp-tab]').forEach(btn => {
    btn.className = btn.dataset.compTab === tab ? _TAB_ON : _TAB_OFF;
  });
  document.querySelectorAll('[data-comp-panel]').forEach(panel =>
    panel.classList.toggle('hidden', panel.dataset.compPanel !== tab));
}

function renderComponentDetail(marketplaceId) {
  const comp = dbLayer.getComponentDetail(marketplaceId);
  if (!comp) { IS_PUBLIC_REPORT ? renderPublicLanding() : renderComponents(); return; }

  // Reset tab when navigating to a different component. A `selectedTab` URL
  // param (e.g. from an Experiments-page row) preselects that tab instead.
  if (_compDetailId !== marketplaceId) {
    _compDetailId  = marketplaceId;
    _compDetailTab = _selectedTab || 'details';
  } else if (_selectedTab) {
    _compDetailTab = _selectedTab;
  }

  // Sub-queries use the internal DB id, not the marketplace_id from the URL.
  const internalId = comp.id;
  const widgets  = dbLayer.getComponentWidgets(internalId);
  const modules  = dbLayer.getComponentModules(internalId);
  const versions = dbLayer.getComponentVersions(internalId);

  // Experimental findings (Java javax/MendixSSO + global-mx on widgets/JS actions)
  // only surface when navigated in with showExperiments. Loaded here so both the
  // widget-only and complex branches can render the Experiments tab.
  const expFindings = _showExperiments ? dbLayer.getExperimentalFindings(internalId) : [];

  // Public build: the components list is blocked, so no back-to-list link.
  const backLink = IS_PUBLIC_REPORT ? '' : `
    <div class="mb-4">
      <a href="#" onclick="navigateTo('components'); return false;"
         class="text-mx-blue hover:text-mx-blue/80 text-sm inline-flex items-center gap-1">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
        </svg>
        Back to Components
      </a>
    </div>`;

  const hero          = buildHeroSection(comp, widgets, modules);
  const compatibility = buildCompatibilitySection(comp);
  const detailsPanel  = buildDetailsPanel(comp, modules, widgets, compatibility);
  const versionsLabel = `Version History${versions.length > 0 ? ` (${versions.length})` : ''}`;

  let body;
  if (modules.length === 0) {
    // Pure widget component — Details + Widgets (if any) + Version History,
    // plus Experiments (global-mx) when navigated in with showExperiments.
    const tabs = [
      { key: 'details',  label: 'Overview' },
      ...(widgets.length > 0 ? [{ key: 'widgets', label: `Widgets (${widgets.length})` }] : []),
      { key: 'versions', label: versionsLabel },
      ...(expFindings.length > 0 ? [{ key: 'experiments', label: `Experiments (${expFindings.length})` }] : []),
    ];

    // Widget-package experiments carry inline snippets (minified widget JS, no full
    // source stored), so no side source viewer is used here — but keep the shared
    // source maps defined so the viewer helpers stay safe if ever called.
    _javaSources = {};
    _jsSources = {};
    _jsFindingLines = {};
    _javaFindingLines = {};

    // Guard: reset to 'details' if saved tab is no longer valid
    if (!tabs.find(t => t.key === _compDetailTab)) _compDetailTab = 'details';

    const tabBar = `
      <div class="flex border-b border-dark-border mb-4">
        ${tabs.map(t => `<button data-comp-tab="${t.key}" onclick="setComponentDetailTab('${t.key}')"
                          class="${_compDetailTab === t.key ? _TAB_ON : _TAB_OFF}">${t.label}</button>`).join('')}
      </div>`;

    body = `
      ${tabBar}
      <div data-comp-panel="details" class="${_compDetailTab !== 'details' ? 'hidden' : ''}">
        ${detailsPanel}
      </div>
      <div data-comp-panel="widgets" class="${_compDetailTab !== 'widgets' ? 'hidden' : ''}">
        ${buildWidgetOnlyBody(widgets)}
      </div>
      <div data-comp-panel="versions" class="${_compDetailTab !== 'versions' ? 'hidden' : ''}">
        ${buildVersionHistoryPanel(versions)}
      </div>
      ${expFindings.length > 0 ? `
      <div data-comp-panel="experiments" class="${_compDetailTab !== 'experiments' ? 'hidden' : ''}">
        ${buildExperimentsPanel(modules, expFindings)}
      </div>` : ''}`;
  } else {
    // Complex component (module/starter/solution…) — tabbed view
    const javaFindings   = dbLayer.getComponentJavaFindings(internalId);
    const jsFindings     = dbLayer.getComponentJSFindings(internalId);
    const bundledWidgets = widgets.filter(w => w.bundled_in_module);

    // Load Java source (only files with findings) and index which lines have
    // findings, so the source viewer can highlight them on click. Java experiment
    // findings (javax/MendixSSO — module surface, empty snippet) share the same
    // module_java_sources snippets and source viewer; global-mx experiments carry
    // their own inline snippets and are not indexed here.
    _javaSources = dbLayer.getComponentJavaSources(internalId);
    _javaFindingLines = {};
    const javaExpFindings = expFindings.filter(f => (f.surface || 'module') === 'module');
    for (const f of javaFindings) {
      for (const loc of parseLocs(f.locations)) {
        const key = f.module_id + '\x1f' + loc.path;
        (_javaFindingLines[key] || (_javaFindingLines[key] = new Set())).add(parseInt(loc.line, 10));
      }
    }
    for (const f of javaExpFindings) {
      for (const loc of parseExpLocs(f.locations)) {
        const key = f.unit_id + '\x1f' + loc.path;
        (_javaFindingLines[key] || (_javaFindingLines[key] = new Set())).add(parseInt(loc.line, 10));
      }
    }
    // Same for JavaScript-action source — including files referenced only by a
    // JS-action experiment finding (global-mx), whose source we now also persist so
    // the Experiments drill-down opens the same side source viewer as JS Actions.
    _jsSources = dbLayer.getComponentJSSources(internalId);
    _jsFindingLines = {};
    const jsExpFindings = expFindings.filter(f =>
      (f.surface || 'module') === 'module' && String(f.category || '').includes('mx-global'));
    for (const f of jsExpFindings) {
      for (const loc of parseExpLocs(f.locations)) {
        const key = f.unit_id + '\x1f' + loc.path;
        (_jsFindingLines[key] || (_jsFindingLines[key] = new Set())).add(parseInt(loc.line, 10));
      }
    }
    for (const f of jsFindings) {
      for (const loc of parseLocs(f.locations)) {
        const key = f.module_id + '\x1f' + loc.path;
        (_jsFindingLines[key] || (_jsFindingLines[key] = new Set())).add(parseInt(loc.line, 10));
      }
    }

    const tabs = [
      { key: 'details',   label: 'Overview' },
      { key: 'structure', label: 'Package Structure' },
      ...(javaFindings.length > 0 ? [{ key: 'java', label: `Java Issues (${javaFindings.length})` }] : []),
      ...(jsFindings.length > 0 ? [{ key: 'jsactions', label: `JS Actions (${jsFindings.length})` }] : []),
      ...(bundledWidgets.length > 0 ? [{ key: 'widgets', label: `Widgets (${bundledWidgets.length})` }] : []),
      { key: 'versions',  label: versionsLabel },
      // Experiments is the last tab, and only present when navigated in with showExperiments.
      ...(expFindings.length > 0 ? [{ key: 'experiments', label: `Experiments (${expFindings.length})` }] : []),
    ];

    if (!tabs.find(t => t.key === _compDetailTab)) _compDetailTab = 'details';

    const tabBar = `
      <div class="flex border-b border-dark-border mb-4">
        ${tabs.map(t => `<button data-comp-tab="${t.key}" onclick="setComponentDetailTab('${t.key}')"
                          class="${_compDetailTab === t.key ? _TAB_ON : _TAB_OFF}">${t.label}</button>`).join('')}
      </div>`;

    body = `
      ${tabBar}
      <div data-comp-panel="details" class="${_compDetailTab !== 'details' ? 'hidden' : ''}">
        ${detailsPanel}
      </div>
      <div data-comp-panel="structure" class="${_compDetailTab !== 'structure' ? 'hidden' : ''}">
        ${buildStructurePanel(comp, modules, widgets, javaFindings, jsFindings)}
      </div>
      <div data-comp-panel="java" class="${_compDetailTab !== 'java' ? 'hidden' : ''}">
        ${buildJavaIssuesPanel(modules, javaFindings)}
      </div>
      ${jsFindings.length > 0 ? `
      <div data-comp-panel="jsactions" class="${_compDetailTab !== 'jsactions' ? 'hidden' : ''}">
        ${buildJSActionsPanel(jsFindings)}
      </div>` : ''}
      ${bundledWidgets.length > 0 ? `
      <div data-comp-panel="widgets" class="${_compDetailTab !== 'widgets' ? 'hidden' : ''}">
        ${buildWidgetTable(bundledWidgets)}
      </div>` : ''}
      <div data-comp-panel="versions" class="${_compDetailTab !== 'versions' ? 'hidden' : ''}">
        ${buildVersionHistoryPanel(versions)}
      </div>
      ${expFindings.length > 0 ? `
      <div data-comp-panel="experiments" class="${_compDetailTab !== 'experiments' ? 'hidden' : ''}">
        ${buildExperimentsPanel(modules, expFindings)}
      </div>` : ''}`;
  }

  document.getElementById('component-detail-view').innerHTML = `
    <div class="p-6">
      ${backLink}
      ${hero}
      <div class="mt-4">${body}</div>
    </div>`;
  showView('component-detail-view');
}

// ---------------------------------------------------------------------------
// Component detail — header helpers
// ---------------------------------------------------------------------------

// Small "external link" SVG arrow reused across detail-page links.
const _EXT_ARROW = `<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`;

// Pill-style external link used in the hero action row.
function extLinkPill(href, label) {
  return `<a href="${esc(href)}" target="_blank" rel="noopener"
    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-dark-border bg-dark-bg/40 text-gray-200 hover:text-white hover:border-mx-blue/50 transition-colors">
    ${esc(label)}${_EXT_ARROW}</a>`;
}

function parseDevelopers(json) {
  if (!json) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}

// Sanitized HTML render of the Marketplace description. Falls back to escaped
// plain text if DOMPurify failed to load.
function renderDescriptionHTML(html) {
  if (!html) return '';
  return window.DOMPurify
    ? DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
    : esc(html);
}

// One label/value cell in the metadata grid. Returns '' when value is empty so
// the grid stays clean.
function metaItem(label, valueHtml) {
  if (valueHtml === '' || valueHtml == null) return '';
  return `<div>
    <dt class="text-xs uppercase tracking-wide text-gray-500">${esc(label)}</dt>
    <dd class="mt-0.5 text-sm text-gray-200">${valueHtml}</dd>
  </div>`;
}

// ---------------------------------------------------------------------------
// Component detail — overall status badge (shared by hero + facets)
// ---------------------------------------------------------------------------
function compDetailStatusBadge(comp, widgets, modules) {
  const certainJava   = modules.reduce((s, m) => s + (m.certain_finding_count || 0), 0);
  const totalJava     = modules.reduce((s, m) => s + (m.total_finding_count   || 0), 0);
  const brokenWidgets = widgets.filter(w => w.broken_always || w.breaks116).length;
  const warnWidgets   = widgets.filter(w => !w.broken_always && !w.breaks116 && w.issue_count > 0).length;
  if (brokenWidgets > 0 || certainJava > 0)
    return badge('Breaking',   'bg-red-500/10 text-red-400 border-red-500/20');
  if (warnWidgets > 0 || totalJava > 0)
    return badge('Warning',    'bg-amber-500/10 text-amber-400 border-amber-500/20');
  return badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20');
}

// ---------------------------------------------------------------------------
// Component detail — hero (logo, name, badges, links) — full width
// ---------------------------------------------------------------------------
function buildHeroSection(comp, widgets, modules) {
  const logo = comp.logo_url
    ? `<img src="${esc(comp.logo_url)}" alt="" class="w-16 h-16 rounded-lg object-contain bg-dark-bg/60 border border-dark-border flex-shrink-0"
         onerror="this.style.display='none'">`
    : `<div class="w-16 h-16 rounded-lg bg-dark-bg/60 border border-dark-border flex items-center justify-center flex-shrink-0 text-gray-600 text-2xl font-semibold">${esc((comp.name || '?').charAt(0).toUpperCase())}</div>`;

  const publisherLine = comp.publisher
    ? (comp.publisher_url
        ? `<a href="${esc(comp.publisher_url)}" target="_blank" rel="noopener" class="hover:text-gray-200">${esc(comp.publisher)}</a>`
        : esc(comp.publisher))
    : '';

  const links = [
    comp.permalink   ? extLinkPill(comp.permalink, 'View on Marketplace') : '',
    comp.git_hub_url ? extLinkPill(comp.git_hub_url, 'GitHub')            : '',
    comp.demo_url    ? extLinkPill(comp.demo_url, 'Live demo')            : '',
    comp.video_url   ? extLinkPill(comp.video_url, 'Video')              : '',
  ].filter(Boolean).join('');

  // Compact at-a-glance facts line — only the parts that exist.
  const usage = comp.prod_apps_mx10 > 0
    ? `${comp.prod_apps_mx10.toLocaleString()} prod apps`
    : comp.download_count > 0 ? `${comp.download_count.toLocaleString()} downloads` : '';
  const facts = [
    comp.latest_version ? `v${esc(comp.latest_version)}` : '',
    comp.min_mx_version ? `Min Mendix ${esc(comp.min_mx_version)}` : '',
    comp.license_name   ? esc(comp.license_name) : '',
    usage,
    comp.rating > 0 ? `★ ${comp.rating}/5${comp.review_count > 0 ? ` (${comp.review_count.toLocaleString()})` : ''}` : '',
  ].filter(Boolean).join(' <span class="text-gray-600">·</span> ');

  return card(`
    <div class="p-5">
      <div class="flex items-start gap-4">
        ${logo}
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-xl font-semibold text-white">${esc(comp.name)}</h2>
                ${contentTypeBadge(comp.content_type)}${supportBadge(comp.support_type)}
                ${comp.distribution_type && comp.distribution_type !== 'regular' ? pkgDistBadge(comp.distribution_type) : ''}
              </div>
              ${publisherLine ? `<div class="mt-0.5 text-sm text-gray-400">by ${publisherLine}</div>` : ''}
            </div>
            ${links ? `<div class="flex items-center gap-2 flex-wrap justify-end flex-shrink-0">${links}</div>` : ''}
          </div>
          ${facts ? `<div class="mt-2 text-sm text-gray-400">${facts}</div>` : ''}
        </div>
      </div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Component detail — Mendix 11 compatibility (facet matrix + health) — full width
// ---------------------------------------------------------------------------
function buildCompatibilitySection(comp) {
  const healthBoxesHtml = _healthBoxes(comp);

  const compatCard = card(`
    <div class="p-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Compatibility</h3>
      ${facetMatrix(comp)}
    </div>`);

  if (!healthBoxesHtml && !comp.scan_error) return compatCard;

  const healthCard = card(`
    <div class="p-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Component Health</h3>
      ${healthBoxesHtml}
      ${comp.scan_error ? `<div class="${healthBoxesHtml ? 'mt-3' : ''} p-3 bg-amber-500/10 border border-amber-500/20 rounded text-xs text-amber-400">Scan error: ${esc(comp.scan_error)}</div>` : ''}
    </div>`);

  return `${compatCard}<div class="mt-3">${healthCard}</div>`;
}

// ---------------------------------------------------------------------------
// Component detail — Package structure summary (compact tree for the Overview tab)
// ---------------------------------------------------------------------------
function _structIcon(pathD, cls) {
  return `<svg class="w-4 h-4 flex-shrink-0 ${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${pathD}</svg>`;
}

function buildStructureSummary(modules, allWidgets) {
  if (modules.length === 0) return '';
  const agg = { hasJava:false, javaFiles:0, javaActions:0, hasCSS:false, cssFiles:0, hasUserlib:false, userlibFiles:0, hasUnmanagedDeps:false, hasManagedDeps:false, hasResources:false, resFiles:0, hasJS:false, jsFiles:0, certainIssues:0, totalIssues:0 };
  for (const m of modules) {
    if (m.has_java) { agg.hasJava=true; agg.javaFiles+=m.total_java_files||0; agg.javaActions+=m.java_action_count||0; }
    if (m.has_css) { agg.hasCSS = true; agg.cssFiles += _parseJSON(m.css_files_json).length; }
    if (m.has_userlib) { agg.hasUserlib = true; agg.userlibFiles += _parseJSON(m.userlib_files_json).length; if (!m.has_managed_dependencies) agg.hasUnmanagedDeps = true; }
    if (m.has_managed_dependencies) agg.hasManagedDeps = true;
    if (m.has_resources) { agg.hasResources = true; agg.resFiles += _parseJSON(m.resource_files_json).length; }
    if (m.has_js) { agg.hasJS = true; agg.jsFiles += m.total_js_files || 0; }
    agg.certainIssues += m.certain_finding_count || 0;
    agg.totalIssues += m.total_finding_count || 0;
  }
  const bundledWidgets = allWidgets.filter(w => w.bundled_in_module);

  // Model counts
  const entities = _mergeJSON(modules.map(m => m.model_entities_json)).length;
  const microflows = _mergeJSON(modules.map(m => m.model_microflows_json)).length;
  const pages = _mergeJSON(modules.map(m => m.model_pages_json)).length;
  const modelParts = [];
  if (entities) modelParts.push(`${entities} entit${entities===1?'y':'ies'}`);
  if (microflows) modelParts.push(`${microflows} microflow${microflows===1?'':'s'}`);
  if (pages) modelParts.push(`${pages} page${pages===1?'':'s'}`);

  const items = [];
  items.push({ icon: _structIcon(_iconModel(), 'text-indigo-400'), name: 'model/', sub: modelParts.length ? modelParts.join(' · ') : 'Mendix model' });
  if (agg.hasJava) {
    const issue = agg.certainIssues > 0 ? `<span class="text-red-400 text-xs font-medium">${agg.certainIssues} breaking</span>`
                : agg.totalIssues > 0 ? `<span class="text-amber-400 text-xs font-medium">${agg.totalIssues} possible</span>` : '';
    items.push({ icon: _structIcon(_iconJava(), 'text-blue-400'), name: 'javasource/', sub: `${agg.javaFiles} file${agg.javaFiles!==1?'s':''}` + (agg.javaActions > 0 ? ` · ${agg.javaActions} action${agg.javaActions!==1?'s':''}` : ''), issue });
  }
  if (agg.hasCSS) items.push({ icon: _structIcon(_iconCSS(), 'text-purple-400'), name: 'themesource/', sub: `${agg.cssFiles} file${agg.cssFiles!==1?'s':''}` });
  if (agg.hasManagedDeps) items.push({ icon: _structIcon(_iconManagedDeps(), 'text-green-400'), name: 'module-dependencies.json', sub: 'managed Java deps', issue: '<span class="text-green-400 text-xs font-medium">Managed ✓</span>' });
  if (agg.hasUserlib) items.push({ icon: _structIcon(_iconUserlib(), 'text-orange-400'), name: 'userlib/', sub: `${agg.userlibFiles} JAR${agg.userlibFiles!==1?'s':''}` + (agg.hasManagedDeps ? ' · managed' : ''), issue: agg.hasUnmanagedDeps ? '<span class="text-amber-400 text-xs font-medium">unmanaged</span>' : '' });
  if (agg.hasResources) items.push({ icon: _structIcon(_iconFolder(), 'text-teal-400'), name: 'resources/', sub: `${agg.resFiles} file${agg.resFiles!==1?'s':''}` });
  if (bundledWidgets.length > 0) items.push({ icon: _structIcon(_iconPuzzle(), 'text-sky-400'), name: 'widgets/', sub: `${bundledWidgets.length} bundled widget${bundledWidgets.length !== 1 ? 's' : ''}` });

  const rows = items.map(i => `
    <div class="flex items-center gap-2.5 py-1.5">
      <span class="text-gray-600 text-xs select-none">›</span>
      ${i.icon}
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-white">${esc(i.name)}</span>
          ${i.issue || ''}
        </div>
        <div class="text-xs text-gray-500">${i.sub || ''}</div>
      </div>
    </div>`).join('');

  return card(`
    <div class="p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Package Structure</h3>
      ${rows}
      <button onclick="setComponentDetailTab('structure')"
        class="mt-3 w-full text-xs text-center text-mx-blue hover:text-mx-blue/80 py-2 border border-dark-border rounded hover:border-mx-blue/30 transition-colors">
        View full structure &rarr;
      </button>
    </div>`);
}

// ---------------------------------------------------------------------------
// Component detail — About card (sanitized description). Lives in the main column.
// ---------------------------------------------------------------------------
// Marketplace descriptions are authored in a rich-text editor and often carry
// runs of empty <p>/<br> padding. Strip them so the About card has no dead space.
function _cleanDescriptionHTML(html) {
  if (!html) return '';
  return html
    .replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '')   // empty paragraphs
    .replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br>')           // collapse <br> runs
    .replace(/^(?:\s|&nbsp;|<br\s*\/?>)+/i, '')           // leading breaks
    .replace(/(?:\s|&nbsp;|<br\s*\/?>)+$/i, '')           // trailing breaks
    .trim();
}

const _ABOUT_PROSE = `text-sm text-gray-300 leading-relaxed max-w-none
  [&_p]:mb-2 [&_a]:text-mx-blue [&_a]:underline hover:[&_a]:text-mx-blue/80
  [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-2
  [&_li]:mb-1 [&_strong]:text-white [&_b]:text-white [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-white [&_h1]:mb-2
  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-white [&_h2]:mb-2 [&_h3]:font-semibold [&_h3]:text-white
  [&_img]:max-w-full [&_img]:rounded`;

function buildAboutCard(comp) {
  const cleaned = _cleanDescriptionHTML(renderDescriptionHTML(comp.description));
  if (!cleaned) return '';
  return card(`
    <div class="p-5">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">About</h3>
      <div class="${_ABOUT_PROSE}">${cleaned}</div>
    </div>`);
}

// ---------------------------------------------------------------------------
// Component detail — Overview tab (compat + health + about + details sidebar)
// ---------------------------------------------------------------------------
// Sidebar card showing which internal Mendix team owns this component, sourced
// from the Content Ownership app. Returns '' when the component has no owning team
// (community/partner content, or an older DB without ownership data). Links the
// team name to the Teams page and offers Jira/Slack shortcuts.
function buildOwnershipCard(comp) {
  if (!comp.owning_team) return '';
  const teamLink = `<a href="#${buildHash({ view: 'components', params: { teams: comp.owning_team } })}"
      class="text-mx-blue hover:text-mx-blue/80 font-medium">${esc(comp.owning_team)}</a>`;
  const hierarchy = [comp.owning_group, comp.owning_unit].filter(Boolean).map(esc).join(' › ');
  const jira = comp.owning_jira
    ? extLinkPill(`https://jira.mendix.com/projects/${encodeURIComponent(comp.owning_jira)}`, `Jira: ${comp.owning_jira}`)
    : '';
  const slack = (comp.owning_slack_channel || comp.owning_slack_url)
    ? extLinkPill(comp.owning_slack_url || '#', comp.owning_slack_channel || 'Slack')
    : '';
  const rows = [
    metaItem('Team', teamLink),
    metaItem('Group / Unit', hierarchy),
  ].filter(Boolean).join('');
  const links = [jira, slack].filter(Boolean).join(' ');
  return card(`
    <div class="p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3 flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5 text-mx-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.4-4.8"/></svg>
        Internal Ownership
      </h3>
      <dl class="space-y-2.5">${rows}</dl>
      ${links ? `<div class="mt-3 flex flex-wrap gap-2">${links}</div>` : ''}
    </div>`);
}

function buildDetailsPanel(comp, modules, allWidgets, compatHtml) {
  const devs = parseDevelopers(comp.developers_json);
  const devHtml = devs.length ? `<div class="flex flex-wrap gap-1.5">${devs.map(d => {
    const inner = `${d.avatarUrl ? `<img src="${esc(d.avatarUrl)}" alt="" class="w-4 h-4 rounded-full" onerror="this.style.display='none'">` : ''}${esc(d.name)}`;
    const chip = `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-dark-bg/60 border border-dark-border text-xs text-gray-200`;
    return d.profileUrl
      ? `<a href="${esc(d.profileUrl)}" target="_blank" rel="noopener" title="${esc(d.jobTitle || '')}" class="${chip} hover:border-mx-blue/50">${inner}</a>`
      : `<span class="${chip}" title="${esc(d.jobTitle || '')}">${inner}</span>`;
  }).join('')}</div>` : '';

  const licenseHtml = comp.license_name
    ? (comp.license_url
        ? `<a href="${esc(comp.license_url)}" target="_blank" rel="noopener" class="text-mx-blue hover:text-mx-blue/80 underline">${esc(comp.license_name)}</a>`
        : esc(comp.license_name))
    : '';

  const downloadsHtml = comp.prod_apps_mx10 > 0
    ? `<span class="text-white font-medium" title="Licensed Mendix apps using this in production on Mx10 (last month)">${comp.prod_apps_mx10.toLocaleString()}</span> <span class="text-gray-500 text-xs">prod apps (Mx10)</span>`
    : comp.download_count > 0
    ? comp.download_count.toLocaleString()
    : '';

  const ratingHtml = comp.rating > 0
    ? `${comp.rating}/5${comp.review_count > 0 ? ` <span class="text-gray-500 text-xs">(${comp.review_count.toLocaleString()} review${comp.review_count !== 1 ? 's' : ''})</span>` : ''}`
    : '';

  const moduleNames = modules.map(m => m.name).filter(Boolean);
  const moduleNamesHtml = moduleNames.length
    ? `<span class="font-mono text-gray-300 text-xs break-words">${moduleNames.map(esc).join(', ')}</span>`
    : '';

  const rows = [
    metaItem('Publisher', comp.publisher ? esc(comp.publisher) : ''),
    metaItem('Developers', devHtml),
    metaItem('License', licenseHtml),
    metaItem('Min Mendix', esc(comp.min_mx_version)),
    metaItem('Latest version', esc(comp.latest_version)),
    metaItem(comp.prod_apps_mx10 > 0 ? 'Usage' : 'Downloads', downloadsHtml),
    metaItem('Prod apps (Mx9)', (comp.prod_apps_mx9 > 0 && comp.prod_apps_mx10 > 0) ? comp.prod_apps_mx9.toLocaleString() : ''),
    metaItem('Rating', ratingHtml),
    metaItem('Published versions', comp.published_version_count > 0 ? String(comp.published_version_count) : ''),
    metaItem('Created', comp.created_date ? formatDate(comp.created_date) : ''),
    metaItem('Last updated', (comp.last_publish_date || comp.changed_date) ? formatDate(comp.last_publish_date || comp.changed_date) : ''),
    metaItem(moduleNames.length === 1 ? 'Module name' : 'Module names', moduleNamesHtml),
    metaItem('Type', contentTypeBadge(comp.content_type) + ' ' + supportBadge(comp.support_type)),
    metaItem('React Client', comp.react_client_ready
      ? '<span class="text-green-400">Ready</span>'
      : '<span class="text-gray-400">Not ready</span>'),
    metaItem(moduleNames.length === 1 ? 'Module name' : 'Module names', moduleNamesHtml),
    metaItem('Support', comp.support_website ? extLinkPill(comp.support_website, 'Support site') : ''),
  ].filter(Boolean).join('');

  const about = buildAboutCard(comp);

  // Main column: compat/health + about description. Sidebar: metadata + structure summary.
  const mainCol = `${compatHtml}${about ? `<div class="mt-3">${about}</div>` : ''}`;
  const structSummary = buildStructureSummary(modules, allWidgets);

  const metaCard = card(`
    <div class="p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Details</h3>
      <dl class="space-y-2.5">${rows || '<p class="text-sm text-gray-500">No metadata available.</p>'}</dl>
    </div>`);

  const ownershipCard = buildOwnershipCard(comp);
  const sidebarTop = ownershipCard ? `${ownershipCard}<div class="mt-3">${metaCard}</div>` : metaCard;
  const sidebarContent = `${structSummary ? `${structSummary}<div class="mt-3">${sidebarTop}</div>` : sidebarTop}`;

  return `
    <div class="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4 items-start">
      <div class="min-w-0">${mainCol}</div>
      <aside class="flex flex-col">${sidebarContent}</aside>
    </div>`;
}

// ---------------------------------------------------------------------------
// Component detail — simple widget-only body (no modules)
// ---------------------------------------------------------------------------
function buildWidgetOnlyBody(widgets) {
  if (widgets.length === 0)
    return `<div class="text-center py-10 text-gray-500 text-sm">No widgets found in this component.</div>`;
  return buildWidgetTable(widgets);
}

function buildWidgetTable(widgets) {
  const rows = widgets.map(w => `
    <tr class="hover:bg-dark-hover cursor-pointer transition-colors"
        onclick="navigateTo('widget', '${w.id}')">
      <td class="px-4 py-3">
        <div class="text-sm font-medium text-white">${esc(w.display_name || w.name)}</div>
        <div class="text-xs text-gray-500 mt-0.5">${esc(w.name)}</div>
      </td>
      <td class="px-4 py-3">${widgetTypeBadge(w.type)}</td>
      <td class="px-4 py-3 text-xs text-gray-400">${esc(w.version || '—')}</td>
      <td class="px-4 py-3">${findingBadges(w.findings)}</td>
      <td class="px-4 py-3">${statusBadge(w.broken_always, w.breaks116, w.issue_count)}</td>
    </tr>`).join('');
  return card(`
    <table class="min-w-full">
      <thead class="bg-dark-bg/50"><tr>${th('Widget')}${th('Type')}${th('Version')}${th('Findings')}${th('Status')}</tr></thead>
      <tbody class="divide-y divide-dark-border">${rows}</tbody>
    </table>`);
}

// ---------------------------------------------------------------------------
// Component detail — Package Structure tab (anatomy cards + dependencies)
// ---------------------------------------------------------------------------
function buildStructurePanel(comp, modules, allWidgets, javaFindings, jsFindings = []) {
  const agg = { hasJava:false, javaFiles:0, javaActions:0, hasCSS:false, hasUserlib:false, hasUnmanagedDeps:false, hasManagedDeps:false, hasResources:false, hasJS:false, jsFiles:0, certainIssues:0, totalIssues:0 };
  for (const m of modules) {
    if (m.has_java) { agg.hasJava=true; agg.javaFiles+=m.total_java_files||0; agg.javaActions+=m.java_action_count||0; }
    if (m.has_css)       agg.hasCSS      = true;
    if (m.has_userlib) {
      agg.hasUserlib = true;
      if (!m.has_managed_dependencies) agg.hasUnmanagedDeps = true;
    }
    if (m.has_managed_dependencies) agg.hasManagedDeps = true;
    if (m.has_resources) agg.hasResources= true;
    if (m.has_js)  { agg.hasJS=true; agg.jsFiles+=m.total_js_files||0; }
    agg.certainIssues += m.certain_finding_count||0;
    agg.totalIssues   += m.total_finding_count||0;
  }
  const bundledWidgets = allWidgets.filter(w => w.bundled_in_module);
  const widgetIssues   = bundledWidgets.filter(w => w.broken_always || w.breaks116 || w.issue_count > 0).length;

  // ── Version mismatch note (only when package.xml ≠ Marketplace) ─────────────
  const versioned = modules.filter(m => m.version);
  const mktVer    = comp.latest_version || '';
  const fileVer   = versioned.length === 1 ? (versioned[0].version || '') : versioned.length > 1 ? 'multiple' : '';
  const mismatch  = fileVer && mktVer && fileVer !== mktVer && versioned.length <= 1;

  const versionNote = mismatch ? `
    <div class="flex items-start gap-2 p-3 bg-amber-500/5 border border-amber-500/20 rounded text-xs text-amber-300">
      <svg class="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
      </svg>
      <span>Package file version <span class="font-mono text-amber-200">${esc(fileVer)}</span> differs from the Marketplace version <span class="font-mono text-amber-200">${esc(mktVer)}</span> — published metadata may be inaccurate.</span>
    </div>` : '';

  // ── Package structure tree (expandable) ──────────────────────────────────
  const rootName = modules.length === 1 ? (modules[0].name || 'module') : 'package';

  // Aggregate file lists from all modules
  const allJavaFiles    = _mergeJSON(modules.map(m => m.java_files_json));
  const allUserlibFiles = _mergeJSON(modules.map(m => m.userlib_files_json));
  const allCSSFiles     = _mergeJSON(modules.map(m => m.css_files_json));
  const allResFiles     = _mergeJSON(modules.map(m => m.resource_files_json));
  const allJSFiles      = _mergeJSON(modules.map(m => m.js_files_json));

  // Expanded content builders
  const javaExpand   = _fileTreeExpand(allJavaFiles, javaFindings, agg.javaFiles, 'java');
  const allManagedDeps = _mergeJSON(modules.map(m => m.managed_deps_json));
  const userlibExpand  = _userlibExpand(allUserlibFiles, allManagedDeps);
  const cssExpand    = _fileTreeExpand(allCSSFiles, [], 0, 'css');
  const resExpand    = _fileTreeExpand(allResFiles, [], 0, 'res');
  const jsExpand     = _fileTreeExpand(allJSFiles, jsFindings, 0, 'js');
  const widgetExpand = bundledWidgets.length > 0
    ? bundledWidgets.map(w => {
        const s = w.broken_always || w.breaks116
          ? `<span class="text-red-400">Breaking</span>`
          : w.issue_count > 0 ? `<span class="text-amber-400">Warning</span>`
          : `<span class="text-green-500">Compatible</span>`;
        return `<div class="flex items-center gap-2 py-0.5 font-mono text-xs cursor-pointer hover:text-blue-400 transition-colors"
                     onclick="event.stopPropagation();navigateTo('widget','${w.id}')">
          <span class="text-gray-700 select-none">─</span>
          <span class="text-gray-300">${esc(w.display_name || w.name)}</span>
          <span class="text-gray-600 ml-1">${esc(w.name)}</span>
          <span class="ml-auto">${s}</span>
        </div>`;
      }).join('')
    : null;

  // Aggregate model structure from all modules
  const allEntities     = _mergeJSON(modules.map(m => m.model_entities_json));
  const allMicroflows   = _mergeJSON(modules.map(m => m.model_microflows_json));
  const allNanoflows    = _mergeJSON(modules.map(m => m.model_nanoflows_json));
  const allPages        = _mergeJSON(modules.map(m => m.model_pages_json));
  const allEnums        = _mergeJSON(modules.map(m => m.model_enums_json));
  const allConstants    = _mergeJSON(modules.map(m => m.model_constants_json));
  const allRoles        = _mergeJSON(modules.map(m => m.model_roles_json));

  const hasModelData = allEntities.length + allMicroflows.length + allNanoflows.length +
                       allPages.length + allEnums.length + allConstants.length > 0;

  const modelExpand = _modelTreeExpand(allEntities, allMicroflows, allNanoflows, allPages, allEnums, allConstants);

  const modelParts = [];
  if (allEntities.length)   modelParts.push(`${allEntities.length} entit${allEntities.length===1?'y':'ies'}`);
  if (allMicroflows.length) modelParts.push(`${allMicroflows.length} microflow${allMicroflows.length===1?'':'s'}`);
  if (allPages.length)      modelParts.push(`${allPages.length} page${allPages.length===1?'':'s'}`);
  if (allEnums.length)      modelParts.push(`${allEnums.length} enum${allEnums.length===1?'':'s'}`);
  if (allConstants.length)  modelParts.push(`${allConstants.length} constant${allConstants.length===1?'':'s'}`);
  const modelSub = hasModelData ? modelParts.join(' · ') : 'Mendix model';

  const entries = [];
  entries.push({ icon:_iconModel(),   cls:'text-indigo-400', name:'model/',       sub:modelSub,   issue:null, expand: modelExpand });
  if (allRoles.length > 0) {
    entries.push({ icon:_iconSecurity(), cls:'text-violet-400', name:'security/', sub:`${allRoles.length} module role${allRoles.length===1?'':'s'}`,
      issue:null, expand:_securityExpand(allRoles) });
  }
  if (agg.hasJava) {
    const [iText,iCls] = agg.certainIssues>0 ? [`${agg.certainIssues} breaking`,'text-red-400']
                       : agg.totalIssues>0   ? [`${agg.totalIssues} possible`,'text-amber-400']
                       :                       ['No issues','text-green-500'];
    entries.push({ icon:_iconJava(), cls:'text-blue-400', name:'javasource/',
      sub:`${agg.javaFiles} file${agg.javaFiles!==1?'s':''}${agg.javaActions>0?' · '+agg.javaActions+' actions':''}`,
      issue:{text:iText,cls:iCls}, expand:javaExpand });
  }
  if (agg.hasJS) {
    const jsCertain = jsFindings.filter(f => f.certain).length;
    const jsPossible = jsFindings.length - jsCertain;
    const jsIssue = jsCertain > 0 ? { text: `${jsCertain} breaking`, cls: 'text-red-400' }
                  : jsPossible > 0 ? { text: `${jsPossible} possible`, cls: 'text-amber-400' }
                  : null;
    entries.push({ icon:_iconJS(), cls:'text-amber-400', name:'javascriptsource/', sub:`${agg.jsFiles} JS action${agg.jsFiles!==1?'s':''}`, issue:jsIssue, expand:jsExpand });
  }
  if (agg.hasCSS)       entries.push({ icon:_iconCSS(),     cls:'text-purple-400', name:'themesource/', sub:'CSS / SCSS',        issue:null, expand:cssExpand });
  if (agg.hasManagedDeps) entries.push({ icon:_iconManagedDeps(), cls:'text-green-400', name:'module-dependencies.json',
    sub:'Mendix managed Java dependencies',
    issue: { text:'Managed ✓', cls:'text-green-400' },
    expand: `<p class="text-xs text-gray-400 py-1">Declares Java dependencies using Mendix managed dependency resolution.<br>
      <span class="text-gray-600 italic">JARs in userlib/ are resolved at build time from these declarations.</span></p>` });
  if (agg.hasUserlib) {
    const userlibSub = agg.hasManagedDeps ? 'JAR dependencies · managed' : 'JAR dependencies';
    entries.push({ icon:_iconUserlib(), cls:'text-orange-400', name:'userlib/',     sub:userlibSub,
      issue: agg.hasUnmanagedDeps ? { text:'No managed-dependencies', cls:'text-amber-400' } : null,
      expand:userlibExpand });
  }
  if (agg.hasResources) entries.push({ icon:_iconFolder(),  cls:'text-teal-400',   name:'resources/',   sub:'Static resources',  issue:null, expand:resExpand });
  if (bundledWidgets.length > 0) entries.push({
    icon:_iconPuzzle(), cls:'text-sky-400', name:'widgets/',
    sub:`${bundledWidgets.length} bundled widget${bundledWidgets.length!==1?'s':''}`,
    issue: widgetIssues>0 ? {text:`${widgetIssues} with issues`,cls:'text-amber-400'} : null,
    expand: widgetExpand,
  });

  // Masonry (CSS multi-column) so cards pack by shortest column with no row
  // gaps, and the layout reflows automatically when a card is expanded.
  const structureBody = entries.length
    ? `<div class="columns-1 md:columns-2 xl:columns-3 gap-3">
         ${entries.map(e => `<div class="break-inside-avoid mb-3">${_structureCard(e)}</div>`).join('')}
       </div>`
    : `<p class="py-4 text-xs text-gray-600">No structure data — re-scan required.</p>`;

  const structureSection = `
    <div>
      <div class="flex items-baseline gap-2.5 mb-2">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Package structure</span>
        <span class="font-mono text-xs text-gray-500">${esc(rootName)}/</span>
      </div>
      ${structureBody}
    </div>`;

  // ── Multiple-module summary ────────────────────────────────────────────────
  let modSummary = '';
  if (modules.length > 1) {
    const rows = modules.map(m => `
      <tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="navigateTo('module','${m.id}')">
        <td class="px-4 py-2.5 text-sm font-medium text-white font-mono">${esc(m.name)}</td>
        <td class="px-4 py-2.5 text-xs text-gray-400 font-mono">${esc(m.version||'—')}</td>
        <td class="px-4 py-2.5 text-xs text-gray-400">${m.has_java ? (m.total_java_files||0)+' files' : '—'}</td>
        <td class="px-4 py-2.5">
          ${m.certain_finding_count>0 ? badge('Breaking','bg-red-500/10 text-red-400 border-red-500/20') :
            m.total_finding_count>0   ? badge('Warning','bg-amber-500/10 text-amber-400 border-amber-500/20') :
                                        badge('Compatible','bg-green-500/10 text-green-400 border-green-500/20')}
        </td>
      </tr>`).join('');
    modSummary = `
      <div class="mt-4">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Modules (${modules.length})</p>
        ${card(`<table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>${th('Module')}${th('Version')}${th('Java')}${th('Status')}</tr></thead>
          <tbody class="divide-y divide-dark-border">${rows}</tbody>
        </table>`)}
      </div>`;
  }

  // ── Module dependencies card ──────────────────────────────────────────────
  const allDeps = new Set();
  for (const m of modules) {
    for (const dep of _parseJSON(m.module_deps_json)) allDeps.add(dep);
  }

  let depsCard = '';
  if (allDeps.size > 0) {
    const depCtx = dbLayer.getDependencyContext();
    const { nameIndex, componentDeps } = depCtx;
    const sortedDeps = [...allDeps].sort();

    // Build each dep row with link / collision / unknown status
    function depRow(depName, indent = false) {
      const matches = nameIndex[depName] || [];
      const padClass = indent ? 'pl-4' : '';
      if (matches.length === 1) {
        const c = matches[0];
        return `<div class="flex items-center gap-2 py-0.5 ${padClass}">
          <div class="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0"></div>
          <button onclick="navigateTo('component','${c.marketplace_id}')"
                  class="text-xs font-mono text-blue-400 hover:text-blue-300 transition-colors text-left">${esc(depName)}</button>
          <span class="text-xs text-gray-600">→ ${esc(c.name)}</span>
        </div>`;
      }
      if (matches.length > 1) {
        const tooltip = 'Ambiguous: matches ' + matches.map(c => c.name).join(', ');
        return `<div class="flex items-center gap-2 py-0.5 ${padClass}">
          <div class="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0"></div>
          <span class="text-xs font-mono text-gray-200">${esc(depName)}</span>
          <svg class="w-3 h-3 text-amber-400 cursor-help flex-shrink-0" title="${esc(tooltip)}"
               fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <span class="text-xs text-gray-600">${matches.length} possible matches</span>
        </div>`;
      }
      return `<div class="flex items-center gap-2 py-0.5 ${padClass}">
        <div class="w-1.5 h-1.5 rounded-full bg-gray-600 flex-shrink-0"></div>
        <span class="text-xs font-mono text-gray-500">${esc(depName)}</span>
        <span class="text-xs text-gray-700">not in scan</span>
      </div>`;
    }

    // Build dependency tree HTML (recursive, DFS, max depth 4, cycle-safe)
    function buildDepTreeHtml(depNames, visited, depth) {
      if (!depNames.length) return '';
      const isRoot = depth === 0;
      return depNames.map(depName => {
        const matches = nameIndex[depName] || [];
        const component = matches.length === 1 ? matches[0] : null;
        const alreadyVisited = component && visited.has(component.id);
        const childDeps = (component && !alreadyVisited) ? (componentDeps[component.id] || []) : [];
        const newVisited = component ? new Set([...visited, component.id]) : visited;
        const children = depth < 4 ? buildDepTreeHtml(childDeps, newVisited, depth + 1) : '';

        let nodeLabel;
        if (matches.length === 1) {
          const c = matches[0];
          nodeLabel = `<button onclick="navigateTo('component','${c.marketplace_id}')"
              class="font-mono text-xs text-blue-400 hover:text-blue-300 transition-colors">${esc(depName)}</button>
            <span class="text-gray-600 text-xs">→ ${esc(c.name)}${alreadyVisited ? ' (↑ already listed)' : ''}</span>`;
        } else if (matches.length > 1) {
          const tooltip = 'Ambiguous: ' + matches.map(c => c.name).join(', ');
          nodeLabel = `<span class="font-mono text-xs text-gray-200">${esc(depName)}</span>
            <svg class="w-3 h-3 text-amber-400 cursor-help flex-shrink-0 inline" title="${esc(tooltip)}"
                 fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>`;
        } else {
          nodeLabel = `<span class="font-mono text-xs text-gray-500">${esc(depName)}</span>
            <span class="text-gray-700 text-xs">not in scan</span>`;
        }

        const indent = depth > 0 ? `style="padding-left:${depth * 14}px"` : '';
        return `<div ${indent}>
          <div class="flex items-center gap-1.5 py-0.5">
            <span class="text-gray-700 select-none text-xs">${isRoot ? '●' : '└'}</span>
            ${nodeLabel}
          </div>
          ${children}
        </div>`;
      }).join('');
    }

    const ownCompIds = new Set(modules.map(m => m.component_id).filter(Boolean));
    const treeHtml = buildDepTreeHtml(sortedDeps, new Set([...ownCompIds, comp.id]), 0);
    const treeId = `dep-tree-${comp.id}`;

    depsCard = card(`
      <div class="px-4 pt-3 pb-1 border-b border-dark-border">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Module Dependencies</span>
        <span class="ml-2 text-xs text-gray-600">${allDeps.size} external module${allDeps.size !== 1 ? 's' : ''}</span>
      </div>
      <div class="p-3 space-y-0.5">
        <p class="text-xs text-gray-600 mb-2">Must be present in the target project to avoid consistency errors.</p>
        ${sortedDeps.map(d => depRow(d)).join('')}
      </div>
      <div class="px-4 pb-3 border-t border-dark-border pt-3">
        <p class="text-xs text-gray-500 mb-2 font-semibold">Dependency tree</p>
        ${treeHtml}
      </div>`);
  }

  // How the package is delivered — add-on module, extension, solution — reads
  // above the anatomy, since it decides what the anatomy means.
  const packagingCard = buildPackagingCard(comp, dbLayer.getPackagingModules(comp.id));

  return `
    <div class="space-y-4">
      ${versionNote}
      ${packagingCard}
      ${structureSection}
      ${depsCard}
      ${modSummary}
    </div>`;
}

// One package-structure section rendered as a self-contained card with its
// contents expanded by default (scrollable when tall).
function _structureCard(e) {
  return card(`
    <div class="px-4 pt-3 pb-2 border-b border-dark-border flex items-start gap-2.5">
      <svg class="w-4 h-4 flex-shrink-0 mt-0.5 ${e.cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${e.icon}</svg>
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="font-mono text-sm text-gray-100">${esc(e.name)}</span>
          ${e.issue ? `<span class="text-xs font-medium ${e.issue.cls}">${esc(e.issue.text)}</span>` : ''}
        </div>
        <div class="text-xs text-gray-500 mt-0.5">${esc(e.sub)}</div>
      </div>
    </div>
    <div class="px-4 py-3">${e.expand || '<p class="text-xs text-gray-600">—</p>'}</div>`);
}

// Parse a JSON array stored in DB (returns [] on null/empty/invalid)
function _parseJSON(s) {
  if (!s || s === '[]') return [];
  try { return JSON.parse(s); } catch { return []; }
}

// Merge JSON arrays from multiple modules into one deduplicated sorted array
function _mergeJSON(jsonStrings) {
  const seen = new Set(), out = [];
  for (const s of jsonStrings) for (const v of _parseJSON(s)) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out.sort();
}

// Render a directory-grouped file tree. For Java files, annotates with issue data.
function _fileTreeExpand(files, findings, totalCount, mode) {
  if (!files.length) return `<p class="text-xs text-gray-600 italic py-1">No files recorded — re-scan required.</p>`;

  // Both 'java' and 'js' pass findings whose `locations` blob maps file paths to
  // per-file issue counts; other modes (css/res) pass [].
  const issueMap = {};
  if (mode === 'java' || mode === 'js') {
    for (const f of findings) {
      for (const loc of parseLocs(f.locations)) {
        if (!issueMap[loc.path]) issueMap[loc.path] = { certain: false, count: 0 };
        if (f.certain) issueMap[loc.path].certain = true;
        issueMap[loc.path].count++;
      }
    }
  }

  const dirs = {};
  for (const path of files) {
    const sl = path.lastIndexOf('/');
    const dir  = sl >= 0 ? path.slice(0, sl) : '';
    const file = sl >= 0 ? path.slice(sl + 1) : path;
    (dirs[dir] || (dirs[dir] = [])).push(file);
  }

  const tree = Object.entries(dirs).sort(([a],[b]) => a.localeCompare(b)).map(([dir, dirFiles]) => `
    ${dir ? `<div class="text-xs text-gray-500 font-mono mt-2 first:mt-0">${esc(dir)}/</div>` : ''}
    ${dirFiles.map((file, i) => {
      const issue = issueMap[dir ? dir+'/'+file : file];
      const cls = issue ? (issue.certain ? 'text-red-400' : 'text-amber-400') : 'text-gray-400';
      const ann = issue ? `<span class="ml-auto ${issue.certain?'text-red-400/60':'text-amber-400/60'}">${issue.count} issue${issue.count!==1?'s':''}</span>` : '';
      return `<div class="flex items-center gap-1.5 font-mono text-xs ${dir?'pl-3':''}">
        <span class="text-gray-700 select-none">${i===dirFiles.length-1?'└':'├'}</span>
        <span class="${cls}">${esc(file)}</span>${ann}
      </div>`;
    }).join('')}`).join('');

  const extra = mode === 'java' && totalCount > files.length
    ? `<div class="text-xs text-gray-600 mt-2 pl-1 font-mono">+ ${totalCount - files.length} more not listed</div>` : '';
  return `<div class="space-y-0.5">${tree}</div>${extra}`;
}

// Userlib expand: shows Maven coordinates (if available) and JAR filenames.
function _userlibExpand(jarFiles, managedCoords) {
  const coordSection = managedCoords.length > 0
    ? `<div class="mb-2">
        <div class="text-xs text-gray-600 uppercase tracking-wider mb-1">Declared Maven deps</div>
        <div class="space-y-0.5 font-mono">${managedCoords.map((c, i) =>
          `<div class="flex items-center gap-1.5 text-xs">
            <span class="text-gray-700 select-none">${i === managedCoords.length - 1 ? '└' : '├'}</span>
            <span class="text-green-400">${esc(c)}</span>
          </div>`).join('')}</div>
      </div>`
    : '';
  const jarSection = jarFiles.length > 0
    ? `<div>
        <div class="text-xs text-gray-600 uppercase tracking-wider mb-1">JAR files</div>
        <div class="space-y-0.5 font-mono">${jarFiles.map((f, i) =>
          `<div class="flex items-center gap-1.5 text-xs">
            <span class="text-gray-700 select-none">${i === jarFiles.length - 1 ? '└' : '├'}</span>
            <span class="text-gray-400">${esc(f)}</span>
          </div>`).join('')}</div>
      </div>`
    : '';
  return coordSection || jarSection
    ? `<div class="space-y-2">${coordSection}${jarSection}</div>`
    : `<p class="text-xs text-gray-600 italic py-1">No files recorded — re-scan required.</p>`;
}

// Simple sorted list (JAR files, no subdirs needed)
function _simpleListExpand(files) {
  if (!files.length) return `<p class="text-xs text-gray-600 italic py-1">No files recorded — re-scan required.</p>`;
  return `<div class="space-y-0.5 font-mono">${files.map((f,i) =>
    `<div class="flex items-center gap-1.5 text-xs">
       <span class="text-gray-700 select-none">${i===files.length-1?'└':'├'}</span>
       <span class="text-gray-400">${esc(f)}</span>
     </div>`).join('')}</div>`;
}

// Builds the expanded model/ tree showing domain model entities, microflows, pages, etc.
function _modelTreeExpand(entities, microflows, nanoflows, pages, enums, constants) {
  const hasAny = entities.length + microflows.length + nanoflows.length +
                 pages.length + enums.length + constants.length > 0;
  if (!hasAny) {
    return `<p class="text-xs text-gray-500 italic py-1">No model data — re-scan required to populate.</p>`;
  }

  const MAX = 40;
  function itemList(names, cls) {
    const shown = names.slice(0, MAX);
    const more  = names.length - shown.length;
    return shown.map((n, i) => {
      const isLast = i === shown.length - 1 && more === 0;
      return `<div class="flex items-center gap-1.5 py-0.5">
        <span class="text-gray-700 select-none text-xs inline-block w-3 text-center">${isLast?'└':'├'}</span>
        <span class="font-mono text-xs ${cls}">${esc(n)}</span>
      </div>`;
    }).join('') + (more > 0 ? `<div class="text-xs text-gray-600 italic pl-4">… ${more} more</div>` : '');
  }

  function section(id, iconSvg, iconCls, label, count, names, nameCls) {
    if (!count) return '';
    const nid = `model-sec-${id}`;
    return `<div class="border-b border-dark-border/30 last:border-0">
      <div class="flex items-center gap-2 py-1.5 cursor-pointer select-none"
           onclick="(function(n){var d=document.getElementById(n);var c=document.getElementById(n+'-chv');d.classList.toggle('hidden');c.style.transform=d.classList.contains('hidden')?'':'rotate(90deg)';}('${nid}'))">
        <svg id="${nid}-chv" class="w-3 h-3 flex-shrink-0 text-gray-600 transition-transform duration-150" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        </svg>
        <svg class="w-3.5 h-3.5 flex-shrink-0 ${iconCls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${iconSvg}</svg>
        <span class="font-mono text-xs text-gray-200">${label}</span>
        <span class="text-xs text-gray-500 ml-1">${count}</span>
      </div>
      <div id="${nid}" class="hidden pl-5 pb-1">${itemList(names, nameCls)}</div>
    </div>`;
  }

  return `<div class="divide-y divide-dark-border/20">
    ${section('dm',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M3 14h18M3 6h18M3 18h18"/>',
               'text-indigo-300', 'DomainModel/', entities.length, entities, 'text-indigo-200')}
    ${section('mf',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
               'text-cyan-400', 'Microflows', microflows.length, microflows, 'text-cyan-200')}
    ${section('nf',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>',
               'text-yellow-400', 'Nanoflows', nanoflows.length, nanoflows, 'text-yellow-200')}
    ${section('pg',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>',
               'text-green-400', 'Pages', pages.length, pages, 'text-green-200')}
    ${section('en',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 10h16M4 14h8"/>',
               'text-orange-400', 'Enumerations', enums.length, enums, 'text-orange-200')}
    ${section('co',  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"/>',
               'text-pink-400', 'Constants', constants.length, constants, 'text-pink-200')}
  </div>`;
}

// Builds the expanded security/ tree showing module roles.
function _securityExpand(roles) {
  if (!roles.length) return '';
  return `<div class="space-y-0.5">${roles.map((r, i) => {
    const isLast = i === roles.length - 1;
    return `<div class="flex items-center gap-1.5 py-0.5">
      <span class="text-gray-700 select-none text-xs inline-block w-3 text-center">${isLast?'└':'├'}</span>
      <svg class="w-3.5 h-3.5 flex-shrink-0 text-violet-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
      </svg>
      <span class="font-mono text-xs text-violet-200">${esc(r)}</span>
    </div>`;
  }).join('')}</div>`;
}

// SVG icon paths for anatomy cards
function _iconModel()   { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>'; }
function _iconSecurity(){ return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>'; }
function _iconJava()    { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>'; }
function _iconJS()      { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>'; }
function _iconCSS()     { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>'; }
function _iconUserlib()     { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/>'; }
function _iconManagedDeps() { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>'; }
function _iconFolder()  { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>'; }
function _iconPuzzle()  { return '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/>'; }

// ---------------------------------------------------------------------------
// Component detail — Java issues tab (three sections + tree view)
// ---------------------------------------------------------------------------
function buildJavaIssuesPanel(modules, javaFindings) {
  if (javaFindings.length === 0) {
    return `<div class="text-center py-10">
      ${badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20')}
      <p class="text-sm text-gray-500 mt-3">No Java API compatibility issues found.</p>
    </div>`;
  }

  const isDeprecated = f => f.category && f.category.startsWith('deprecated-');
  const isMx10       = f => f.category && f.category.includes('-mx10');
  const isMx11       = f => !isMx10(f) && !isDeprecated(f);

  const multiModule = new Set(javaFindings.map(f => f.module_id)).size > 1;

  // Group a subset of findings by module
  function byModule(findings) {
    const map = {};
    for (const f of findings) {
      if (!map[f.module_id]) map[f.module_id] = { name: f.module_name, version: f.module_version, findings: [] };
      map[f.module_id].findings.push(f);
    }
    return Object.values(map);
  }

  function renderFinding(f) {
    const locs = parseLocs(f.locations);
    const moduleId = f.module_id;
    const dep  = isDeprecated(f);
    const cls  = f.certain ? 'red' : dep ? 'gray' : 'amber';
    const borderCls = cls === 'red' ? 'border-red-500/20' : cls === 'gray' ? 'border-dark-border' : 'border-amber-500/20';
    const bgCls     = cls === 'red' ? 'bg-red-500/5'      : cls === 'gray' ? 'bg-dark-bg/30'      : 'bg-amber-500/5';
    const ruleCls   = cls === 'red' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                    : cls === 'gray'? 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                    :                 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    const labelTxt  = f.certain ? 'certain' : dep ? 'deprecated' : 'possible';
    const labelCls  = cls === 'red' ? 'text-red-400' : cls === 'gray' ? 'text-gray-500' : 'text-amber-400';
    const numCls    = cls === 'red' ? 'text-red-400' : cls === 'gray' ? 'text-gray-500' : 'text-amber-400';

    return `
      <div class="rounded-lg border ${borderCls} overflow-hidden">
        <div class="px-4 py-3 ${bgCls} flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
              <span class="inline-block px-2 py-0.5 ${ruleCls} text-xs rounded border font-medium">${esc(f.rule)}</span>
              <span class="text-xs ${labelCls}">${labelTxt}</span>
            </div>
            <p class="text-xs text-gray-300 leading-relaxed">${esc(f.description)}</p>
            ${f.doc_url ? `<a href="${esc(f.doc_url)}" target="_blank" onclick="event.stopPropagation()"
               class="text-xs text-mx-blue hover:underline mt-1 inline-block">Documentation →</a>` : ''}
          </div>
          <div class="text-right flex-shrink-0 pt-0.5">
            <div class="text-sm font-semibold ${numCls}">${f.match_count || 0}</div>
            <div class="text-xs text-gray-600">matches</div>
          </div>
        </div>
        ${locs.length > 0 ? `
          <div class="px-4 py-3 border-t ${borderCls} bg-dark-bg/60">
            <div class="text-xs text-gray-600 uppercase tracking-wider mb-2">Source locations</div>
            ${buildLocationTree(locs, moduleId)}
          </div>` : ''}
      </div>`;
  }

  function renderSection(title, color, subset) {
    if (!subset.length) return '';
    const dot = color === 'red' ? 'bg-red-500' : color === 'amber' ? 'bg-amber-500' : 'bg-gray-500';
    const hdr = color === 'red' ? 'text-red-400' : color === 'amber' ? 'text-amber-400' : 'text-gray-400';
    const groups = byModule(subset);
    return `
      <div class="mb-6">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-2 h-2 rounded-full ${dot}"></div>
          <h3 class="text-sm font-semibold ${hdr}">${title}</h3>
          <span class="text-xs text-gray-600">${subset.length} finding${subset.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="space-y-3">
          ${groups.map(mod => `
            ${multiModule ? `<div class="text-xs font-mono text-gray-500 mb-1">${esc(mod.name)}${mod.version ? ' v' + esc(mod.version) : ''}</div>` : ''}
            ${mod.findings.map(renderFinding).join('')}`).join('')}
        </div>
      </div>`;
  }

  const sections = `
    ${renderSection('Breaking in Mendix 10', 'red',   javaFindings.filter(isMx10))}
    ${renderSection('Breaking in Mendix 11', 'red',   javaFindings.filter(isMx11))}
    ${renderSection('Deprecated — will break in a future Mendix version', 'gray', javaFindings.filter(isDeprecated))}`;

  // Two-column layout: findings on the left, source viewer on the right.
  // The viewer column stays hidden until a source location is clicked.
  return `
    <div id="java-issues-split" class="flex gap-4 items-start">
      <div id="java-findings-col" class="flex-1 min-w-0">${sections}</div>
      <div id="java-source-col" class="hidden w-1/2 flex-shrink-0 sticky top-4"></div>
    </div>`;
}

// Experiments panel for the component detail page — the drill-down for experimental /
// future-migration findings (e.g. javax.servlet/websocket imports). Mirrors
// buildJavaIssuesPanel (findings left, clickable source viewer right) but uses its
// own DOM ids so it doesn't clash with the Java Issues panel, and frames the findings
// as neutral migration heads-ups rather than breaks.
function buildExperimentsPanel(modules, expFindings) {
  if (expFindings.length === 0) {
    return `<div class="text-center py-10">
      <p class="text-sm text-gray-500">No experimental findings for this component.</p>
    </div>`;
  }

  // Fresh per-file widget snippet store for this component (populated as we render
  // widget findings below, read back by showWidgetExpMatches on click).
  _widgetExpMatches = {};

  // Group by unit (a module or a widget). surface distinguishes the two so we can
  // label widget-JS findings and route the Java source viewer only for modules.
  const unitKey = f => (f.surface || 'module') + ':' + f.unit_id;
  const multiUnit = new Set(expFindings.map(unitKey)).size > 1;

  function byUnit(findings) {
    const map = {};
    for (const f of findings) {
      const k = unitKey(f);
      if (!map[k]) map[k] = { surface: f.surface || 'module', name: f.unit_name, version: f.unit_version, findings: [] };
      map[k].findings.push(f);
    }
    return Object.values(map);
  }

  // Location rendering — all three surfaces show a clickable file tree that opens
  // the matches for that file in the side column:
  //   • widget global-mx  → sidebar lists the captured snippets per file, matched
  //                          token highlighted (minified widget JS — no full source)
  //   • module global-mx  → sidebar shows the full JS-action source (stored), line
  //                          highlighted (action files are short & un-minified)
  //   • module javax/SSO   → sidebar shows the full Java source, line highlighted
  function renderLocations(f) {
    const surface = f.surface || 'module';
    const isMxGlobal = String(f.category || '').includes('mx-global');
    const locs = parseExpLocs(f.locations);
    if (!locs.length) return '';

    let tree;
    if (surface === 'widget') {
      // Register the per-file snippet matches for the sidebar, then a snippet-backed
      // clickable tree (no full source — showWidgetExpMatches renders the snippets).
      registerWidgetExpMatches(f.unit_id, locs, f.rule);
      tree = buildWidgetExpLocationTree(locs, f.unit_id);
    } else if (isMxGlobal) {
      tree = buildJSLocationTree(locs.map(l => ({ path: l.path, line: l.line })),
                                 f.unit_id, 'exp-source-col', 'exp-findings-col');
    } else {
      tree = buildLocationTree(locs.map(l => ({ path: l.path, line: l.line })),
                               f.unit_id, 'exp-source-col', 'exp-findings-col');
    }
    return `
      <div class="px-4 py-3 border-t border-amber-500/20 bg-dark-bg/60">
        <div class="text-xs text-gray-600 uppercase tracking-wider mb-2">Source locations</div>
        ${tree}
      </div>`;
  }

  function renderFinding(f) {
    return `
      <div class="rounded-lg border border-amber-500/20 overflow-hidden">
        <div class="px-4 py-3 bg-amber-500/5 flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
              <span class="inline-block px-2 py-0.5 bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs rounded border font-medium">${esc(f.rule)}</span>
              <span class="text-xs text-amber-400">experimental</span>
            </div>
            <p class="text-xs text-gray-300 leading-relaxed">${esc(f.description)}</p>
            ${f.doc_url ? `<a href="${esc(f.doc_url)}" target="_blank" onclick="event.stopPropagation()"
               class="text-xs text-mx-blue hover:underline mt-1 inline-block">Documentation →</a>` : ''}
          </div>
          <div class="text-right flex-shrink-0 pt-0.5">
            <div class="text-sm font-semibold text-amber-400">${f.match_count || 0}</div>
            <div class="text-xs text-gray-600">matches</div>
          </div>
        </div>
        ${renderLocations(f)}
      </div>`;
  }

  const groups = byUnit(expFindings);
  const sections = `
    <div class="mb-4 text-xs text-gray-500 leading-relaxed">
      Experimental, not-yet-finalized signals — heads-ups for upcoming migrations, not Mendix 11 breaks.
      They are excluded from this component's compatibility status and issue counts.
    </div>
    <div class="space-y-3">
      ${groups.map(u => `
        ${multiUnit ? `<div class="text-xs font-mono text-gray-500 mb-1">${u.surface === 'widget' ? '🧩 ' : ''}${esc(u.name)}${u.version ? ' v' + esc(u.version) : ''}</div>` : ''}
        ${u.findings.map(renderFinding).join('')}`).join('')}
    </div>`;

  return `
    <div id="exp-issues-split" class="flex gap-4 items-start">
      <div id="exp-findings-col" class="flex-1 min-w-0">${sections}</div>
      <div id="exp-source-col" class="hidden w-1/2 flex-shrink-0 sticky top-4"></div>
    </div>`;
}

// Open the Java source viewer for a finding location in the right-hand column.
// Highlights every line in that file that has a finding and scrolls to `line`.
// colId/splitId let the same viewer serve multiple panels (Java + Experiments)
// without duplicate DOM ids clashing.
function showJavaSource(moduleId, filePath, line, colId = 'java-source-col', splitId = 'java-findings-col') {
  const key = moduleId + '\x1f' + filePath;
  const src = _javaSources[key];
  const col = document.getElementById(colId);
  const split = document.getElementById(splitId);
  if (!col) return;

  if (src == null) {
    col.classList.remove('hidden');
    col.innerHTML = `<div class="rounded-lg border border-dark-border bg-dark-surface p-4 text-xs text-gray-500">
      Source not available for <span class="font-mono">${esc(filePath)}</span>.</div>`;
    return;
  }

  const hlLines = _javaFindingLines[key] || new Set();
  const lines = src.replace(/\r\n/g, '\n').split('\n');

  // Syntax-highlight the whole file once, then split back into lines so we can
  // wrap each in a gutter row. highlight.js keeps spans line-internal for Java.
  let highlighted;
  try {
    highlighted = hljs.highlight(src.replace(/\r\n/g, '\n'), { language: 'java' }).value.split('\n');
  } catch (e) {
    highlighted = lines.map(esc);
  }

  const rows = highlighted.map((html, i) => {
    const n = i + 1;
    const isHl = hlLines.has(n);
    return `<div class="code-line${isHl ? ' hl' : ''}" data-line="${n}">` +
      `<span class="code-gutter">${n}</span>` +
      `<span class="code-content">${html || ' '}</span></div>`;
  }).join('');

  const fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  col.classList.remove('hidden');
  if (split) split.classList.remove('flex-1'), split.classList.add('w-1/2');
  col.innerHTML = `
    <div class="rounded-lg border border-dark-border bg-dark-surface overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2 border-b border-dark-border bg-dark-bg/60">
        <span class="text-xs font-mono text-gray-300 truncate" title="${esc(filePath)}">${esc(fileName)}</span>
        <button onclick="closeJavaSource('${colId}','${splitId}')" class="text-gray-500 hover:text-gray-200 text-lg leading-none px-1">&times;</button>
      </div>
      <div class="code-viewer overflow-auto" style="max-height:calc(100vh - 8rem)">${rows}</div>
    </div>`;

  const target = col.querySelector(`.code-line[data-line="${line}"]`);
  if (target) target.scrollIntoView({ block: 'center' });
}

function closeJavaSource(colId = 'java-source-col', splitId = 'java-findings-col') {
  const col = document.getElementById(colId);
  const split = document.getElementById(splitId);
  if (col) { col.classList.add('hidden'); col.innerHTML = ''; }
  if (split) { split.classList.remove('w-1/2'); split.classList.add('flex-1'); }
}

// JavaScript-action issues panel for the component detail page. Mirrors
// buildJavaIssuesPanel: findings on the left, a clickable JS source viewer on the
// right. The rules are the shared widget rules, so severity follows the same model
// as widget JS — `certain` (removed / forbidden client API) is breaking, everything
// else (behavior changes like the async / new-string rules) is a possible break.
function buildJSActionsPanel(jsFindings) {
  if (jsFindings.length === 0) {
    return `<div class="text-center py-10">
      ${badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20')}
      <p class="text-sm text-gray-500 mt-3">No JavaScript-action compatibility issues found.</p>
    </div>`;
  }

  const multiModule = new Set(jsFindings.map(f => f.module_id)).size > 1;

  function byModule(findings) {
    const map = {};
    for (const f of findings) {
      if (!map[f.module_id]) map[f.module_id] = { name: f.module_name, version: f.module_version, findings: [] };
      map[f.module_id].findings.push(f);
    }
    return Object.values(map);
  }

  function renderFinding(f) {
    const locs = parseLocs(f.locations);
    const moduleId = f.module_id;
    const cls  = f.certain ? 'red' : 'amber';
    const borderCls = cls === 'red' ? 'border-red-500/20' : 'border-amber-500/20';
    const bgCls     = cls === 'red' ? 'bg-red-500/5'      : 'bg-amber-500/5';
    const ruleCls   = cls === 'red' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                    :                 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    const labelTxt  = f.certain ? 'certain' : 'possible';
    const labelCls  = cls === 'red' ? 'text-red-400' : 'text-amber-400';
    const numCls    = labelCls;

    return `
      <div class="rounded-lg border ${borderCls} overflow-hidden">
        <div class="px-4 py-3 ${bgCls} flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
              <span class="inline-block px-2 py-0.5 ${ruleCls} text-xs rounded border font-medium">${esc(f.rule)}</span>
              <span class="text-xs ${labelCls}">${labelTxt}</span>
            </div>
            <p class="text-xs text-gray-300 leading-relaxed">${esc(f.description)}</p>
            ${f.doc_url ? `<a href="${esc(f.doc_url)}" target="_blank" onclick="event.stopPropagation()"
               class="text-xs text-mx-blue hover:underline mt-1 inline-block">Documentation →</a>` : ''}
          </div>
          <div class="text-right flex-shrink-0 pt-0.5">
            <div class="text-sm font-semibold ${numCls}">${f.match_count || 0}</div>
            <div class="text-xs text-gray-600">matches</div>
          </div>
        </div>
        ${locs.length > 0 ? `
          <div class="px-4 py-3 border-t ${borderCls} bg-dark-bg/60">
            <div class="text-xs text-gray-600 uppercase tracking-wider mb-2">Source locations</div>
            ${buildJSLocationTree(locs, moduleId)}
          </div>` : ''}
      </div>`;
  }

  function renderSection(title, color, subset) {
    if (!subset.length) return '';
    const dot = color === 'red' ? 'bg-red-500' : 'bg-amber-500';
    const hdr = color === 'red' ? 'text-red-400' : 'text-amber-400';
    const groups = byModule(subset);
    return `
      <div class="mb-6">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-2 h-2 rounded-full ${dot}"></div>
          <h3 class="text-sm font-semibold ${hdr}">${title}</h3>
          <span class="text-xs text-gray-600">${subset.length} finding${subset.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="space-y-3">
          ${groups.map(mod => `
            ${multiModule ? `<div class="text-xs font-mono text-gray-500 mb-1">${esc(mod.name)}${mod.version ? ' v' + esc(mod.version) : ''}</div>` : ''}
            ${mod.findings.map(renderFinding).join('')}`).join('')}
        </div>
      </div>`;
  }

  const sections = `
    ${renderSection('Breaking', 'red', jsFindings.filter(f => f.certain))}
    ${renderSection('Possible / behavioral', 'amber', jsFindings.filter(f => !f.certain))}`;

  return `
    <div id="js-issues-split" class="flex gap-4 items-start">
      <div id="js-findings-col" class="flex-1 min-w-0">${sections}</div>
      <div id="js-source-col" class="hidden w-1/2 flex-shrink-0 sticky top-4"></div>
    </div>`;
}

// Open the JS-action source viewer in the right-hand column (mirror of showJavaSource).
// colId/splitId let the same viewer serve multiple panels (JS Actions + Experiments).
function showJSSource(moduleId, filePath, line, colId = 'js-source-col', splitId = 'js-findings-col') {
  const key = moduleId + '\x1f' + filePath;
  const src = _jsSources[key];
  const col = document.getElementById(colId);
  const split = document.getElementById(splitId);
  if (!col) return;

  if (src == null) {
    col.classList.remove('hidden');
    col.innerHTML = `<div class="rounded-lg border border-dark-border bg-dark-surface p-4 text-xs text-gray-500">
      Source not available for <span class="font-mono">${esc(filePath)}</span>.</div>`;
    return;
  }

  const hlLines = _jsFindingLines[key] || new Set();
  let highlighted;
  try {
    highlighted = hljs.highlight(src.replace(/\r\n/g, '\n'), { language: 'javascript' }).value.split('\n');
  } catch (e) {
    highlighted = src.replace(/\r\n/g, '\n').split('\n').map(esc);
  }

  const rows = highlighted.map((html, i) => {
    const n = i + 1;
    const isHl = hlLines.has(n);
    return `<div class="code-line${isHl ? ' hl' : ''}" data-line="${n}">` +
      `<span class="code-gutter">${n}</span>` +
      `<span class="code-content">${html || ' '}</span></div>`;
  }).join('');

  const fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  col.classList.remove('hidden');
  if (split) split.classList.remove('flex-1'), split.classList.add('w-1/2');
  col.innerHTML = `
    <div class="rounded-lg border border-dark-border bg-dark-surface overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2 border-b border-dark-border bg-dark-bg/60">
        <span class="text-xs font-mono text-gray-300 truncate" title="${esc(filePath)}">${esc(fileName)}</span>
        <button onclick="closeJSSource('${colId}','${splitId}')" class="text-gray-500 hover:text-gray-200 text-lg leading-none px-1">&times;</button>
      </div>
      <div class="code-viewer overflow-auto" style="max-height:calc(100vh - 8rem)">${rows}</div>
    </div>`;

  const target = col.querySelector(`.code-line[data-line="${line}"]`);
  if (target) target.scrollIntoView({ block: 'center' });
}

function closeJSSource(colId = 'js-source-col', splitId = 'js-findings-col') {
  const col = document.getElementById(colId);
  const split = document.getElementById(splitId);
  if (col) { col.classList.add('hidden'); col.innerHTML = ''; }
  if (split) { split.classList.remove('w-1/2'); split.classList.add('flex-1'); }
}

// -- Widget experiment matches (minified widget JS — snippets, not full source) --
//
// We never store minified widget source, so the Experiments sidebar for a widget
// shows the captured per-line snippets for the clicked file, with the matched
// global-mx token highlighted. Matches are registered per (widgetId, filePath)
// while the panel renders, then read back by showWidgetExpMatches on click.
let _widgetExpMatches = {}; // "widgetId\x1ffilePath" -> [{ line, snippet, rule }]

function registerWidgetExpMatches(widgetId, locs, rule) {
  for (const l of locs) {
    const key = widgetId + '\x1f' + l.path;
    (_widgetExpMatches[key] || (_widgetExpMatches[key] = [])).push({
      line: l.line, snippet: l.snippet || '', rule,
    });
  }
}

// Clickable file tree for widget experiment matches. Widget JS is minified, so
// clicking opens the captured snippets for that file in the side column (we never
// store the full minified source). One row per file with a (N) count, like the rest.
function buildWidgetExpLocationTree(locs, widgetId) {
  return buildFileTree(locs, {
    hasSource: () => true, // always openable — we have the snippets
    onClick: path => `showWidgetExpMatches(${widgetId}, ${jsStr(path)})`,
  });
}

// Highlight the global-mx token (window.mx.x or mx.x) inside an escaped snippet.
function highlightMxToken(escapedSnippet) {
  return escapedSnippet.replace(/\b(window\.mx\.[A-Za-z_$][\w$]*|mx\.[A-Za-z_$][\w$]*)/g,
    '<span class="bg-amber-500/25 text-amber-200 rounded px-0.5">$1</span>');
}

// Open the widget experiment matches for a file in the exp side column.
function showWidgetExpMatches(widgetId, filePath) {
  const col = document.getElementById('exp-source-col');
  const split = document.getElementById('exp-findings-col');
  if (!col) return;
  const matches = _widgetExpMatches[widgetId + '\x1f' + filePath] || [];
  const fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;

  // Minified widget JS puts every match on one line, and the ±60-char windows often
  // repeat verbatim — dedupe identical snippets and show how many times each occurs.
  const bySnippet = new Map();
  for (const m of matches) {
    const s = (m.snippet || '').trim();
    bySnippet.set(s, (bySnippet.get(s) || 0) + 1);
  }
  const uniq = [...bySnippet.entries()];

  const rows = uniq.length
    ? uniq.map(([snip, n]) => `
        <div class="px-3 py-2 border-b border-dark-border last:border-0">
          ${n > 1 ? `<div class="text-xs text-gray-500 mb-1">×${n}</div>` : ''}
          <pre class="text-xs text-gray-300 whitespace-pre-wrap break-all">${snip ? highlightMxToken(esc(snip)) : '<span class="text-gray-600">(no snippet)</span>'}</pre>
        </div>`).join('')
    : `<div class="p-4 text-xs text-gray-500">No snippet captured.</div>`;

  col.classList.remove('hidden');
  if (split) split.classList.remove('flex-1'), split.classList.add('w-1/2');
  col.innerHTML = `
    <div class="rounded-lg border border-dark-border bg-dark-surface overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2 border-b border-dark-border bg-dark-bg/60">
        <span class="text-xs font-mono text-gray-300 truncate" title="${esc(filePath)}">${esc(fileName)} · ${uniq.length} unique · ${matches.length} match${matches.length !== 1 ? 'es' : ''}</span>
        <button onclick="closeJSSource('exp-source-col','exp-findings-col')" class="text-gray-500 hover:text-gray-200 text-lg leading-none px-1">&times;</button>
      </div>
      <div class="overflow-auto" style="max-height:calc(100vh - 8rem)">${rows}</div>
    </div>`;
}

// -- Widget finding matches (minified widget JS — snippets, not full source) -----
//
// Same model as the widget experiment matches: widget JS is minified so we never
// store full source, only a short snippet per hit. Keyed by (rule, filePath) so a
// widget detail page with multiple findings keeps them separate. Populated while
// renderWidgetDetail builds the finding trees, read back by showWidgetFindingMatches.
let _widgetFindingMatches = {}; // "rule\x1ffilePath" -> [{ line, snippet }]

function registerWidgetFindingMatches(rule, locs) {
  for (const l of locs) {
    const key = rule + '\x1f' + l.path;
    (_widgetFindingMatches[key] || (_widgetFindingMatches[key] = [])).push({
      line: l.line, snippet: l.snippet || '',
    });
  }
}

// Clickable file tree for a widget finding's locations. Like the experiment tree,
// every file is openable (we always have the captured snippets). rule is passed
// through the click handler so the sidebar looks up the right match set.
function buildWidgetFindingLocationTree(locs, rule) {
  return buildFileTree(locs, {
    hasSource: () => true,
    onClick: path => `showWidgetFindingMatches(${jsStr(rule)}, ${jsStr(path)})`,
  });
}

// Open a widget finding's captured snippets for a file in the wf-source column.
// Mirrors showWidgetExpMatches: dedupes identical minified snippets with a ×N count.
// Each snippet window is centered on a match, so no separate token highlight is
// needed (unlike global-mx, we don't persist the matched literal per location).
function showWidgetFindingMatches(rule, filePath) {
  const col = document.getElementById('wf-source-col');
  const split = document.getElementById('wf-findings-col');
  if (!col) return;
  const matches = _widgetFindingMatches[rule + '\x1f' + filePath] || [];
  const fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;

  const bySnippet = new Map();
  for (const m of matches) {
    const s = (m.snippet || '').trim();
    bySnippet.set(s, (bySnippet.get(s) || 0) + 1);
  }
  const uniq = [...bySnippet.entries()];

  const rows = uniq.length
    ? uniq.map(([snip, n]) => `
        <div class="px-3 py-2 border-b border-dark-border last:border-0">
          ${n > 1 ? `<div class="text-xs text-gray-500 mb-1">×${n}</div>` : ''}
          <pre class="text-xs text-gray-300 whitespace-pre-wrap break-all">${snip ? esc(snip) : '<span class="text-gray-600">(no snippet)</span>'}</pre>
        </div>`).join('')
    : `<div class="p-4 text-xs text-gray-500">No snippet captured.</div>`;

  col.classList.remove('hidden');
  if (split) split.classList.remove('flex-1'), split.classList.add('w-1/2');
  col.innerHTML = `
    <div class="rounded-lg border border-dark-border bg-dark-surface overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2 border-b border-dark-border bg-dark-bg/60">
        <span class="text-xs font-mono text-gray-300 truncate" title="${esc(filePath)}">${esc(fileName)} · ${uniq.length} unique · ${matches.length} match${matches.length !== 1 ? 'es' : ''}</span>
        <button onclick="closeJSSource('wf-source-col','wf-findings-col')" class="text-gray-500 hover:text-gray-200 text-lg leading-none px-1">&times;</button>
      </div>
      <div class="overflow-auto" style="max-height:calc(100vh - 8rem)">${rows}</div>
    </div>`;
}

// Directory-grouped tree for JS actions (mirror of buildLocationTree), linking to
// showJSSource when the file's source is available. colId/splitId let the same tree
// target either the JS Actions viewer or the Experiments viewer.
function buildJSLocationTree(locs, moduleId, colId = 'js-source-col', splitId = 'js-findings-col') {
  return buildFileTree(locs, {
    hasSource: path => moduleId != null && _jsSources[moduleId + '\x1f' + path] != null,
    onClick: (path, line) => `showJSSource(${moduleId}, ${jsStr(path)}, ${line}, '${colId}', '${splitId}')`,
  });
}

// Parse the locations blob from getComponentJavaFindings into [{path, line}]
function parseLocs(raw) {
  if (!raw) return [];
  return raw.split('\x1e').filter(Boolean).map(l => {
    const idx = l.lastIndexOf('~');
    return idx >= 0 ? { path: l.slice(0, idx), line: l.slice(idx + 1) } : { path: l, line: '' };
  });
}

// Parse experiment locations packed as path~line~snippet (snippet may be empty
// and may itself contain '~', so split on the first two separators only).
function parseExpLocs(raw) {
  if (!raw) return [];
  return raw.split('\x1e').filter(Boolean).map(l => {
    const i1 = l.indexOf('~');
    if (i1 < 0) return { path: l, line: '', snippet: '' };
    const i2 = l.indexOf('~', i1 + 1);
    if (i2 < 0) return { path: l.slice(0, i1), line: l.slice(i1 + 1), snippet: '' };
    return { path: l.slice(0, i1), line: l.slice(i1 + 1, i2), snippet: l.slice(i2 + 1) };
  });
}

// Render locations as a directory-grouped tree, one row per file with a match count.
// When moduleId is given and source is available, each file links into the source
// viewer scrolled to the first match (every matched line stays highlighted).
function buildLocationTree(locs, moduleId, colId = 'java-source-col', splitId = 'java-findings-col') {
  return buildFileTree(locs, {
    hasSource: path => moduleId != null && _javaSources[moduleId + '\x1f' + path] != null,
    onClick: (path, line) => `showJavaSource(${moduleId}, ${jsStr(path)}, ${line}, '${colId}', '${splitId}')`,
  });
}

// Shared file-level tree renderer. Collapses locations to ONE row per file with a
// (N) match count — no per-line rows or line numbers (they add noise, and are
// meaningless for minified JS). opts.hasSource(path) decides clickability; the
// first location's line per file is the scroll target passed to opts.onClick.
function buildFileTree(locs, opts) {
  if (!locs || !locs.length) return '';
  const dirs = {};
  const count = {};      // path -> match count
  const firstLine = {};  // path -> first line seen (scroll target)
  for (const loc of locs) {
    if (count[loc.path] == null) {
      count[loc.path] = 0;
      firstLine[loc.path] = parseInt(loc.line, 10) || 0;
      const slash = loc.path.lastIndexOf('/');
      const dir  = slash >= 0 ? loc.path.slice(0, slash) : '';
      const file = slash >= 0 ? loc.path.slice(slash + 1) : loc.path;
      (dirs[dir] || (dirs[dir] = [])).push({ file, path: loc.path });
    }
    count[loc.path]++;
  }
  return `<div class="font-mono text-xs space-y-0.5">
    ${Object.entries(dirs).sort(([a],[b]) => a.localeCompare(b)).map(([dir, files]) => `
      ${dir ? `<div class="text-gray-500 mt-1.5 first:mt-0">${esc(dir)}/</div>` : ''}
      ${files.map((f, i) => {
        const clickable = opts.hasSource(f.path);
        const n = count[f.path];
        const inner = `<span class="${clickable ? 'text-mx-blue group-hover:underline' : 'text-gray-300'}">${esc(f.file)}</span><span class="text-gray-600"> (${n})</span>`;
        return `
        <div class="flex items-baseline gap-2 ${dir ? 'pl-4' : ''}">
          <span class="text-gray-700 select-none">${i === files.length - 1 ? '└' : '├'}</span>
          ${clickable
            ? `<a class="group cursor-pointer" onclick="${opts.onClick(f.path, firstLine[f.path])}">${inner}</a>`
            : inner}
        </div>`;
      }).join('')}`).join('')}
  </div>`;
}

// =============================================================================
// Widgets view
// =============================================================================

let widgetFilters = { status: null, type: null };

function renderWidgets() {
  const widgets = dbLayer.getWidgets(widgetFilters);

  const breakingCount   = widgets.filter(w => w.broken_always || w.breaks116).length;
  const warningCount    = widgets.filter(w => !w.broken_always && !w.breaks116 && w.issue_count > 0).length;
  const compatibleCount = widgets.filter(w => w.issue_count === 0).length;

  const filterBar = `
    <div class="flex flex-wrap gap-2 mb-4">
      ${[['All', null], ['Breaking', 'breaking'], ['Warning', 'warning'], ['Compatible', 'compatible']].map(([label, val]) => {
        const count = val === 'breaking' ? breakingCount : val === 'warning' ? warningCount : val === 'compatible' ? compatibleCount : widgets.length;
        const active = widgetFilters.status === val;
        const cls = val === 'breaking' ? 'text-red-400' : val === 'warning' ? 'text-amber-400' : val === 'compatible' ? 'text-green-400' : 'text-gray-400';
        return `<button onclick="setWidgetFilter('status', ${val === null ? 'null' : `'${val}'`})"
                  class="filter-btn ${active ? 'active' : ''}">
                  ${label} <span class="${cls} ml-1">${count}</span>
                </button>`;
      }).join('')}
      <div class="ml-2 flex gap-1">
        <span class="text-xs text-gray-500 self-center">Type:</span>
        ${[['All', null], ['React', 'React'], ['Dojo', 'Dojo']].map(([label, val]) => {
          const active = widgetFilters.type === val;
          return `<button onclick="setWidgetFilter('type', ${val === null ? 'null' : `'${val}'`})"
                    class="filter-btn ${active ? 'active' : ''}">${label}</button>`;
        }).join('')}
      </div>
    </div>`;

  const rows = widgets.map(w => `
    <tr class="hover:bg-dark-hover cursor-pointer transition-colors"
        onclick="navigateTo('widget', '${w.id}')">
      <td class="px-4 py-3">
        <div class="text-sm font-medium text-white">${esc(w.display_name || w.name)}</div>
        <div class="text-xs text-gray-500">${esc(w.name)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-gray-400">
        <a class="text-mx-blue hover:underline" onclick="event.stopPropagation(); navigateTo('component', '${w.component_marketplace_id}')">
          ${esc(w.component_name)}
        </a>
        <div class="mt-0.5">${contentTypeBadge(w.component_content_type)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-gray-400">${esc(w.version || '—')}</td>
      <td class="px-4 py-3">${widgetTypeBadge(w.type)}</td>
      <td class="px-4 py-3">${findingBadges(w.findings)}</td>
      <td class="px-4 py-3">${statusBadge(w.broken_always, w.breaks116, w.issue_count)}</td>
    </tr>`).join('');

  const html = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">Widgets</h2>
        <p class="text-gray-400 text-sm mt-1">${widgets.length} widget${widgets.length !== 1 ? 's' : ''} across all components</p>
      </div>
      ${filterBar}
      ${card(`
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>${th('Widget')}${th('Component')}${th('Version')}${th('Type')}${th('Findings')}${th('Status')}</tr></thead>
          <tbody class="divide-y divide-dark-border">
            ${rows || '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">No widgets match filters</td></tr>'}
          </tbody>
        </table>
      `)}
    </div>`;

  document.getElementById('widgets-view').innerHTML = html;
  showView('widgets-view');
}

function setWidgetFilter(key, value) {
  widgetFilters[key] = value;
  renderWidgets();
}

// =============================================================================
// Widget detail
// =============================================================================


function renderWidgetDetail(widgetId) {
  const widget = dbLayer.getWidgetDetail(widgetId);
  if (!widget) { IS_PUBLIC_REPORT ? renderPublicLanding() : renderComponentCategory('widgets'); return; }

  const findings = dbLayer.getWidgetFindings(widgetId);
  const variants = dbLayer.getWidgetVariants(widgetId);

  const variantGroups = [];
  const seen = new Map();
  for (const row of variants) {
    if (!seen.has(row.group_id)) { seen.set(row.group_id, { title: row.title, members: [] }); variantGroups.push(seen.get(row.group_id)); }
    if (row.id !== widgetId) seen.get(row.group_id).members.push(row);
  }

  const canonicalId = widget.widget_id || widget.name;
  const activeFindings = findings.filter(f => !f.suppressed);

  // Fresh per-rule snippet store for this widget (populated as we render the finding
  // cards below, read back by showWidgetFindingMatches on click).
  _widgetFindingMatches = {};

  // Each finding renders as a card (rule badge + category + description + match
  // count) with a clickable source-location tree, mirroring the Experiments panel.
  // Clicking a file opens its captured snippets in the right-hand side column.
  const findingCards = activeFindings.map(f => {
    const [bg, text] = findingCategoryColor(f.category);
    const locs = parseExpLocs(f.locations);
    if (locs.length) registerWidgetFindingMatches(f.rule, locs);
    const tree = locs.length ? buildWidgetFindingLocationTree(locs, f.rule) : '';
    return `
      <div class="rounded-lg border border-dark-border overflow-hidden">
        <div class="px-4 py-3 bg-dark-bg/30 flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
              <span class="inline-block px-2 py-0.5 ${bg} ${text} text-xs rounded border border-current/20 font-medium">${esc(f.rule)}</span>
              <span class="text-xs text-gray-500">${esc(f.category)}</span>
            </div>
            <p class="text-xs text-gray-300 leading-relaxed">${esc(f.description)}</p>
            <div class="flex items-center gap-3 mt-1.5">
              ${f.doc_url ? `<a href="${esc(f.doc_url)}" target="_blank" class="text-xs text-mx-blue hover:underline">Documentation →</a>` : ''}
              ${typeof _suppressButton === 'function' ? _suppressButton(canonicalId, f.rule, widget.component_name || '') : ''}
            </div>
          </div>
          <div class="text-right flex-shrink-0 pt-0.5">
            <div class="text-sm font-semibold text-gray-300">${f.match_count > 0 ? f.match_count : '—'}</div>
            <div class="text-xs text-gray-600">matches</div>
          </div>
        </div>
        ${tree ? `
          <div class="px-4 py-3 border-t border-dark-border bg-dark-bg/60">
            <div class="text-xs text-gray-600 uppercase tracking-wider mb-2">Source locations</div>
            ${tree}
          </div>` : ''}
      </div>`;
  }).join('');

  const html = `
    <div class="p-6">
      <div class="mb-4">
        <a href="#" onclick="navigateTo('component', '${widget.component_marketplace_id}'); return false;"
           class="text-mx-blue hover:text-mx-blue/80 text-sm inline-flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
          Back to ${esc(widget.component_name)}
        </a>
      </div>

      ${card(`
        <div class="p-5">
          <div class="flex items-start justify-between mb-3">
            <div>
              <h2 class="text-xl font-semibold text-white">${esc(widget.display_name || widget.name)}</h2>
              <p class="text-sm text-gray-500 mt-0.5">${esc(widget.name)}</p>
            </div>
            ${statusBadge(widget.broken_always, widget.breaks116, widget.issue_count)}
          </div>
          <div class="flex flex-wrap gap-3 text-sm text-gray-400">
            ${widgetTypeBadge(widget.type)}
            ${widget.version ? `<span><span class="text-gray-500">Version:</span> ${esc(widget.version)}</span>` : ''}
            ${widget.bundled_in_module ? `<span class="text-gray-500 italic text-xs">bundled in module</span>` : ''}
            <span><span class="text-gray-500">Component:</span>
              <a onclick="navigateTo('component', '${widget.component_marketplace_id}')"
                 class="text-mx-blue hover:underline cursor-pointer ml-1">${esc(widget.component_name)}</a>
            </span>
          </div>
          ${variantGroups.map(g => `
            <div class="mt-3 text-xs text-gray-500">
              ${esc(g.title)}:
              ${g.members.map(m => `<a onclick="navigateTo('widget', '${m.id}')"
                class="text-mx-blue hover:underline cursor-pointer ml-1">${esc(m.display_name || m.name)}</a>`).join('')}
            </div>`).join('')}
        </div>
      `)}

      ${activeFindings.length > 0 ? `
        <div class="mt-4">
          <h3 class="text-base font-semibold text-white mb-3">Findings (${activeFindings.length})</h3>
          <div id="wf-issues-split" class="flex gap-4 items-start">
            <div id="wf-findings-col" class="flex-1 min-w-0 space-y-3">${findingCards}</div>
            <div id="wf-source-col" class="hidden w-1/2 flex-shrink-0 sticky top-4"></div>
          </div>
        </div>` : `
        <div class="mt-4 p-6 text-center text-green-400">
          <p class="text-sm font-medium">No compatibility issues found</p>
        </div>`}
    </div>`;

  document.getElementById('widget-detail-view').innerHTML = html;
  showView('widget-detail-view');
}

// =============================================================================
// Modules view
// =============================================================================

let moduleFilters = { status: null };

function renderModules() {
  const modules = dbLayer.getModules(moduleFilters);
  const breakingCount   = modules.filter(m => m.certain_finding_count > 0).length;
  const warningCount    = modules.filter(m => m.certain_finding_count === 0 && m.total_finding_count > 0).length;
  const compatibleCount = modules.filter(m => m.total_finding_count === 0).length;

  const filterBar = `
    <div class="flex gap-2 mb-4">
      ${[['All', null], ['Breaking', 'breaking'], ['Warning', 'warning'], ['Compatible', 'compatible']].map(([label, val]) => {
        const count = val === 'breaking' ? breakingCount : val === 'warning' ? warningCount : val === 'compatible' ? compatibleCount : modules.length;
        const active = moduleFilters.status === val;
        const cls = val === 'breaking' ? 'text-red-400' : val === 'warning' ? 'text-amber-400' : val === 'compatible' ? 'text-green-400' : 'text-gray-400';
        return `<button onclick="setModuleFilter('status', ${val === null ? 'null' : `'${val}'`})"
                  class="filter-btn ${active ? 'active' : ''}">
                  ${label} <span class="${cls} ml-1">${count}</span>
                </button>`;
      }).join('')}
    </div>`;

  const rows = modules.map(m => `
    <tr class="hover:bg-dark-hover cursor-pointer transition-colors"
        onclick="navigateTo('module', '${m.id}')">
      <td class="px-4 py-3">
        <div class="text-sm font-medium text-white">${esc(m.name)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-gray-400">
        <a class="text-mx-blue hover:underline" onclick="event.stopPropagation(); navigateTo('component', '${m.component_marketplace_id}')">
          ${esc(m.component_name)}
        </a>
        <div class="mt-0.5">${contentTypeBadge(m.component_content_type)}</div>
      </td>
      <td class="px-4 py-3 text-xs text-gray-400">${esc(m.version || '—')}</td>
      <td class="px-4 py-3 text-xs text-gray-400">${m.has_java ? m.java_action_count + ' actions' : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-300">${m.total_finding_count}</td>
      <td class="px-4 py-3">
        ${m.certain_finding_count > 0 ? badge('Breaking', 'bg-red-500/10 text-red-400 border-red-500/20') :
          m.total_finding_count > 0   ? badge('Warning',  'bg-amber-500/10 text-amber-400 border-amber-500/20') :
                                        badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20')}
      </td>
    </tr>`).join('');

  const html = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">Modules</h2>
        <p class="text-gray-400 text-sm mt-1">${modules.length} module${modules.length !== 1 ? 's' : ''} across all components</p>
      </div>
      ${filterBar}
      ${card(`
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>${th('Module')}${th('Component')}${th('Version')}${th('Java Actions')}${th('Findings')}${th('Status')}</tr></thead>
          <tbody class="divide-y divide-dark-border">
            ${rows || '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">No modules match filters</td></tr>'}
          </tbody>
        </table>
      `)}
    </div>`;

  document.getElementById('modules-view').innerHTML = html;
  showView('modules-view');
}

function setModuleFilter(key, value) {
  moduleFilters[key] = value;
  renderModules();
}

// =============================================================================
// Module detail
// =============================================================================

function renderModuleDetail(moduleId) {
  const mod = dbLayer.getModuleDetail(moduleId);
  if (!mod) { IS_PUBLIC_REPORT ? renderPublicLanding() : renderComponentCategory('modules'); return; }

  const findings = dbLayer.getModuleFindings(moduleId);
  const locations = dbLayer.getModuleSourceLocations(moduleId);
  const jsFindings = dbLayer.getModuleJSFindings(moduleId);
  const jsLocations = dbLayer.getModuleJSSourceLocations(moduleId);

  // Group locations by rule
  const locByRule = {};
  for (const loc of locations) {
    if (!locByRule[loc.rule]) locByRule[loc.rule] = [];
    locByRule[loc.rule].push(loc);
  }
  const jsLocByRule = {};
  for (const loc of jsLocations) {
    if (!jsLocByRule[loc.rule]) jsLocByRule[loc.rule] = [];
    jsLocByRule[loc.rule].push(loc);
  }

  // JavaScript-action findings share the widget rule catalog; a `certain` finding
  // (removed API, forbidden client API) is breaking, otherwise a possible/behavioral.
  const jsFindingRows = jsFindings.map(f => {
    const locs = jsLocByRule[f.rule] || [];
    return `
      <tr class="border-b border-dark-border last:border-0">
        <td class="px-4 py-3 align-top">
          <span class="inline-block px-2 py-0.5 ${f.certain ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'} text-xs rounded border">${esc(f.rule)}</span>
          ${f.certain ? '<span class="ml-1 text-xs text-red-400">certain</span>' : '<span class="ml-1 text-xs text-amber-400">possible</span>'}
        </td>
        <td class="px-4 py-3 text-xs text-gray-400 align-top">${esc(f.category)}</td>
        <td class="px-4 py-3 text-xs text-gray-300 align-top">${esc(f.description)}</td>
        <td class="px-4 py-3 text-xs text-gray-500 align-top">${f.match_count || '—'}</td>
        <td class="px-4 py-3 align-top">
          ${locs.length > 0 ? `<div class="space-y-0.5">${locs.slice(0, 5).map(l =>
            `<div class="text-xs text-gray-500 font-mono">${esc(l.file_path)}:${l.line_number}</div>`
          ).join('')}${locs.length > 5 ? `<div class="text-xs text-gray-600">+${locs.length - 5} more</div>` : ''}</div>` : '—'}
        </td>
      </tr>`;
  }).join('');

  const findingRows = findings.map(f => {
    const isCertain = f.certain && (f.category === 'removed-class' || f.category === 'removed-method' || f.category === 'removed-api');
    const locs = locByRule[f.rule] || [];
    return `
      <tr class="border-b border-dark-border last:border-0">
        <td class="px-4 py-3 align-top">
          <span class="inline-block px-2 py-0.5 ${isCertain ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'} text-xs rounded border">${esc(f.rule)}</span>
          ${f.certain ? '<span class="ml-1 text-xs text-red-400">certain</span>' : '<span class="ml-1 text-xs text-amber-400">possible</span>'}
        </td>
        <td class="px-4 py-3 text-xs text-gray-400 align-top">${esc(f.category)}</td>
        <td class="px-4 py-3 text-xs text-gray-300 align-top">${esc(f.description)}</td>
        <td class="px-4 py-3 text-xs text-gray-500 align-top">${f.match_count || '—'}</td>
        <td class="px-4 py-3 align-top">
          ${locs.length > 0 ? `<div class="space-y-0.5">${locs.slice(0, 5).map(l =>
            `<div class="text-xs text-gray-500 font-mono">${esc(l.file_path)}:${l.line_number}</div>`
          ).join('')}${locs.length > 5 ? `<div class="text-xs text-gray-600">+${locs.length - 5} more</div>` : ''}</div>` : '—'}
        </td>
      </tr>`;
  }).join('');

  const html = `
    <div class="p-6">
      <div class="mb-4">
        <a href="#" onclick="navigateTo('component', '${mod.component_marketplace_id}'); return false;"
           class="text-mx-blue hover:text-mx-blue/80 text-sm inline-flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
          Back to ${esc(mod.component_name)}
        </a>
      </div>

      ${card(`
        <div class="p-5">
          <div class="flex items-start justify-between mb-3">
            <h2 class="text-xl font-semibold text-white">${esc(mod.name)}</h2>
            ${(findings.length + jsFindings.length) > 0
              ? ((findings.some(f => f.certain) || jsFindings.some(f => f.certain)) ? badge('Breaking', 'bg-red-500/10 text-red-400 border-red-500/20') : badge('Warning', 'bg-amber-500/10 text-amber-400 border-amber-500/20'))
              : badge('Compatible', 'bg-green-500/10 text-green-400 border-green-500/20')}
          </div>
          <div class="flex flex-wrap gap-3 text-sm text-gray-400">
            ${mod.version ? `<span><span class="text-gray-500">Version:</span> ${esc(mod.version)}</span>` : ''}
            ${mod.has_java ? `<span><span class="text-gray-500">Java actions:</span> ${mod.java_action_count}</span>` : ''}
            ${mod.has_js ? `<span><span class="text-gray-500">JS action files:</span> ${mod.total_js_files}</span>` : ''}
            <span><span class="text-gray-500">Component:</span>
              <a onclick="navigateTo('component', '${mod.component_marketplace_id}')"
                 class="text-mx-blue hover:underline cursor-pointer ml-1">${esc(mod.component_name)}</a>
            </span>
          </div>
        </div>
      `)}

      ${findings.length > 0 ? `
        <div class="mt-4">
          <h3 class="text-base font-semibold text-white mb-3">Java API Findings (${findings.length})</h3>
          ${card(`
            <table class="min-w-full">
              <thead class="bg-dark-bg/50"><tr>${th('Rule')}${th('Category')}${th('Description')}${th('Matches')}${th('Source Locations')}</tr></thead>
              <tbody>${findingRows}</tbody>
            </table>
          `)}
        </div>` : ''}

      ${jsFindings.length > 0 ? `
        <div class="mt-4">
          <h3 class="text-base font-semibold text-white mb-3">JavaScript Action Findings (${jsFindings.length})</h3>
          <p class="text-xs text-gray-500 mb-3 max-w-3xl">Compatibility issues in the module's JavaScript actions (<span class="font-mono">javascriptsource/…/actions/*.js</span>) — the same Mendix client APIs that break in widget JS.</p>
          ${card(`
            <table class="min-w-full">
              <thead class="bg-dark-bg/50"><tr>${th('Rule')}${th('Category')}${th('Description')}${th('Matches')}${th('Source Locations')}</tr></thead>
              <tbody>${jsFindingRows}</tbody>
            </table>
          `)}
        </div>` : ''}

      ${(findings.length + jsFindings.length) === 0 ? `
        <div class="mt-4 p-6 text-center text-green-400">
          <p class="text-sm font-medium">No Java or JavaScript-action compatibility issues found</p>
        </div>` : ''}
    </div>`;

  document.getElementById('module-detail-view').innerHTML = html;
  showView('module-detail-view');
}

// =============================================================================
// Issues view
// =============================================================================

// Severity model unifying code-finding categories and health checks.
//   breaking    — certain breakage on a shipping target (removed APIs, Dojo, …)
//   deprecation — works today, removed in Mendix 12+ (deprecated APIs, mx12 facet)
//   possible    — behavioral / uncertain
//   quality     — non-compatibility quality warnings (stale, unmanaged deps, …)
const SEVERITY_META = {
  breaking:    { rank: 0, label: 'Breaking',    cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
  deprecation: { rank: 1, label: 'Deprecation', cls: 'bg-gray-400/10 text-gray-300 border-gray-400/30' },
  possible:    { rank: 2, label: 'Possible',    cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  quality:     { rank: 3, label: 'Quality',     cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
};
const SEVERITY_ORDER = ['breaking', 'deprecation', 'possible', 'quality'];
function severityBadge(sev) {
  const m = SEVERITY_META[sev] || SEVERITY_META.quality;
  return badge(m.label, m.cls);
}

// Severity of a code finding from its category. JS and Java category names are
// disjoint, so one mapping serves both. Any `removed*` category is a certain
// breakage; `deprecated*` is a Mendix-12 deprecation; everything else behavioral.
function _issueSeverity(category) {
  const cat = category || '';
  if (cat.indexOf('deprecat') === 0) return 'deprecation';
  if (cat.indexOf('removed') === 0 || cat === 'dojo-widget' || cat === 'react-client-only' || cat === 'react19-breaking') return 'breaking';
  return 'possible';
}

// What kind of problem an issue is — its technical domain, and so what expertise
// fixes it. This is one coherent question for every issue regardless of how it was
// detected (replacing the old analyzer-identity axis, where "Code vs Java" was just
// widget-vs-module — already shown under "Applies to" — and "Health" sat at a
// different altitude). The compatibility domains are deliberately split because the
// owner/fix differs: a Java runtime-API removal, a frontend/client-JS break, a CSS/
// DOM change, and a removed Mendix platform feature (e.g. App Services, removed in
// Mx10) are very different problems. Packaging/Maintenance are the non-compatibility
// concerns. Domains with no issues today still belong here so new rules slot in.
const KIND_META = {
  java:        { label: 'Java API',      cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
  frontend:    { label: 'Frontend / JS', cls: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
  styling:     { label: 'Styling / DOM', cls: 'bg-pink-500/10 text-pink-400 border-pink-500/20' },
  platform:    { label: 'Platform',      cls: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
  packaging:   { label: 'Packaging',     cls: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' },
  maintenance: { label: 'Maintenance',   cls: 'bg-slate-500/10 text-slate-400 border-slate-500/20' },
};
const KIND_ORDER = ['java', 'frontend', 'styling', 'platform', 'packaging', 'maintenance'];
function kindTag(kind) {
  const m = KIND_META[kind] || KIND_META.maintenance;
  return badge(m.label, m.cls);
}

// Per-category overrides that refine a code finding into a more specific domain
// than its source implies. Java findings default to 'java' and JS findings to
// 'frontend' (widget JS *and* JavaScript actions — the same client APIs break in
// both); a rule whose category names a platform-feature removal or a styling/DOM
// change is reclassified here. Add new categories as such rules are introduced.
const CATEGORY_KIND_OVERRIDES = {
  // e.g. 'removed-app-services': 'platform', 'styling-change': 'styling',
};
function _codeIssueKind(source, category) {
  return CATEGORY_KIND_OVERRIDES[category] || (source === 'java' ? 'java' : 'frontend');
}

// Content types an issue is relevant to ([] = all). Issues commonly span several
// types (e.g. a Java removal hits Modules, Solutions and Starter Apps alike); show
// them all (the column widens / wraps to fit).
function appliesToCell(appliesTo) {
  if (!appliesTo || !appliesTo.length) return badge('All', 'bg-gray-500/10 text-gray-400 border-gray-500/20');
  return `<div class="flex flex-wrap gap-1">${appliesTo.map(contentTypeBadge).join('')}</div>`;
}

function _splitTypes(s) { return (s || '').split(',').map(t => t.trim()).filter(Boolean).sort(); }

// React-client breakage implies Mendix 12+ breakage: the legacy Dojo client and
// its client API are removed in Mx12, so a react-client-incompatible (or Dojo)
// issue necessarily breaks Mx12 too. Mirror of report.ExpandFacets in the Go
// scanner, applied here so the report is correct even before a re-scan repopulates
// the stored facet strings.
function _expandFacets(facets) {
  return (facets.includes('react-client') && !facets.includes('mx12'))
    ? [...facets, 'mx12'] : facets;
}

// Normalized, unified issue catalog assembled from three sources: JS widget
// findings, Java module findings, and synthetic health checks. The DB is static,
// so memoize. Each issue is shaped:
//   { id, source, sourceId, title, category, severity, facets:[], description,
//     docUrl, componentCount, appliesTo:[] }
let _issueCatalog = null;
function buildIssueCatalog() {
  if (_issueCatalog) return _issueCatalog;
  const out = [];

  // Frontend (JS) issues. Widget JS and JavaScript-action findings share the same
  // rule catalog, so each rule is a single issue whose affected set is the UNION of
  // both — a module-only package that trips a forbidden API in a JS action must still
  // surface here. Keyed by finding id so the JS-action pass merges into the same row.
  const jsById = {};
  for (const f of dbLayer.getIssues()) {
    const row = {
      id: 'js-' + f.id, source: 'js', sourceId: f.id, kind: _codeIssueKind('js', f.category),
      title: f.rule, category: f.category, severity: _issueSeverity(f.category),
      facets: _expandFacets((f.facets || '').split(',').filter(Boolean)),
      description: f.description, docUrl: f.doc_url,
      componentCount: f.component_count || 0,
      appliesTo: _splitTypes(f.content_types),
      hasJSActions: false,
    };
    jsById[f.id] = row;
    out.push(row);
  }
  for (const f of dbLayer.getJSActionIssues()) {
    let row = jsById[f.id];
    if (!row) {
      // A rule that ONLY ever matched JS actions (no widget hit). Rare, but handle it.
      row = {
        id: 'js-' + f.id, source: 'js', sourceId: f.id, kind: _codeIssueKind('js', f.category),
        title: f.rule, category: f.category, severity: _issueSeverity(f.category),
        facets: _expandFacets((f.facets || '').split(',').filter(Boolean)),
        description: f.description, docUrl: f.doc_url,
        componentCount: 0, appliesTo: [], hasJSActions: false,
      };
      jsById[f.id] = row;
      out.push(row);
    }
    row.hasJSActions = true;
    row.appliesTo = [...new Set([...row.appliesTo, ..._splitTypes(f.content_types)])].sort();
  }
  // Recompute each frontend issue's affected-component count as the true union of
  // widget-affected and JS-action-affected packages (dedup by marketplace_id).
  for (const row of out) {
    if (row.source !== 'js' || !row.hasJSActions) continue;
    const mps = new Set();
    for (const it of dbLayer.getIssueAffectedWidgets(row.sourceId)) mps.add(it.marketplace_id);
    for (const it of dbLayer.getJSActionIssueAffectedModules(row.sourceId)) mps.add(it.marketplace_id);
    row.componentCount = mps.size;
  }
  for (const f of dbLayer.getJavaIssues()) {
    out.push({
      id: 'java-' + f.id, source: 'java', sourceId: f.id, kind: _codeIssueKind('java', f.category),
      title: f.rule, category: f.category, severity: _issueSeverity(f.category),
      facets: _expandFacets((f.facets || '').split(',').filter(Boolean)),
      description: f.description, docUrl: f.doc_url,
      componentCount: f.component_count || 0,
      appliesTo: _splitTypes(f.content_types),
    });
  }
  // Health checks — synthetic, no findings row. Affected set computed by predicate;
  // appliesTo is the distinct content types actually hit.
  const comps = dbLayer.getComponents().filter(c => c.support_type !== 'Deprecated');
  for (const h of HEALTH_CHECKS) {
    const affected = comps.filter(h.predicate);
    if (!affected.length) continue;
    out.push({
      id: 'health-' + h.key, source: 'health', sourceId: h.key, kind: h.kind,
      title: h.title, category: 'health', severity: h.severity,
      facets: _expandFacets(h.facets || []), description: h.description, docUrl: '',
      componentCount: affected.length,
      appliesTo: [...new Set(affected.map(c => c.content_type).filter(Boolean))].sort(),
    });
  }

  _issueCatalog = out;
  return out;
}

let issueFilters = { severities: [], kinds: [], facets: [], types: [], search: '' };
let issueSort = { by: 'severity', dir: 'asc' };

function _issuePassesFilters(i) {
  const f = issueFilters;
  if (f.severities.length && !f.severities.includes(i.severity)) return false;
  if (f.kinds.length && !f.kinds.includes(i.kind)) return false;
  if (f.facets.length && !i.facets.some(x => f.facets.includes(x))) return false;
  // Type filter: issues with no appliesTo apply to all types, so they always pass.
  if (f.types.length && i.appliesTo.length && !i.appliesTo.some(t => f.types.includes(t))) return false;
  const q = (f.search || '').trim().toLowerCase();
  if (q && !`${i.title} ${i.category}`.toLowerCase().includes(q)) return false;
  return true;
}

function _sortIssues(list) {
  const { by, dir } = issueSort;
  const sgn = dir === 'asc' ? 1 : -1;
  const val = i => by === 'severity'   ? SEVERITY_META[i.severity].rank
                 : by === 'components' ? i.componentCount
                 : i.title.toLowerCase();
  return [...list].sort((a, b) => {
    const av = val(a), bv = val(b);
    const c = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    if (c !== 0) return sgn * c;
    return b.componentCount - a.componentCount; // stable tiebreak by impact
  });
}

function _anyIssueFilter() {
  return issueFilters.severities.length || issueFilters.kinds.length
      || issueFilters.facets.length || issueFilters.types.length
      || (issueFilters.search || '').trim().length;
}
function clearIssueFilters() {
  issueFilters = { severities: [], kinds: [], facets: [], types: [], search: '' };
  renderIssues();
}
function _toggleIssueArr(key, v) {
  const a = issueFilters[key], i = a.indexOf(v);
  if (i >= 0) a.splice(i, 1); else a.push(v);
  renderIssues();
}
function toggleIssueSeverity(v) { _openCombo = 'combo-issue-sev';   _toggleIssueArr('severities', v); }
function toggleIssueKind(v)     { _openCombo = 'combo-issue-kind';  _toggleIssueArr('kinds', v); }
function toggleIssueFacet(v)    { _openCombo = 'combo-issue-facet'; _toggleIssueArr('facets', v); }
function toggleIssueType(v)     { _openCombo = 'combo-issue-type';  _toggleIssueArr('types', v); }
function setIssueSearch(v)      { issueFilters.search = v; _refreshIssueRows(); }
function setIssueSort(key) {
  if (issueSort.by === key) issueSort.dir = issueSort.dir === 'asc' ? 'desc' : 'asc';
  else issueSort = { by: key, dir: (key === 'title' || key === 'severity') ? 'asc' : 'desc' };
  renderIssues();
}

function _clearIssueBtn() {
  return _anyIssueFilter()
    ? `<button onclick="clearIssueFilters()" class="text-xs text-gray-500 hover:text-gray-200 px-2 py-1 rounded border border-dark-border hover:border-gray-500 transition-colors">Clear all</button>`
    : '';
}

function _issueRowsHtml(filtered) {
  return filtered.map(i => `
    <tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="navigateTo('issue','${i.id}')">
      <td class="px-4 py-3">${severityBadge(i.severity)}</td>
      <td class="px-4 py-3">
        <div class="text-sm text-white">${esc(i.title)}</div>
        ${i.category && i.category !== 'health' ? `<div class="text-xs text-gray-500 mt-0.5">${esc(i.category)}</div>` : ''}
      </td>
      <td class="px-4 py-3">${appliesToCell(i.appliesTo)}</td>
      <td class="px-4 py-3">${facetTags(i.facets.join(','))}</td>
      <td class="px-4 py-3">${kindTag(i.kind)}</td>
      <td class="px-4 py-3 text-sm text-gray-300">${i.componentCount}</td>
    </tr>`).join('')
    || '<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">No issues match filters</td></tr>';
}

// In-place refresh of just the rows + count, used while typing in the search box
// so the input keeps focus (mirrors the components list's _refreshComponentResults).
function _refreshIssueRows() {
  const catalog = buildIssueCatalog();
  const filtered = _sortIssues(catalog.filter(_issuePassesFilters));
  const tbody = document.getElementById('issues-tbody');
  if (tbody) tbody.innerHTML = _issueRowsHtml(filtered);
  const count = document.getElementById('issues-count');
  if (count) count.textContent = `${filtered.length} of ${catalog.length} issues`;
  const clear = document.getElementById('issues-clear-wrap');
  if (clear) clear.innerHTML = _clearIssueBtn();
}

// Teams page — lists internal teams that own scanned components, with a shortcut
// into the Components page filtered to each team. References the Content Ownership
// app so people are nudged to keep the ownership data there up to date.
function renderTeams() {
  const teams = dbLayer.getTeams();

  const ownershipRef = `
    <div class="mb-5 flex items-start gap-3 rounded-lg border border-mx-blue/20 bg-mx-blue/5 p-4">
      <svg class="w-5 h-5 flex-shrink-0 text-mx-blue mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      <div class="text-sm text-gray-300 leading-relaxed">
        Team ownership is sourced from the
        <a href="https://mxcontentownership.mendixcloud.com/" target="_blank" rel="noopener" class="text-mx-blue hover:text-mx-blue/80 font-medium underline">Content Ownership app</a>.
        If a component is unassigned or its owner looks wrong, please
        <a href="https://mxcontentownership.mendixcloud.com/" target="_blank" rel="noopener" class="text-mx-blue hover:text-mx-blue/80 font-medium underline">update it there</a>
        — this report picks up the change on the next scan.
      </div>
    </div>`;

  if (!teams.length) {
    document.getElementById('teams-view').innerHTML = `
      <div class="p-6">
        <div class="mb-5"><h2 class="text-2xl font-semibold text-white">Teams</h2></div>
        ${ownershipRef}
        <div class="text-center py-10 text-gray-500 text-sm">No internal team ownership data available in this scan.</div>
      </div>`;
    showView('teams-view');
    return;
  }

  const slackCell = t => {
    if (!t.slack_channel && !t.slack_url) return '<span class="text-gray-600">—</span>';
    const label = esc(t.slack_channel || 'Slack');
    return t.slack_url
      ? `<a href="${esc(t.slack_url)}" target="_blank" rel="noopener" class="text-mx-blue hover:text-mx-blue/80">${label}</a>`
      : `<span class="text-gray-300">${label}</span>`;
  };

  const rows = teams.map(t => {
    const breaking = t.breaking_component_count > 0
      ? `<span class="text-red-400 font-medium">${t.breaking_component_count}</span>`
      : '<span class="text-gray-500">0</span>';
    const hierarchy = [t.group_name, t.unit_name].filter(Boolean).map(esc).join(' › ') || '<span class="text-gray-600">—</span>';
    const viewHref = '#' + buildHash({ view: 'components', params: { teams: t.name } });
    return `
      <tr class="hover:bg-dark-hover transition-colors">
        <td class="px-4 py-3">
          <div class="text-sm font-medium text-white">${esc(t.name)}</div>
          ${t.jira_project ? `<div class="text-xs text-gray-500 mt-0.5">Jira: ${esc(t.jira_project)}</div>` : ''}
        </td>
        <td class="px-4 py-3 text-sm text-gray-300">${hierarchy}</td>
        <td class="px-4 py-3 text-sm">${slackCell(t)}</td>
        <td class="px-4 py-3 text-sm text-gray-200">${t.component_count}</td>
        <td class="px-4 py-3 text-sm">${breaking}</td>
        <td class="px-4 py-3 text-right">
          <a href="${viewHref}" class="inline-flex items-center gap-1 text-sm text-mx-blue hover:text-mx-blue/80">
            View components
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </a>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('teams-view').innerHTML = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">Teams</h2>
        <p class="text-gray-400 text-sm mt-1">${teams.length} internal team${teams.length !== 1 ? 's' : ''} owning scanned marketplace components</p>
      </div>
      ${ownershipRef}
      ${card(`
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>
            ${th('Team')}${th('Group / Unit')}${th('Slack')}${th('Components')}${th('Breaking')}${th('')}
          </tr></thead>
          <tbody class="divide-y divide-dark-border">${rows}</tbody>
        </table>
      `)}
    </div>`;
  showView('teams-view');
}

function renderIssues() {
  const catalog  = buildIssueCatalog();
  const types    = [...new Set(catalog.flatMap(i => i.appliesTo))].sort();
  const filtered = _sortIssues(catalog.filter(_issuePassesFilters));

  const sevCombo = _comboFilter({ id: 'combo-issue-sev', allLabel: 'All severities', selLabel: 'Severity',
    items: SEVERITY_ORDER.map(s => ({ value: s, label: SEVERITY_META[s].label })), selected: issueFilters.severities, onToggle: 'toggleIssueSeverity' });
  const presentKinds = new Set(catalog.map(i => i.kind));
  const kindCombo = _comboFilter({ id: 'combo-issue-kind', allLabel: 'All kinds', selLabel: 'Kind',
    items: KIND_ORDER.filter(k => presentKinds.has(k)).map(k => ({ value: k, label: KIND_META[k].label })), selected: issueFilters.kinds, onToggle: 'toggleIssueKind' });
  const facetCombo = _comboFilter({ id: 'combo-issue-facet', allLabel: 'All facets', selLabel: 'Facets',
    items: FACET_DEFS.map(d => ({ value: d.key, label: d.full })), selected: issueFilters.facets, onToggle: 'toggleIssueFacet' });
  const typeCombo = _comboFilter({ id: 'combo-issue-type', allLabel: 'All types', selLabel: 'Types',
    items: types.map(t => ({ value: t, label: t })), selected: issueFilters.types, onToggle: 'toggleIssueType' });

  const sortTh = (label, key) =>
    `<th onclick="setIssueSort('${key}')" class="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-200">${label}${issueSort.by === key ? (issueSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;

  document.getElementById('issues-view').innerHTML = `
    <div class="p-6">
      <div class="mb-5">
        <h2 class="text-2xl font-semibold text-white">Issues</h2>
        <p class="text-gray-400 text-sm mt-1">Compatibility &amp; quality issues across the marketplace — code findings and health checks</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap mb-4">
        <div class="relative">
          <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0"/>
          </svg>
          <input id="issue-search" type="text" placeholder="Search…" value="${esc(issueFilters.search)}" oninput="setIssueSearch(this.value)"
                 class="pl-9 pr-3 py-1.5 w-56 bg-dark-surface border border-dark-border rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/50"/>
        </div>
        ${sevCombo}
        ${kindCombo}
        ${facetCombo}
        ${typeCombo}
        <span id="issues-clear-wrap" class="ml-auto">${_clearIssueBtn()}</span>
        <span id="issues-count" class="text-xs text-gray-500">${filtered.length} of ${catalog.length} issues</span>
      </div>
      ${card(`
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>
            ${sortTh('Severity', 'severity')}
            ${sortTh('Issue', 'title')}
            ${th('Applies to')}
            ${th('Facets')}
            ${th('Kind')}
            ${sortTh('Components', 'components')}
          </tr></thead>
          <tbody id="issues-tbody" class="divide-y divide-dark-border">${_issueRowsHtml(filtered)}</tbody>
        </table>
      `)}
    </div>`;
  if (_openCombo) { const p = document.getElementById(_openCombo); if (p) p.classList.remove('hidden'); }
  showView('issues-view');
}

// Dedicated issue detail page: header + affected components ranked by impact.
function renderIssueDetail(issueId) {
  const issue = buildIssueCatalog().find(i => i.id === issueId);
  if (!issue) { renderIssues(); return; }

  // Resolve the affected components, rolling widget/module hits up to their component.
  let comps;
  if (issue.source === 'health') {
    const h = HEALTH_CHECK_BY_KEY[issue.sourceId];
    comps = dbLayer.getComponents().filter(c => c.support_type !== 'Deprecated' && h.predicate(c));
  } else {
    // Frontend (js) issues union widget hits with JavaScript-action module hits, so a
    // module-only package that only trips the rule in a JS action is still listed.
    const items = issue.source === 'java'
      ? dbLayer.getJavaIssueAffectedModules(issue.sourceId)
      : issue.source === 'js'
      ? [...dbLayer.getIssueAffectedWidgets(issue.sourceId), ...dbLayer.getJSActionIssueAffectedModules(issue.sourceId)]
      : dbLayer.getIssueAffectedWidgets(issue.sourceId);
    const byMp = {};
    for (const it of items) {
      if (!byMp[it.marketplace_id]) byMp[it.marketplace_id] = {
        name: it.component_name, marketplace_id: it.marketplace_id, content_type: it.content_type,
        support_type: it.support_type, download_count: it.download_count, prod_apps_mx10: it.prod_apps_mx10,
      };
    }
    comps = Object.values(byMp);
  }
  comps.sort((a, b) => (b.prod_apps_mx10 || 0) - (a.prod_apps_mx10 || 0)
                    || (b.download_count || 0) - (a.download_count || 0)
                    || String(a.name).localeCompare(String(b.name)));

  // Scope denominator — how many in-scope packages exist for this issue.
  const h = issue.source === 'health' ? HEALTH_CHECK_BY_KEY[issue.sourceId] : null;
  const scopePool = dbLayer.getComponents().filter(c => issue.source !== 'health' || c.support_type !== 'Deprecated');
  const domainCount = (h && h.domain) ? scopePool.filter(h.domain).length
    : issue.appliesTo.length ? scopePool.filter(c => issue.appliesTo.includes(c.content_type)).length
    : scopePool.length;
  const scopeNoun = (h && h.scopeNoun) ? h.scopeNoun
    : issue.appliesTo.length ? issue.appliesTo.join(' / ') + ' packages'
    : 'packages';

  const rows = comps.map(c => `
    <tr class="hover:bg-dark-hover cursor-pointer transition-colors" onclick="navigateTo('component','${c.marketplace_id}')">
      <td class="px-4 py-3"><div class="text-sm font-medium text-white">${esc(c.name)}</div></td>
      <td class="px-4 py-3">${contentTypeBadge(c.content_type)}</td>
      <td class="px-4 py-3">${supportBadge(c.support_type)}</td>
      <td class="px-4 py-3 text-right whitespace-nowrap">${c.prod_apps_mx10 > 0
        ? `<div class="text-white text-sm font-medium">${c.prod_apps_mx10.toLocaleString()}</div><div class="text-xs text-gray-500">prod apps</div>`
        : c.download_count > 0
        ? `<div class="text-gray-300 text-sm">${c.download_count.toLocaleString()}</div><div class="text-xs text-gray-500">downloads</div>`
        : '<span class="text-gray-600 text-xs">—</span>'}</td>
    </tr>`).join('');

  const html = `
    <div class="p-6">
      <div class="mb-4">
        <a href="#" onclick="navigateTo('issues'); return false;" class="text-mx-blue hover:text-mx-blue/80 text-sm inline-flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
          Back to Issues
        </a>
      </div>
      ${card(`
        <div class="p-5">
          <div class="flex items-start justify-between gap-3 mb-3">
            <h2 class="text-xl font-semibold text-white">${esc(issue.title)}</h2>
            ${severityBadge(issue.severity)}
          </div>
          <div class="flex flex-wrap items-center gap-1.5 mb-3">
            ${kindTag(issue.kind)}
            ${appliesToCell(issue.appliesTo)}
            ${facetTags(issue.facets.join(','))}
          </div>
          ${issue.description ? `<p class="text-sm text-gray-300">${esc(issue.description)}</p>` : ''}
          ${issue.severity === 'deprecation' ? `<p class="text-xs text-gray-400 mt-2">Compatible today — this API is deprecated and is expected to be removed in Mendix 12+.</p>` : ''}
          ${issue.docUrl ? `<a href="${esc(issue.docUrl)}" target="_blank" class="text-mx-blue text-sm hover:underline inline-flex items-center gap-1 mt-2">Documentation
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg></a>` : ''}
        </div>
      `)}
      <div class="mt-4">
        <h3 class="text-base font-semibold text-white mb-3">Affected components
          <span class="text-gray-500 font-normal text-sm">${comps.length} of ${domainCount} ${esc(scopeNoun)} — ranked by impact</span>
        </h3>
        ${card(`
          <table class="min-w-full">
            <thead class="bg-dark-bg/50"><tr>${th('Component')}${th('Type')}${th('Support')}<th class="px-4 py-3 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">Impact</th></tr></thead>
            <tbody class="divide-y divide-dark-border">
              ${rows || '<tr><td colspan="4" class="px-4 py-8 text-center text-gray-500">No affected components</td></tr>'}
            </tbody>
          </table>
        `)}
      </div>
    </div>`;

  document.getElementById('issue-detail-view').innerHTML = html;
  showView('issue-detail-view');
}

// =============================================================================
// Packaging — add-on modules, Studio Pro extensions and solutions
// =============================================================================
//
// Three pages over the same rows, split by how a component is delivered. The
// classification is computed during the scan (pkg/modules/packaging.go) and
// stored on components.distribution_type; the helpers here only present it.
//
// The vocabulary, since the Marketplace listing says none of it:
//   • add-on module      — model ships Protected: consumers can call it but not
//                          open it. Exported as .mxmodule.
//   • Studio Pro extension — an IDE plugin (extensions/<name>/). Mendix packages
//                          these *as* add-on modules, so most add-ons are these.
//   • solution           — a whole app sold to customers, exported .mxsolution;
//                          "solution module" is the module type used inside one.

// Module kind → badge. Mirrors ModuleSettingsInfo.Kind() in
// pkg/modules/packaging.go — change one, change the other.
const PKG_KIND_META = {
  'add-on':     { label: 'Add-on',     cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  'solution':   { label: 'Solution',   cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  'app-module': { label: 'App module', cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40' },
};

const PKG_DIST_META = {
  'add-on':           { label: 'Add-on module',       cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  'add-on-extension': { label: 'Add-on + extension',  cls: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' },
  'extension-source': { label: 'Extension, unprotected', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  'solution':         { label: 'Solution package',    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  'regular':          { label: 'Regular module/app',  cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40' },
};

const PKG_FORMAT_META = {
  mxmodule:   { label: '.mxmodule',   cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  mxsolution: { label: '.mxsolution', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  mpk:        { label: '.mpk',        cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40' },
};

// Kind of a single module's export settings. Must agree with the Go side.
function _pkgModuleKind(s) {
  if (s.protected_module_type === 'Solution') return 'solution';
  if (s.export_level === 'Protected') return 'add-on';
  return 'app-module';
}

function pkgKindBadge(kind) {
  const m = PKG_KIND_META[kind] || PKG_KIND_META['app-module'];
  return `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${m.cls}">${m.label}</span>`;
}

function pkgDistBadge(dist) {
  const m = PKG_DIST_META[dist] || PKG_DIST_META['regular'];
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${m.cls}">${m.label}</span>`;
}

function pkgFormatBadge(format, fileName) {
  if (!format) return '<span class="text-gray-600">—</span>';
  const m = PKG_FORMAT_META[format] || { label: '.' + format, cls: PKG_FORMAT_META.mpk.cls };
  const title = fileName ? ` title="${esc(fileName)}"` : '';
  return `<span${title} class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono border ${m.cls}">${m.label}</span>`;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

let _pkgRowCache = null;

// One row per component with a packaging signal, with its modules' export
// settings flattened and de-duplicated (a component can ship several packages,
// and a bundled add-on appears once per package that carries it).
function packagingRows() {
  if (_pkgRowCache) return _pkgRowCache;
  const comps = dbLayer.getPackagingComponents();
  const byComp = {};
  for (const m of dbLayer.getPackagingModules()) (byComp[m.component_id] = byComp[m.component_id] || []).push(m);

  _pkgRowCache = comps.map(c => {
    const mods = byComp[c.id] || [];
    const seen = new Set();
    const settings = [];
    const nested = [];
    for (const m of mods) {
      for (const s of _parseJSON(m.package_modules_json)) {
        const key = (s.name || '?') + '\x1f' + (s.source || '');
        if (seen.has(key)) continue;
        seen.add(key);
        settings.push(Object.assign({ package: m.name, kind: _pkgModuleKind(s) }, s));
      }
      for (const n of _parseJSON(m.nested_packages_json)) nested.push(n);
    }
    const extensions = _parseJSON(c.extension_names_json);
    return {
      id: c.id,
      marketplaceId: c.marketplace_id,
      name: c.name,
      publisher: c.publisher || '',
      support: c.support_type || '',
      contentType: c.content_type || '',
      minMx: c.min_mx_version || '',
      downloads: c.download_count || 0,
      lastPublish: c.last_publish_date || '',
      permalink: c.permalink || '',
      team: c.owning_team || '',
      dist: c.distribution_type || 'regular',
      packageFile: c.package_file_name || '',
      packageFormat: c.package_format || '',
      developers: parseDevelopers(c.developers_json).map(d => d.name).filter(Boolean),
      settings,
      nested,
      extensions,
      addOnModules: settings.filter(s => s.kind === 'add-on'),
      solutionModules: settings.filter(s => s.kind === 'solution'),
      moduleCount: settings.length,
    };
  });
  return _pkgRowCache;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const PACKAGING_PAGES = {
  addons: {
    viewId: 'addons-view',
    title: 'Add-on Modules',
    lead: 'Components that ship at least one IP-protected module',
    blurb: `An <strong>add-on module</strong> ships with its model compiled: consumers can call the elements
      marked <em>Usable</em>, but cannot open or edit them. That is what "IP protection" means in the artifact,
      and it is recorded as <code class="text-gray-300">ExportLevel = Protected</code> in Module Settings.
      Note that the <em>module type</em> field alone cannot be trusted — it stores "AddOn" by default on
      ordinary app modules too.`,
    // The bucket decides the badge, but a component that ships a protected module
    // belongs here even when its bucket says something else (a solution package
    // that also bundles add-ons, say).
    match: r => r.dist === 'add-on' || r.dist === 'add-on-extension' || r.addOnModules.length > 0,
    metric: r => r.addOnModules.length,
    metricLabel: 'Add-on modules',
  },
  extensions: {
    viewId: 'extensions-view',
    title: 'Studio Pro Extensions',
    lead: 'Components shipping an IDE extension (extensions/<name>)',
    blurb: `A <strong>Studio Pro extension</strong> is a plugin for the IDE itself, not app functionality.
      Mendix's documented way to distribute one is to package it <em>as an add-on module</em>, so extension
      delivery rides on the same mechanism — deprecating add-on modules takes this path with it.
      A few components ship an extension inside an ordinary source module instead, which is possible but
      unprotected.`,
    match: r => r.extensions.length > 0,
    metric: r => r.extensions.length,
    metricLabel: 'Extensions',
  },
  solutions: {
    viewId: 'solutions-view',
    title: 'Solutions',
    lead: 'Solution packages (.mxsolution) and components declaring solution modules',
    blurb: `A <strong>solution</strong> is a whole app sold to multiple customers, exported as
      <code class="text-gray-300">.mxsolution</code>; a <strong>solution module</strong> is the module type
      used inside one. This is unrelated to the Marketplace's own "Solution" content type, which is a listing
      category — the one real <code class="text-gray-300">.mxsolution</code> in the Marketplace is filed
      under "Sample".`,
    match: r => r.dist === 'solution' || r.solutionModules.length > 0,
    metric: r => r.solutionModules.length,
    metricLabel: 'Solution modules',
  },
};

// Filter/sort state, shared by the three pages and mirrored into the URL so a
// filtered view can be pasted to someone else.
let _pkgFilters = { q: '', support: [], sort: 'downloads' };
let _pkgPage = 'addons';

function _pkgSyncURL() {
  const params = {};
  if (_pkgFilters.q.trim()) params.q = _pkgFilters.q.trim();
  if (_pkgFilters.support.length) params.support = _pkgFilters.support.join(',');
  if (_pkgFilters.sort !== 'downloads') params.sort = _pkgFilters.sort;
  history.replaceState(null, '', '#' + buildHash({ view: _pkgPage, params }));
}

function _pkgApplyParams(params) {
  _pkgFilters.q = params.q || '';
  _pkgFilters.support = params.support ? params.support.split(',').filter(Boolean) : [];
  _pkgFilters.sort = params.sort || 'downloads';
}

function setPackagingSearch(v) {
  _pkgFilters.q = v;
  _pkgSyncURL();
  _pkgRenderResults();
}

function togglePackagingSupport(v) {
  const i = _pkgFilters.support.indexOf(v);
  if (i >= 0) _pkgFilters.support.splice(i, 1); else _pkgFilters.support.push(v);
  _pkgSyncURL();
  renderPackagingPage(_pkgPage);
}

function setPackagingSort(v) {
  _pkgFilters.sort = v;
  _pkgSyncURL();
  renderPackagingPage(_pkgPage);
}

function clearPackagingFilters() {
  _pkgFilters = { q: '', support: [], sort: 'downloads' };
  _pkgSyncURL();
  renderPackagingPage(_pkgPage);
}

function _pkgFiltered(pageKey) {
  const page = PACKAGING_PAGES[pageKey];
  const q = _pkgFilters.q.trim().toLowerCase();
  let rows = packagingRows().filter(page.match);
  if (_pkgFilters.support.length) rows = rows.filter(r => _pkgFilters.support.includes(r.support));
  if (q) {
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.publisher.toLowerCase().includes(q) ||
      r.marketplaceId.includes(q) ||
      r.extensions.some(e => e.toLowerCase().includes(q)) ||
      r.settings.some(s => (s.name || '').toLowerCase().includes(q)));
  }
  const sorters = {
    downloads: (a, b) => b.downloads - a.downloads,
    name: (a, b) => a.name.localeCompare(b.name),
    publisher: (a, b) => a.publisher.localeCompare(b.publisher) || b.downloads - a.downloads,
    published: (a, b) => (b.lastPublish || '').localeCompare(a.lastPublish || ''),
    minmx: (a, b) => dbLayer.compareVersions(a.minMx, b.minMx) || b.downloads - a.downloads,
  };
  return rows.slice().sort(sorters[_pkgFilters.sort] || sorters.downloads);
}

function renderAddons()     { renderPackagingPage('addons'); }
function renderExtensions() { renderPackagingPage('extensions'); }
function renderSolutions()  { renderPackagingPage('solutions'); }

function renderPackagingPage(pageKey) {
  const page = PACKAGING_PAGES[pageKey];
  _pkgPage = pageKey;

  if (!dbLayer.hasPackagingData()) {
    document.getElementById(page.viewId).innerHTML = `
      <div class="p-6">
        <h2 class="text-2xl font-semibold text-white">${page.title}</h2>
        <div class="text-center py-10 text-gray-500 text-sm">
          This report predates packaging analysis. Re-run the scan to populate it.
        </div>
      </div>`;
    showView(page.viewId);
    return;
  }

  const all = packagingRows().filter(page.match);
  const rows = _pkgFiltered(pageKey);
  const supportTypes = [...new Set(all.map(r => r.support).filter(Boolean))].sort();

  const kpi = (label, value, sub) => `
    <div class="bg-dark-surface border border-dark-border rounded-lg p-4">
      <div class="text-2xl font-semibold text-white">${value}</div>
      <div class="text-xs text-gray-400 mt-1">${label}</div>
      ${sub ? `<div class="text-[11px] text-gray-500 mt-1">${sub}</div>` : ''}
    </div>`;

  const totalDownloads = all.reduce((s, r) => s + r.downloads, 0);
  const publishers = new Set(all.map(r => r.publisher).filter(Boolean));
  const external = new Set(all.filter(r => !['Mendix', 'Siemens'].includes(r.publisher)).map(r => r.publisher).filter(Boolean));
  const unitCount = all.reduce((s, r) => s + page.metric(r), 0);

  const kpis = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
      ${kpi('Components', all.length, `<span id="packaging-shown-count">${rows.length !== all.length ? `${rows.length} shown` : ''}</span>`)}
      ${kpi(page.metricLabel, unitCount, '')}
      ${kpi('Downloads', totalDownloads.toLocaleString(), 'across these components')}
      ${kpi('Publishers', publishers.size, `${external.size} outside Mendix/Siemens`)}
    </div>`;

  const supportChips = supportTypes.map(s => {
    const on = _pkgFilters.support.includes(s);
    return `<button onclick="togglePackagingSupport(${jsStr(s)})"
      class="px-2.5 py-1 rounded-md text-xs border transition-colors ${on
        ? 'bg-mx-blue/20 border-mx-blue/50 text-white'
        : 'bg-dark-bg/40 border-dark-border text-gray-400 hover:text-gray-200'}">${esc(s)}</button>`;
  }).join('');

  const anyFilter = _pkgFilters.q.trim() || _pkgFilters.support.length || _pkgFilters.sort !== 'downloads';

  const filterBar = `
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <input type="search" value="${esc(_pkgFilters.q)}" oninput="setPackagingSearch(this.value)"
        placeholder="Search component, publisher, module or extension…"
        class="flex-1 min-w-[240px] bg-dark-surface border border-dark-border rounded-md px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-mx-blue/50">
      ${supportChips}
      <select onchange="setPackagingSort(this.value)"
        class="bg-dark-surface border border-dark-border rounded-md px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-mx-blue/50">
        <option value="downloads" ${_pkgFilters.sort === 'downloads' ? 'selected' : ''}>Most downloaded</option>
        <option value="name"      ${_pkgFilters.sort === 'name' ? 'selected' : ''}>Name</option>
        <option value="publisher" ${_pkgFilters.sort === 'publisher' ? 'selected' : ''}>Publisher</option>
        <option value="published" ${_pkgFilters.sort === 'published' ? 'selected' : ''}>Last published</option>
        <option value="minmx"     ${_pkgFilters.sort === 'minmx' ? 'selected' : ''}>Minimum Mendix version</option>
      </select>
      <button onclick="exportPackagingCSV('${pageKey}')"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-dark-border bg-dark-bg/40 text-gray-200 hover:text-white hover:border-mx-blue/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg>
        Export CSV
      </button>
      ${anyFilter ? `<button onclick="clearPackagingFilters()" class="px-2.5 py-1 rounded-md text-xs border border-dark-border text-gray-400 hover:text-gray-200">Clear</button>` : ''}
    </div>`;

  const body = _pkgTableHTML(pageKey, rows);

  document.getElementById(page.viewId).innerHTML = `
    <div class="p-6">
      <div class="mb-4">
        <h2 class="text-2xl font-semibold text-white">${page.title}</h2>
        <p class="text-gray-400 text-sm mt-1">${esc(page.lead)} · ${all.length} component${all.length !== 1 ? 's' : ''}</p>
      </div>
      <div class="mb-5 flex items-start gap-3 rounded-lg border border-mx-blue/20 bg-mx-blue/5 p-4">
        <svg class="w-5 h-5 flex-shrink-0 text-mx-blue mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <div class="text-sm text-gray-300 leading-relaxed">${page.blurb}</div>
      </div>
      ${kpis}
      ${filterBar}
      <div id="packaging-results">${body}</div>
    </div>`;
  showView(page.viewId);
}

// The column that carries what each page is actually about.
const _PKG_FOCUS_LABEL = {
  addons: 'Protected modules',
  extensions: 'Extensions',
  solutions: 'Solution modules',
};

// The results table. The "focus" column shows what the page is about: the
// extensions it ships, the solution modules it declares, or the protected
// modules behind the classification.
function _pkgTableHTML(pageKey, rows) {
  if (rows.length === 0) {
    return `<div class="text-center py-10 text-gray-500 text-sm">No components match these filters.</div>`;
  }
  return card(`
    <table class="min-w-full">
      <thead class="bg-dark-bg/50"><tr>
        ${th('Component')}${th('Publisher')}${th('Support')}${th('Delivery')}
        ${th(_PKG_FOCUS_LABEL[pageKey] || 'Protected modules')}
        ${th('Package file')}${th('Min Mx')}${th('Downloads')}${th('Last published')}
      </tr></thead>
      <tbody class="divide-y divide-dark-border">${rows.map(r => _pkgRow(r, pageKey)).join('')}</tbody>
    </table>`);
}

// Re-render only the table after a keystroke, so the search box keeps focus.
function _pkgRenderResults() {
  const host = document.getElementById('packaging-results');
  if (!host) return;
  host.innerHTML = _pkgTableHTML(_pkgPage, _pkgFiltered(_pkgPage));
  const count = document.getElementById('packaging-shown-count');
  if (count) {
    const total = packagingRows().filter(PACKAGING_PAGES[_pkgPage].match).length;
    const shown = _pkgFiltered(_pkgPage).length;
    count.textContent = shown === total ? '' : `${shown} shown`;
  }
}

function _pkgRow(r, pageKey) {
  const href = '#' + buildHash({ view: 'component', id: r.marketplaceId, params: { selectedTab: 'structure' } });

  const focus = pageKey === 'extensions'
    ? (r.extensions.length
        ? r.extensions.map(e => `<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-dark-bg/60 border border-dark-border text-gray-300">${esc(e)}</span>`).join(' ')
        : '<span class="text-gray-600">—</span>')
    : (() => {
        const list = pageKey === 'solutions'
          ? (r.solutionModules.length ? r.solutionModules : r.addOnModules)
          : r.addOnModules;
        if (!list.length) return '<span class="text-gray-600">—</span>';
        const shown = list.slice(0, 3).map(s =>
          `<span class="text-gray-200">${esc(s.name || '?')}</span> ${pkgKindBadge(s.kind)}`).join('<br>');
        return shown + (list.length > 3 ? `<div class="text-[11px] text-gray-500 mt-0.5">+${list.length - 3} more</div>` : '');
      })();

  return `
    <tr class="hover:bg-dark-hover transition-colors cursor-pointer" onclick="navigateTo('component', ${jsStr(r.marketplaceId)}, { selectedTab: 'structure' })">
      <td class="px-4 py-3">
        <a href="${href}" onclick="event.stopPropagation()" class="text-sm font-medium text-white hover:text-mx-blue">${esc(r.name)}</a>
        <div class="text-xs text-gray-500 mt-0.5">${esc(r.contentType)} · ${esc(r.marketplaceId)}${r.team ? ` · ${esc(r.team)}` : ''}</div>
      </td>
      <td class="px-4 py-3 text-sm text-gray-300">${esc(r.publisher || '—')}</td>
      <td class="px-4 py-3">${supportBadge(r.support)}</td>
      <td class="px-4 py-3">${pkgDistBadge(r.dist)}</td>
      <td class="px-4 py-3 text-sm">${focus}</td>
      <td class="px-4 py-3">${pkgFormatBadge(r.packageFormat, r.packageFile)}</td>
      <td class="px-4 py-3 text-sm text-gray-300">${esc(r.minMx || '—')}</td>
      <td class="px-4 py-3 text-sm text-gray-300">${(r.downloads || 0).toLocaleString()}</td>
      <td class="px-4 py-3 text-sm text-gray-400">${esc(formatDate(r.lastPublish) || '—')}</td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

// Escape one CSV field: quote when it contains a delimiter, quote or newline.
function _csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Build a CSV from column definitions and hand it to the browser as a download.
// Used by the packaging pages; written generically so other list views can reuse it.
function downloadCSV(fileName, columns, rows) {
  const lines = [columns.map(c => _csvCell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map(c => _csvCell(c.value(row))).join(','));
  // A BOM keeps Excel from mangling non-ASCII publisher names.
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPackagingCSV(pageKey) {
  const rows = _pkgFiltered(pageKey);
  const columns = [
    { label: 'Marketplace ID', value: r => r.marketplaceId },
    { label: 'Component',      value: r => r.name },
    { label: 'Delivery',       value: r => (PKG_DIST_META[r.dist] || {}).label || r.dist },
    { label: 'Content type',   value: r => r.contentType },
    { label: 'Publisher',      value: r => r.publisher },
    { label: 'Support type',   value: r => r.support },
    { label: 'Owning team',    value: r => r.team },
    { label: 'Maintainers',    value: r => r.developers.join('; ') },
    { label: 'Add-on modules', value: r => r.addOnModules.map(s => s.name).join('; ') },
    { label: 'Solution modules', value: r => r.solutionModules.map(s => s.name).join('; ') },
    { label: 'Extensions',     value: r => r.extensions.join('; ') },
    { label: 'Package file',   value: r => r.packageFile },
    { label: 'Package format', value: r => r.packageFormat },
    { label: 'Min Mendix version', value: r => r.minMx },
    { label: 'Downloads',      value: r => r.downloads },
    { label: 'Last published', value: r => r.lastPublish },
    { label: 'Marketplace URL', value: r => r.permalink },
  ];
  const stamp = window.SCAN_DATE ? String(window.SCAN_DATE).slice(0, 10) : 'export';
  downloadCSV(`mx-${pageKey}-${stamp}.csv`, columns, rows);
}

// ---------------------------------------------------------------------------
// Component detail — packaging card (shown on the Package Structure tab)
// ---------------------------------------------------------------------------

// The packaging facts for one component: how it is delivered, what each module in
// it is, what is bundled inside, and how the archive is laid out. Returns '' when
// there is nothing packaging-specific to say and the component is an ordinary one.
function buildPackagingCard(comp, packagingModules) {
  if (!dbLayer.hasPackagingData()) return '';

  const settings = [];
  const nested = [];
  const layout = [];
  const seen = new Set();
  let archiveFiles = 0, archiveBytes = 0;
  for (const m of packagingModules || []) {
    for (const s of _parseJSON(m.package_modules_json)) {
      const key = (s.name || '?') + '\x1f' + (s.source || '');
      if (seen.has(key)) continue;
      seen.add(key);
      settings.push(Object.assign({ kind: _pkgModuleKind(s) }, s));
    }
    for (const n of _parseJSON(m.nested_packages_json)) nested.push(n);
    for (const l of _parseJSON(m.package_layout_json)) layout.push(l);
    archiveFiles += m.archive_files || 0;
    archiveBytes += m.archive_bytes || 0;
  }

  const dist = comp.distribution_type || 'regular';
  const extensions = _parseJSON(comp.extension_names_json || '[]');
  if (dist === 'regular' && !settings.length && !comp.package_file_name) return '';

  const fact = (label, valueHtml) => `
    <div>
      <div class="text-[11px] uppercase tracking-wide text-gray-500">${label}</div>
      <div class="text-sm text-gray-200 mt-0.5">${valueHtml}</div>
    </div>`;

  const protectedCount = settings.filter(s => s.kind === 'add-on').length;
  const solutionCount  = settings.filter(s => s.kind === 'solution').length;

  const facts = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      ${fact('Delivered as', pkgDistBadge(dist))}
      ${fact('Package file', comp.package_file_name
          ? `<span class="font-mono text-xs text-gray-300">${esc(comp.package_file_name)}</span>`
          : '<span class="text-gray-600">not recorded</span>')}
      ${fact('Archive', archiveFiles ? `${archiveFiles.toLocaleString()} files · ${fmtBytes(archiveBytes)}` : '<span class="text-gray-600">—</span>')}
      ${fact('Modules', settings.length
          ? `${settings.length} total${protectedCount ? ` · ${protectedCount} protected` : ''}${solutionCount ? ` · ${solutionCount} solution` : ''}`
          : '<span class="text-gray-600">—</span>')}
    </div>`;

  const moduleRows = settings.map(s => `
    <tr class="hover:bg-dark-hover transition-colors">
      <td class="px-3 py-2 text-sm text-gray-200">${esc(s.name || '?')}</td>
      <td class="px-3 py-2">${pkgKindBadge(s.kind)}</td>
      <td class="px-3 py-2 text-sm ${s.export_level === 'Protected' ? 'text-purple-300' : 'text-gray-400'}">${esc(s.export_level || '—')}</td>
      <td class="px-3 py-2 text-sm text-gray-400">${esc(s.protected_module_type || '—')}</td>
      <td class="px-3 py-2 text-sm text-gray-300">${s.extension_name ? `<span class="font-mono text-xs">${esc(s.extension_name)}</span>` : '<span class="text-gray-600">—</span>'}</td>
      <td class="px-3 py-2 text-sm text-gray-400">${esc(s.version || '—')}</td>
      <td class="px-3 py-2 text-xs text-gray-500">${s.source ? esc(s.source) : 'package model'}</td>
    </tr>`).join('');

  const modulesTable = settings.length ? `
    <div class="mt-5">
      <div class="text-sm font-medium text-gray-300 mb-2">Modules in this package</div>
      <div class="overflow-x-auto rounded-lg border border-dark-border">
        <table class="min-w-full">
          <thead class="bg-dark-bg/50"><tr>
            ${th('Module')}${th('Kind')}${th('Export level')}${th('Module type')}${th('Extension')}${th('Version')}${th('From')}
          </tr></thead>
          <tbody class="divide-y divide-dark-border">${moduleRows}</tbody>
        </table>
      </div>
      <p class="text-[11px] text-gray-500 mt-2">
        Export level is the reliable signal: <span class="text-gray-400">Protected</span> means the model ships compiled.
        Module type stores "AddOn" by default, so on its own it does not mark a module as an add-on.
      </p>
    </div>` : '';

  const nestedList = nested.length ? `
    <div class="mt-5">
      <div class="text-sm font-medium text-gray-300 mb-2">Packages bundled inside</div>
      <div class="space-y-1.5">
        ${nested.map(n => `
          <div class="flex flex-wrap items-center gap-2 rounded-md border border-dark-border bg-dark-bg/40 px-3 py-2">
            <span class="font-mono text-xs text-gray-300">${esc(n.path)}</span>
            ${n.kind ? pkgKindBadge(n.kind) : ''}
            ${n.extension_name ? `<span class="text-[11px] text-gray-400">extension: <span class="font-mono">${esc(n.extension_name)}</span></span>` : ''}
            <span class="text-[11px] text-gray-500">${(n.file_count || 0).toLocaleString()} files · ${fmtBytes(n.size_bytes)}${n.model_mx_version ? ` · model ${esc(n.model_mx_version)}` : ''}</span>
          </div>`).join('')}
      </div>
    </div>` : '';

  // Merge layout entries across packages, then draw a proportional bar per folder.
  const merged = {};
  for (const l of layout) {
    const e = merged[l.dir] || (merged[l.dir] = { dir: l.dir, files: 0, size_bytes: 0 });
    e.files += l.files || 0;
    e.size_bytes += l.size_bytes || 0;
  }
  const layoutRows = Object.values(merged).sort((a, b) => b.size_bytes - a.size_bytes);
  const maxBytes = layoutRows.length ? Math.max(...layoutRows.map(l => l.size_bytes)) : 0;
  const layoutHTML = layoutRows.length ? `
    <div class="mt-5">
      <div class="text-sm font-medium text-gray-300 mb-2">Archive layout</div>
      <div class="space-y-1">
        ${layoutRows.map(l => `
          <div class="flex items-center gap-3">
            <div class="w-40 flex-shrink-0 font-mono text-xs text-gray-300 truncate" title="${esc(l.dir)}">${esc(l.dir)}</div>
            <div class="flex-1 h-2 rounded bg-dark-bg/60 overflow-hidden">
              <div class="h-full bg-mx-blue/60" style="width:${maxBytes ? Math.max(2, Math.round(l.size_bytes / maxBytes * 100)) : 0}%"></div>
            </div>
            <div class="w-40 flex-shrink-0 text-right text-xs text-gray-500">${l.files.toLocaleString()} files · ${fmtBytes(l.size_bytes)}</div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const extensionsHTML = extensions.length ? `
    <div class="mt-4 text-sm text-gray-300">
      Ships Studio Pro extension${extensions.length !== 1 ? 's' : ''}:
      ${extensions.map(e => `<span class="font-mono text-xs bg-dark-bg/60 border border-dark-border rounded px-1.5 py-0.5 ml-1">${esc(e)}</span>`).join('')}
    </div>` : '';

  return card(`
    <div class="p-4">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-sm font-semibold text-white">Packaging &amp; distribution</h3>
        <span class="text-[11px] text-gray-500">from Module Settings in the model</span>
      </div>
      ${facts}
      ${extensionsHTML}
      ${modulesTable}
      ${nestedList}
      ${layoutHTML}
    </div>`);
}
