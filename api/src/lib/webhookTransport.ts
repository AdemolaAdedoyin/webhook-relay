import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isUnsafeIpAddress } from "./network";

/** Resolve at connection time and hand the validated address directly to the socket. */
export const safeLookup: LookupFunction = (hostname, _options, callback) => {
  void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
    if (!addresses.length || addresses.some(({ address }) => isUnsafeIpAddress(address))) {
      callback(new Error("Webhook target resolves to a private, local, or reserved address"), "", 4);
      return;
    }
    const address = addresses[0]!;
    callback(null, address.address, address.family);
  }, error => callback(error, "", 4));
};

/** Receives a URL already checked by assertSafeWebhookUrl. Never follows redirects. */
export function postWebhook(url: URL, headers: Record<string, string>, body: string, signal: AbortSignal, maxBytes: number) {
  return new Promise<{ status: number; snippet: string }>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const options = {
      method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
      signal, lookup: safeLookup, autoSelectFamily: false, agent: false as const,
    };
    const req = request(url, options, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve({ status: res.statusCode ?? 0, snippet: Buffer.concat(chunks).toString("utf8") });
      };
      res.on("data", (chunk: Buffer) => {
        const kept = chunk.subarray(0, Math.max(0, maxBytes - size));
        chunks.push(kept); size += kept.length;
        if (size >= maxBytes) { finish(); res.destroy(); }
      });
      res.on("end", finish);
      res.on("error", error => { if (!finished) reject(error); });
    });
    req.on("error", reject);
    req.end(body);
  });
}
