import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '..', '..');

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('finance legal mentions migration guards (#221)', () => {
  const initialPatch = readRepositoryFile(
    'db/patches/20260729_finance_legal_mentions.sql'
  );
  const hardeningPatch = readRepositoryFile(
    'db/patches/20260729_finance_legal_mentions_hardening_221.sql'
  );
  const preflight = readRepositoryFile(
    'db/patches/support/20260729_finance_legal_mentions.preflight.sql'
  );
  const verification = readRepositoryFile(
    'db/patches/support/20260729_finance_legal_mentions.verify.sql'
  );
  const rollback = readRepositoryFile(
    'db/patches/support/20260729_finance_legal_mentions.rollback.sql'
  );

  it('keeps both patches transactional and avoids destructive table operations', () => {
    for (const patch of [initialPatch, hardeningPatch]) {
      expect(patch).toMatch(/\bBEGIN\s*;/i);
      expect(patch).toMatch(/\bCOMMIT\s*;/i);
      expect(patch).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(patch).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it('prevents overlapping legal versions and resolves one deterministic version', () => {
    expect(hardeningPatch).toMatch(/pg_advisory_xact_lock/i);
    expect(hardeningPatch).toMatch(/daterange\s*\(/i);
    expect(hardeningPatch).toMatch(
      /CREATE\s+TRIGGER\s+finance_legal_mentions_no_overlap_trg/i
    );
    expect(hardeningPatch).toMatch(/LEFT\s+JOIN\s+LATERAL/i);
    expect(hardeningPatch).toMatch(
      /ORDER\s+BY\s+resolved\.effective_from\s+DESC,\s*resolved\.version\s+DESC/i
    );
    expect(hardeningPatch).toMatch(/LIMIT\s+1/i);
  });

  it('keeps the preflight read-only', () => {
    expect(preflight).not.toMatch(
      /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im
    );
  });

  it('verifies the overlap guard and the absence of ambiguous periods', () => {
    expect(verification).toMatch(
      /tg_finance_legal_mentions_no_overlap/i
    );
    expect(verification).toMatch(
      /finance_legal_mentions_no_overlap_trg/i
    );
    expect(verification).toMatch(/overlap/i);
    expect(verification).toMatch(/périodes de mentions qui se chevauchent/i);
  });

  it('restricts rollback to cerp_test and refuses snapshotted documents', () => {
    expect(rollback).toMatch(/current_database\(\)\s*<>\s*'cerp_test'/i);
    expect(rollback).toMatch(
      /legal_number\s+IS\s+NOT\s+NULL\s+OR\s+issuer_snapshot\s+IS\s+NOT\s+NULL/i
    );
    expect(rollback).toMatch(
      /DROP\s+TRIGGER\s+IF\s+EXISTS\s+finance_legal_mentions_no_overlap_trg/i
    );
  });
});
