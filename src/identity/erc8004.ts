import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { SDK } from "agent0-sdk";
import type { Config } from "../config.js";

export interface RegistrationResult {
  agentId: string;
  txHash: string;
  agentURI?: string;
  imageCID?: string;
}

export type RegistryAddresses = Record<string, string>;

const REGISTRY_ADDRESSES: Record<number, RegistryAddresses> = {
  84532: { IDENTITY: "0x8004AA63c570c570eBF15376c0dB199918BFe9Fb" }, // Base Sepolia
  8453: { IDENTITY: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }, // Base Mainnet
};

function parseChainId(network: string): number {
  return parseInt(network.split(":")[1], 10);
}

async function uploadImageToPinata(
  imagePath: string,
  pinataJwt: string,
): Promise<string> {
  const imageData = readFileSync(imagePath);
  const blob = new Blob([imageData], { type: "image/png" });
  const formData = new FormData();
  formData.append("file", blob, basename(imagePath));
  formData.append("network", "public");

  const response = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${pinataJwt}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload image to Pinata: HTTP ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  const cid = result?.data?.cid || result?.cid || result?.IpfsHash;
  if (!cid) {
    throw new Error(`No CID returned from Pinata. Response: ${JSON.stringify(result)}`);
  }
  return cid;
}

function buildSDK(config: Config, opts?: { registryAddresses?: RegistryAddresses }) {
  const chainId = parseChainId(config.network);
  const addresses = opts?.registryAddresses ?? REGISTRY_ADDRESSES[chainId];
  const registryOverrides = addresses ? { [chainId]: addresses } : undefined;

  return new SDK({
    chainId,
    rpcUrl: config.rpcUrl,
    privateKey: config.privateKey,
    ...(registryOverrides && { registryOverrides }),
    ...(config.pinataJwt && { ipfs: "pinata" as const, pinataJwt: config.pinataJwt }),
  });
}

async function applyAgentMetadata(
  agent: ReturnType<SDK["createAgent"]>,
  config: Config,
  opts?: { imagePath?: string },
): Promise<string | undefined> {
  await agent.setA2A(config.agentUrl);
  agent.setX402Support(true);

  let imageCID: string | undefined;
  if (opts?.imagePath && config.pinataJwt) {
    imageCID = await uploadImageToPinata(opts.imagePath, config.pinataJwt);
    agent.updateInfo(undefined, undefined, `ipfs://${imageCID}`);
  }
  return imageCID;
}

export async function findAgentByOwner(
  config: Config,
  opts?: { registryAddresses?: RegistryAddresses },
): Promise<number | null> {
  const sdk = buildSDK(config, opts);
  const chainId = parseChainId(config.network);
  const results = await sdk.searchAgents({ owners: [config.walletAddress], chains: [chainId] });
  if (results.length === 0) return null;
  return Number(results[0].agentId);
}

export async function registerAgent(
  config: Config,
  opts?: { registryAddresses?: RegistryAddresses; imagePath?: string },
): Promise<RegistrationResult> {
  const sdk = buildSDK(config, opts);
  const agent = sdk.createAgent(config.agentName, config.agentDescription);

  const imageCID = await applyAgentMetadata(agent, config, opts);

  const txHandle = await agent.registerIPFS();
  const { result } = await txHandle.waitMined();

  return {
    agentId: agent.agentId ?? "pending",
    txHash: txHandle.hash,
    agentURI: result?.agentURI,
    imageCID,
  };
}

export async function updateAgent(
  config: Config,
  agentId: number,
  opts?: { registryAddresses?: RegistryAddresses; imagePath?: string },
): Promise<RegistrationResult> {
  const sdk = buildSDK(config, opts);
  const agent = await sdk.loadAgent(String(agentId));

  agent.updateInfo(config.agentName, config.agentDescription);
  const imageCID = await applyAgentMetadata(agent, config, opts);

  const txHandle = await agent.registerIPFS();
  const { result } = await txHandle.waitMined();

  return {
    agentId: agent.agentId ?? String(agentId),
    txHash: txHandle.hash,
    agentURI: result?.agentURI,
    imageCID,
  };
}
