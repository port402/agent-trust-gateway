/**
 * Sequential smoke test: test IDs 1–100 one-at-a-time through the running server.
 * First discovers which IDs return a profile, then tests score + validate on those.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TIMEOUT = 30_000; // 30s per request

interface Result {
  id: number;
  status: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
  uriScheme?: string;
}

async function probe(url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: any; latencyMs: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    const body = await resp.json().catch(() => null);
    return { status: resp.status, ok: resp.ok, body, latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 0, ok: false, body: { error: err instanceof Error ? err.message : "unknown" }, latencyMs: Date.now() - start };
  }
}

async function main() {
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);

  // Phase 1: GET profile for all IDs
  console.log("Phase 1: GET /api/agent/:id/profile for IDs 1–100\n");
  const profileResults: Result[] = [];

  for (const id of ids) {
    const { status, ok, body, latencyMs } = await probe(`${BASE_URL}/api/agent/${id}/profile?chain=base`);
    const result: Result = { id, status, ok, latencyMs };
    if (!ok) result.error = body?.error || body?.details || "unknown";
    profileResults.push(result);

    const symbol = ok ? "✓" : status === 404 ? "·" : status === 502 ? "⚡" : status === 504 ? "⏱" : status === 0 ? "✗" : "?";
    const name = ok ? (body?.name || "").slice(0, 30) : result.error?.slice(0, 40);
    process.stdout.write(`  ${symbol} #${String(id).padStart(3)} ${String(status).padStart(3)} ${String(latencyMs).padStart(6)}ms  ${name}\n`);
  }

  const succeeded = profileResults.filter(r => r.ok);
  const failed = profileResults.filter(r => !r.ok);
  console.log(`\nPhase 1 summary: ${succeeded.length} OK, ${failed.length} failed`);

  // Group failures
  const failByStatus = new Map<number, number>();
  for (const f of failed) {
    failByStatus.set(f.status, (failByStatus.get(f.status) || 0) + 1);
  }
  for (const [status, count] of failByStatus) {
    console.log(`  HTTP ${status}: ${count}`);
  }

  if (succeeded.length === 0) {
    console.log("\nNo IDs succeeded on profile — cannot test other endpoints.");
    return;
  }

  // Phase 2: POST score/invoke and validate/invoke for succeeded IDs
  const testIds = succeeded.map(r => r.id);
  console.log(`\nPhase 2: Testing score + validate for ${testIds.length} working IDs\n`);

  const scoreResults: Result[] = [];
  const validateResults: Result[] = [];

  for (const id of testIds) {
    // Score
    const scoreResp = await probe(`${BASE_URL}/api/agent/score/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { agentId: String(id), chain: "base" } }),
    });
    const sr: Result = { id, status: scoreResp.status, ok: scoreResp.ok, latencyMs: scoreResp.latencyMs };
    if (!scoreResp.ok) sr.error = scoreResp.body?.error || "unknown";
    scoreResults.push(sr);

    // Validate
    const valResp = await probe(`${BASE_URL}/api/agent/validate/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { agentId: String(id), chain: "base" } }),
    });
    const vr: Result = { id, status: valResp.status, ok: valResp.ok, latencyMs: valResp.latencyMs };
    if (!valResp.ok) vr.error = valResp.body?.error || "unknown";
    validateResults.push(vr);

    const ss = scoreResp.ok ? "✓" : "✗";
    const vs = valResp.ok ? "✓" : "✗";
    console.log(`  #${String(id).padStart(3)}  score:${ss}(${scoreResp.status},${scoreResp.latencyMs}ms)  validate:${vs}(${valResp.status},${valResp.latencyMs}ms)`);
  }

  // Final summary
  console.log("\n\n═══════════════════════════════════════════════════");
  console.log("FINAL SUMMARY");
  console.log("═══════════════════════════════════════════════════");

  const endpoints = [
    { name: "GET profile", results: profileResults },
    { name: "POST score/invoke", results: scoreResults },
    { name: "POST validate/invoke", results: validateResults },
  ];

  for (const ep of endpoints) {
    const ok = ep.results.filter(r => r.ok);
    const latencies = ok.map(r => r.latencyMs).sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const max = latencies[latencies.length - 1] || 0;

    console.log(`\n${ep.name} (${ep.results.length} tested)`);
    console.log(`  ✓ ${ok.length} succeeded`);

    const failGroups = new Map<string, number[]>();
    for (const r of ep.results.filter(r => !r.ok)) {
      const key = `${r.status}: ${r.error?.slice(0, 60) || "unknown"}`;
      if (!failGroups.has(key)) failGroups.set(key, []);
      failGroups.get(key)!.push(r.id);
    }
    for (const [key, ids] of failGroups) {
      console.log(`  ✗ [${key}] — ${ids.length} IDs`);
    }

    if (ok.length > 0) {
      console.log(`  Latency: p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
