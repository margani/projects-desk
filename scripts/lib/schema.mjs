// Validator for status files. Mirrors the schema table in STATUS_INSTRUCTIONS.md
// (schema_version 5). When that file's schema changes, update this file to match.

export const CURRENT_SCHEMA_VERSION = 5;

// Projects migrate one session at a time, so a schema bump would otherwise turn
// every not-yet-migrated project into a warning card. Versions from this one up
// still render, marked as needing migration.
export const OLDEST_RENDERED_VERSION = 1;

export const MAX_LINKS = 10;
// Desktop apps per project: optional, so existing files stay valid.
export const MAX_APPS = 10;
const OPTIONAL_FIELDS_BY_VERSION = { 5: ['apps'] };
// Was 5 while every project's steps shared the Overview; each has its own page now.
export const MAX_NEXT_STEPS = 10;

export const HEALTH_VALUES = ['ok', 'attention', 'blocked'];

const V1_FIELDS = [
  'schema_version', 'project', 'repo_url', 'urls', 'version', 'pending_release',
  'open_issues', 'owner_tasks', 'next_steps', 'health', 'health_reason',
  'last_session', 'summary',
];
const V2_FIELDS = [...V1_FIELDS, 'links'];
const V3_FIELDS = [...V2_FIELDS, 'closed_issues'];
const V4_FIELDS = [...V3_FIELDS, 'activity'];
// v5 keeps v4's fields; only the shape of "activity" changes (daily "days").
const FIELDS_BY_VERSION = { 1: V1_FIELDS, 2: V2_FIELDS, 3: V3_FIELDS, 4: V4_FIELDS, 5: V4_FIELDS };

export const MAX_ACTIVITY_WEEKS = 26;
export const MAX_ACTIVITY_DAYS = 14 * 7;
export const MAX_ACTIVITY_BUILDS = 50;
export const BUILD_SYSTEMS = ['github', 'cloudflare'];
export const BUILD_CONCLUSIONS = ['success', 'failure', 'cancelled', 'other'];
const WEEK_FIELDS = ['week', 'commits', 'issues_closed', 'lines_added', 'lines_deleted'];
const DAY_FIELDS = ['date', 'commits', 'issues_closed', 'lines_added', 'lines_deleted'];
const BUILD_FIELDS = ['system', 'name', 'started_at', 'duration_s', 'conclusion'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ISO_DATETIME_TZ =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isHttpUrl = (v) => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};
const isHttpsUrl = (v) => isHttpUrl(v) && v.startsWith('https://');

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Validate a parsed status object.
 * @param {unknown} data parsed JSON
 * @param {string} expectedProject file name without .json
 * @returns {string[]} list of problems; empty means valid
 */
