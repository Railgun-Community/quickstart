import { BigNumber } from '@ethersproject/bignumber';
import { PopulatedTransaction } from '@ethersproject/contracts';
import { BaseProvider } from '@ethersproject/providers';
import { SerializedTransaction } from '@railgun-community/engine';
import {
  NetworkName,
  TransactionGasDetails,
  RailgunWalletTokenAmount,
  TransactionGasDetailsSerialized,
  RailgunTransactionGasEstimateResponse,
  FeeTokenDetails,
  calculateMaximumGas,
  NETWORK_CONFIG,
  RailgunWalletTokenAmountRecipient,
} from '@railgun-community/shared-models';
import { getProviderForNetwork } from '../railgun/core/providers';
import {
  DUMMY_FROM_ADDRESS,
  createDummyRelayerFeeTokenAmount,
} from './tx-generator';
import {
  getGasEstimate,
  deserializeTransactionGasDetails,
  gasEstimateResponse,
} from './tx-gas-details';
import { balanceForToken } from '../railgun/wallets/balance-update';
import { walletForID } from '../railgun';

const MAX_ITERATIONS_RELAYER_FEE_REESTIMATION = 5;

export const calculateRelayerFeeTokenAmount = (
  feeTokenDetails: FeeTokenDetails,
  gasDetails: TransactionGasDetails,
): RailgunWalletTokenAmount => {
  const tokenFeePerUnitGas = BigNumber.from(feeTokenDetails.feePerUnitGas);
  const oneUnitGas = BigNumber.from(10).pow(18);
  const maximumGas = calculateMaximumGas(gasDetails);
  const tokenFee = tokenFeePerUnitGas.mul(maximumGas).div(oneUnitGas);

  return {
    tokenAddress: feeTokenDetails.tokenAddress,
    amountString: tokenFee.toHexString(),
  };
};

const getUpdatedRelayerFeeForGasEstimation = async (
  provider: BaseProvider,
  populatedTransaction: PopulatedTransaction,
  fromWalletAddress: string,
  originalGasDetails: TransactionGasDetails,
  feeTokenDetails: FeeTokenDetails,
  multiplierBasisPoints?: number,
): Promise<RailgunWalletTokenAmount> => {
  const gasEstimate = await getGasEstimate(
    populatedTransaction,
    provider,
    fromWalletAddress,
    multiplierBasisPoints,
  );

  const updatedGasDetails: TransactionGasDetails = {
    ...originalGasDetails,
    gasEstimate,
  };

  const relayerFeeTokenAmount: RailgunWalletTokenAmount =
    calculateRelayerFeeTokenAmount(feeTokenDetails, updatedGasDetails);

  return relayerFeeTokenAmount;
};

