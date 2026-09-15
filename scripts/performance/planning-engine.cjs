const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
// Benchmark the checked-out TypeScript without changing application build output.
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { planningFixture } = require('./planning-fixture.cjs');
const { schedule } = require('../../src/module/planning/domain/central-scheduler');
const { expandCalendar } = require('../../src/module/planning/domain/central-calendar');
const fixture = planningFixture();
const samples = [];
for (let run = 0; run < Number(process.env.PERF_RUNS || 3); run++) {
  const start = performance.now();
  const result = schedule(fixture);
  if (!result.feasible || result.changes.length !== 10000) throw new Error('Incomplete or infeasible synthetic schedule');
  const simulationMs = performance.now() - start;
  const localStart = performance.now();
  const local = schedule({ ...fixture, tasks: fixture.tasks.map(t => ({ ...t, committed: result.forecasts[t.id], commitment: 'COMMITTED' })), requested: [fixture.requested[0]] });
  if (local.affected.length !== 10) throw new Error('Incorrect impact closure');
  samples.push({ simulationMs, impactMs: performance.now() - localStart });
}
const calStart = performance.now();
const intervals = expandCalendar({ timezone: 'Europe/Paris', shifts: [1,2,3,4,5].map(weekday => ({ weekday, startMinute: 480, endMinute: 960 })), closures: [], closedDates: [] }, fixture.from, fixture.to);
const report = { kind: 'engine-only-not-preproduction-proof', fixture: { hash: fixture.hash, resources: 50, operations: 10000 }, node: process.version,
  host: { platform: os.platform(), cpu: os.cpus()[0].model, cores: os.cpus().length }, samples, calendarMs: performance.now() - calStart, intervals: intervals.length };
console.log(JSON.stringify(report, null, 2));
if (process.env.PERF_OUTPUT) fs.writeFileSync(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n');
