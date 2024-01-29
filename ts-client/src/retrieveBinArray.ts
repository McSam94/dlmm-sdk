
import { Cluster, Connection, PublicKey } from "@solana/web3.js";
import { DLMM } from "./dlmm";
import { Wallet } from "@coral-xyz/anchor";
import Redis from "ioredis";

const redis = new Redis();

let jupPool: DLMM;
let binArrayPubkey: PublicKey[] = [];

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
    binArrayPubkey = (await jupPool.getBinArrayForSwap(true, 17)).map(
        ({ publicKey }) => publicKey
    );
    console.log("✅ ~ Bin Array Pubkey Updated");
    redis.set("binArray", JSON.stringify(binArrayPubkey.map((pubkey) => pubkey.toBase58()))); 
}

async function main() {
    if (!jupPool) {
        await init();
    }

    setInterval(() => {
        retrieveBinArray();
    }, 1000)
}

main();