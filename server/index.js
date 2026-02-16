import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dns from 'node:dns/promises';

const app = express();
const PORT = Number(process.env.PORT) || 3010;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

const connectionString =
  process.env.DB_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/domains';

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_SIZE) || 10,
});

const DOMAINS_TABLE = process.env.DOMAINS_TABLE || 'expired_domains';

function parseTableRef(ref) {
  const raw = String(ref || '').trim();
  const parts = raw.split('.').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return { schema: 'public', table: parts[0] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { schema: 'public', table: 'expired_domains' };
}

function quoteIdent(id) {
  const s = String(id);
  // Double-quote identifiers; escape internal quotes
  return `"${s.replaceAll('"', '""')}"`;
}

function quoteTable(ref) {
  return `${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`;
}

let domainsTableMetaPromise = null;
async function getDomainsTableMeta() {
  if (!domainsTableMetaPromise) {
    domainsTableMetaPromise = (async () => {
      const tableRef = parseTableRef(DOMAINS_TABLE);
      const result = await pool.query(
        `
        SELECT column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position ASC;
        `,
        [tableRef.schema, tableRef.table]
      );
      const columns = result.rows || [];
      const byName = new Map();
      for (const c of columns) byName.set(String(c.column_name).toLowerCase(), c);
      return { tableRef, tableSql: quoteTable(tableRef), columns, byName };
    })().catch((err) => {
      console.warn(`Could not load table columns for ${DOMAINS_TABLE}:`, err?.message || err);
      return { tableRef: parseTableRef(DOMAINS_TABLE), tableSql: quoteTable(parseTableRef(DOMAINS_TABLE)), columns: [], byName: new Map() };
    });
  }
  return domainsTableMetaPromise;
}

function findFirstColumn(meta, candidates = []) {
  for (const name of candidates) {
    const key = String(name).toLowerCase();
    if (meta.byName.has(key)) return meta.byName.get(key).column_name;
  }
  return null;
}

function findColumnsLike(meta, re) {
  return (meta.columns || [])
    .map((c) => c.column_name)
    .filter((n) => re.test(String(n).toLowerCase()));
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function splitList(v) {
  const s = normalizeString(v);
  if (!s) return [];
  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeDomain(input) {
  const s = normalizeString(input);
  if (!s) return null;
  let x = s.trim();
  // Strip protocol
  x = x.replace(/^https?:\/\//i, '');
  // Strip path/query/hash
  x = x.split('/')[0];
  x = x.split('?')[0];
  x = x.split('#')[0];
  // Strip port
  x = x.split(':')[0];
  // Trim dots
  x = x.replace(/^\.+/, '').replace(/\.+$/, '');
  x = x.toLowerCase();
  // Basic validation
  if (!/^[a-z0-9.-]+$/.test(x)) return null;
  if (!x.includes('.')) return null;
  return x;
}

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, options, { timeoutMs = 12_000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withTimeout(fetch(url, options), timeoutMs, 'fetch_timeout');
      if (res.status >= 500 || res.status === 429) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status} ${text}`.slice(0, 500));
        if (attempt < retries) {
          await sleep(250 * Math.pow(2, attempt));
          continue;
        }
      }
      const text = await res.text().catch(() => '');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { res, text, json };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(250 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr || new Error('fetch_failed');
}

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/db/tables', async (_, res) => {
  try {
    const result = await pool.query(
      `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema ASC, table_name ASC;
      `
    );
    res.json({
      tables: (result.rows || []).map((r) => ({
        schema: r.table_schema,
        name: r.table_name,
        type: r.table_type,
      })),
    });
  } catch (err) {
    console.error('Tables error:', err);
    res.status(500).json({ error: err.message || 'Failed to list tables' });
  }
});

app.get('/api/db/columns', async (req, res) => {
  try {
    const tableParam = normalizeString(req.query?.table);
    const ref = parseTableRef(tableParam || DOMAINS_TABLE);
    const result = await pool.query(
      `
      SELECT
        ordinal_position,
        column_name,
        data_type,
        udt_name,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position ASC;
      `,
      [ref.schema, ref.table]
    );

    res.json({
      table: `${ref.schema}.${ref.table}`,
      columns: (result.rows || []).map((c) => ({
        position: Number(c.ordinal_position),
        name: c.column_name,
        dataType: c.data_type,
        udt: c.udt_name,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
      })),
    });
  } catch (err) {
    console.error('Columns error:', err);
    res.status(500).json({ error: err.message || 'Failed to list columns' });
  }
});

app.get('/api/capabilities', async (_, res) => {
  const meta = await getDomainsTableMeta();
  const columns = meta.columns || [];

  const waybackCandidates = [
    'wayback_snapshots',
    'wayback_total',
    'wayback_count',
    'webarchive_snapshots',
    'archive_snapshots',
    'archive_count',
  ];
  const spamhausCandidates = ['spamhaus', 'spamhouse', 'spamhaus_listed', 'spamhouse_listed'];
  const viewsTotalCandidates = ['viewstotal', 'views_total', 'viewstotal_listed', 'views_total_listed'];

  const domainColumn =
    findFirstColumn(meta, ['domain', 'hostname', 'host', 'name']) || findColumnsLike(meta, /domain/)[0] || null;
  const tldColumn = findFirstColumn(meta, ['tld', 'zone', 'tld_suffix']) || null;
  const createdColumn =
    findFirstColumn(meta, ['domain_creation_date', 'creation_date', 'created_at', 'registered_at', 'registration_date']) ||
    findColumnsLike(meta, /(creation|created|registered|registration)/)[0] ||
    null;
  const expiresColumn =
    findFirstColumn(meta, ['domain_expiration_date', 'expiration_date', 'expires_at', 'expires_on', 'expiry_date', 'expire_date']) ||
    findColumnsLike(meta, /(expiration|expire|expires|expiry)/)[0] ||
    null;
  const scheduledDeleteColumn =
    findFirstColumn(meta, ['drop_date', 'delete_date', 'deletion_date', 'pending_delete_date', 'scheduled_delete_date']) ||
    findColumnsLike(meta, /(drop|delete|deletion)/)[0] ||
    null;
  const deletedAtColumn =
    findFirstColumn(meta, ['deleted_at', 'dropped_at', 'removed_at']) || null;
  const deletedFlagColumn =
    findFirstColumn(meta, ['is_deleted', 'deleted', 'is_dropped', 'dropped', 'is_removed', 'removed']) || null;
  const statusColumn =
    findFirstColumn(meta, ['status', 'domain_status', 'state', 'domain_state', 'lifecycle']) || null;

  const waybackColumn =
    findFirstColumn(meta, waybackCandidates) || findColumnsLike(meta, /(wayback|archive)/)[0] || null;
  const spamhausColumn = findFirstColumn(meta, spamhausCandidates) || findColumnsLike(meta, /(spamhaus|spamhouse)/)[0] || null;
  const viewsTotalColumn = findFirstColumn(meta, viewsTotalCandidates) || findColumnsLike(meta, /(viewstotal|views_total)/)[0] || null;

  let statusValues = [];
  if (statusColumn) {
    try {
      const r = await pool.query(
        `SELECT DISTINCT ${quoteIdent(statusColumn)}::text AS v FROM ${meta.tableSql} WHERE ${quoteIdent(statusColumn)} IS NOT NULL LIMIT 50;`
      );
      statusValues = (r.rows || []).map((x) => x.v).filter(Boolean);
    } catch {
      statusValues = [];
    }
  }

  res.json({
    table: `${meta.tableRef.schema}.${meta.tableRef.table}`,
    columns: columns.map((c) => ({
      name: c.column_name,
      dataType: c.data_type,
      udt: c.udt_name,
    })),
    supports: {
      lifecycle:
        !!statusColumn ||
        !!expiresColumn ||
        !!scheduledDeleteColumn ||
        !!deletedAtColumn ||
        !!deletedFlagColumn,
      ageRange: !!createdColumn,
      creationDateRange: !!createdColumn,
      keywords: !!domainColumn,
      tld: !!tldColumn || !!domainColumn,
      wayback: !!waybackColumn,
      spamhaus: !!spamhausColumn,
      viewsTotal: !!viewsTotalColumn,
    },
    columnsPicked: {
      domainColumn,
      tldColumn,
      createdColumn,
      expiresColumn,
      scheduledDeleteColumn,
      deletedAtColumn,
      deletedFlagColumn,
      statusColumn,
      waybackColumn,
      spamhausColumn,
      viewsTotalColumn,
    },
    statusValues,
  });
});

// Live checks (Spamhaus only)
const checkCache = new Map(); // domain -> { ts, value }
const CHECK_TTL_MS = 15 * 60 * 1000;

let spamhausIntelAuth = null; // { token, expiresAtMs }
async function getSpamhausIntelToken() {
  const direct =
    process.env.SPAMHAUS_INTEL_API_KEY ||
    process.env.SPAMHAUS_API_KEY ||
    process.env.SPAMHAUS_INTEL_TOKEN ||
    null;
  if (direct) return { token: direct, source: 'api_key' };

  const username = process.env.SPAMHAUS_INTEL_USERNAME || null;
  const password = process.env.SPAMHAUS_INTEL_PASSWORD || null;
  if (!username || !password) return { token: null, source: 'missing' };

  // Cached token
  if (spamhausIntelAuth?.token && spamhausIntelAuth.expiresAtMs && Date.now() < spamhausIntelAuth.expiresAtMs - 60_000) {
    return { token: spamhausIntelAuth.token, source: 'login_cached' };
  }

  const base = (process.env.SPAMHAUS_INTEL_BASE_URL || 'https://api.spamhaus.com').replace(/\/+$/, '');
  const url = `${base}/api/v1/login`;
  const { res, json, text } = await fetchJsonWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password, realm: 'intel' }),
    },
    { timeoutMs: 12_000, retries: 1 }
  );

  if (!res.ok) throw new Error(`Spamhaus login failed: HTTP ${res.status} ${(text || '').slice(0, 200)}`);
  const token = json?.token || null;
  const expiresUnix = Number(json?.expires || 0);
  if (!token) throw new Error('Spamhaus login failed: no token in response');
  spamhausIntelAuth = {
    token,
    expiresAtMs: expiresUnix ? expiresUnix * 1000 : Date.now() + 23 * 60 * 60 * 1000,
  };
  return { token, source: 'login' };
}

async function checkSpamhaus(domain) {
  // Requirement: Spamhaus Intel API lookup.
  const base = (process.env.SPAMHAUS_INTEL_BASE_URL || 'https://api.spamhaus.com').replace(/\/+$/, '');
  const { token, source } = await getSpamhausIntelToken();
  if (!token) {
    return {
      supported: false,
      source: 'spamhaus_intel',
      error:
        source === 'missing'
          ? 'Missing Spamhaus Intel credentials (set SPAMHAUS_INTEL_API_KEY or SPAMHAUS_INTEL_USERNAME/PASSWORD)'
          : 'Missing Spamhaus Intel token',
    };
  }

  const url = `${base}/api/intel/v2/byobject/domain/${encodeURIComponent(domain)}`;
  try {
    const { res, json, text } = await fetchJsonWithRetry(
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      { timeoutMs: 12_000, retries: 1 }
    );

    if (res.status === 404) return { supported: true, source: 'spamhaus_intel', listed: false };
    if (res.status === 200) return { supported: true, source: 'spamhaus_intel', listed: true, raw: json ?? text };
    if (res.status === 401 || res.status === 403) {
      // invalidate cached login token
      spamhausIntelAuth = null;
      return { supported: true, source: 'spamhaus_intel', error: `Auth failed (HTTP ${res.status})` };
    }
    return { supported: true, source: 'spamhaus_intel', error: `HTTP ${res.status} ${(text || '').slice(0, 300)}` };
  } catch (err) {
    return { supported: true, source: 'spamhaus_intel', error: err?.message || String(err) };
  }
}

async function checkWayback(domain) {
  // Wayback Machine: availability check (fast) + CDX count (slower but gives numbers).
  const link = `https://web.archive.org/web/*/${encodeURIComponent(domain)}`;
  try {
    // Run both in parallel: availability (fast ~2s) + CDX count (~10-15s)
    const availPromise = fetchJsonWithRetry(
      `https://archive.org/wayback/available?url=http://${encodeURIComponent(domain)}`,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: 8_000, retries: 1 }
    ).catch(() => null);

    const cdxPromise = fetchJsonWithRetry(
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&matchType=exact&output=json&fl=timestamp&limit=10000`,
      { headers: { Accept: 'application/json' } },
      { timeoutMs: 25_000, retries: 0 }
    ).catch(() => null);

    const [availResult, cdxResult] = await Promise.all([availPromise, cdxPromise]);

    // Parse availability
    const closest = availResult?.res?.ok ? availResult.json?.archived_snapshots?.closest : null;
    const hasSnapshots = !!closest?.available;
    const lastSnapshot = closest?.timestamp
      ? `${closest.timestamp.slice(0, 4)}-${closest.timestamp.slice(4, 6)}-${closest.timestamp.slice(6, 8)}`
      : null;

    // Parse CDX count
    let snapshots = null;
    if (cdxResult?.res?.ok && Array.isArray(cdxResult.json) && cdxResult.json.length > 0) {
      snapshots = cdxResult.json.length - 1; // first row is header ["timestamp"]
      if (snapshots >= 9999) snapshots = '10000+';
    }

    return { supported: true, hasSnapshots, snapshots, lastSnapshot, link };
  } catch (err) {
    return { supported: true, error: err?.message || String(err), link };
  }
}

app.post('/api/domains/check', async (req, res) => {
  try {
    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return res.status(400).json({ error: 'Invalid domain' });

    const cached = checkCache.get(domain);
    if (cached && Date.now() - cached.ts < CHECK_TTL_MS) {
      return res.json({ domain, cached: true, ...cached.value });
    }

    const [spamhaus, wayback] = await Promise.all([checkSpamhaus(domain), checkWayback(domain)]);
    const value = { spamhaus, wayback };
    // Don't cache transient errors for long
    const hasError = spamhaus?.error || wayback?.error;
    if (!hasError) checkCache.set(domain, { ts: Date.now(), value });
    res.json({ domain, cached: false, ...value });
  } catch (err) {
    console.error('Domain check error:', err);
    res.status(500).json({ error: err.message || 'Check failed' });
  }
});

app.post('/api/domains/search', async (req, res) => {
  try {
    const body = req.body || {};
    const criteria = body.criteria || {};
    const meta = await getDomainsTableMeta();

    const has = (name) => meta.byName.has(String(name).toLowerCase());
    const pick = (cands, fallbackRe) =>
      findFirstColumn(meta, cands) || (fallbackRe ? findColumnsLike(meta, fallbackRe)[0] : null) || null;

    const domainColumn = pick(['domain', 'hostname', 'host', 'name'], /domain/);
    if (!domainColumn) {
      return res.status(500).json({ error: `No domain column found in table ${meta.tableRef.schema}.${meta.tableRef.table}` });
    }
    const tldColumn = pick(['tld', 'zone', 'tld_suffix'], null);
    const createdColumn = pick(
      ['domain_creation_date', 'creation_date', 'created_at', 'registered_at', 'registration_date'],
      /(creation|created|registered|registration)/
    );
    const expiresColumn = pick(
      ['domain_expiration_date', 'expiration_date', 'expires_at', 'expires_on', 'expiry_date', 'expire_date'],
      /(expiration|expire|expires|expiry)/
    );
    const scheduledDeleteColumn = pick(
      ['drop_date', 'delete_date', 'deletion_date', 'pending_delete_date', 'scheduled_delete_date'],
      /(drop|delete|deletion)/
    );
    const deletedAtColumn = pick(['deleted_at', 'dropped_at', 'removed_at'], null);
    const deletedFlagColumn = pick(['is_deleted', 'deleted', 'is_dropped', 'dropped', 'is_removed', 'removed'], null);
    const statusColumn = pick(['status', 'domain_status', 'state', 'domain_state', 'lifecycle'], null);

    const pageSize = clampInt(body.pageSize, 1, 500, 50);
    const page = clampInt(body.page, 1, 1_000_000_000, 1);
    const offset = (page - 1) * pageSize;

    const where = [];
    const values = [];
    const add = (fragment, ...vals) => {
      where.push(fragment);
      values.push(...vals);
    };

    const domainStartsWith = normalizeString(criteria.domainStartsWith);
    if (domainStartsWith) add(`${quoteIdent(domainColumn)} ILIKE $${values.length + 1}`, `${domainStartsWith}%`);

    const domainEndsWith = normalizeString(criteria.domainEndsWith);
    if (domainEndsWith) add(`${quoteIdent(domainColumn)} ILIKE $${values.length + 1}`, `%${domainEndsWith}`);

    const tlds = splitList(criteria.tld);
    if (tlds.length) {
      if (tldColumn) {
        add(`${quoteIdent(tldColumn)} = ANY($${values.length + 1}::text[])`, tlds);
      } else {
        // Fallback: match by domain suffix (works well for ".com")
        const patterns = tlds.map((t) => {
          const x = String(t).trim().replace(/^\./, '').toLowerCase();
          return `%.${x}`;
        });
        add(`LOWER(${quoteIdent(domainColumn)}) LIKE ANY($${values.length + 1}::text[])`, patterns);
      }
    }

    // Optional lifecycle filter (active / deleted / expiring).
    // IMPORTANT: must be side-effect free when not used.
    const lifecycleRaw = normalizeString(criteria.lifecycleState ?? criteria.expiredState);
    const lifecycle = lifecycleRaw ? String(lifecycleRaw).toLowerCase() : null;
    if (lifecycle) {
      const daysRaw = criteria.expiringWithinDays;
      const daysNum = Number(daysRaw);
      const days = Number.isFinite(daysNum) ? Math.max(1, Math.trunc(daysNum)) : 30;

      const statusColSql = statusColumn ? quoteIdent(statusColumn) : null;
      const deletedFlagSql = deletedFlagColumn ? quoteIdent(deletedFlagColumn) : null;
      const deletedAtSql = deletedAtColumn ? quoteIdent(deletedAtColumn) : null;
      const expiresSql = expiresColumn ? quoteIdent(expiresColumn) : null;
      const schedDelSql = scheduledDeleteColumn ? quoteIdent(scheduledDeleteColumn) : null;

      const deletedClauses = [];
      if (deletedFlagSql) {
        const info = meta.byName.get(String(deletedFlagColumn).toLowerCase());
        if (info?.data_type === 'boolean') deletedClauses.push(`${deletedFlagSql} IS TRUE`);
        else deletedClauses.push(`COALESCE(NULLIF(${deletedFlagSql}::text, ''), '0')::int > 0`);
      }
      if (deletedAtSql) deletedClauses.push(`NULLIF(${deletedAtSql}::text, '') IS NOT NULL`);

      // As a last resort, derive deleted-ness from status column patterns
      let deletedStatusFragment = null;
      if (!deletedClauses.length && statusColSql) {
        deletedStatusFragment = `${statusColSql}::text ILIKE ANY($${values.length + 1}::text[])`;
        add(deletedStatusFragment, ['%deleted%', '%dropped%', '%removed%']);
      }

      const deletedFragment = deletedClauses.length ? `(${deletedClauses.join(' OR ')})` : deletedStatusFragment;
      const notDeletedFragment = deletedFragment ? `NOT (${deletedFragment})` : null;

      if (lifecycle === 'deleted') {
        if (deletedFragment) add(deletedFragment);
      } else if (lifecycle === 'expiring') {
        if (notDeletedFragment) add(notDeletedFragment);
        if (schedDelSql) {
          add(
            `NULLIF(${schedDelSql}::text, '')::timestamp >= NOW() AND NULLIF(${schedDelSql}::text, '')::timestamp < (NOW() + ($${values.length + 1}::int || ' days')::interval)`,
            days
          );
        } else if (expiresSql) {
          add(
            `NULLIF(${expiresSql}::text, '')::timestamp >= NOW() AND NULLIF(${expiresSql}::text, '')::timestamp < (NOW() + ($${values.length + 1}::int || ' days')::interval)`,
            days
          );
        } else if (statusColSql) {
          add(`${statusColSql}::text ILIKE ANY($${values.length + 1}::text[])`, ['%expir%', '%pending%', '%to_delete%']);
        }
      } else if (lifecycle === 'active') {
        if (notDeletedFragment) add(notDeletedFragment);
        if (expiresSql) add(`NULLIF(${expiresSql}::text, '')::timestamp >= NOW()`);
        if (statusColSql) {
          add(`${statusColSql}::text ILIKE ANY($${values.length + 1}::text[])`, ['active', 'ok', 'registered', '%active%']);
        }
      }
    }

    const creationDateFrom = normalizeString(criteria.creationDateFrom);
    if (creationDateFrom && createdColumn) {
      add(`NULLIF(${quoteIdent(createdColumn)}::text, '')::date >= $${values.length + 1}`, creationDateFrom);
    }

    const creationDateTo = normalizeString(criteria.creationDateTo);
    if (creationDateTo && createdColumn) {
      add(`NULLIF(${quoteIdent(createdColumn)}::text, '')::date <= $${values.length + 1}`, creationDateTo);
    }

    let ageYearsFrom = normalizeString(criteria.ageYearsFrom);
    let ageYearsTo = normalizeString(criteria.ageYearsTo);
    if (createdColumn) {
      const aFrom = ageYearsFrom != null && ageYearsFrom !== '' ? Number(ageYearsFrom) : null;
      const aTo = ageYearsTo != null && ageYearsTo !== '' ? Number(ageYearsTo) : null;
      if (Number.isFinite(aFrom) || Number.isFinite(aTo)) {
        let minYears = Number.isFinite(aFrom) ? Math.max(0, Math.trunc(aFrom)) : null;
        let maxYears = Number.isFinite(aTo) ? Math.max(0, Math.trunc(aTo)) : null;
        if (minYears != null && maxYears != null && minYears > maxYears) {
          const tmp = minYears;
          minYears = maxYears;
          maxYears = tmp;
        }
        // older than or equal to minYears
        if (minYears != null) {
          add(
            `NULLIF(${quoteIdent(createdColumn)}::text, '')::date <= (CURRENT_DATE - ($${values.length + 1}::int || ' years')::interval)`,
            minYears
          );
        }
        // younger than or equal to maxYears
        if (maxYears != null) {
          add(
            `NULLIF(${quoteIdent(createdColumn)}::text, '')::date >= (CURRENT_DATE - ($${values.length + 1}::int || ' years')::interval)`,
            maxYears
          );
        }
      }
    }

    const country = normalizeString(criteria.countryByIp);
    if (country && has('country_by_ip')) add(`country_by_ip = $${values.length + 1}`, country);

    const registrarContains = normalizeString(criteria.registrarContains);
    if (registrarContains && has('registrar')) add(`registrar ILIKE $${values.length + 1}`, `%${registrarContains}%`);

    const technologiesContains = normalizeString(criteria.technologiesContains);
    if (technologiesContains && has('technologies')) add(`technologies ILIKE $${values.length + 1}`, `%${technologiesContains}%`);

    const responseStatusContains = normalizeString(criteria.responseStatusContains);
    if (responseStatusContains && has('response_status')) add(`response_status ILIKE $${values.length + 1}`, `%${responseStatusContains}%`);

    const detectedHostsMin = normalizeString(criteria.detectedHostsMin);
    if (detectedHostsMin && has('detected_hosts')) {
      add(`NULLIF(detected_hosts, '')::int >= $${values.length + 1}`, Number(detectedHostsMin));
    }

    const detectedHostsMax = normalizeString(criteria.detectedHostsMax);
    if (detectedHostsMax && has('detected_hosts')) {
      add(`NULLIF(detected_hosts, '')::int <= $${values.length + 1}`, Number(detectedHostsMax));
    }

    const expirationFrom = normalizeString(criteria.expirationFrom);
    if (expirationFrom && expiresColumn) {
      add(`NULLIF(${quoteIdent(expiresColumn)}::text, '')::timestamp >= $${values.length + 1}`, expirationFrom);
    }

    const expirationTo = normalizeString(criteria.expirationTo);
    if (expirationTo && expiresColumn) {
      add(`NULLIF(${quoteIdent(expiresColumn)}::text, '')::timestamp <= $${values.length + 1}`, expirationTo);
    }

    // Optional: Wayback / Blacklists (only if columns exist)
    const waybackMin = normalizeString(criteria.waybackMinSnapshots);
    const waybackColumn =
      findFirstColumn(meta, ['wayback_snapshots', 'wayback_total', 'wayback_count']) ||
      findColumnsLike(meta, /(wayback|archive)/)[0] ||
      null;
    if (waybackMin && waybackColumn) {
      add(
        `COALESCE(NULLIF(${quoteIdent(waybackColumn)}::text, ''), '0')::int >= $${values.length + 1}`,
        Number(waybackMin)
      );
    }

    const safeSpamhausOnly = criteria.safeSpamhausOnly === true;
    const spamhausColumn =
      findFirstColumn(meta, ['spamhaus_listed', 'spamhouse_listed', 'spamhaus', 'spamhouse']) ||
      findColumnsLike(meta, /(spamhaus|spamhouse)/)[0] ||
      null;
    if (safeSpamhausOnly && spamhausColumn) {
      const info = meta.byName.get(String(spamhausColumn).toLowerCase());
      const col = quoteIdent(spamhausColumn);
      if (info?.data_type === 'boolean') {
        add(`${col} IS NOT TRUE`);
      } else {
        add(`COALESCE(NULLIF(${col}::text, ''), '0')::int <= 0`);
      }
    }

    const safeViewsTotalOnly = criteria.safeViewsTotalOnly === true;
    const viewsTotalColumn =
      findFirstColumn(meta, ['views_total_listed', 'viewstotal_listed', 'views_total', 'viewstotal']) ||
      findColumnsLike(meta, /(viewstotal|views_total)/)[0] ||
      null;
    if (safeViewsTotalOnly && viewsTotalColumn) {
      const info = meta.byName.get(String(viewsTotalColumn).toLowerCase());
      const col = quoteIdent(viewsTotalColumn);
      if (info?.data_type === 'boolean') {
        add(`${col} IS NOT TRUE`);
      } else {
        add(`COALESCE(NULLIF(${col}::text, ''), '0')::int <= 0`);
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*)::bigint AS total FROM ${meta.tableSql} ${whereSql};`;
    const countResult = await pool.query(countSql, values);
    const total = Number(countResult.rows?.[0]?.total || 0);

    const selectCols = [];
    // Always return "domain" and "tld" for the client
    selectCols.push(`${quoteIdent(domainColumn)} AS domain`);
    if (tldColumn) selectCols.push(`${quoteIdent(tldColumn)} AS tld`);
    if (createdColumn) selectCols.push(`${quoteIdent(createdColumn)} AS domain_creation_date`);
    if (expiresColumn) selectCols.push(`${quoteIdent(expiresColumn)} AS domain_expiration_date`);
    if (scheduledDeleteColumn) selectCols.push(`${quoteIdent(scheduledDeleteColumn)} AS scheduled_delete_date`);
    if (statusColumn) selectCols.push(`${quoteIdent(statusColumn)} AS status`);
    if (deletedFlagColumn) selectCols.push(`${quoteIdent(deletedFlagColumn)} AS is_deleted`);
    if (deletedAtColumn) selectCols.push(`${quoteIdent(deletedAtColumn)} AS deleted_at`);

    // Optional existing known fields (keeps old UI columns if present)
    for (const c of [
      'tld_suffix',
      'technologies',
      'country_by_ip',
      'pr_value',
      'harmonic_value',
      'detected_hosts',
      'rdap_whois_last_data_checked',
      'rdap_whois_method',
      'domain_last_changed',
      'registrar',
      'response_status',
    ]) {
      if (has(c)) selectCols.push(`${quoteIdent(c)}`);
    }
    if (waybackColumn) selectCols.push(`${quoteIdent(waybackColumn)} AS wayback`);
    if (spamhausColumn) selectCols.push(`${quoteIdent(spamhausColumn)} AS spamhaus`);
    if (viewsTotalColumn) selectCols.push(`${quoteIdent(viewsTotalColumn)} AS viewstotal`);

    const listSql = `
      SELECT
        ${selectCols.join(',\n        ')}
      FROM ${meta.tableSql}
      ${whereSql}
      ORDER BY ${quoteIdent(domainColumn)} ASC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2};
    `;

    const listValues = [...values, pageSize, offset];
    const listResult = await pool.query(listSql, listValues);

    res.json({
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: listResult.rows || [],
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message || 'Search failed' });
  }
});

app.listen(PORT, () => {
  console.log(`API server: http://localhost:${PORT}`);
});

