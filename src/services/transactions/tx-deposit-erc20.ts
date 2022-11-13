import { PopulatedTransaction } from '@ethersproject/contracts';
import {
  RailgunPopulateTransactionResponse,
  RailgunTransactionGasEstimateResponse,
  RailgunWalletTokenAmount,
  TransactionGasDetailsSerialized,
  NetworkName,
  NETWORK_CONFIG,
  sanitizeError,
  serializeUnsignedTransaction,
} from '@railgun-community/shared-models';
import { ERC20Deposit , RailgunEngine , DepositInput , randomHex } from '@railgun-community/engine';
import {
  getProxyContractForNetwork,
  getProviderForNetwork,
} from '../railgun/core/providers';
import {
  gasEstimateResponse,
  getGasEstimate,
  setGasDetailsForPopulatedTransaction,
} from './tx-gas-details';
import { sendErrorMessage } from '../../utils/logger';
import { walletForID } from '../railgun/core/engine';
import { assertNotBlockedAddress } from '../../utils/blocked-address';

const generateDepositTransaction = async (
  networkName: NetworkName,
  railgunWalletID: string,
  tokenAmounts: RailgunWalletTokenAmount[],
): Promise<PopulatedTransaction> => {
  try {
    const railgunWallet = walletForID(railgunWalletID);
    const { chain } = NETWORK_CONFIG[networkName];
    const railgunAddress = railgunWallet.getAddress(chain);
    const railContract = getProxyContractForNetwork(networkName);
    const { masterPublicKey } = RailgunEngine.decodeAddress(railgunAddress);
    const vpk = railgunWallet.getViewingKeyPair().privateKey;
    const random = randomHex(16);

    const depositInputs: DepositInput[] = [];

    tokenAmounts.forEach(tokenAmount => {
      const deposit = new ERC20Deposit(
        masterPublicKey,
        random,
        BigInt(tokenAmount.amountString),
        tokenAmount.tokenAddress,
      );
      const depositInput: DepositInput = deposit.serialize(vpk);
      depositInputs.push(depositInput);
    });

    const populatedTransaction = await railContract.generateDeposit(
      depositInputs,
    );
    return populatedTransaction;
  } catch (err) {
    sendErrorMessage(err.message);
    sendErrorMessage(err.stack);
    throw sanitizeError(err);
  }
};

export const populateDeposit = async (
  networkName: NetworkName,
  railgunWalletID: string,
  tokenAmounts: RailgunWalletTokenAmount[],
  gasDetailsSerialized: Optional<TransactionGasDetailsSerialized>,
): Promise<RailgunPopulateTransactionResponse> => {
  try {
    const populatedTransaction = await generateDepositTransaction(
      networkName,
      railgunWalletID,
      tokenAmounts,
    );

    setGasDetailsForPopulatedTransaction(
      populatedTransaction,
      gasDetailsSerialized,
    );

    return {
      serializedTransaction: serializeUnsignedTransaction(populatedTransaction),
    };
  } catch (err) {
    sendErrorMessage(err.message);
    sendErrorMessage(err.stack);
    const railResponse: RailgunPopulateTransactionResponse = {
      error: sanitizeError(err).message,
    };
    return railResponse;
  }
};

export const gasEstimateForDeposit = async (
  networkName: NetworkName,
  railgunWalletID: string,
  tokenAmounts: RailgunWalletTokenAmount[],
  fromWalletAddress: string,
): Promise<RailgunTransactionGasEstimateResponse> => {
  try {
    assertNotBlockedAddress(fromWalletAddress);

    const populatedTransaction = await generateDepositTransaction(
      networkName,
      railgunWalletID,
      tokenAmounts,
    );

    const provider = getProviderForNetwork(networkName);
    return gasEstimateResponse(
      await getGasEstimate(populatedTransaction, provider, fromWalletAddress),
    );
  } catch (err) {
    sendErrorMessage(err.message);
    sendErrorMessage(err.stack);
    const railResponse: RailgunTransactionGasEstimateResponse = {
      error: sanitizeError(err).message,
    };
    return railResponse;
  }
};