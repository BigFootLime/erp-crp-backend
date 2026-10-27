import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { companyRuntimeConfiguration } from "../runtime/company-runtime.config";
import { canonicalIntercompanyJson, intercompanyDigest, parseIntercompanyMessage, type IntercompanyMessage } from "./intercompany-message";

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const peerSchema = z.object({
  company_id: uuid, environment: z.enum(["cerp_prod", "cerp_test"]),
  api_base_url: z.string().url(), signing_key_hex: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type IntercompanyPeer = z.infer<typeof peerSchema>;
export type IntercompanyTransportConfiguration = { enabled: false } | {
  enabled: true; company_id: string; environment: "cerp_prod" | "cerp_test";
  peers: ReadonlyMap<string, IntercompanyPeer>;
};
const unavailable = () => new HttpError(503, "INTERCOMPANY_TRANSPORT_CONFIGURATION_INVALID", "La liaison entre entreprises doit être configurée.");

/** Fixed private operator configuration. Neither a browser nor a message selects a URL or key. */
export function intercompanyTransportConfiguration(env: NodeJS.ProcessEnv = process.env): IntercompanyTransportConfiguration {
  if (env.CERP_INTERCOMPANY_ENABLED === undefined || env.CERP_INTERCOMPANY_ENABLED === "false") return { enabled: false };
  if (env.CERP_INTERCOMPANY_ENABLED !== "true") throw unavailable();
  try {
    const runtime = companyRuntimeConfiguration(env);
    if (!runtime.enabled) throw unavailable();
    const rows = z.array(peerSchema).min(1).max(100).parse(JSON.parse(env.CERP_INTERCOMPANY_PEERS_JSON ?? ""));
    const peers = new Map<string, IntercompanyPeer>();
    const keys = new Set<string>();
    for (const peer of rows) {
      const url = new URL(peer.api_base_url);
      const testLoopback = env.NODE_ENV === "test" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(testLoopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash ||
        !url.pathname.replace(/\/$/, "").endsWith("/api/v1") || peer.company_id === runtime.company_id || peer.environment !== runtime.environment ||
        peers.has(peer.company_id) || keys.has(peer.signing_key_hex)) throw unavailable();
      peers.set(peer.company_id, Object.freeze(peer)); keys.add(peer.signing_key_hex);
    }
    return { enabled: true, company_id: runtime.company_id, environment: runtime.environment, peers };
  } catch { throw unavailable(); }
}

function signedFrame(message: IntercompanyMessage, at: string, nonce: string): string {
  return ["CERP-INTERCOMPANY-DELIVERY-v1", "POST", "/api/v1/intercompany/messages",
    message.source_company_id, message.destination_company_id, message.environment,
    at, nonce, intercompanyDigest(message), ""].join("\n");
}
export function signIntercompanyDelivery(message: IntercompanyMessage, keyHex: string, now = Date.now(), nonce = randomUUID()): Record<string, string> {
  const at = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", Buffer.from(keyHex, "hex")).update(signedFrame(message, at, nonce)).digest("hex");
  return { "Content-Type": "application/json", "X-CERP-Company": message.destination_company_id, "X-CERP-Database": message.environment,
    "X-CERP-Intercompany-Source": message.source_company_id,
    "X-CERP-Intercompany-Destination": message.destination_company_id, "X-CERP-Intercompany-Environment": message.environment,
    "X-CERP-Intercompany-Time": at, "X-CERP-Intercompany-Nonce": nonce, "X-CERP-Intercompany-Signature": signature };
}
export function verifyIntercompanyDelivery(config: IntercompanyTransportConfiguration, header: (name: string) => string | undefined, body: unknown, now = Date.now()): IntercompanyMessage {
  const rejected = () => new HttpError(403, "INTERCOMPANY_DELIVERY_REJECTED", "La livraison inter-entreprises n'est pas autorisée.");
  if (!config.enabled) throw new HttpError(404, "NOT_FOUND", "Ressource introuvable.");
  let message: IntercompanyMessage;
  try { message = parseIntercompanyMessage(body); } catch { throw rejected(); }
  const at = header("X-CERP-Intercompany-Time") ?? "";
  const nonce = header("X-CERP-Intercompany-Nonce") ?? "";
  const signature = header("X-CERP-Intercompany-Signature") ?? "";
  const peer = config.peers.get(message.source_company_id);
  if (!peer || message.destination_company_id !== config.company_id || message.environment !== config.environment ||
    peer.environment !== config.environment || header("X-CERP-Intercompany-Source") !== message.source_company_id ||
    header("X-CERP-Intercompany-Destination") !== message.destination_company_id || header("X-CERP-Intercompany-Environment") !== message.environment ||
    !/^\d{10,12}$/.test(at) || Math.abs(now / 1000 - Number(at)) > 60 || !uuid.safeParse(nonce).success || !/^[a-f0-9]{64}$/.test(signature)) throw rejected();
  const expected = createHmac("sha256", Buffer.from(peer.signing_key_hex, "hex")).update(signedFrame(message, at, nonce)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw rejected();
  return message;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("INTERCOMPANY_EMPTY_RESPONSE");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length;
      if (bytes > 16384) throw new Error("INTERCOMPANY_RESPONSE_TOO_LARGE"); chunks.push(item.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function deliverIntercompanyMessage(config: IntercompanyTransportConfiguration, message: IntercompanyMessage, fetcher: typeof fetch = fetch): Promise<void> {
  if (!config.enabled || message.source_company_id !== config.company_id || message.environment !== config.environment) throw unavailable();
  const peer = config.peers.get(message.destination_company_id);
  if (!peer) throw new HttpError(409, "INTERCOMPANY_PEER_NOT_CONFIGURED", "L'entreprise destinataire n'est pas raccordée.");
  const endpoint = `${peer.api_base_url.replace(/\/$/, "")}/intercompany/messages`;
  const response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: signIntercompanyDelivery(message, peer.signing_key_hex), body: canonicalIntercompanyJson(message) });
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new HttpError(503, "INTERCOMPANY_REMOTE_REJECTED", "La livraison sera retentée après vérification de la liaison."); }
  const receipt = z.object({ id: uuid, payload_sha256: z.string(), status: z.enum(["PROCESSED", "REPLAY"]) }).strict().parse(await boundedResponseJson(response));
  if (receipt.id !== message.id || receipt.payload_sha256 !== message.payload_sha256) throw new Error("INTERCOMPANY_DELIVERY_RECEIPT_MISMATCH");
}
