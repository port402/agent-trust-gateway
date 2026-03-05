import { v4 as uuidv4 } from "uuid";
import type { Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { IdentityClient, ViemAdapter } from "erc-8004-js";

// ERC-8004 Contract Addresses
const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as Address;

// The on-chain readAllFeedback returns 7 arrays, but erc-8004-js declares only 5,
// causing a decoding error. We call viem directly with the correct ABI.
const READ_ALL_FEEDBACK_ABI = [{
  name: "readAllFeedback",
  type: "function",
  stateMutability: "view",
  inputs: [
    { name: "agentId", type: "uint256" },
    { name: "clientAddresses", type: "address[]" },
    { name: "tag1", type: "string" },
    { name: "tag2", type: "string" },
    { name: "includeRevoked", type: "bool" },
  ],
  outputs: [
    { name: "clients", type: "address[]" },
    { name: "feedbackTypes", type: "uint256[]" },
    { name: "scores", type: "uint256[]" },
    { name: "timestamps", type: "uint256[]" },
    { name: "tag1s", type: "string[]" },
    { name: "tag2s", type: "string[]" },
    { name: "revoked", type: "bool[]" },
  ],
}] as const;

// Agent Trust Gateway executor for A2A protocol
export class TrustGatewayExecutor implements AgentExecutor {
  private publicClient: PublicClient;
  private identityClient: IdentityClient;

  constructor() {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
    });
    this.publicClient = publicClient as PublicClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new ViemAdapter(publicClient as any);
    this.identityClient = new IdentityClient(adapter, IDENTITY_REGISTRY);
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Extract the user's message
    const userMessage = requestContext.userMessage;
    const textPart = userMessage?.parts?.find((p: { kind: string }) => p.kind === "text");
    const userText = textPart && "text" in textPart ? (textPart as { text: string }).text : "";

    const taskId = requestContext.taskId ?? uuidv4();
    const contextId = requestContext.contextId ?? uuidv4();

    const publishResult = (state: "completed" | "failed", text: string): void => {
      const statusMessage = {
        kind: "message" as const,
        messageId: uuidv4(),
        role: "agent" as const,
        parts: [{ kind: "text" as const, text }],
      };
      const status = { state, message: statusMessage };
      eventBus.publish({ kind: "task", id: taskId, contextId, status } satisfies Task);
      eventBus.publish({ kind: "status-update", taskId, contextId, final: true, status } satisfies TaskStatusUpdateEvent);
    };

    try {
      let responseText = "";

      // Parse intent from message
      const agentIdMatch = userText.match(/agent\s*(?:#?\s*)?(\d+)/i);

      if (!agentIdMatch) {
        responseText = "Please specify an agent ID. Example: 'Get trust score for agent 42' or 'Validate agent #100'";
      } else {
        const agentId = BigInt(agentIdMatch[1]);

        if (userText.toLowerCase().includes("profile") || userText.toLowerCase().includes("identity") || userText.toLowerCase().includes("details")) {
          responseText = await this.getProfile(agentId);
        } else if (userText.toLowerCase().includes("score") || userText.toLowerCase().includes("trust") || userText.toLowerCase().includes("reputation")) {
          responseText = await this.getTrustScore(agentId);
        } else if (userText.toLowerCase().includes("validate") || userText.toLowerCase().includes("check") || userText.toLowerCase().includes("health")) {
          responseText = await this.validateAgent(agentId);
        } else {
          // Default to profile lookup
          responseText = await this.getProfile(agentId);
        }
      }

      publishResult("completed", responseText);
    } catch (error) {
      const errorText = `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`;
      publishResult("failed", errorText);
    }

    eventBus.finished();
  }

  private async getProfile(agentId: bigint): Promise<string> {
    const registration = await this.identityClient.getRegistrationFile(agentId);
    const owner = await this.identityClient.getOwner(agentId);
    
    let wallet = owner;
    try {
      wallet = await this.identityClient.getMetadata(agentId, "agentWallet");
    } catch {
      // Use owner if wallet not set
    }

    return `**Agent #${agentId} Profile**

**Name:** ${registration.name}
**Description:** ${registration.description}
**Owner:** ${owner}
**Wallet:** ${wallet}
**Active:** ${(registration as { active?: boolean }).active ?? true}
**Endpoints:** ${registration.endpoints?.map((e: { name: string; endpoint: string }) => `${e.name} (${e.endpoint})`).join(", ") || "None"}
**Supported Trust:** ${registration.supportedTrust?.join(", ") || "None specified"}`;
  }

  private async readFeedbackSafe(
    agentId: bigint,
  ): Promise<{ scores: number[]; warning?: string }> {
    try {
      const result = await this.publicClient.readContract({
        address: REPUTATION_REGISTRY,
        abi: READ_ALL_FEEDBACK_ABI,
        functionName: "readAllFeedback",
        args: [agentId, [], "", "", false],
      });
      const [, , scores] = result;
      return { scores: scores.map(Number) };
    } catch (error) {
      const warning = error instanceof Error ? error.message : "Failed to read feedback";
      return { scores: [], warning };
    }
  }

  private async getTrustScore(agentId: bigint): Promise<string> {
    const registration = await this.identityClient.getRegistrationFile(agentId);
    const { scores, warning } = await this.readFeedbackSafe(agentId);
    const feedbackCount = scores.length;
    const avgScore = feedbackCount > 0
      ? scores.reduce((a, b) => a + b, 0) / feedbackCount
      : 0;

    // Compute trust score
    const hasEndpoints = (registration.endpoints?.length || 0) > 0;
    const hasTrustMethods = (registration.supportedTrust?.length || 0) > 0;
    const identityMaturity = (hasEndpoints ? 30 : 0) + (hasTrustMethods ? 20 : 0);
    const volumeScore = Math.min(30, feedbackCount * 3);
    const reputationConfidence = volumeScore;
    
    const effectiveBaseScore = feedbackCount > 0 ? avgScore : 50;
    const trustScore = Math.min(100, Math.max(0, Math.round(effectiveBaseScore + identityMaturity * 0.3 + reputationConfidence * 0.2)));
    
    const verdict = trustScore >= 80 ? "highly-trusted" :
                    trustScore >= 60 ? "trusted" :
                    trustScore >= 40 ? "neutral" :
                    trustScore >= 20 ? "low-trust" : "untrusted";

    return `**Agent #${agentId} Trust Score**

**Name:** ${registration.name}
**Trust Score:** ${trustScore}/100
**Verdict:** ${verdict}

**Breakdown:**
- Feedback Score: ${Math.round(effectiveBaseScore)}
- Identity Maturity: ${identityMaturity}
- Reputation Confidence: ${reputationConfidence}

**Feedback Summary:**
- Total Feedback: ${feedbackCount}
- Average Score: ${Math.round(avgScore * 10) / 10}${warning ? `\n\n**Warning:** ${warning}` : ""}`;
  }

  private async validateAgent(agentId: bigint): Promise<string> {
    const registration = await this.identityClient.getRegistrationFile(agentId);
    const owner = await this.identityClient.getOwner(agentId);
    
    let wallet = owner;
    try {
      wallet = await this.identityClient.getMetadata(agentId, "agentWallet");
    } catch {
      // Use owner if wallet not set
    }

    const issues: string[] = [];
    const endpointResults: string[] = [];

    // Check endpoints
    if (registration.endpoints && registration.endpoints.length > 0) {
      for (const ep of registration.endpoints) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(ep.endpoint, { method: "HEAD", signal: controller.signal }).catch(() => null);
          clearTimeout(timeout);
          
          if (response && response.ok) {
            endpointResults.push(`✅ ${ep.name}: Reachable`);
          } else {
            endpointResults.push(`❌ ${ep.name}: Unreachable`);
            issues.push(`Endpoint ${ep.name} is unreachable`);
          }
        } catch {
          endpointResults.push(`❌ ${ep.name}: Error`);
          issues.push(`Endpoint ${ep.name} check failed`);
        }
      }
    } else {
      endpointResults.push("No endpoints declared");
    }

    // Check wallet
    const walletValid = /^0x[a-fA-F0-9]{40}$/.test(wallet);
    if (!walletValid) {
      issues.push("Invalid wallet address format");
    }

    const verdict = issues.length === 0 ? "✅ Validated" : `⚠️ ${issues.length} issue(s) found`;

    return `**Agent #${agentId} Validation Report**

**Name:** ${registration.name}
**Overall:** ${verdict}

**Endpoints:**
${endpointResults.join("\n")}

**Wallet:** ${wallet} ${walletValid ? "✅" : "❌"}

${issues.length > 0 ? `**Issues:**\n${issues.map((i) => `- ${i}`).join("\n")}` : ""}`;
  }

  async cancelTask(
    _taskId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    eventBus.finished();
  }
}

// Export alias for backward compatibility
export { TrustGatewayExecutor as HelloExecutor };
