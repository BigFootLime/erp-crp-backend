import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const root = process.cwd()
const script = path.join(root, "scripts/contracts/realtime-invalidation-contract.mjs")
const temporary: string[] = []

async function fixture(source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "cerp-realtime-contract-"))
  temporary.push(dir)
  await writeFile(path.join(dir, "producer.ts"), source, "utf8")
  return { dir, output: path.join(dir, "catalog.json") }
}

function run(dir: string, output: string, check = false, extra: string[] = []) {
  return spawnSync(process.execPath, [script, ...extra, "--source", dir, "--output", output, ...(check ? ["--check"] : [])], {
    cwd: root,
    encoding: "utf8",
  })
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe("realtime invalidation producer contract", () => {
  it("extracts AST keys, resolves const spreads, normalizes templates, and ignores test/comment text", async () => {
    const { dir, output } = await fixture(`
      const detail = \`beta:\${id}\`
      const inherited = ["alpha", detail]
      enqueue({ invalidateKeys: [...inherited, "gamma:" + targetId] })
      // invalidateKeys: ["comment-only"]
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.authority).toBe("erp-crp-backend")
    expect(catalog.key_patterns).toEqual(["alpha", "beta:{id}", "gamma:{id}"])
    expect(catalog.generated_from.exhaustive).toBe(true)
    expect(catalog.unresolved_dynamic_sites).toEqual([])
  })

  it("reports unresolved dynamic producers and rejects a stale catalog in check mode", async () => {
    const { dir, output } = await fixture(`
      const keys = getInvalidationKeys()
      enqueue({ invalidateKeys: keys })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.generated_from.exhaustive).toBe(false)
    expect(catalog.unresolved_dynamic_sites).toEqual([expect.objectContaining({ reason: "invalidateKeys is not a statically resolvable array" })])
    expect(run(dir, output, true).status).toBe(0)
    await writeFile(path.join(dir, "producer.ts"), `enqueue({ invalidateKeys: ["new-key"] })`, "utf8")
    expect(run(dir, output, true).status).toBe(1)
  })

  it("does not resolve mutable, shadowed, or cyclic bindings, but supports shorthand const arrays", async () => {
    const { dir, output } = await fixture(`
      let mutable = ["mutable"]
      enqueue({ invalidateKeys: mutable })
      const scoped = ["outer"]
      function nested() { let scoped = ["inner"]; enqueue({ invalidateKeys: scoped }) }
      enqueue({ invalidateKeys: scoped })
      const cyclic = [...cyclic]
      enqueue({ invalidateKeys: cyclic })
      const invalidateKeys = ["shorthand"]
      enqueue({ invalidateKeys })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.key_patterns).toEqual(["shorthand"])
    expect(catalog.unresolved_dynamic_sites.length).toBeGreaterThanOrEqual(3)
    expect(catalog.unresolved_dynamic_sites.some((site: { reason: string }) => site.reason === "invalidateKeys const array is cyclic")).toBe(true)
  })

  it("rejects invalid CLI input before writes and excludes test and fixture directories", async () => {
    const { dir, output } = await fixture(`enqueue({ invalidateKeys: ["runtime"] })`)
    await Promise.all(["__tests__", "__fixtures__", "fixtures"].map(name => mkdir(path.join(dir, name))))
    await Promise.all(["__tests__", "__fixtures__", "fixtures"].map(name => writeFile(path.join(dir, name, "helper.ts"), `enqueue({ invalidateKeys: ["${name}"] })`)))
    await writeFile(path.join(dir, "ignored.test.ts"), `enqueue({ invalidateKeys: ["test-file"] })`)
    expect(run(dir, output).status).toBe(0)
    expect(JSON.parse(await readFile(output, "utf8")).key_patterns).toEqual(["runtime"])
    await writeFile(output, "unchanged", "utf8")
    expect(run(dir, output, false, ["--chekc"]).status).toBe(1)
    expect(await readFile(output, "utf8")).toBe("unchanged")
    expect(run(dir, output, false, ["--source"]).status).toBe(1)
  })
})
