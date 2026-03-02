import { Hono } from "hono";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildEntrypoints } from "../agent/entrypoints.js";

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function parseJsonRpcRequest(c: { req: { header: (name: string) => string | undefined; text: () => Promise<string> }; get: (key: string) => unknown }) {
  const fromMiddleware = c.get("jsonrpcBody");
  if (typeof fromMiddleware !== "undefined") {
    return { ok: true as const, body: fromMiddleware };
  }

  const contentType = c.req.header("content-type") ?? "";
  const raw = await c.req.text();
  if (!raw.trim()) {
    return { ok: true as const, body: null as unknown };
  }

  const acceptsAsJson =
    contentType === "" ||
    /(^|;)\s*application\/(?:[\w.+-]+\+)?json\s*(;|$)/i.test(contentType) ||
    /(^|;)\s*text\/plain\s*(;|$)/i.test(contentType);

  if (!acceptsAsJson) {
    return { ok: false as const, response: jsonRpcError(null, -32600, "Invalid JSON-RPC Request.") };
  }

  try {
    return { ok: true as const, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false as const, response: jsonRpcError(null, -32700, "Parse error") };
  }
}

export interface A2ARoutesConfig {
  agentId?: number;
  network: string;
  walletAddress: string;
}

export function createA2ARoutes(agentCard: AgentCard, executor: AgentExecutor, config: A2ARoutesConfig) {
  const taskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
  );
  const jsonRpcHandler = new JsonRpcTransportHandler(requestHandler);

  const a2a = new Hono();

  // Agent card discovery — merges A2A card with structured entrypoints
  a2a.get("/.well-known/agent-card.json", async (c) => {
    const card = await requestHandler.getAgentCard();
    const baseUrl = card.url.replace(/\/a2a\/?$/, "");
    const entrypoints = buildEntrypoints(baseUrl);
    return c.json({ ...card, entrypoints });
  });

  // Agent registration discovery — links on-chain identity to this endpoint
  a2a.get("/.well-known/agent-registration.json", (c) => {
    if (config.agentId == null) {
      return c.json({ error: "Agent ID not configured" }, 404);
    }
    const chainId = config.network.split(":")[1];
    return c.json({
      agentId: config.agentId,
      agentRegistry: `eip155:${chainId}:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`,
      owner: config.walletAddress,
    });
  });

  // A2A JSON-RPC endpoint
  a2a.post("/a2a", async (c) => {
    const parsed = await parseJsonRpcRequest(c);
    if (!parsed.ok) {
      return c.json(parsed.response);
    }

    const body = parsed.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(jsonRpcError(null, -32600, "Invalid JSON-RPC Request."));
    }

    try {
      const context = new ServerCallContext([], new UnauthenticatedUser());
      const result = await jsonRpcHandler.handle(body, context);

      // handle() may return an AsyncGenerator for streaming — we don't support
      // streaming in Lambda, so treat non-generator results as single responses
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        // Consume the first value from the generator for non-streaming response
        const iterator = result as AsyncGenerator;
        const first = await iterator.next();
        return c.json(first.value);
      }

      return c.json(result);
    } catch {
      return c.json(
        jsonRpcError((body as { id?: string | number | null }).id ?? null, -32603, "Internal error"),
      );
    }
  });

  return a2a;
}
