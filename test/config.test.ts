import { describe, it, expect } from "vitest";

describe("config safety", () => {
  it("throws when BYPASS_PAYMENTS=true in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.BYPASS_PAYMENTS = "true";
    process.env.WALLET_ADDRESS = "0x123";
    process.env.PRIVATE_KEY = "0xabc";

    const { loadConfig } = await import("../src/config.js");
    await expect(loadConfig()).rejects.toThrow(
      "BYPASS_PAYMENTS=true is not allowed in production",
    );
  });
});