export function validateStatus(data, expectedProject) {
  const problems = [];
  if (!isObject(data)) {
    return [`Top level must be a JSON object, got ${typeName(data)}.`];
  }

  // Schema version first: an old or unknown version makes every other check meaningless.
  if (!('schema_version' in data)) {
    return [
      `Missing "schema_version": this is an unversioned (v0) file. ` +
        `Migrate it to schema version ${CURRENT_SCHEMA_VERSION} as described in STATUS_INSTRUCTIONS.md.`,
    ];
  }
  const sv = data.schema_version;
  if (!Number.isInteger(sv)) {
    return [`"schema_version" must be an integer, got ${JSON.stringify(sv)}.`];
  }
  if (sv < OLDEST_RENDERED_VERSION) {
    return [
      `Old schema: "schema_version" is ${sv}, current is ${CURRENT_SCHEMA_VERSION}. ` +
        `Migrate it as described in STATUS_INSTRUCTIONS.md.`,
    ];
  }
  if (sv > CURRENT_SCHEMA_VERSION) {
    return [
      `"schema_version" is ${sv}, but this dashboard only understands ${CURRENT_SCHEMA_VERSION}. ` +
        `Update the dashboard's validator (scripts/lib/schema.mjs) and renderer.`,
    ];
  }

  const fields = FIELDS_BY_VERSION[sv];
  for (const field of fields) {
    if (!(field in data)) problems.push(`Missing field "${field}".`);
  }
  const optional = OPTIONAL_FIELDS_BY_VERSION[sv] ?? [];
  for (const field of Object.keys(data)) {
    if (!fields.includes(field) && !optional.includes(field)) problems.push(`Unknown field "${field}".`);
  }

  const check = (path, value, ok, expected) => {
    if (value === undefined) return; // already reported as missing
    if (!ok(value)) problems.push(`"${path}" must be ${expected}, got ${JSON.stringify(value)}.`);
  };
  const nullable = (fn) => (v) => v === null || fn(v);

  check('project', data.project, (v) => typeof v === 'string' && v.length > 0, 'a non-empty string');
  if (typeof data.project === 'string' && data.project !== expectedProject) {
    problems.push(
      `"project" is "${data.project}" but the file is named "${expectedProject}.json"; they must match.`,
    );
  }
  check('repo_url', data.repo_url, nullable(isHttpsUrl), 'an https:// URL or null');

  const nested = (parent, keys, ok, expected) => {
    const obj = data[parent];
    if (obj === undefined) return;
    if (!isObject(obj)) {
      problems.push(`"${parent}" must be an object with ${keys.map((k) => `"${k}"`).join(' and ')}.`);
      return;
    }
    for (const key of keys) {
      if (!(key in obj)) problems.push(`Missing field "${parent}.${key}".`);
      else check(`${parent}.${key}`, obj[key], ok[key], expected[key]);
    }
    for (const key of Object.keys(obj)) {
      if (!keys.includes(key)) problems.push(`Unknown field "${parent}.${key}".`);
    }
  };

  nested('urls', ['sandbox', 'production'],
    { sandbox: nullable(isHttpUrl), production: nullable(isHttpUrl) },
    { sandbox: 'an http(s) URL or null', production: 'an http(s) URL or null' });
  const nullableString = nullable((v) => typeof v === 'string' && v.length > 0);
  nested('version', ['sandbox', 'production'],
    { sandbox: nullableString, production: nullableString },
    { sandbox: 'a string or null', production: 'a string or null' });
  nested('pending_release', ['merged_prs', 'release_pr_url'],
    { merged_prs: nullable(isNonNegInt), release_pr_url: nullable(isHttpUrl) },
    { merged_prs: 'an integer ≥ 0 or null', release_pr_url: 'an http(s) URL or null' });

  check('open_issues', data.open_issues, nullable(isNonNegInt), 'an integer ≥ 0 or null');
  if (fields.includes('closed_issues')) {
    check('closed_issues', data.closed_issues, nullable(isNonNegInt), 'an integer ≥ 0 or null');
  }

  if (data.owner_tasks !== undefined) {
    if (!Array.isArray(data.owner_tasks)) {
      problems.push(`"owner_tasks" must be an array (use [] when empty), got ${typeName(data.owner_tasks)}.`);
    } else {
      data.owner_tasks.forEach((t, i) => {
        if (!isObject(t)) {
          problems.push(`"owner_tasks[${i}]" must be an object with "title" and "url".`);
          return;
        }
        check(`owner_tasks[${i}].title`, t.title, (v) => typeof v === 'string' && v.length > 0, 'a non-empty string');
        check(`owner_tasks[${i}].url`, t.url, isHttpUrl, 'an http(s) URL');
        if (!('title' in t)) problems.push(`Missing field "owner_tasks[${i}].title".`);
        if (!('url' in t)) problems.push(`Missing field "owner_tasks[${i}].url".`);
        for (const key of Object.keys(t)) {
          if (key !== 'title' && key !== 'url') problems.push(`Unknown field "owner_tasks[${i}].${key}".`);
        }
      });
    }
  }

  if (data.next_steps !== undefined) {
    if (!Array.isArray(data.next_steps)) {
      problems.push(`"next_steps" must be an array (use [] when empty), got ${typeName(data.next_steps)}.`);
    } else {
      if (data.next_steps.length > MAX_NEXT_STEPS) {
        problems.push(`"next_steps" has ${data.next_steps.length} items; the maximum is ${MAX_NEXT_STEPS}.`);
      }
      data.next_steps.forEach((s, i) => {
        check(`next_steps[${i}]`, s, (v) => typeof v === 'string' && v.length > 0, 'a non-empty string');
      });
    }
  }

  check('health', data.health, (v) => HEALTH_VALUES.includes(v), `one of ${HEALTH_VALUES.join(', ')}`);
  check('health_reason', data.health_reason, nullableString, 'a string or null');
  if ((data.health === 'attention' || data.health === 'blocked') && data.health_reason == null) {
    problems.push(`"health_reason" is required when health is "${data.health}".`);
  }

  check('last_session', data.last_session,
    (v) => typeof v === 'string' && ISO_DATETIME_TZ.test(v) && !Number.isNaN(Date.parse(v)),
    'an ISO-8601 datetime with timezone, e.g. 2026-10-06T21:30:00+01:00');
  check('summary', data.summary, nullableString, 'a string or null');

  if (fields.includes('links') && data.links !== undefined) {
    if (!Array.isArray(data.links)) {
      problems.push(`"links" must be an array (use [] when empty), got ${typeName(data.links)}.`);
    } else {
      if (data.links.length > MAX_LINKS) {
        problems.push(`"links" has ${data.links.length} items; the maximum is ${MAX_LINKS}.`);
      }
      data.links.forEach((l, i) => {
        if (!isObject(l)) {
          problems.push(`"links[${i}]" must be an object with "label" and "url".`);
          return;
        }
        if (!('label' in l)) problems.push(`Missing field "links[${i}].label".`);
        else check(`links[${i}].label`, l.label, (v) => typeof v === 'string' && v.trim().length > 0, 'a non-empty string');
        if (!('url' in l)) problems.push(`Missing field "links[${i}].url".`);
        else check(`links[${i}].url`, l.url, isHttpUrl, 'an http(s) URL');
        for (const key of Object.keys(l)) {
          if (key !== 'label' && key !== 'url') problems.push(`Unknown field "links[${i}].${key}".`);
        }
      });
    }
  }

  if (optional.includes('apps') && data.apps !== undefined) {
    if (!Array.isArray(data.apps)) {
      problems.push(`"apps" must be an array (use [] to show no Desktop icon), got ${typeName(data.apps)}.`);
    } else {
      if (data.apps.length > MAX_APPS) problems.push(`"apps" has ${data.apps.length} items; the maximum is ${MAX_APPS}.`);
      const seen = new Set();
      data.apps.forEach((a, i) => {
        if (!isObject(a)) {
          problems.push(`"apps[${i}]" must be an object with "name" and "url".`);
          return;
        }
        if (!('name' in a)) problems.push(`Missing field "apps[${i}].name".`);
        else check(`apps[${i}].name`, a.name, (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 40, 'a non-empty string of at most 40 characters');
        if (typeof a.name === 'string') {
          if (seen.has(a.name)) problems.push(`"apps[${i}].name" repeats "${a.name}"; each app needs its own name.`);
          seen.add(a.name);
        }
        if (!('url' in a)) problems.push(`Missing field "apps[${i}].url".`);
        else check(`apps[${i}].url`, a.url, isHttpUrl, 'an http(s) URL');
        if ('icon' in a) check(`apps[${i}].icon`, a.icon, nullable(isHttpsUrl), 'an https:// URL or null');
        for (const key of Object.keys(a)) {
          if (!['name', 'url', 'icon'].includes(key)) problems.push(`Unknown field "apps[${i}].${key}".`);
        }
      });
    }
  }

  if (fields.includes('activity') && data.activity !== undefined && data.activity !== null) {
    validateActivity(data.activity, problems, check, sv);
  }

  return problems;
}

/**
 * "activity" (v4: weekly "weeks"; v5: daily "days"). Written by the collector,
 * so problems here mean a hand edit or an old script.
 */
function validateActivity(a, problems, check, version) {
  const series = version >= 5 ? 'days' : 'weeks';
  if (!isObject(a)) {
    problems.push(`"activity" must be an object or null, got ${typeName(a)}.`);
    return;
  }
  const isoTz = (v) => typeof v === 'string' && ISO_DATETIME_TZ.test(v) && !Number.isNaN(Date.parse(v));
  for (const key of Object.keys(a)) {
    if (!['generated_at', series, 'builds'].includes(key)) problems.push(`Unknown field "activity.${key}".`);
  }
  if (!('generated_at' in a)) problems.push('Missing field "activity.generated_at".');
  else check('activity.generated_at', a.generated_at, isoTz, 'an ISO-8601 datetime with timezone');
  const list = (key, max, itemFields, checkItem) => {
    if (!(key in a)) { problems.push(`Missing field "activity.${key}".`); return; }
    const arr = a[key];
    if (!Array.isArray(arr)) { problems.push(`"activity.${key}" must be an array, got ${typeName(arr)}.`); return; }
    if (arr.length > max) problems.push(`"activity.${key}" has ${arr.length} items; the maximum is ${max}.`);
    arr.forEach((item, i) => {
      const p = `activity.${key}[${i}]`;
      if (!isObject(item)) { problems.push(`"${p}" must be an object.`); return; }
      for (const f of itemFields) if (!(f in item)) problems.push(`Missing field "${p}.${f}".`);
      for (const f of Object.keys(item)) if (!itemFields.includes(f)) problems.push(`Unknown field "${p}.${f}".`);
      checkItem(item, p);
    });
  };
  if (series === 'weeks') {
    list('weeks', MAX_ACTIVITY_WEEKS, WEEK_FIELDS, (w, p) => {
      check(`${p}.week`, w.week, (v) => typeof v === 'string' && ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).getUTCDay() === 1,
        'a Monday as YYYY-MM-DD');
      for (const f of WEEK_FIELDS.slice(1)) check(`${p}.${f}`, w[f], isNonNegInt, 'an integer ≥ 0');
    });
  } else {
    list('days', MAX_ACTIVITY_DAYS, DAY_FIELDS, (d, p) => {
      check(`${p}.date`, d.date, (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
        'a date as YYYY-MM-DD');
      for (const f of DAY_FIELDS.slice(1)) check(`${p}.${f}`, d[f], isNonNegInt, 'an integer ≥ 0');
    });
  }
  list('builds', MAX_ACTIVITY_BUILDS, BUILD_FIELDS, (b, p) => {
    check(`${p}.system`, b.system, (v) => BUILD_SYSTEMS.includes(v), `one of ${BUILD_SYSTEMS.join(', ')}`);
    check(`${p}.name`, b.name, (v) => typeof v === 'string' && v.length > 0, 'a non-empty string');
    check(`${p}.started_at`, b.started_at, isoTz, 'an ISO-8601 datetime with timezone');
    check(`${p}.duration_s`, b.duration_s, isNonNegInt, 'an integer ≥ 0 (seconds)');
    check(`${p}.conclusion`, b.conclusion, (v) => BUILD_CONCLUSIONS.includes(v), `one of ${BUILD_CONCLUSIONS.join(', ')}`);
  });
}

/**
 * Parse and validate raw file contents. Never throws. `outdated` marks a valid
 * file on an older schema that still renders.
 * @returns {{ name: string, ok: true, data: object, outdated: boolean } | { name: string, ok: false, problems: string[] }}
 */
export function loadStatus(name, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { name, ok: false, problems: [`Not valid JSON: ${err.message}`] };
  }
  const problems = validateStatus(data, name);
  if (problems.length) return { name, ok: false, problems };
  return { name, ok: true, data, outdated: data.schema_version < CURRENT_SCHEMA_VERSION };
}
