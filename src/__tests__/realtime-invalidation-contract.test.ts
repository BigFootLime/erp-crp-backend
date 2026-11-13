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
  it("extracts inline AST keys and spreads, normalizes templates, and ignores test/comment text", async () => {
    const { dir, output } = await fixture(`
      const detail = \`beta:\${id}\`
      enqueue({ invalidateKeys: [...["alpha", detail], "gamma:" + targetId] })
      // invalidateKeys: ["comment-only"]
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.authority).toBe("erp-crp-backend")
    expect(catalog.key_patterns).toEqual(["alpha", "beta:{id}", "gamma:{id}"])
    expect(catalog.generated_from.exhaustive).toBe(true)
    expect(catalog.unresolved_dynamic_sites).toEqual([])
    const rendered = await readFile(output, "utf8")
    await writeFile(output, rendered.replaceAll("\n", "\r\n"), "utf8")
    expect(run(dir, output, true).status).toBe(0)
  })

  it("reports unresolved dynamic producers and rejects a stale catalog in check mode", async () => {
    const { dir, output } = await fixture(`
      const keys = getInvalidationKeys()
      enqueue({ invalidateKeys: keys })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.generated_from.exhaustive).toBe(false)
    expect(catalog.unresolved_dynamic_sites).toEqual([expect.objectContaining({ reason: "invalidateKeys array binding is not proven immutable" })])
    expect(run(dir, output, true).status).toBe(0)
    await writeFile(path.join(dir, "producer.ts"), `enqueue({ invalidateKeys: ["new-key"] })`, "utf8")
    expect(run(dir, output, true).status).toBe(1)
  })

  it("does not resolve array bindings that could be mutated or aliased", async () => {
    const { dir, output } = await fixture(`
      const pushed = ["before-push"]
      pushed.push("after-push")
      enqueue({ invalidateKeys: pushed })
      const indexed = ["before-index"]
      indexed[0] = "after-index"
      enqueue({ invalidateKeys: indexed })
      const original = ["aliased"]
      const alias = original
      alias.splice(0, 1, "changed-through-alias")
      enqueue({ invalidateKeys: original })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.key_patterns).toEqual([])
    expect(catalog.unresolved_dynamic_sites.length).toBeGreaterThanOrEqual(3)
    expect(catalog.unresolved_dynamic_sites.every((site: { reason: string }) => site.reason === "invalidateKeys array binding is not proven immutable")).toBe(true)
  })

  it("keeps inherited const spreads and conditional const arrays as conservative negative cases", async () => {
    const { dir, output } = await fixture(`
      const inherited = ["inherited"]
      enqueue({ invalidateKeys: [...inherited] })
      const conditional = condition ? ["left"] : ["right"]
      enqueue({ invalidateKeys: conditional })
      const invalidateKeys = ["shorthand"]
      enqueue({ invalidateKeys })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.key_patterns).toEqual([])
    expect(catalog.unresolved_dynamic_sites).toHaveLength(3)
    expect(catalog.unresolved_dynamic_sites.every((site: { reason: string }) => site.reason === "invalidateKeys array binding is not proven immutable")).toBe(true)
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

  it("unions both static conditional branches without evaluating the condition", async () => {
    const { dir, output } = await fixture(`
      enqueue({ invalidateKeys: condition ? (["left", \`detail:\${id}\`] as const) : (["right"] satisfies readonly string[]) })
      enqueue({ invalidateKeys: condition ? ["known"] : getKeys() })
    `)
    expect(run(dir, output).status).toBe(0)
    const catalog = JSON.parse(await readFile(output, "utf8"))
    expect(catalog.key_patterns).toEqual(["detail:{id}", "known", "left", "right"])
    expect(catalog.generated_from.exhaustive).toBe(false)
    expect(catalog.unresolved_dynamic_sites).toEqual([expect.objectContaining({ reason: "invalidateKeys is not a statically resolvable array" })])
  })
})
