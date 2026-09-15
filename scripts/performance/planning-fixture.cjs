const { createHash } = require('node:crypto');

/** Synthetic, reproducible operation graph. Never reads business data. */
function planningFixture({ count = 10000, resourceCount = 50, variant = 'unplanned' } = {}) {
  const from = '2026-01-01T00:00:00.000Z', to = '2027-01-01T00:00:00.000Z';
  const uuid = (kind, n) => `${kind.toString(16).padStart(8, '0')}-0970-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const availability = [];
  for (let day = 0; day < 365; day++) {
    const start = Date.parse(from) + day * 86400000 + 7 * 3600000;
    if (![0, 6].includes(new Date(start).getUTCDay())) availability.push({ start: new Date(start).toISOString(), end: new Date(start + 8 * 3600000).toISOString() });
  }
  const resources = Array.from({ length: resourceCount }, (_, i) => ({ id: `machine:${uuid(970, i + 1)}`, kind: 'MACHINE', label: `Machine ${i + 1}`, timezone: 'Europe/Paris', availability, version: '1' }));
  const tasks = Array.from({ length: count }, (_, i) => {
    const operationId = uuid(971, i + 1), machine = resources[Math.floor(i / 10) % resourceCount];
    const minutes = 15 * (1 + (i * 7 % 8));
    const start = Date.parse(availability[Math.floor(i / resourceCount / 10) % availability.length].start) + i % 10 * 45 * 60000;
    const committed = variant === 'planned' || variant === 'mixed' && i % 5 !== 0 ? { start: new Date(start).toISOString(), end: new Date(start + 30 * 60000).toISOString() } : null;
    return { id: `op:${operationId}`, source: 'OPERATION', operationId, programmingId: null, ofId: 970000 + Math.floor(i / 10), orderId: null,
      ofNumber: `PERF-970-${String(Math.floor(i / 10)).padStart(4, '0')}`, reference: 'PIECE-PERF-970', revision: null, label: `Phase ${i % 10 + 1}`,
      view: 'machines', internal: false, internalPurpose: null, quantity: 10, good: 0, scrap: 0, rework: 0, released: 0,
      resourceIds: [machine.id], eligibleResourceIds: [machine.id], committed, forecast: null, actual: null,
      commitment: committed ? 'COMMITTED' : 'FORECAST', locked: false, readiness: 'READY', blockers: [], earliestStart: null,
      due: to, priority: Math.floor(i / 10) % 4, createdAt: from, version: '1',
      estimate: { policy: 'fixture-970-v1', setupMinutes: 0, unitMinutes: minutes, remainingMinutes: minutes,
        provenance: 'ROUTING', confidence: 'INITIAL', observations: 0, dispersionMinutes: null, provisional: false, excluded: [] } };
  });
  const dependencies = tasks.flatMap((t, i) => i % 10 ? [{ predecessorId: tasks[i - 1].id, successorId: t.id, transferQuantity: null, releasedQuantity: 0, lagMinutes: 0 }] : []);
  const input = { tasks, resources, dependencies, from, requested: tasks.map(t => ({ taskId: t.id, earliestStart: from })) };
  return { ...input, to, hash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}
module.exports = { planningFixture };
