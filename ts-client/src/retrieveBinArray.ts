import { Cluster, Connection, PublicKey } from "@solana/web3.js";
import { DLMM } from "./dlmm";
import { Wallet } from "@coral-xyz/anchor";
import Redis from "ioredis";
import { BinArrayAccount } from "./dlmm/types";

const redis = new Redis();

let jupPool: DLMM;
let binArrayPubkey: BinArrayAccount[] = [];
let timer: NodeJS.Timeout;

const connection = new Connection(process.env.RPC_URL);
async function init() {
  jupPool = await DLMM.create(
    connection,
    new PublicKey(process.env.JUP_POOL || ""),
    {} as Wallet,
    {
      cluster: process.env.CLUSTER as Cluster,
    }
  );
}

async function retrieveBinArray() {
  timer && clearTimeout(timer);
  binArrayPubkey = await jupPool.getBinArrayForSwap(true, 17);
  console.log("✅ ~ Bin Array Pubkey Updated");
  redis.set(
    "binArray",
    JSON.stringify(binArrayPubkey.map(({ publicKey }) => publicKey.toBase58()))
  );

  timer = setTimeout(() => {
    retrieveBinArray();
  }, 500);
}

async function main() {
  if (!jupPool) {
    await init();
  }

  retrieveBinArray();
}

main();
