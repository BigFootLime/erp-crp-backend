import http from "node:http"
import nodeFs, { type PathLike, type WriteStreamOptions } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import express from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearRegisteredUploadDestinationsForTests,
  createSecureUpload,
  getRegisteredUploadDestinationCountForTests,
  setUploadHashChunkHookForTests,
} from "../shared/uploads/secure-upload"
import { setUploadScannerForTests } from "../shared/uploads/upload-scanner"

const VALID_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
const SECOND_VALID_PDF = Buffer.from("%PDF-1.4\n2 0 obj\n<< /Different true >>\nendobj\n%%EOF\n")

let temporaryRoot: string

async function storedFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

async function waitForNoStoredFiles(root: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await storedFiles(root)).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  expect(await storedFiles(root)).toEqual([])
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearRegisteredUploadDestinationsForTests()
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-upload-abort-"))
  process.env.CERP_TMP_ROOT = temporaryRoot
  process.env.CERP_UPLOAD_SCAN_MODE = "monitor"
})

afterEach(async () => {
  setUploadScannerForTests(null)
  setUploadHashChunkHookForTests(null)
  clearRegisteredUploadDestinationsForTests()
  delete process.env.CERP_TMP_ROOT
  delete process.env.CERP_UPLOAD_SCAN_MODE
  vi.restoreAllMocks()
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

describe("upload abort lifecycle", () => {
  it("settles once and removes the partial file when the staging output errors", async () => {
    const realCreateWriteStream = nodeFs.createWriteStream.bind(nodeFs)
    vi.spyOn(nodeFs, "createWriteStream").mockImplementation(((
      filePath: PathLike,
      options?: BufferEncoding | WriteStreamOptions
    ) => {
      const output = realCreateWriteStream(filePath, options)
      process.nextTick(() => output.destroy(Object.assign(new Error("staging write failed"), { code: "EIO" })))
      return output
    }) as typeof nodeFs.createWriteStream)
    const scan = vi.fn(async () => ({ status: "clean" as const, provider: "must-not-run" }))
    setUploadScannerForTests({ name: "must-not-run", scan })
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const downstream = vi.fn((_req, res: express.Response) => res.status(201).end())
    const app = express()
    app.post(
      "/upload",
      createSecureUpload("business-document", { storage: "staging" }).single("file"),
      downstream
    )
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).end()
    })

    const response = await request(app)
      .post("/upload")
      .attach("file", VALID_PDF, { filename: "write-error.pdf", contentType: "application/pdf" })

    const auditLines = infoSpy.mock.calls.map((args) => args.join(" "))
    expect(response.status).toBe(500)
    expect(scan).not.toHaveBeenCalled()
    expect(downstream).not.toHaveBeenCalled()
    expect(await storedFiles(temporaryRoot)).toEqual([])
    expect(auditLines.filter((line) => line.includes('"outcome":"cleaned"'))).toHaveLength(1)
    expect(auditLines.filter((line) => line.includes('"outcome":"rejected"'))).toHaveLength(1)
  })

  it("closes and removes a private partial file when the request aborts during reception", async () => {
    const scan = vi.fn(async () => ({ status: "clean" as const, provider: "must-not-run" }))
    setUploadScannerForTests({ name: "must-not-run", scan })
    let signalCleanup!: () => void
    const cleanupObserved = new Promise<void>((resolve) => { signalCleanup = resolve })
    const infoSpy = vi.spyOn(console, "info").mockImplementation((...args) => {
      if (args.join(" ").includes('"outcome":"cleaned"')) signalCleanup()
    })
    const downstream = vi.fn((_req, res: express.Response) => res.status(201).end())
    const app = express()
    app.post(
      "/upload",
      createSecureUpload("business-document", { storage: "staging" }).single("file"),
      downstream
    )

    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once("listening", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server address unavailable")
    const boundary = "----cerp-mid-reception-abort"
    let clientRequest: http.ClientRequest | null = null
    try {
      clientRequest = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: "/upload",
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      })
      clientRequest.on("error", () => undefined)
      clientRequest.write(
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="partial.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\n"
      )
      clientRequest.write(Buffer.concat([VALID_PDF, Buffer.alloc(256 * 1024, 0x41)]))

      const deadline = Date.now() + 2_000
      while ((await storedFiles(temporaryRoot)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(await storedFiles(temporaryRoot)).toHaveLength(1)

      clientRequest.destroy()
      await Promise.race([
        cleanupObserved,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("mid-reception cleanup timed out")), 2_000)
        ),
      ])

      const cleanupLines = infoSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.includes('"outcome":"cleaned"'))
      expect(scan).not.toHaveBeenCalled()
      expect(downstream).not.toHaveBeenCalled()
      expect(await storedFiles(temporaryRoot)).toEqual([])
      expect(cleanupLines).toHaveLength(1)
      expect(cleanupLines[0]).toContain('"staged_count":1')
    } finally {
      clientRequest?.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("aborts the active scanner, skips following files, and audits cleanup exactly once", async () => {
    let signalScanStarted!: () => void
    let signalScanAborted!: () => void
    const scanStarted = new Promise<void>((resolve) => { signalScanStarted = resolve })
    const scanAborted = new Promise<void>((resolve) => { signalScanAborted = resolve })
    let receivedSignal: AbortSignal | undefined
    let scanCalls = 0
    setUploadScannerForTests({
      name: "slow-test-scanner",
      async scan(input) {
        scanCalls += 1
        receivedSignal = input.signal
        signalScanStarted()
        return await new Promise((resolve) => {
          const finish = () => {
            signalScanAborted()
            resolve({ status: "unavailable", provider: "slow-test-scanner", reason: "requete_annulee" })
          }
          if (input.signal?.aborted) finish()
          else input.signal?.addEventListener("abort", finish, { once: true })
        })
      },
    })

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const downstream = vi.fn((_req, res: express.Response) => res.status(201).end())
    const app = express()
    app.post(
      "/upload",
      createSecureUpload("business-document", { storage: "staging" }).array("file", 2),
      downstream
    )

    const testRequest = request(app)
      .post("/upload")
      .attach("file", VALID_PDF, { filename: "safe.pdf", contentType: "application/pdf" })
      .attach("file", SECOND_VALID_PDF, { filename: "safe-2.pdf", contentType: "application/pdf" })
    // `.abort()` intentionally prevents Superagent's completion callback from
    // being a reliable synchronization point, so the scanner gate owns it.
    testRequest.end(() => undefined)

    await scanStarted
    testRequest.abort()
    await scanAborted
    await waitForNoStoredFiles(temporaryRoot)

    const cleanupEvents = infoSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((line) => line.includes('"outcome":"cleaned"'))
    expect(receivedSignal?.aborted).toBe(true)
    expect(scanCalls).toBe(1)
    expect(downstream).not.toHaveBeenCalled()
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0)
    expect(cleanupEvents).toHaveLength(1)
    expect(cleanupEvents[0]).toContain('"staged_count":2')
  })

  it("stops disk hashing on abort before the scanner or next file", async () => {
    const content = Buffer.alloc(4 * 1024 * 1024, 0x41)
    VALID_PDF.copy(content, 0)
    VALID_PDF.copy(content, content.length - VALID_PDF.length)
    let signalHashStarted!: () => void
    const hashStarted = new Promise<void>((resolve) => { signalHashStarted = resolve })
    let hashChunks = 0
    setUploadHashChunkHookForTests(async ({ signal }) => {
      hashChunks += 1
      signalHashStarted()
      if (signal.aborted) return
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    })
    const scan = vi.fn(async () => ({ status: "clean" as const, provider: "must-not-run" }))
    setUploadScannerForTests({ name: "must-not-run", scan })
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const downstream = vi.fn((_req, res: express.Response) => res.status(201).end())
    const app = express()
    app.post(
      "/upload",
      createSecureUpload("business-document", { storage: "staging" }).single("file"),
      downstream
    )

    const testRequest = request(app)
      .post("/upload")
      .attach("file", content, { filename: "large.pdf", contentType: "application/pdf" })
    testRequest.end(() => undefined)

    await hashStarted
    testRequest.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const cleanupEvents = infoSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((line) => line.includes('"outcome":"cleaned"'))
    expect(hashChunks).toBe(1)
    expect(scan).not.toHaveBeenCalled()
    expect(downstream).not.toHaveBeenCalled()
    expect(await storedFiles(temporaryRoot)).toEqual([])
    expect(cleanupEvents).toHaveLength(1)
  })

  it("reports a persistent staging cleanup failure without claiming the file was cleaned", async () => {
    let signalScanStarted!: () => void
    let signalScanAborted!: () => void
    const scanStarted = new Promise<void>((resolve) => { signalScanStarted = resolve })
    const scanAborted = new Promise<void>((resolve) => { signalScanAborted = resolve })
    setUploadScannerForTests({
      name: "slow-test-scanner",
      async scan(input) {
        signalScanStarted()
        return await new Promise((resolve) => {
          const finish = () => {
            signalScanAborted()
            resolve({ status: "unavailable", provider: "slow-test-scanner", reason: "requete_annulee" })
          }
          if (input.signal?.aborted) finish()
          else input.signal?.addEventListener("abort", finish, { once: true })
        })
      },
    })

    const realUnlink = fs.unlink.bind(fs)
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (candidate) => {
      if (path.resolve(candidate.toString()).startsWith(path.resolve(temporaryRoot) + path.sep)) {
        throw Object.assign(new Error("staging locked"), { code: "EACCES" })
      }
      return realUnlink(candidate)
    })
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const downstream = vi.fn((_req, res: express.Response) => res.status(201).end())
    const app = express()
    app.post(
      "/upload",
      createSecureUpload("business-document", { storage: "staging" }).single("file"),
      downstream
    )

    const testRequest = request(app)
      .post("/upload")
      .attach("file", VALID_PDF, { filename: "safe.pdf", contentType: "application/pdf" })
    testRequest.end(() => undefined)

    await scanStarted
    testRequest.abort()
    await scanAborted
    await new Promise((resolve) => setTimeout(resolve, 60))

    const auditLines = infoSpy.mock.calls.map((args) => args.join(" "))
    const auditOutput = auditLines.join("\n")
    expect(downstream).not.toHaveBeenCalled()
    expect(await storedFiles(temporaryRoot)).toHaveLength(1)
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0)
    expect(auditOutput).toContain('"outcome":"cleanup_failed"')
    expect(auditOutput).toContain('"failed_count":1')
    expect(auditOutput).not.toContain('"outcome":"cleaned"')
    expect(auditOutput).not.toContain(temporaryRoot)
    expect(auditLines.filter((line) => line.includes('"outcome":"cleanup_failed"'))).toHaveLength(1)
    // Identity-aware cleanup never retries a failed tombstone unlink: a retry
    // after a mismatch could otherwise mistake an absent pathname for success.
    expect(unlinkSpy).toHaveBeenCalledTimes(1)
  })
})
