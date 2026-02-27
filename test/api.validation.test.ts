import { describe, it, expect } from "vitest";
import { api } from "../src/routes/api.js";

describe("API validation paths", () => {
  it("POST /agent/score/invoke invalid agentId returns 400 (not 500)", async () => {
    const res = await api.request("/agent/score/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { agentId: "abc" } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
  });
});
