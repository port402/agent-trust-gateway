import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";

const testConfig: Config = {
  walletAddress: "0xtest",
  privateKey: "0xkey",
  network: "eip155:84532",
  rpcUrl: "https://sepolia.base.org",
  agentName: "Test Agent",
  agentDescription: "A test agent",
  agentUrl: "http://localhost:3000",
  port: 3000,
  bypassPayments: true,
};

describe("Hono app routes", () => {
  const app = createApp(testConfig);

  it("GET /health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /.well-known/agent-card.json returns valid card", async () => {
    const res = await app.request("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe("Test Agent");
    expect(card.skills).toHaveLength(3);
    expect(card.url).toContain("/a2a");
    expect(card.entrypoints).toBeDefined();
    expect(Object.keys(card.entrypoints)).toEqual(["profile", "score", "validate"]);
    expect(card.entrypoints.profile.url).toBe("http://localhost:3000/api/agent/profile/invoke");
    expect(card.entrypoints.score.url).toBe("http://localhost:3000/api/agent/score/invoke");
    expect(card.entrypoints.validate.url).toBe("http://localhost:3000/api/agent/validate/invoke");
    expect(card.entrypoints.profile.method).toBe("POST");
    expect(card.entrypoints.score.pricing).toEqual({ invoke: "0.01" });
    expect(card.entrypoints.validate.input_schema.properties.checks).toBeDefined();
  });

  // CDP facilitator requires auth + only supports mainnet — run manually as integration test
  it.skip("GET /api/agent/:id/profile without payment returns 402", async () => {
    const res = await app.request("/api/agent/1/profile");
    expect(res.status).toBe(402);
  });

  // CDP facilitator requires auth + only supports mainnet — run manually as integration test
  it.skip("POST /a2a message/send without payment returns 402", async () => {
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "test",
            role: "user",
            parts: [{ kind: "text", text: "hi" }],
          },
        },
      }),
    });
    expect(res.status).toBe(402);
  });

  it("POST /a2a tasks/get does not require payment", async () => {
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tasks/get",
        params: { id: "nonexistent" },
      }),
    });
    expect(res.status).not.toBe(402);
  });

  it("POST /a2a malformed JSON returns JSON-RPC parse error (not 500)", async () => {
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("POST /a2a text/plain body returns JSON-RPC parse error (not 500)", async () => {
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it("POST /a2a with unsupported content-type returns invalid request (not 500)", async () => {
    const res = await app.request("/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: "<rpc />",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
  });

  it("GET /.well-known/agent-registration.json returns registration data when agentId configured", async () => {
    const appWithId = createApp({ ...testConfig, agentId: 21557 });
    const res = await appWithId.request("/.well-known/agent-registration.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(21557);
    expect(body.agentRegistry).toBe("eip155:84532:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(body.owner).toBe("0xtest");
  });

  it("GET /.well-known/agent-registration.json returns 404 when agentId not configured", async () => {
    const res = await app.request("/.well-known/agent-registration.json");
    expect(res.status).toBe(404);
  });

  it("GET /api/agent/:id/profile with invalid id returns 400", async () => {
    const noPayApp = createApp({ ...testConfig, bypassPayments: true });
    const res = await noPayApp.request("/api/agent/not-a-number/profile");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid agentId");
  });
});
