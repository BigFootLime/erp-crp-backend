const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const patchPath = path.resolve(__dirname, '../../db/patches/20261013_minor_stock_compatibility_1294.sql');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const quote = value => value === null ? 'NULL' : typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;

// Synthetic fixtures exercise the actual migration query, never business rows.
const versions = [
  [1, 101, 'A', 'OBSOLETE', 'MAJOR', null, null],
  [2, 101, 'A', 'OBSOLETE', 'MINOR', false, 1],
  [3, 101, 'A', 'APPLICABLE', 'MINOR', false, 2],
  [4, 101, 'A', 'APPLICABLE', 'MINOR', false, 2],
  [5, 101, 'A', 'APPLICABLE', 'MAJOR', false, 3],
  [6, 101, 'A', 'APPLICABLE', 'MINOR', true, 3],
  [7, 101, 'A', 'APPLICABLE', 'MINOR', null, 3],
  [8, 101, 'A', 'DRAFT', 'MINOR', false, 3],
  [9, 101, 'B', 'APPLICABLE', 'MINOR', false, 3],
  [10, 102, 'A', 'APPLICABLE', 'MINOR', false, 3],
  [11, 101, 'A', 'REVIEWED', 'MINOR', false, 3],
  [12, 103, 'C', 'APPLICABLE', 'MINOR', false, 13],
  [13, 103, 'C', 'OBSOLETE', 'MINOR', false, 12],
  [14, 101, 'A', 'APPLICABLE', 'MINOR', false, 99],
  [15, 101, 'A', 'APPLICABLE', 'MINOR', false, 8],
  [16, 101, 'A', 'APPLICABLE', 'MINOR', false, 5],
];
const cases = [
  ['new-stock-earlier-order', 1, 3, true],
  ['old-stock-current-order', 3, 1, true],
  ['minor-branch-forward', 4, 3, true],
  ['minor-branch-reverse', 3, 4, true],
  ['major-same-indice-refused', 3, 5, false],
  ['minor-after-major-cannot-cross', 16, 3, false],
  ['approved-minor-after-major', 16, 5, true],
  ['impacting-minor-refused', 3, 6, false],
  ['unknown-impact-refused', 3, 7, false],
  ['draft-refused', 3, 8, false],
  ['draft-identity-refused', 8, 8, false],
  ['different-indice-refused', 3, 9, false],
  ['different-piece-refused', 3, 10, false],
  ['unapproved-refused', 3, 11, false],
  ['cycle-terminates', 12, 13, true],
  ['approved-identity', 1, 1, true],
  ['missing-parent-refused', 3, 14, false],
  ['unapproved-parent-cannot-cross', 15, 3, false],
];

function buildReadOnlyCasesQuery() {
  const patch = fs.readFileSync(patchPath, 'utf8');
  const from = patch.indexOf('WITH RECURSIVE '), to = patch.indexOf(';', from);
  assert(from >= 0 && to > from, 'Missing migration query');
  let query = patch.slice(from, to).replaceAll('public.piece_technique_versions', 'fixture_versions');
  const rows = versions.map(([id, piece, indice, status, level, impact, parent]) =>
    `(${quote(uuid(id))}::uuid,${quote(uuid(piece))}::uuid,${quote(indice)}::text,${quote(status)}::text,${quote(level)}::text,${quote(impact)}::boolean,${parent === null ? 'NULL' : quote(uuid(parent))}::uuid)`);
  query = query.replace('WITH RECURSIVE ', `WITH RECURSIVE fixture_versions(id,piece_technique_id,indice,statut,change_level,impact_interchangeabilite,copied_from_version_id) AS (VALUES ${rows.join(',')}), `);
  const select = query.lastIndexOf('SELECT target_version_id, stock_version_id FROM compatible');
  assert(select > 0, 'Missing final projection');
  const expectations = cases.map(([name, target, stock, expected]) => `(${quote(name)},${quote(uuid(target))}::uuid,${quote(uuid(stock))}::uuid,${expected})`);
  return query.slice(0, select).trimEnd() + `, expected(name,target,stock,expected) AS (VALUES ${expectations.join(',')})
  SELECT expected.name, EXISTS(SELECT 1 FROM compatible WHERE target_version_id=expected.target AND stock_version_id=expected.stock)=expected.expected AS passed
  FROM expected
  UNION ALL
  SELECT 'unique-pairs', NOT EXISTS(SELECT 1 FROM compatible GROUP BY target_version_id,stock_version_id HAVING count(*)>1)
  UNION ALL
  SELECT 'all-pairs-symmetric', NOT EXISTS(SELECT 1 FROM compatible forward WHERE NOT EXISTS(SELECT 1 FROM compatible reverse WHERE reverse.target_version_id=forward.stock_version_id AND reverse.stock_version_id=forward.target_version_id))`;
}
function assertCases(rows) {
  assert.equal(rows.length, cases.length + 2);
  assert(rows.every(row => row.passed === true), JSON.stringify(rows.filter(row => !row.passed)));
  return { assertions: rows.length, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex'), cases: rows };
}
module.exports = { buildReadOnlyCasesQuery, assertCases };

if (require.main === module) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  (async () => {
    await client.connect();
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    assert(/^cerp_(test|stock1294_[a-z0-9_]+)$/.test(database), 'Verification requires a Test/isolated database');
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = assertCases((await client.query(buildReadOnlyCasesQuery())).rows);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ database, readOnly: true, ...result }));
  })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => client.end());
}
