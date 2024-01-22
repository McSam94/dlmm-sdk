import { Cluster, Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DLMM } from "./dlmm";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Wallet } from "@coral-xyz/anchor";
import { BN } from "bn.js";
import {
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const connection = new Connection(process.env.RPC_URL);
const walletKeypair = Keypair.fromSecretKey(
  new Uint8Array(bs58.decode(process.env.USER_PRIVATE_KEY))
);
const wallet = new Wallet(walletKeypair);

let jupPool: DLMM;
let binArrayPubkey: PublicKey[] = [];
let jupAtaAccount;
let usdcAtaAccount;

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
  const inAmount = new BN(amount * 10 ** 6);
  if (binArrayPubkey.length === 0) {
    binArrayPubkey = (await jupPool.getBinArrayForSwap(true, 17)).map(
      ({ publicKey }) => publicKey
    );
  }

  // const priorityFeeData = await fetch(process.env.PRIORITY_FEE_KV).then((res) =>
  //   res.json()
  // );
  // const priorityFee: number = Math.min(
  //   1,
  //   Math.min(priorityFeeData.swapFee, 357107142)
  // );
  try {
    console.log(`⏳ ~ Swapping JUP with ${amount}USDC...`);
    const tx = await jupPool.swap({
      lbPair: jupPool.pubkey,
      inAmount,
      minOutAmount: new BN(0),
      binArraysPubkey: binArrayPubkey,
      user: wallet.publicKey,
      // priorityFee,
      userTokenIn: usdcAtaAccount,
      userTokenOut: jupAtaAccount,
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

async function prepareATA() {
  if (!jupAtaAccount) {
    jupAtaAccount = getAssociatedTokenAddressSync(
      jupPool.lbPair.tokenXMint,
      wallet.publicKey
    );
    const jupAtaAccountBuffer = await connection.getAccountInfo(jupAtaAccount);
    if (!jupAtaAccountBuffer) {
      jupAtaAccount = await createAssociatedTokenAccount(
        connection,
        wallet.payer,
        jupPool.lbPair.tokenXMint,
        wallet.publicKey
      );
    }
  }

  if (!usdcAtaAccount) {
    usdcAtaAccount = getAssociatedTokenAddressSync(
      jupPool.lbPair.tokenYMint,
      wallet.publicKey
    );
    const usdcAtaAccountBuffer = await connection.getAccountInfo(
      usdcAtaAccount
    );
    if (!usdcAtaAccountBuffer) {
      usdcAtaAccount = await createAssociatedTokenAccount(
        connection,
        wallet.payer,
        jupPool.lbPair.tokenYMint,
        wallet.publicKey
      );
    }
  }
}

async function loopCondition() {
  const currentSlot = await connection.getSlot();
  prepareATA();

  if (currentSlot > jupPool.lbPair.activationSlot.toNumber() + 30 / 0.45) {
    setInterval(() => {
      execute(1);
    }, 300);
  } else {
    loopCondition();
  }
}

async function main() {
  if (!jupPool) {
    await init();
  }

  loopCondition();
}

main();
