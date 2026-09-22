import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
import { postWebhook, safeLookup } from "../lib/webhookTransport";
import { isUnsafeIpAddress } from "../lib/network";

function resolve() {
  return new Promise((accept, reject) => safeLookup("example.com", {}, (error, address, family) => error ? reject(error) : accept({ address, family })));
}
describe("connection-time destination validation", () => {
  it("rejects private answers even when an earlier lookup was public", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    expect(await resolve()).toEqual({ address: "8.8.8.8", family: 4 });
    await expect(resolve()).rejects.toThrow(/private/);
  });
  it("uses the guarded lookup when opening the actual HTTP connection", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(postWebhook(new URL("http://example.com/"), {}, "{}", AbortSignal.timeout(1000), 2000)).rejects.toThrow(/private/);
    expect(mocks.lookup).toHaveBeenLastCalledWith("example.com", { all: true, verbatim: true });
  });
  it("rejects mixed answers and DNS failures", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(resolve()).rejects.toThrow(/private/);
    mocks.lookup.mockRejectedValueOnce(new Error("DNS failed"));
    await expect(resolve()).rejects.toThrow("DNS failed");
  });
  it("rejects mapped, translated, documentation and transition networks", () => {
    for (const ip of ["0:0:0:0:0:ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "203.0.113.2", "198.51.100.2", "2001:db8::1"]) expect(isUnsafeIpAddress(ip)).toBe(true);
    expect(isUnsafeIpAddress("2606:4700:4700::1111")).toBe(false);
  });
});
