import { existsSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { findAgentByOwner, registerAgent, updateAgent } from "../src/identity/erc8004.js";

const DEFAULT_ICON = resolve(import.meta.dirname, "..", "assets", "icon.png");

async function main() {
  const config = await loadConfig();
  const explicit = process.env.AGENT_IMAGE_PATH;
  const imagePath = explicit ?? (existsSync(DEFAULT_ICON) ? DEFAULT_ICON : undefined);

  const overrideId = process.env.AGENT_ID ? parseInt(process.env.AGENT_ID, 10) : undefined;
  let existingAgentId = overrideId;

  if (existingAgentId == null) {
    console.log(`Checking if ${config.walletAddress} already owns an agent on ${config.network}...`);
    existingAgentId = (await findAgentByOwner(config)) ?? undefined;
    if (existingAgentId != null) {
      console.log(`  Found existing agent #${existingAgentId}`);
    }
  }

  const mode = existingAgentId != null ? "update" : "register";

  console.log(`\n${mode === "update" ? "Updating" : "Registering"} agent "${config.agentName}" on ${config.network}...`);
  if (existingAgentId != null) {
    console.log(`  Agent ID:     ${existingAgentId}`);
  }
  console.log(`  A2A endpoint: ${config.agentUrl}`);
  console.log(`  Wallet:       ${config.walletAddress}`);
  if (imagePath) {
    console.log(`  Image:        ${imagePath}`);
  }

  const result = mode === "update"
    ? await updateAgent(config, existingAgentId!, { imagePath })
    : await registerAgent(config, { imagePath });

  console.log(`\n${mode === "update" ? "Update" : "Registration"} complete!`);
  console.log(`  Agent ID:  ${result.agentId}`);
  console.log(`  TX Hash:   ${result.txHash}`);
  if (result.agentURI) {
    console.log(`  Agent URI: ${result.agentURI}`);
  }
  if (result.imageCID) {
    console.log(`  Image CID: ${result.imageCID}`);
    console.log(`  Image URL: https://gateway.pinata.cloud/ipfs/${result.imageCID}`);
  }
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