export const gasEstimateResponseIterativeRelayerFee = async (
  generateSerializedTransactions: (
    relayerFeeTokenAmount: Optional<RailgunWalletTokenAmount>,
  ) => Promise<SerializedTransaction[]>,
  generatePopulatedTransaction: (
    serializedTransactions: SerializedTransaction[],
  ) => Promise<PopulatedTransaction>,
  networkName: NetworkName,
  railgunWalletID: string,
  tokenAmountRecipients: RailgunWalletTokenAmountRecipient[],
  originalGasDetailsSerialized: TransactionGasDetailsSerialized,
  feeTokenDetails: Optional<FeeTokenDetails>,
  sendWithPublicWallet: boolean,
  multiplierBasisPoints: Optional<number>,
): Promise<RailgunTransactionGasEstimateResponse> => {
  const wallet = walletForID(railgunWalletID);
  const provider = getProviderForNetwork(networkName);
  const originalGasDetails = deserializeTransactionGasDetails(
    originalGasDetailsSerialized,
  );

  // Use dead address for private transaction gas estimate
  const fromWalletAddress = DUMMY_FROM_ADDRESS;

  const dummyRelayerFee = feeTokenDetails
    ? createDummyRelayerFeeTokenAmount(feeTokenDetails.tokenAddress)
    : undefined;

  let serializedTransactions = await generateSerializedTransactions(
    dummyRelayerFee,
  );
  let populatedTransaction = await generatePopulatedTransaction(
    serializedTransactions,
  );

  let gasEstimate = await getGasEstimate(
    populatedTransaction,
    provider,
    fromWalletAddress,
    multiplierBasisPoints,
  );

  if (sendWithPublicWallet) {
    return gasEstimateResponse(gasEstimate);
  }

  if (!feeTokenDetails) {
    throw new Error(
      'Must have Relayer Fee details or sendWithPublicWallet field.',
    );
  }

  // Find tokenAmount that matches token of relayer fee, if exists.
  const relayerFeeMatchingSendingTokenAmount = tokenAmountRecipients.find(
    tokenAmountRecipient =>
      tokenAmountRecipient.tokenAddress.toLowerCase() ===
      feeTokenDetails.tokenAddress.toLowerCase(),
  );

  // Get private balance of matching token.
  const matchingSendingTokenBalance: Optional<BigNumber> =
    await balanceForToken(
      wallet,
      NETWORK_CONFIG[networkName].chain,
      feeTokenDetails.tokenAddress,
    );

  // Iteratively calculate new relayer fee and estimate new gas amount.
  // This change if the number of circuits changes because of the additional Relayer Fees.
  for (let i = 0; i < MAX_ITERATIONS_RELAYER_FEE_REESTIMATION; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const updatedRelayerFee = await getUpdatedRelayerFeeForGasEstimation(
      provider,
      populatedTransaction,
      fromWalletAddress,
      originalGasDetails,
      feeTokenDetails,
      multiplierBasisPoints,
    );

    // If Relayer fee causes overflow with the token balance,
    // then use the MAX amount for Relayer Fee, which is BALANCE - SENDING AMOUNT.
    if (
      relayerFeeMatchingSendingTokenAmount &&
      matchingSendingTokenBalance &&
      // eslint-disable-next-line no-await-in-loop
      (await relayerFeeWillOverflowBalance(
        matchingSendingTokenBalance,
        relayerFeeMatchingSendingTokenAmount,
        updatedRelayerFee,
      ))
    ) {
      updatedRelayerFee.amountString = matchingSendingTokenBalance
        .sub(relayerFeeMatchingSendingTokenAmount.amountString)
        .toHexString();
    }

    // eslint-disable-next-line no-await-in-loop
    const newSerializedTransactions = await generateSerializedTransactions(
      updatedRelayerFee,
    );

    if (
      compareCircuitSizesSerializedTransactions(
        newSerializedTransactions,
        serializedTransactions,
      )
    ) {
      // Same circuit sizes, no need to run gas estimates.
      return gasEstimateResponse(gasEstimate);
    }

    serializedTransactions = newSerializedTransactions;

    // eslint-disable-next-line no-await-in-loop
    populatedTransaction = await generatePopulatedTransaction(
      serializedTransactions,
    );

    // eslint-disable-next-line no-await-in-loop
    const newGasEstimate = await getGasEstimate(
      populatedTransaction,
      provider,
      fromWalletAddress,
      multiplierBasisPoints,
    );

    if (newGasEstimate.toHexString() === gasEstimate.toHexString()) {
      return gasEstimateResponse(newGasEstimate);
    }
    gasEstimate = newGasEstimate;
  }

  return gasEstimateResponse(gasEstimate);
};

const compareCircuitSizesSerializedTransactions = (
  serializedA: SerializedTransaction[],
  serializedB: SerializedTransaction[],
) => {
  if (serializedA.length !== serializedB.length) {
    return false;
  }
  for (let i = 0; i < serializedA.length; i += 1) {
    if (
      serializedA[i].commitments.length !== serializedB[i].commitments.length
    ) {
      return false;
    }
    if (serializedA[i].nullifiers.length !== serializedB[i].nullifiers.length) {
      return false;
    }
  }
  return true;
};

const relayerFeeWillOverflowBalance = async (
  tokenBalance: BigNumber,
  sendingTokenAmount: RailgunWalletTokenAmount,
  relayerFeeTokenAmount: RailgunWalletTokenAmount,
) => {
  const sendingAmount = BigNumber.from(sendingTokenAmount.amountString);
  const relayerFeeAmount = BigNumber.from(relayerFeeTokenAmount.amountString);

  return sendingAmount.add(relayerFeeAmount).gt(tokenBalance);
};
