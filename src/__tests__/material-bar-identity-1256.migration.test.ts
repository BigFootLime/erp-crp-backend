import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/repo-paths';
const require = createRequire(import.meta.url);
const { orderPatchDependencies } = require(resolve(repoRoot, 'scripts/migrations/patch-dependencies.js'));
const patch = readFileSync(resolve(repoRoot, 'db/patches/20261013_material_bar_identity_1256.sql'), 'utf8');

describe('combined physical-bar identity migration', () => {
  it('applies after both identification and transfer extensions regardless of inventory order', () => {
    const files = ['20261013_material_bar_identity_1256.sql', '20261012_material_bar_identification_1248.sql',
      '20261012_physical_material_bar_movements_1246.sql', '20261012_physical_material_bars_1246.sql'];
    const order = orderPatchDependencies(files);
    expect(order.at(-1)).toBe('20261013_material_bar_identity_1256.sql');
    expect(order.indexOf('20261012_physical_material_bars_1246.sql')).toBeLessThan(order.indexOf('20261012_physical_material_bar_movements_1246.sql'));
  });

  it('keeps barcode immutability and the full canonical transfer proof in one guard', () => {
    expect(patch).toContain('NEW.public_number IS DISTINCT FROM OLD.public_number');
    expect(patch).toContain('NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm');
    expect(patch).toContain('stock_material_bar_reservations');
    expect(patch).toContain("leg.movement_type::text='OUT'");
    expect(patch).toContain("leg.movement_type::text='IN'");
    expect(patch).toContain('moved_length IS DISTINCT FROM proof.qty');
    expect(patch).not.toMatch(/(?:DROP TABLE|DELETE FROM|UPDATE public\.stock_|ALTER TABLE)/i);
  });

  it('rolls back only the function while retaining numbers, rows and transfer evidence', () => {
    const rollback = readFileSync(resolve(repoRoot, 'db/patches/support/20261013_material_bar_identity_1256.rollback.sql'), 'utf8');
    expect(rollback).toContain('NEW.public_number IS DISTINCT FROM OLD.public_number');
    expect(rollback).not.toMatch(/(?:DROP TABLE|DELETE FROM|UPDATE public\.stock_|DROP COLUMN)/i);
  });
});
