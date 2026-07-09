// Database Query Layer — Mendix Marketplace Component Scanner
// Schema: components → widgets/modules → widget_findings/module_findings

class DatabaseLayer {
  constructor(db) {
    this.db = db;
  }

  parseVersion(v) {
    const cleaned = (v || '').replace(/^v/, '');
    const parts = cleaned.split('.').map(p => parseInt(p) || 0);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  compareVersions(a, b) {
    const av = this.parseVersion(a), bv = this.parseVersion(b);
    if (av.major !== bv.major) return av.major - bv.major;
    if (av.minor !== bv.minor) return av.minor - bv.minor;
    return av.patch - bv.patch;
  }

  query(sql, params = []) {
    try {
      const stmt = this.db.prepare(sql);
      if (params.length > 0) stmt.bind(params);
      const results = [];
      while (stmt.step()) results.push(stmt.getAsObject());
      stmt.free();
      return results;
    } catch (err) {
      console.error('SQL Error:', sql, params, err);
      throw err;
    }
  }

  queryOne(sql, params = []) {
    const rows = this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  // Whether a column exists — used to stay compatible with databases produced
  // before a column was added (e.g. modules.model_mx_version), since selecting a
  // missing column throws. Cached per table.column.
  columnExists(table, col) {
    this._colCache = this._colCache || {};
    const key = `${table}.${col}`;
    if (key in this._colCache) return this._colCache[key];
    let exists = false;
    try { exists = this.query(`PRAGMA table_info(${table})`).some(r => r.name === col); } catch (_) {}
    this._colCache[key] = exists;
    return exists;
  }

  // Whether a table exists — used to stay compatible with databases produced before
  // a table was added (e.g. module_js_findings). Cached per table name.
  _tableExists(table) {
    this._tblCache = this._tblCache || {};
    if (table in this._tblCache) return this._tblCache[table];
    let exists = false;
    try {
      exists = this.query(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`, [table]
      ).length > 0;
    } catch (_) {}
    this._tblCache[table] = exists;
    return exists;
  }

  // =============================================================================
  // Dashboard
  // =============================================================================

  getStats() {
    return this.queryOne(`
      SELECT
        COUNT(DISTINCT c.id)                                    AS total_components,
        COUNT(DISTINCT w.id)                                    AS total_widgets,
        COUNT(DISTINCT m.id)                                    AS total_modules,
        COUNT(DISTINCT CASE WHEN w.broken_always OR w.breaks116 THEN w.id END) AS breaking_widgets,
        COUNT(DISTINCT CASE WHEN NOT w.broken_always AND NOT w.breaks116 AND w.issue_count = 0 THEN w.id END) AS compatible_widgets
      FROM components c
      LEFT JOIN widgets   w ON w.component_id = c.id
      LEFT JOIN modules   m ON m.component_id = c.id
    `);
  }

  getComponentBreakdown() {
    return this.query(`
      SELECT
        c.content_type,
        c.support_type,
        COUNT(DISTINCT c.id)                                    AS component_count,
        COUNT(DISTINCT w.id)                                    AS widget_count,
        COUNT(DISTINCT CASE WHEN w.broken_always OR w.breaks116 THEN w.id END) AS breaking_widget_count,
        COUNT(DISTINCT m.id)                                    AS module_count,
        COUNT(DISTINCT CASE WHEN mf.certain THEN m.id END)     AS breaking_module_count
      FROM components c
      LEFT JOIN widgets w ON w.component_id = c.id
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      GROUP BY c.content_type, c.support_type
      ORDER BY c.content_type, c.support_type
    `);
  }

  getPriorityComponents(limit = 10) {
    return this.query(`
      SELECT
        c.id, c.marketplace_id, c.name, c.content_type, c.support_type, c.react_client_ready,
        c.min_mx_version, c.download_count, c.permalink, c.publisher,
        COUNT(DISTINCT w.id)                                          AS widget_count,
        COUNT(DISTINCT CASE WHEN w.broken_always THEN w.id END)      AS broken_always_count,
        COUNT(DISTINCT CASE WHEN w.breaks116 THEN w.id END)          AS breaks116_count,
        COUNT(DISTINCT m.id)                                          AS module_count,
        COUNT(DISTINCT CASE WHEN mf.certain THEN m.id END)           AS breaking_module_count
      FROM components c
      LEFT JOIN widgets w ON w.component_id = c.id
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      WHERE c.scan_error = '' OR c.scan_error IS NULL
      GROUP BY c.id
      HAVING (broken_always_count > 0 OR breaks116_count > 0 OR breaking_module_count > 0)
      ORDER BY broken_always_count DESC, breaks116_count DESC, c.download_count DESC
      LIMIT ?
    `, [limit]);
  }

  // =============================================================================
  // Components
  // =============================================================================

  getComponents(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.contentTypes && filters.contentTypes.length > 0) {
      const ph = filters.contentTypes.map(() => '?').join(',');
      conditions.push(`c.content_type IN (${ph})`);
      params.push(...filters.contentTypes);
    }
    if (filters.supportTypes && filters.supportTypes.length > 0) {
      const ph = filters.supportTypes.map(() => '?').join(',');
      conditions.push(`c.support_type IN (${ph})`);
      params.push(...filters.supportTypes);
    }
    if (filters.statuses && filters.statuses.length > 0) {
      const statusConds = filters.statuses.map(s => {
        if (s === 'breaking')   return '(broken_always_count > 0 OR breaks116_count > 0 OR breaking_module_count > 0)';
        if (s === 'compatible') return '(broken_always_count = 0 AND breaks116_count = 0 AND breaking_module_count = 0)';
        return null;
      }).filter(Boolean);
      if (statusConds.length > 0) conditions.push('(' + statusConds.join(' OR ') + ')');
    }

    const where = conditions.length > 0 ? 'HAVING ' + conditions.join(' AND ') : '';

    // The unfiltered result is the heaviest query and is requested many times per
    // view (list scope, dashboard, health stats). The embedded DB is read-only, so
    // cache it; the frontend applies all filtering in JS anyway.
    if (conditions.length === 0 && this._allComponents) return this._allComponents;

    // Distinct Mendix versions the modules were built in (from the MPR), for the
    // marketplace-vs-model mismatch check. Empty string when the DB predates the column.
    const modelVerSel = this.columnExists('modules', 'model_mx_version')
      ? `GROUP_CONCAT(DISTINCT NULLIF(m.model_mx_version, ''))` : `''`;

    const rows = this.query(`
      SELECT
        c.id, c.marketplace_id, c.name, c.content_type, c.support_type,
        ${modelVerSel} AS model_mx_versions,
        c.min_mx_version, c.react_client_ready, c.download_count, c.rating,
        c.permalink, c.publisher, c.latest_version, c.scan_error,
        c.prod_apps_mx9, c.prod_apps_mx10,
        c.git_hub_url, c.last_publish_date, c.changed_date, c.created_date,
        COUNT(DISTINCT w.id)                                          AS widget_count,
        COUNT(DISTINCT CASE WHEN w.broken_always THEN w.id END)      AS broken_always_count,
        COUNT(DISTINCT CASE WHEN w.breaks116 THEN w.id END)          AS breaks116_count,
        COUNT(DISTINCT CASE WHEN w.issue_count > 0 AND NOT w.broken_always AND NOT w.breaks116 THEN w.id END) AS warning_widget_count,
        COUNT(DISTINCT CASE WHEN w.issue_count = 0 THEN w.id END)    AS compatible_widget_count,
        COUNT(DISTINCT m.id)                                          AS module_count,
        COUNT(DISTINCT CASE WHEN mf.certain THEN m.id END)           AS breaking_module_count,
        COUNT(DISTINCT mf.finding_id)                                 AS total_module_finding_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib AND NOT COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS unmanaged_dep_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib THEN m.id END)        AS userlib_module_count,
        COUNT(DISTINCT CASE WHEN COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS managed_dep_module_count
      FROM components c
      LEFT JOIN widgets w ON w.component_id = c.id
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      GROUP BY c.id
      ${where}
      ORDER BY
        CASE WHEN (broken_always_count > 0 OR breaks116_count > 0 OR breaking_module_count > 0) THEN 0 ELSE 1 END,
        c.download_count DESC,
        c.name
    `, params);

    if (conditions.length === 0) this._allComponents = rows;
    return rows;
  }

  // Look up a component by marketplace_id (used for URL routing).
  getComponentDetail(marketplaceId) {
    const modelVerSel = this.columnExists('modules', 'model_mx_version')
      ? `GROUP_CONCAT(DISTINCT NULLIF(m.model_mx_version, ''))` : `''`;
    // Rich metadata columns were added later; guard so older embedded DBs still work.
    const richCols = this.columnExists('components', 'description')
      ? `c.description, c.logo_url, c.demo_url, c.video_url, c.review_count,
         c.published_version_count, c.support_contact, c.support_website,
         c.publisher_logo, c.publisher_url, c.license_name, c.license_url, c.developers_json,`
      : '';
    return this.queryOne(`
      SELECT
        c.id, c.marketplace_id, c.name, c.content_type, c.support_type,
        ${modelVerSel} AS model_mx_versions,
        c.min_mx_version, c.react_client_ready, c.download_count, c.rating,
        c.permalink, c.publisher, c.latest_version, c.scan_error,
        c.prod_apps_mx9, c.prod_apps_mx10,
        c.git_hub_url, c.last_publish_date, c.changed_date, c.created_date,
        ${richCols}
        COUNT(DISTINCT CASE WHEN m.has_userlib AND NOT COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS unmanaged_dep_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib THEN m.id END)        AS userlib_module_count,
        COUNT(DISTINCT CASE WHEN COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS managed_dep_module_count,
        COUNT(DISTINCT m.id) AS module_count,
        COUNT(DISTINCT w.id) AS widget_count
      FROM components c
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN widgets w ON w.component_id = c.id
      WHERE c.marketplace_id = ?
      GROUP BY c.id
    `, [marketplaceId]);
  }

  getComponentWidgets(componentId) {
    return this.query(`
      SELECT
        w.id, w.widget_id, w.name, w.display_name, w.version, w.file_hash,
        w.type, w.breaks116, w.broken_always, w.issue_count, w.bundled_in_module,
        GROUP_CONCAT(f.rule || '|' || f.category || '|' || wf.match_count, ',') AS findings
      FROM widgets w
      LEFT JOIN widget_findings wf ON wf.widget_id = w.id AND COALESCE(wf.suppressed, 0) = 0
      LEFT JOIN findings f ON f.id = wf.finding_id
      WHERE w.component_id = ?
      GROUP BY w.id
      ORDER BY w.broken_always DESC, w.breaks116 DESC, w.issue_count DESC, w.name
    `, [componentId]);
  }

  getComponentModules(componentId) {
    return this.query(`
      SELECT
        m.id, m.name, m.version, m.has_java, m.java_action_count,
        m.total_java_files, m.has_css, m.has_userlib, m.has_resources,
        m.has_js, m.total_js_files, COALESCE(m.has_managed_dependencies, 0) AS has_managed_dependencies,
        COALESCE(m.managed_deps_json, '[]') AS managed_deps_json,
        COALESCE(m.module_deps_json, '[]') AS module_deps_json,
        COALESCE(m.model_entities_json, '[]') AS model_entities_json,
        COALESCE(m.model_microflows_json, '[]') AS model_microflows_json,
        COALESCE(m.model_nanoflows_json, '[]') AS model_nanoflows_json,
        COALESCE(m.model_pages_json, '[]') AS model_pages_json,
        COALESCE(m.model_enums_json, '[]') AS model_enums_json,
        COALESCE(m.model_constants_json, '[]') AS model_constants_json,
        COALESCE(m.model_roles_json, '[]') AS model_roles_json,
        m.java_files_json, m.userlib_files_json, m.css_files_json, m.resource_files_json, m.js_files_json,
        COUNT(DISTINCT CASE WHEN mf.certain THEN mf.finding_id END) AS certain_finding_count,
        COUNT(DISTINCT mf.finding_id)                               AS total_finding_count,
        GROUP_CONCAT(
          jf.rule || '|' || jf.category || '|' || mf.match_count || '|' || CAST(mf.certain AS INTEGER)
          || '|' || REPLACE(COALESCE(jf.description, ''), '|', ' ')
          || '|' || COALESCE(jf.doc_url, ''),
          X'1e'
        ) AS findings
      FROM modules m
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      LEFT JOIN java_findings jf ON jf.id = mf.finding_id
      WHERE m.component_id = ?
      GROUP BY m.id
      ORDER BY m.name
    `, [componentId]);
  }

  // Returns all Java findings for a component (across all its modules), each with
  // its source file locations packed into a record-separator-delimited string.
  getComponentJavaFindings(componentId) {
    return this.query(`
      SELECT
        m.id AS module_id, m.name AS module_name, m.version AS module_version,
        jf.rule, jf.category, jf.description, jf.doc_url,
        mf.id AS module_finding_id, mf.match_count, mf.certain,
        GROUP_CONCAT(mfl.file_path || '~' || mfl.line_number, X'1e') AS locations
      FROM module_findings mf
      JOIN modules m ON m.id = mf.module_id
      JOIN java_findings jf ON jf.id = mf.finding_id
      LEFT JOIN module_finding_locations mfl ON mfl.module_finding_id = mf.id
      WHERE m.component_id = ?
      GROUP BY mf.id
      ORDER BY mf.certain DESC, m.name, jf.rule
    `, [componentId]);
  }

  // Full source of every Java file (with findings) in a component's modules,
  // keyed by "moduleId\x1ffilePath" → content. Loaded on demand when the user
  // clicks a source location. Returns {} if no sources were stored.
  getComponentJavaSources(componentId) {
    let rows;
    try {
      rows = this.query(`
        SELECT s.module_id, s.file_path, s.content
        FROM module_java_sources s
        JOIN modules m ON m.id = s.module_id
        WHERE m.component_id = ?
      `, [componentId]);
    } catch (e) {
      return {}; // table absent in older DBs
    }
    const map = {};
    for (const r of rows) map[r.module_id + '\x1f' + r.file_path] = r.content;
    return map;
  }

  // Returns all JavaScript-action findings for a component (across all its modules),
  // each with its source file:line locations packed into a record-separator string.
  // Mirrors getComponentJavaFindings; empty when the JS tables are absent (older DB).
  getComponentJSFindings(componentId) {
    if (!this._tableExists('module_js_findings')) return [];
    return this.query(`
      SELECT
        m.id AS module_id, m.name AS module_name, m.version AS module_version,
        f.rule, f.category, f.description, f.doc_url, f.doc_anchor,
        mjf.id AS module_js_finding_id, mjf.match_count, mjf.certain,
        GROUP_CONCAT(mjfl.file_path || '~' || mjfl.line_number, X'1e') AS locations
      FROM module_js_findings mjf
      JOIN modules m ON m.id = mjf.module_id
      JOIN findings f ON f.id = mjf.finding_id
      LEFT JOIN module_js_finding_locations mjfl ON mjfl.module_js_finding_id = mjf.id
      WHERE m.component_id = ?
      GROUP BY mjf.id
      ORDER BY mjf.certain DESC, m.name, f.rule
    `, [componentId]);
  }

  // Full source of every JS action file (with findings) in a component's modules,
  // keyed by "moduleId\x1ffilePath" → content. Loaded on demand on location click.
  getComponentJSSources(componentId) {
    if (!this._tableExists('module_js_sources')) return {};
    let rows;
    try {
      rows = this.query(`
        SELECT s.module_id, s.file_path, s.content
        FROM module_js_sources s
        JOIN modules m ON m.id = s.module_id
        WHERE m.component_id = ?
      `, [componentId]);
    } catch (e) {
      return {};
    }
    const map = {};
    for (const r of rows) map[r.module_id + '\x1f' + r.file_path] = r.content;
    return map;
  }

  // Per-module JS-action findings (for the standalone module detail page).
  getModuleJSFindings(moduleId) {
    if (!this._tableExists('module_js_findings')) return [];
    return this.query(`
      SELECT
        f.id, f.rule, f.category, f.description, f.doc_url,
        mjf.match_count, mjf.certain
      FROM module_js_findings mjf
      JOIN findings f ON f.id = mjf.finding_id
      WHERE mjf.module_id = ?
      ORDER BY mjf.certain DESC, f.category, f.rule
    `, [moduleId]);
  }

  getModuleJSSourceLocations(moduleId) {
    if (!this._tableExists('module_js_finding_locations')) return [];
    return this.query(`
      SELECT f.rule, f.category, mjf.certain, mjfl.file_path, mjfl.line_number
      FROM module_js_finding_locations mjfl
      JOIN module_js_findings mjf ON mjf.id = mjfl.module_js_finding_id
      JOIN findings f ON f.id = mjf.finding_id
      WHERE mjf.module_id = ?
      ORDER BY f.rule, mjfl.file_path, mjfl.line_number
    `, [moduleId]);
  }

  getDistinctContentTypes() {
    return this.query(`SELECT DISTINCT content_type FROM components WHERE content_type IS NOT NULL ORDER BY content_type`);
  }

  getDistinctSupportTypes() {
    return this.query(`SELECT DISTINCT support_type FROM components WHERE support_type IS NOT NULL ORDER BY support_type`);
  }

  // =============================================================================
  // Facet rollups
  // =============================================================================
  //
  // Returns, per component id, the raw per-facet finding counts plus the two
  // non-finding signals the UI needs (Dojo widgets, external module deps):
  //   { [componentId]: {
  //       facets: { <facetKey>: { certain, uncertain } },
  //       dojoWidgets: <n>,
  //       moduleDeps:  [<external module name>, ...],
  //   } }
  // Finding facets are stored comma-joined on findings.facets / java_findings.facets
  // (see pkg/report/facets.go). The component-level status per facet — including the
  // derived `mx12` facet — is resolved in app.js (componentFacetStatus), since it
  // also folds in react_client_ready, min version and content type. Cached because
  // it scans every finding row and the views re-render frequently.
  getComponentFacetData() {
    if (this._facetData) return this._facetData;
    const byId = {};
    const entry = cid => (byId[cid] || (byId[cid] = { facets: {}, dojoWidgets: 0, moduleDeps: [] }));
    const tally = (cid, facetsStr, certain) => {
      if (!facetsStr) return;
      const e = entry(cid);
      for (const f of String(facetsStr).split(',').filter(Boolean)) {
        const c = e.facets[f] || (e.facets[f] = { certain: 0, uncertain: 0 });
        if (certain) c.certain++; else c.uncertain++;
      }
    };

    // Widget (JS) findings
    for (const r of this.query(`
      SELECT w.component_id AS cid, f.facets AS facets, wf.certain AS certain
      FROM widgets w
      JOIN widget_findings wf ON wf.widget_id = w.id AND COALESCE(wf.suppressed, 0) = 0
      JOIN findings f ON f.id = wf.finding_id
      WHERE COALESCE(f.facets, '') <> ''
    `)) tally(r.cid, r.facets, r.certain);

    // Module (Java) findings
    for (const r of this.query(`
      SELECT m.component_id AS cid, jf.facets AS facets, mf.certain AS certain
      FROM modules m
      JOIN module_findings mf ON mf.module_id = m.id
      JOIN java_findings jf ON jf.id = mf.finding_id
      WHERE COALESCE(jf.facets, '') <> ''
    `)) tally(r.cid, r.facets, r.certain);

    // Module JavaScript-action findings (reuse the shared `findings` catalog).
    // Same facet contract as widget JS findings — the same rules produced them.
    if (this._tableExists('module_js_findings')) {
      for (const r of this.query(`
        SELECT m.component_id AS cid, f.facets AS facets, mjf.certain AS certain
        FROM modules m
        JOIN module_js_findings mjf ON mjf.module_id = m.id
        JOIN findings f ON f.id = mjf.finding_id
        WHERE COALESCE(f.facets, '') <> ''
      `)) tally(r.cid, r.facets, r.certain);
    }

    // Dojo widget counts (more reliable than the dojo-widget JS rule alone)
    for (const r of this.query(`
      SELECT component_id AS cid, COUNT(*) AS n FROM widgets WHERE type = 'Dojo' GROUP BY component_id
    `)) entry(r.cid).dojoWidgets = r.n;

    // External module dependencies (parsed from module_deps_json)
    for (const r of this.query(`
      SELECT component_id AS cid, module_deps_json AS deps
      FROM modules WHERE module_deps_json IS NOT NULL AND module_deps_json <> '[]'
    `)) {
      const e = entry(r.cid);
      let deps; try { deps = JSON.parse(r.deps); } catch { deps = []; }
      for (const d of deps) if (!e.moduleDeps.includes(d)) e.moduleDeps.push(d);
    }

    this._facetData = { byId };
    return this._facetData;
  }

  // =============================================================================
  // Widgets
  // =============================================================================

  getWidgets(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.status === 'breaking') {
      conditions.push(`(w.broken_always = 1 OR w.breaks116 = 1)`);
    } else if (filters.status === 'warning') {
      conditions.push(`(w.broken_always = 0 AND w.breaks116 = 0 AND w.issue_count > 0)`);
    } else if (filters.status === 'compatible') {
      conditions.push(`(w.issue_count = 0)`);
    }
    if (filters.type) {
      conditions.push(`w.type = ?`);
      params.push(filters.type);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    return this.query(`
      SELECT
        w.id, w.widget_id, w.name, w.display_name, w.version, w.type,
        w.breaks116, w.broken_always, w.issue_count, w.bundled_in_module,
        c.id AS component_id, c.marketplace_id AS component_marketplace_id,
        c.name AS component_name,
        c.content_type AS component_content_type, c.support_type AS component_support_type,
        GROUP_CONCAT(f.rule || '|' || f.category || '|' || wf.match_count, ',') AS findings
      FROM widgets w
      JOIN components c ON c.id = w.component_id
      LEFT JOIN widget_findings wf ON wf.widget_id = w.id AND COALESCE(wf.suppressed, 0) = 0
      LEFT JOIN findings f ON f.id = wf.finding_id
      ${where}
      GROUP BY w.id
      ORDER BY w.broken_always DESC, w.breaks116 DESC, w.issue_count DESC, c.name, w.name
    `, params);
  }

  getWidgetDetail(widgetId) {
    return this.queryOne(`
      SELECT
        w.id, w.widget_id, w.name, w.display_name, w.version, w.file_hash,
        w.type, w.breaks116, w.broken_always, w.issue_count, w.bundled_in_module,
        c.id AS component_id, c.marketplace_id AS component_marketplace_id,
        c.name AS component_name,
        c.content_type, c.support_type, c.permalink AS component_permalink
      FROM widgets w
      JOIN components c ON c.id = w.component_id
      WHERE w.id = ?
    `, [widgetId]);
  }

  getWidgetFindings(widgetId) {
    return this.query(`
      SELECT
        f.id, f.rule, f.category, f.description, f.doc_url, f.doc_anchor,
        wf.match_count, wf.certain, wf.suppressed
      FROM widget_findings wf
      JOIN findings f ON f.id = wf.finding_id
      WHERE wf.widget_id = ?
      ORDER BY COALESCE(wf.suppressed, 0), f.category, f.rule
    `, [widgetId]);
  }

  // =============================================================================
  // Modules
  // =============================================================================

  getModules(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.status === 'breaking') {
      conditions.push(`certain_finding_count > 0`);
    } else if (filters.status === 'warning') {
      conditions.push(`certain_finding_count = 0 AND total_finding_count > 0`);
    } else if (filters.status === 'compatible') {
      conditions.push(`total_finding_count = 0`);
    }

    const having = conditions.length > 0 ? 'HAVING ' + conditions.join(' AND ') : '';

    return this.query(`
      SELECT
        m.id, m.name, m.version, m.has_java, m.java_action_count,
        c.id AS component_id, c.marketplace_id AS component_marketplace_id,
        c.name AS component_name,
        c.content_type AS component_content_type, c.support_type AS component_support_type,
        COUNT(DISTINCT CASE WHEN mf.certain THEN mf.finding_id END) AS certain_finding_count,
        COUNT(DISTINCT mf.finding_id)                               AS total_finding_count
      FROM modules m
      JOIN components c ON c.id = m.component_id
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      GROUP BY m.id
      ${having}
      ORDER BY certain_finding_count DESC, total_finding_count DESC, c.name, m.name
    `, params);
  }

  getModuleDetail(moduleId) {
    return this.queryOne(`
      SELECT
        m.id, m.name, m.version, m.has_java, m.java_action_count,
        m.total_java_files, m.has_css, m.has_userlib, m.has_resources,
        m.has_js, m.total_js_files,
        m.java_files_json, m.userlib_files_json, m.css_files_json, m.resource_files_json, m.js_files_json,
        c.id AS component_id, c.marketplace_id AS component_marketplace_id,
        c.name AS component_name, c.latest_version AS component_latest_version,
        c.content_type, c.support_type, c.permalink AS component_permalink
      FROM modules m
      JOIN components c ON c.id = m.component_id
      WHERE m.id = ?
    `, [moduleId]);
  }

  getModuleFindings(moduleId) {
    return this.query(`
      SELECT
        jf.id, jf.rule, jf.category, jf.description, jf.doc_url,
        mf.match_count, mf.certain
      FROM module_findings mf
      JOIN java_findings jf ON jf.id = mf.finding_id
      WHERE mf.module_id = ?
      ORDER BY mf.certain DESC, jf.category, jf.rule
    `, [moduleId]);
  }

  getModuleSourceLocations(moduleId) {
    return this.query(`
      SELECT jf.rule, jf.category, mf.certain, mfl.file_path, mfl.line_number
      FROM module_finding_locations mfl
      JOIN module_findings mf ON mf.id = mfl.module_finding_id
      JOIN java_findings jf ON jf.id = mf.finding_id
      WHERE mf.module_id = ?
      ORDER BY jf.rule, mfl.file_path, mfl.line_number
    `, [moduleId]);
  }

  // =============================================================================
  // Issues (JS widget findings)
  // =============================================================================

  getIssues() {
    return this.query(`
      SELECT
        f.id, f.rule, f.category, f.description, f.doc_url, f.doc_anchor, f.facets,
        COUNT(DISTINCT w.id)  AS widget_count,
        COUNT(DISTINCT c.id)  AS component_count,
        GROUP_CONCAT(DISTINCT c.content_type) AS content_types
      FROM findings f
      JOIN widget_findings wf ON f.id = wf.finding_id AND COALESCE(wf.suppressed, 0) = 0
      JOIN widgets w ON wf.widget_id = w.id
      JOIN components c ON c.id = w.component_id
      GROUP BY f.id
      ORDER BY
        CASE f.category
          WHEN 'removed-always'    THEN 0
          WHEN 'react19-breaking'  THEN 1
          WHEN 'react-client-only' THEN 2
          WHEN 'behavior-change'   THEN 3
          ELSE 4
        END,
        widget_count DESC
    `);
  }

  getIssueAffectedWidgets(findingId) {
    return this.query(`
      SELECT
        w.id AS widget_id, w.name AS widget_name, w.display_name, w.version, w.type,
        c.name AS component_name, c.support_type,
        c.marketplace_id, c.content_type, c.download_count, c.prod_apps_mx10
      FROM widget_findings wf
      JOIN widgets w ON wf.widget_id = w.id
      JOIN components c ON c.id = w.component_id
      WHERE wf.finding_id = ? AND COALESCE(wf.suppressed, 0) = 0
      ORDER BY c.name, w.name
    `, [findingId]);
  }

  getJavaIssues() {
    return this.query(`
      SELECT
        jf.id, jf.rule, jf.category, jf.description, jf.doc_url, jf.facets,
        MAX(mf.certain) AS certain,
        COUNT(DISTINCT m.id)  AS module_count,
        COUNT(DISTINCT c.id)  AS component_count,
        GROUP_CONCAT(DISTINCT c.content_type) AS content_types
      FROM java_findings jf
      JOIN module_findings mf ON jf.id = mf.finding_id
      JOIN modules m ON mf.module_id = m.id
      JOIN components c ON c.id = m.component_id
      GROUP BY jf.id
      ORDER BY
        CASE jf.category
          WHEN 'removed-class'  THEN 0
          WHEN 'removed-method' THEN 1
          WHEN 'removed-api'    THEN 2
          ELSE 3
        END, module_count DESC
    `);
  }

  getJavaIssueAffectedModules(findingId) {
    return this.query(`
      SELECT
        m.id AS module_id, m.name AS module_name, m.version,
        MAX(mf.match_count) AS match_count, MAX(mf.certain) AS certain,
        c.name AS component_name, c.support_type,
        c.marketplace_id, c.content_type, c.download_count, c.prod_apps_mx10
      FROM module_findings mf
      JOIN modules m ON mf.module_id = m.id
      JOIN components c ON c.id = m.component_id
      WHERE mf.finding_id = ?
      GROUP BY m.id
      ORDER BY m.name
    `, [findingId]);
  }

  // JavaScript-action issues, keyed by the shared findings catalog. Each row is a
  // rule (e.g. mx.ui.openForm) with the count of modules/components whose JS actions
  // trigger it. Mirrors getIssues (widgets) / getJavaIssues (Java modules). Returns
  // [] when the JS tables are absent (older DB).
  getJSActionIssues() {
    if (!this._tableExists('module_js_findings')) return [];
    return this.query(`
      SELECT
        f.id, f.rule, f.category, f.description, f.doc_url, f.doc_anchor, f.facets,
        MAX(mjf.certain) AS certain,
        COUNT(DISTINCT m.id)  AS module_count,
        COUNT(DISTINCT c.id)  AS component_count,
        GROUP_CONCAT(DISTINCT c.content_type) AS content_types
      FROM findings f
      JOIN module_js_findings mjf ON f.id = mjf.finding_id
      JOIN modules m ON mjf.module_id = m.id
      JOIN components c ON c.id = m.component_id
      GROUP BY f.id
      ORDER BY
        CASE f.category
          WHEN 'removed-always'    THEN 0
          WHEN 'react-client-only' THEN 1
          WHEN 'behavior-change'   THEN 2
          ELSE 3
        END, module_count DESC
    `);
  }

  getJSActionIssueAffectedModules(findingId) {
    if (!this._tableExists('module_js_findings')) return [];
    return this.query(`
      SELECT
        m.id AS module_id, m.name AS module_name, m.version,
        MAX(mjf.match_count) AS match_count, MAX(mjf.certain) AS certain,
        c.name AS component_name, c.support_type,
        c.marketplace_id, c.content_type, c.download_count, c.prod_apps_mx10
      FROM module_js_findings mjf
      JOIN modules m ON mjf.module_id = m.id
      JOIN components c ON c.id = m.component_id
      WHERE mjf.finding_id = ?
      GROUP BY m.id
      ORDER BY m.name
    `, [findingId]);
  }

  // =============================================================================
  // Version history
  // =============================================================================

  getComponentVersions(componentId) {
    return this.query(`
      SELECT cv.id, cv.version_id, cv.version_number, cv.name,
             cv.min_supported_mendix_version, cv.publication_date
      FROM component_versions cv
      WHERE cv.component_id = ?
      ORDER BY cv.publication_date DESC, cv.version_number DESC
    `, [componentId]);
  }

  // =============================================================================
  // Variant groups (web vs native widget pairs)
  // =============================================================================

  // =============================================================================
  // Module dependency resolution
  // =============================================================================

  // Returns everything needed to resolve module dependency names to components:
  //   nameIndex:    { module_model_name → [{id, name, permalink}] }  (1+ entries = collision)
  //   componentDeps: { component_id → [dep_module_names] }
  getDependencyContext() {
    const rows = this.query(`
      SELECT m.name AS module_name, COALESCE(m.module_deps_json, '[]') AS module_deps_json,
             c.id AS component_id, c.marketplace_id, c.name AS component_name, c.permalink
      FROM modules m
      JOIN components c ON c.id = m.component_id
    `);
    const nameIndex = {};     // module_name → [{id, name, permalink}]
    const componentDeps = {}; // component_id → Set<depName>

    for (const r of rows) {
      // name index
      if (!nameIndex[r.module_name]) nameIndex[r.module_name] = [];
      const existing = nameIndex[r.module_name];
      if (!existing.find(e => e.id === r.component_id)) {
        existing.push({ id: r.component_id, marketplace_id: r.marketplace_id, name: r.component_name, permalink: r.permalink });
      }
      // component deps
      let deps;
      try { deps = JSON.parse(r.module_deps_json); } catch { deps = []; }
      if (deps.length > 0) {
        if (!componentDeps[r.component_id]) componentDeps[r.component_id] = new Set();
        for (const d of deps) componentDeps[r.component_id].add(d);
      }
    }

    // Convert Sets to sorted arrays
    for (const id of Object.keys(componentDeps)) {
      componentDeps[id] = [...componentDeps[id]].sort();
    }

    return { nameIndex, componentDeps };
  }

  // =============================================================================
  // Health stats (non-compatibility quality warnings)
  // =============================================================================

  getHealthStats() {
    const components = this.getComponents();
    const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;
    const cutoff = Date.now() - ONE_YEAR_MS;
    let notImportable = 0, stale = 0, unmanagedDeps = 0, starterNoReact = 0, starterNoMprV2 = 0;
    for (const c of components) {
      if (c.support_type === 'Deprecated') continue;
      const isModuleType = c.content_type === 'Module' || (c.module_count > 0 && c.content_type !== 'Widget');
      if (isModuleType && c.min_mx_version && this.compareVersions(c.min_mx_version, '10.21.0') < 0)
        notImportable++;
      const lastUpdate = c.last_publish_date || c.changed_date;
      if (lastUpdate && new Date(lastUpdate).getTime() < cutoff)
        stale++;
      if ((c.unmanaged_dep_count || 0) > 0)
        unmanagedDeps++;
      if (c.content_type === 'Starter App') {
        if (!c.react_client_ready) starterNoReact++;
        if (c.min_mx_version && this.compareVersions(c.min_mx_version, '9.24.0') < 0)
          starterNoMprV2++;
      }
    }
    return { notImportable, stale, unmanagedDeps, starterNoReact, starterNoMprV2 };
  }

  getWidgetVariants(widgetId) {
    return this.query(`
      SELECT vg.id AS group_id, vg.title, w.id, w.name, w.display_name
      FROM variant_groups vg
      JOIN variant_group_members vgm ON vgm.group_id = vg.id
      JOIN widgets w ON w.id = vgm.widget_id
      WHERE vg.id IN (
        SELECT vgm2.group_id FROM variant_group_members vgm2 WHERE vgm2.widget_id = ?
      )
      ORDER BY vg.title, w.display_name
    `, [widgetId]);
  }
}

// Export for use in webapp.html
window.DatabaseLayer = DatabaseLayer;
