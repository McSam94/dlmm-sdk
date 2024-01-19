import { Cluster, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DLMM } from "./dlmm";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Wallet } from "@coral-xyz/anchor";
import { BN } from "bn.js";

const connection = new Connection(process.env.RPC_URL);
const walletKeypair = Keypair.fromSecretKey(
  new Uint8Array(bs58.decode(process.env.USER_PRIVATE_KEY))
);
const wallet = new Wallet(walletKeypair);

let jupPool: DLMM;
let binArrayPubkey: PublicKey[] = [];

async function init() {
  jupPool = await DLMM.create(
    connection,
    new PublicKey(process.env.JUP_POOL || ""),
    wallet,
    {
      cluster: process.env.CLUSTER as Cluster,
    }
  );
}

async function execute(amount: number) {
  const inAmount = new BN(amount * 10 ** jupPool.tokenY.decimal);
  if (binArrayPubkey.length === 0) {
    binArrayPubkey = (await jupPool.getBinArrayForSwap(true, 17)).map(
      ({ publicKey }) => publicKey
    );
  }
  //   const inSlippage = new BN(100 * 100);
  //   const binArraysForSwap = await jupPool.getBinArrayForSwap(false, 10);
  //   const quotation = jupPool.swapQuote(
  //     inAmount,
  //     false,
  //     inSlippage,
  //     binArraysForSwap
  //   );
  //   console.log(
  //     "🚀 ~ quotation ~ minOutAmount",
  //     quotation.minOutAmount.toString()
  //   );

  const priorityFeeData = await fetch(process.env.PRIORITY_FEE_KV).then((res) =>
    res.json()
  );
  const priorityFee: number = Math.min(
    1,
    Math.min(priorityFeeData.swapFee, 357107142)
  );
  try {
    console.log(`⏳ ~ Swapping JUP with ${amount}USDC...`);
    const tx = await jupPool.swap({
      lbPair: jupPool.pubkey,
      inToken: jupPool.tokenY.publicKey,
      outToken: jupPool.tokenX.publicKey,
      inAmount,
      minOutAmount: new BN(0),
      binArraysPubkey: binArrayPubkey,
      user: wallet.publicKey,
      priorityFee,
    });
    const txHash = await connection.sendTransaction(tx, [walletKeypair], {
      skipPreflight: true,
    });
    console.log(`🗞️ ~ Result ~ tx: ${txHash}`);
  } catch (error) {
    console.warn("❌ ~ Error:", error);
    console.warn("❌ ~ Error:", JSON.parse(JSON.stringify(error)));
  }
}

async function main() {
  if (!jupPool) {
    await init();
  }

  setInterval(() => {
    execute(1);
  }, 300);
}

main();
