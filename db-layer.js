// Database Query Layer — Mendix Marketplace Component Scanner
// Schema: components → widgets/modules → widget_findings/module_findings

class DatabaseLayer {
  constructor(db) {
    this.db = db;
  }

  // Parse a dotted version into an array of numeric components. Handles any length
  // (min_mx_version is 3-part like "10.24.8"; a model version is 4-part like
  // "10.24.8.80126"; marketplace version numbers vary, e.g. "2412.225.0"). A
  // non-numeric or empty component parses as 0.
  parseVersion(v) {
    return (v || '').replace(/^v/, '').split('.').map(p => parseInt(p, 10) || 0);
  }

  // Compare two dotted numeric versions component-by-component, treating a missing
  // trailing component as 0 (so "2.1" == "2.1.0"). Returns >0 if a>b, <0 if a<b, 0 if
  // equal. Must NOT be lexicographic — "10.24.8" is greater than "9.24.0".
  compareVersions(a, b) {
    const av = this.parseVersion(a), bv = this.parseVersion(b);
    const n = Math.max(av.length, bv.length);
    for (let i = 0; i < n; i++) {
      const d = (av[i] || 0) - (bv[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
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

    // Internal team ownership (teams table + components.team_id) was added later;
    // guard so older embedded DBs without these still work.
    const hasTeams = this.columnExists('components', 'team_id');
    const teamSel = hasTeams
      ? `t.name AS owning_team, t.group_name AS owning_group, t.unit_name AS owning_unit,`
      : '';
    const teamJoin = hasTeams ? `LEFT JOIN teams t ON t.id = c.team_id` : '';

    const rows = this.query(`
      SELECT
        c.id, c.marketplace_id, c.name, c.content_type, c.support_type,
        ${modelVerSel} AS model_mx_versions,
        ${teamSel}
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
        COUNT(DISTINCT CASE WHEN COALESCE(m.has_js, 0) THEN m.id END) AS js_module_count,
        COUNT(DISTINCT CASE WHEN mf.certain THEN m.id END)           AS breaking_module_count,
        COUNT(DISTINCT mf.finding_id)                                 AS total_module_finding_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib AND NOT COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS unmanaged_dep_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib THEN m.id END)        AS userlib_module_count,
        COUNT(DISTINCT CASE WHEN COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS managed_dep_module_count
      FROM components c
      LEFT JOIN widgets w ON w.component_id = c.id
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN module_findings mf ON mf.module_id = m.id
      ${teamJoin}
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
    // Internal team ownership; guard for older DBs without the teams table.
    const hasTeams = this.columnExists('components', 'team_id');
    const teamSel = hasTeams
      ? `t.name AS owning_team, t.group_name AS owning_group, t.unit_name AS owning_unit,
         t.jira_project AS owning_jira, t.slack_channel AS owning_slack_channel, t.slack_url AS owning_slack_url,`
      : '';
    const teamJoin = hasTeams ? `LEFT JOIN teams t ON t.id = c.team_id` : '';
    return this.queryOne(`
      SELECT
        c.id, c.marketplace_id, c.name, c.content_type, c.support_type,
        ${modelVerSel} AS model_mx_versions,
        c.min_mx_version, c.react_client_ready, c.download_count, c.rating,
        c.permalink, c.publisher, c.latest_version, c.scan_error,
        c.prod_apps_mx9, c.prod_apps_mx10,
        c.git_hub_url, c.last_publish_date, c.changed_date, c.created_date,
        ${richCols}
        ${teamSel}
        COUNT(DISTINCT CASE WHEN m.has_userlib AND NOT COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS unmanaged_dep_count,
        COUNT(DISTINCT CASE WHEN m.has_userlib THEN m.id END)        AS userlib_module_count,
        COUNT(DISTINCT CASE WHEN COALESCE(m.has_managed_dependencies, 0) THEN m.id END) AS managed_dep_module_count,
        COUNT(DISTINCT m.id) AS module_count,
        COUNT(DISTINCT w.id) AS widget_count
      FROM components c
      LEFT JOIN modules m ON m.component_id = c.id
      LEFT JOIN widgets w ON w.component_id = c.id
      ${teamJoin}
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

  // Experimental / future-migration findings for a component (e.g. the javax
  // servlet/websocket migration signal). Lives in the isolated experiment_findings
  // tables, so it never touches a finalized query. Same row shape as
  // getComponentJavaFindings, so the Experiments-page drill-down reuses the identical
  // file:line + snippet rendering (snippets come from the shared module_java_sources).
  // Returns [] if the tables are absent (older embedded DBs).
  getExperimentalFindings(componentId) {
    if (!this._tableExists('module_experiment_findings')) return [];
    // Locations pack file~line~snippet, records separated by X'1e'. The snippet
    // column is empty for Java experiments (their snippet comes from
    // module_java_sources, keyed file:line) and populated for JS experiments.
    const rows = this.query(`
      SELECT
        'module' AS surface,
        m.id AS unit_id, m.name AS unit_name, m.version AS unit_version,
        ef.rule, ef.category, ef.description, ef.doc_url,
        mef.id AS finding_id, mef.match_count, mef.certain,
        GROUP_CONCAT(mefl.file_path || '~' || mefl.line_number || '~' || COALESCE(mefl.snippet, ''), X'1e') AS locations
      FROM module_experiment_findings mef
      JOIN modules m ON m.id = mef.module_id
      JOIN experiment_findings ef ON ef.id = mef.finding_id
      LEFT JOIN module_experiment_finding_locations mefl ON mefl.module_experiment_finding_id = mef.id
      WHERE m.component_id = ?
      GROUP BY mef.id
      ORDER BY m.name, ef.rule
    `, [componentId]);

    // Widget experiment findings (global-mx in bundled widget JS), same shape.
    if (this._tableExists('widget_experiment_findings')) {
      for (const r of this.query(`
        SELECT
          'widget' AS surface,
          w.id AS unit_id, COALESCE(w.display_name, w.name) AS unit_name, w.version AS unit_version,
          ef.rule, ef.category, ef.description, ef.doc_url,
          wef.id AS finding_id, wef.match_count, wef.certain,
          GROUP_CONCAT(wefl.file_path || '~' || wefl.line_number || '~' || COALESCE(wefl.snippet, ''), X'1e') AS locations
        FROM widget_experiment_findings wef
        JOIN widgets w ON w.id = wef.widget_id
        JOIN experiment_findings ef ON ef.id = wef.finding_id
        LEFT JOIN widget_experiment_finding_locations wefl ON wefl.widget_experiment_finding_id = wef.id
        WHERE w.component_id = ?
        GROUP BY wef.id
        ORDER BY unit_name, ef.rule
      `, [componentId])) rows.push(r);
    }
    return rows;
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

  // Distinct owning-team names (for the Components-page team filter). Empty when
  // the DB predates internal ownership.
  getDistinctTeams() {
    if (!this.columnExists('components', 'team_id')) return [];
    return this.query(`SELECT DISTINCT name AS team FROM teams ORDER BY name`);
  }

  // Whether the dataset carries any experimental findings. The public (redacted)
  // build empties the experiment tables, so the Experiments nav item and page have
  // nothing to show — callers use this to hide them. Checks the module surface (the
  // widget-experiment table is always a superset-or-equal signal, so module presence
  // alone is a safe proxy; both are emptied together in redaction).
  hasExperimentData() {
    if (!this._tableExists('module_experiment_findings')) return false;
    const rows = this.query(`SELECT COUNT(*) AS n FROM module_experiment_findings`);
    let n = (rows[0] && rows[0].n) || 0;
    if (n === 0 && this._tableExists('widget_experiment_findings')) {
      const wr = this.query(`SELECT COUNT(*) AS n FROM widget_experiment_findings`);
      n = (wr[0] && wr[0].n) || 0;
    }
    return n > 0;
  }

  // All internal teams that own at least one scanned component, with a component
  // count and the aggregate compatibility breakdown across their components. Powers
  // the Teams page. Returns [] when the DB predates internal ownership.
  getTeams() {
    if (!this.columnExists('components', 'team_id')) return [];
    return this.query(`
      SELECT
        t.id, t.name, t.group_name, t.unit_name, t.jira_project,
        t.slack_channel, t.slack_url,
        COUNT(DISTINCT c.id) AS component_count,
        COUNT(DISTINCT CASE WHEN cs.breaking THEN c.id END) AS breaking_component_count,
        SUM(c.download_count) AS total_downloads
      FROM teams t
      LEFT JOIN components c ON c.team_id = t.id
      LEFT JOIN (
        SELECT
          c.id,
          (COUNT(DISTINCT CASE WHEN w.broken_always THEN w.id END) > 0
            OR COUNT(DISTINCT CASE WHEN w.breaks116 THEN w.id END) > 0
            OR COUNT(DISTINCT CASE WHEN mf.certain THEN m.id END) > 0) AS breaking
        FROM components c
        LEFT JOIN widgets w ON w.component_id = c.id
        LEFT JOIN modules m ON m.component_id = c.id
        LEFT JOIN module_findings mf ON mf.module_id = m.id
        GROUP BY c.id
      ) cs ON cs.id = c.id
      GROUP BY t.id
      ORDER BY breaking_component_count DESC, component_count DESC, t.name
    `);
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

    // Experimental / future-migration findings (isolated experiment_findings tables).
    // Tallied here so the Experiments-page facet/column status can be resolved the same
    // way as the finalized facets — but their keys (e.g. experiment-javax) are NOT in
    // FACET_DEFS, so componentFacetStatus never folds them into the finalized facets.
    if (this._tableExists('module_experiment_findings')) {
      for (const r of this.query(`
        SELECT m.component_id AS cid, ef.facets AS facets, mef.certain AS certain
        FROM modules m
        JOIN module_experiment_findings mef ON mef.module_id = m.id
        JOIN experiment_findings ef ON ef.id = mef.finding_id
        WHERE COALESCE(ef.facets, '') <> ''
      `)) tally(r.cid, r.facets, r.certain);
    }

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

    // Widget experiment findings (global-mx in bundled widget JS). Same isolated
    // contract as the module experiments — keys (experiment-mx-global, …) are not
    // in FACET_DEFS, so they never fold into the finalized facets.
    if (this._tableExists('widget_experiment_findings')) {
      for (const r of this.query(`
        SELECT w.component_id AS cid, ef.facets AS facets, wef.certain AS certain
        FROM widgets w
        JOIN widget_experiment_findings wef ON wef.widget_id = w.id
        JOIN experiment_findings ef ON ef.id = wef.finding_id
        WHERE COALESCE(ef.facets, '') <> ''
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
    // Locations (path~line~snippet, records separated by X'1e') back the finding
    // tree + snippet viewer. LEFT JOIN so findings without stored locations (older
    // DBs, suppressed findings) still return, with locations null. Guarded so a DB
    // predating the widget_finding_locations table degrades to the plain list.
    const hasLocs = this._tableExists('widget_finding_locations');
    const locSelect = hasLocs
      ? `GROUP_CONCAT(wfl.file_path || '~' || wfl.line_number || '~' || COALESCE(wfl.snippet, ''), X'1e') AS locations`
      : `NULL AS locations`;
    const locJoin = hasLocs
      ? `LEFT JOIN widget_finding_locations wfl ON wfl.widget_finding_id = wf.id`
      : ``;
    return this.query(`
      SELECT
        f.id, f.rule, f.category, f.description, f.doc_url, f.doc_anchor,
        wf.match_count, wf.certain, wf.suppressed,
        ${locSelect}
      FROM widget_findings wf
      JOIN findings f ON f.id = wf.finding_id
      ${locJoin}
      WHERE wf.widget_id = ?
      GROUP BY wf.id
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
    const rows = this.query(`
      SELECT cv.id, cv.version_id, cv.version_number, cv.name,
             cv.min_supported_mendix_version, cv.publication_date
      FROM component_versions cv
      WHERE cv.component_id = ?
    `, [componentId]);
    // Sort by version NUMBER descending so versions[0] is the true latest. Ordering
    // by publication_date is wrong: a republished older release (e.g. an old Mendix 10
    // line patched for a library vulnerability) has the newest date but a lower number,
    // which would otherwise steal the "latest" badge. Version number is stable and
    // matches what the Marketplace surfaces as latest.
    return rows.sort((a, b) => {
      const cmp = this.compareVersions(b.version_number, a.version_number);
      if (cmp !== 0) return cmp;
      return (b.publication_date || '').localeCompare(a.publication_date || '');
    });
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


  // ===========================================================================
  // Snapshot history (dashboard trends)
  //
  // Written by pkg/history during the scan: every published report carries the
  // whole series, so there is no side file to load. Older databases predate
  // these tables, hence the guards — the dashboard falls back to today's
  // snapshot when history is absent.
  // ===========================================================================

  hasSnapshotHistory() {
    if (this._hasHistory !== undefined) return this._hasHistory;
    // Two snapshots is the minimum that can express a change.
    this._hasHistory = this._tableExists('snapshots')
      && this._tableExists('snapshot_rollups')
      && (this.queryOne(`SELECT COUNT(*) AS n FROM snapshots`) || {}).n >= 2;
    return this._hasHistory;
  }

  getSnapshots() {
    if (!this.hasSnapshotHistory()) return [];
    return this.query(`
      SELECT id, scanned_at, source_ref, component_count, movers_omitted
      FROM snapshots ORDER BY scanned_at
    `);
  }

  // All rollup cells, at criterion x content-type x support-type grain. Loaded
  // once and aggregated in JS — same pattern as getComponents(), and it is what
  // lets the dashboard's filters subset history without a query per toggle.
  getSnapshotRollups() {
    if (!this.hasSnapshotHistory()) return [];
    if (this._snapshotRollups) return this._snapshotRollups;
    this._snapshotRollups = this.query(`
      SELECT snapshot_id, criterion, content_type, support_type,
             components, pass, possible, open_fail, dep_fail, not_appl,
             COALESCE(open_fail_mx11_ready, 0) AS open_fail_mx11_ready,
             downloads, dl_pass, dl_possible, dl_open_fail, dl_dep_fail,
             COALESCE(dl_open_fail_mx11_ready, 0) AS dl_open_fail_mx11_ready
      FROM snapshot_rollups
    `);
    return this._snapshotRollups;
  }

  getSnapshotChanges() {
    if (!this.hasSnapshotHistory() || !this._tableExists('snapshot_changes')) return [];
    return this.query(`
      SELECT snapshot_id, criterion, fixed, deprecated, regressed, reclassified, arrived, departed
      FROM snapshot_changes
    `);
  }

  getSnapshotMovers() {
    if (!this.hasSnapshotHistory() || !this._tableExists('snapshot_movers')) return [];
    return this.query(`
      SELECT snapshot_id, criterion, marketplace_id, name, publisher,
             content_type, support_type, downloads, kind
      FROM snapshot_movers
      ORDER BY downloads DESC
    `);
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
