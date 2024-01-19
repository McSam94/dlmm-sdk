import {
  Cluster,
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  AccountMeta,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { IDL } from "./idl";
import {
  BASIS_POINT_MAX,
  FEE_PRECISION,
  LBCLMM_PROGRAM_IDS,
  MAX_BIN_PER_POSITION,
  MAX_FEE_RATE,
  MAX_CLAIM_ALL_ALLOWED,
  PRECISION,
  MAX_BIN_LENGTH_ALLOWED_IN_ONE_TX,
  SCALE_OFFSET,
  MAX_ACTIVE_BIN_SLIPPAGE,
} from "./constants";
import {
  BinLiquidity,
  ClmmProgram,
  LbPairAccount,
  LbPairAccountsStruct,
  PositionAccount,
  PositionBinData,
  PositionData,
  TokenReserve,
  TInitializePositionAndAddLiquidityParams,
  BinAndAmount,
  vParameters,
  sParameters,
  BinArrayAccount,
  SwapParams,
  BinLiquidityReduction,
  BinArrayBitmapExtensionAccount,
  Bin,
  BinArray,
  LiquidityParameterByWeight,
  LiquidityOneSideParameter,
  BinArrayBitmapExtension,
  PositionVersion,
  Position,
  FeeInfo,
  EmissionRate,
  PositionInfo,
  SwapQuote,
  SwapFee,
  LMRewards,
} from "./types";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  binIdToBinArrayIndex,
  chunks,
  computeFeeFromAmount,
  deriveBinArray,
  deriveBinArrayBitmapExtension,
  deriveReserve,
  getBinArrayLowerUpperBinId,
  getBinFromBinArray,
  getOrCreateATAInstruction,
  getOutAmount,
  getTokenDecimals,
  isBinIdWithinBinArray,
  isOverflowDefaultBinArrayBitmap,
  swapQuoteAtBin,
  unwrapSOLInstruction,
  wrapSOLInstruction,
  findNextBinArrayWithLiquidity,
  getTotalFee,
  toWeightDistribution,
  chunkedGetMultipleAccountInfos,
  deriveLbPair,
  deriveOracle,
  derivePresetParameter,
  computeBudgetIx,
  findNextBinArrayIndexWithLiquidity,
  computeUnitPriceIx,
} from "./helpers";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import Decimal from "decimal.js";
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Rounding, mulShr } from "./helpers/math";

type Opt = {
  cluster: Cluster | "localhost";
};

export class DLMM {
  constructor(
    public pubkey: PublicKey,
    public program: ClmmProgram,
    public lbPair: LbPairAccount,
    public binArrayBitmapExtension: BinArrayBitmapExtensionAccount | null,
    private opt?: Opt
  ) {}

  /** Static public method */

  /**
   * The function `getLbPairs` retrieves a list of LB pair accounts using a connection and optional
   * parameters.
   * @param {Connection} connection - The `connection` parameter is an instance of the `Connection`
   * class, which represents the connection to the Solana blockchain network.
   * @param {Opt} [opt] - The `opt` parameter is an optional object that contains additional options
   * for the function. It can have the following properties:
   * @returns The function `getLbPairs` returns a Promise that resolves to an array of
   * `LbPairAccountsStruct` objects.
   */
  public static async getLbPairs(
    connection: Connection,
    opt?: Opt
  ): Promise<LbPairAccountsStruct[]> {
    const provider = new AnchorProvider(
      connection,
      {} as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program(
      IDL,
      LBCLMM_PROGRAM_IDS[opt?.cluster ?? "mainnet-beta"],
      provider
    );

    return program.account.lbPair.all();
  }

  /**
   * The `create` function is a static method that creates a new instance of the `DLMM` class
   * @param {Connection} connection - The `connection` parameter is an instance of the `Connection`
   * class, which represents the connection to the Solana blockchain network.
   * @param {PublicKey} dlmm - The PublicKey of LB Pair.
   * @param {Opt} [opt] - The `opt` parameter is an optional object that can contain additional options
   * for the `create` function. It has the following properties:
   * @returns The `create` function returns a `Promise` that resolves to a `DLMM` object.
   */
  static async create(
    connection: Connection,
    dlmm: PublicKey,
    wallet: Wallet,
    opt?: Opt
  ): Promise<DLMM> {
    const cluster = opt?.cluster || "mainnet-beta";

    const provider = new AnchorProvider(
      connection,
      wallet,
      AnchorProvider.defaultOptions()
    );
    const program = new Program(IDL, LBCLMM_PROGRAM_IDS[cluster], provider);

    const binArrayBitMapExtensionPubkey = deriveBinArrayBitmapExtension(
      dlmm,
      program.programId
    )[0];
    const accountsToFetch = [dlmm, binArrayBitMapExtensionPubkey];

    const accountsInfo = await chunkedGetMultipleAccountInfos(
      connection,
      accountsToFetch
    );
    const lbPairAccountInfoBuffer = accountsInfo[0]?.data;
    if (!lbPairAccountInfoBuffer)
      throw new Error(`LB Pair account ${dlmm.toBase58()} not found`);
    const lbPairAccInfo: LbPairAccount = program.coder.accounts.decode(
      "lbPair",
      lbPairAccountInfoBuffer
    );
    const binArrayBitMapAccountInfoBuffer = accountsInfo[1]?.data;
    let binArrayBitMapExtensionAccInfo: BinArrayBitmapExtension | null = null;
    if (binArrayBitMapAccountInfoBuffer) {
      binArrayBitMapExtensionAccInfo = program.coder.accounts.decode(
        "binArrayBitmapExtension",
        binArrayBitMapAccountInfoBuffer
      );
    }

    let binArrayBitmapExtension: BinArrayBitmapExtensionAccount | null;
    if (binArrayBitMapExtensionAccInfo) {
      binArrayBitmapExtension = {
        account: binArrayBitMapExtensionAccInfo,
        publicKey: binArrayBitMapExtensionPubkey,
      };
    }

    return new DLMM(dlmm, program, lbPairAccInfo, binArrayBitmapExtension, opt);
  }

  /**
   * The function `refetchStates` retrieves and updates various states and data related to bin arrays
   * and lb pairs.
   */
  public async refetchStates(): Promise<void> {
    const binArrayBitmapExtensionPubkey = deriveBinArrayBitmapExtension(
      this.pubkey,
      this.program.programId
    )[0];
    const [lbPairAccountInfo, binArrayBitmapExtensionAccountInfo] =
      await chunkedGetMultipleAccountInfos(this.program.provider.connection, [
        this.pubkey,
        binArrayBitmapExtensionPubkey,
      ]);

    const lbPairState = this.program.coder.accounts.decode(
      "lbPair",
      lbPairAccountInfo.data
    );
    if (binArrayBitmapExtensionAccountInfo) {
      const binArrayBitmapExtensionState = this.program.coder.accounts.decode(
        "binArrayBitmapExtension",
        binArrayBitmapExtensionAccountInfo.data
      );

      if (binArrayBitmapExtensionState) {
        this.binArrayBitmapExtension = {
          account: binArrayBitmapExtensionState,
          publicKey: binArrayBitmapExtensionPubkey,
        };
      }
    }

    this.lbPair = lbPairState;
  }

  /**
   * The function `getBinArrays` returns an array of `BinArrayAccount` objects
   * @returns a Promise that resolves to an array of BinArrayAccount objects.
   */
  public async getBinArrays(): Promise<BinArrayAccount[]> {
    return this.program.account.binArray.all([
      {
        memcmp: {
          bytes: bs58.encode(this.pubkey.toBuffer()),
          offset: 8 + 16,
        },
      },
    ]);
  }

  /**
   * The function `getBinArrayAroundActiveBin` retrieves a specified number of `BinArrayAccount`
   * objects from the blockchain, based on the active bin and its surrounding bin arrays.
   * @param
   *    swapForY - The `swapForY` parameter is a boolean value that indicates whether the swap is using quote token as input.
   *    [count=4] - The `count` parameter is the number of bin arrays to retrieve on left and right respectively. By default, it is set to 4.
   * @returns an array of `BinArrayAccount` objects.
   */
  public async getBinArrayForSwap(
    swapForY,
    count = 4
  ): Promise<BinArrayAccount[]> {
    await this.refetchStates();

    const binArraysPubkey = new Set<string>();

    let shouldStop = false;
    let activeIdToLoop = this.lbPair.activeId;

    while (!shouldStop) {
      const binArrayIndex = findNextBinArrayIndexWithLiquidity(
        swapForY,
        new BN(activeIdToLoop),
        this.lbPair,
        this.binArrayBitmapExtension?.account ?? null
      );
      if (binArrayIndex === null) shouldStop = true;
      else {
        const [binArrayPubKey] = deriveBinArray(
          this.pubkey,
          binArrayIndex,
          this.program.programId
        );
        binArraysPubkey.add(binArrayPubKey.toBase58());

        const [lowerBinId, upperBinId] =
          getBinArrayLowerUpperBinId(binArrayIndex);
        activeIdToLoop = swapForY
          ? lowerBinId.toNumber() - 1
          : upperBinId.toNumber() + 1;
      }

      if (binArraysPubkey.size === count) shouldStop = true;
    }

    const accountsToFetch = Array.from(binArraysPubkey).map(
      (pubkey) => new PublicKey(pubkey)
    );

    const binArraysAccInfoBuffer = await chunkedGetMultipleAccountInfos(
      this.program.provider.connection,
      accountsToFetch
    );

    const binArrays: BinArrayAccount[] = await Promise.all(
      binArraysAccInfoBuffer.map(async (accInfo, idx) => {
        const account: BinArray = this.program.coder.accounts.decode(
          "binArray",
          accInfo.data
        );
        const publicKey = accountsToFetch[idx];
        return {
          account,
          publicKey,
        };
      })
    );

    return binArrays;
  }

  /**
   * The function retrieves the active bin ID and its corresponding price.
   * @returns an object with two properties: "binId" which is a number, and "price" which is a string.
   */
  public async getActiveBin(): Promise<{ binId: number; price: string }> {
    const { activeId } = await this.program.account.lbPair.fetch(this.pubkey);
    return {
      binId: activeId,
      price: this.getPriceOfBinByBinId(activeId),
    };
  }

  /**
   * The function get the price of a bin based on its bin ID.
   * @param {number} binId - The `binId` parameter is a number that represents the ID of a bin.
   * @returns {number} the calculated price of a bin based on the provided binId.
   */
  public getPriceOfBinByBinId(binId: number): string {
    const binStepNum = new Decimal(this.lbPair.binStep).div(
      new Decimal(BASIS_POINT_MAX)
    );
    return new Decimal(1)
      .add(new Decimal(binStepNum))
      .pow(new Decimal(binId))
      .toString();
  }

  /**
   * The function get bin ID based on a given price and a boolean flag indicating whether to
   * round down or up.
   * @param {number} price - The price parameter is a number that represents the price value.
   * @param {boolean} min - The "min" parameter is a boolean value that determines whether to round
   * down or round up the calculated binId. If "min" is true, the binId will be rounded down (floor),
   * otherwise it will be rounded up (ceil).
   * @returns {number} which is the binId calculated based on the given price and whether the minimum
   * value should be used.
   */
  public getBinIdFromPrice(price: number, min: boolean): number {
    const binStepNum = new Decimal(this.lbPair.binStep).div(
      new Decimal(BASIS_POINT_MAX)
    );
    const binId = new Decimal(price)
      .log()
      .dividedBy(new Decimal(1).add(binStepNum).log());
    return (min ? binId.floor() : binId.ceil()).toNumber();
  }

  /**
   * Returns a transaction to be signed and sent by user performing swap.
   * @param {SwapParams}
   *    - `inToken`: The public key of the token to be swapped in.
   *    - `outToken`: The public key of the token to be swapped out.
   *    - `inAmount`: The amount of token to be swapped in.
   *    - `minOutAmount`: The minimum amount of token to be swapped out.
   *    - `lbPair`: The public key of the liquidity pool.
   *    - `user`: The public key of the user account.
   *    - `binArraysPubkey`: Array of bin arrays involved in the swap
   * @returns {Promise<Transaction>}
   */
  public async swap({
    inToken,
    outToken,
    inAmount,
    minOutAmount,
    lbPair,
    user,
    binArraysPubkey,
    priorityFee,
  }: SwapParams): Promise<Transaction> {
    const { tokenXMint, tokenYMint, reserveX, reserveY, activeId, oracle } =
      await this.program.account.lbPair.fetch(lbPair);

    const preInstructions: TransactionInstruction[] = [
      computeBudgetIx(),
      ...(priorityFee ? [computeUnitPriceIx(priorityFee)] : []),
    ];

    const [
      { ataPubKey: userTokenIn, ix: createInTokenAccountIx },
      { ataPubKey: userTokenOut, ix: createOutTokenAccountIx },
    ] = await Promise.all([
      getOrCreateATAInstruction(
        this.program.provider.connection,
        inToken,
        user
      ),
      getOrCreateATAInstruction(
        this.program.provider.connection,
        outToken,
        user
      ),
    ]);
    createInTokenAccountIx && preInstructions.push(createInTokenAccountIx);
    createOutTokenAccountIx && preInstructions.push(createOutTokenAccountIx);

    if (inToken.equals(NATIVE_MINT)) {
      const wrapSOLIx = wrapSOLInstruction(
        user,
        userTokenIn,
        BigInt(inAmount.toString())
      );

      preInstructions.push(...wrapSOLIx);
    }

    const postInstructions: Array<TransactionInstruction> = [];
    if (outToken.equals(NATIVE_MINT)) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(user);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    let swapForY = true;
    if (outToken.equals(tokenXMint)) swapForY = false;

    // TODO: needs some refinement in case binArray not yet initialized
    const binArrays: AccountMeta[] = binArraysPubkey.map((pubkey) => {
      return {
        isSigner: false,
        isWritable: true,
        pubkey,
      };
    });

    return this.program.methods
      .swap(inAmount, minOutAmount)
      .accounts({
        lbPair,
        reserveX,
        reserveY,
        tokenXMint,
        tokenYMint,
        tokenXProgram: TOKEN_PROGRAM_ID, // dont use 2022 first; lack familiarity
        tokenYProgram: TOKEN_PROGRAM_ID, // dont use 2022 first; lack familiarity
        user,
        userTokenIn,
        userTokenOut,
        binArrayBitmapExtension: this.binArrayBitmapExtension
          ? this.binArrayBitmapExtension.publicKey
          : null,
        oracle,
        hostFeeIn: null,
      })
      .remainingAccounts(binArrays)
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();
  }
}
