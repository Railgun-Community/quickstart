import { FallbackProvider } from '@ethersproject/providers';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon, { SinonStub, SinonSpy } from 'sinon';
import {
  RailgunWallet,
  SerializedTransaction,
  TransactionBatch,
  RailgunProxyContract,
  RelayAdaptContract,
} from '@railgun-community/engine';
import {
  RailgunWalletTokenAmount,
  NetworkName,
  deserializeTransaction,
  RailgunWalletTokenAmountRecipient,
} from '@railgun-community/shared-models';
import { BigNumber } from '@ethersproject/bignumber';
import { PopulatedTransaction } from '@ethersproject/contracts';
import {
  initTestEngine,
  initTestEngineNetwork,
} from '../../../test/setup.test';
import {
  MOCK_DB_ENCRYPTION_KEY,
  MOCK_ETH_WALLET_ADDRESS,
  MOCK_FEE_TOKEN_DETAILS,
  MOCK_MEMO,
  MOCK_MNEMONIC,
  MOCK_RAILGUN_WALLET_ADDRESS,
  MOCK_TOKEN_ADDRESS,
  MOCK_TOKEN_ADDRESS_2,
  MOCK_TOKEN_AMOUNTS,
  MOCK_TOKEN_FEE,
  MOCK_TRANSACTION_GAS_DETAILS_SERIALIZED_TYPE_2,
} from '../../../test/mocks.test';
import {
  populateProvedTransfer,
  gasEstimateForUnprovenTransfer,
} from '../tx-transfer';
import { generateTransferProof } from '../tx-proof-transfer';
import { createRailgunWallet } from '../../railgun/wallets/wallets';
import { fullWalletForID } from '../../railgun/core/engine';
import { setCachedProvedTransaction } from '../proof-cache';
import { decimalToHexString } from '../../../utils/format';
import * as txErc20Notes from '../tx-erc20-notes';

let gasEstimateStub: SinonStub;
let railProveStub: SinonStub;
let railDummyProveStub: SinonStub;
let railTransactStub: SinonStub;
let relayAdaptPopulateWithdrawBaseToken: SinonStub;
let setWithdrawSpy: SinonSpy;
let erc20NoteSpy: SinonSpy;

let railgunWallet: RailgunWallet;
let relayerFeeTokenAmountRecipient: RailgunWalletTokenAmountRecipient;

chai.use(chaiAsPromised);
const { expect } = chai;

const MOCK_TOKEN_AMOUNTS_DIFFERENT: RailgunWalletTokenAmount[] = [
  {
    tokenAddress: MOCK_TOKEN_ADDRESS,
    amountString: '100',
  },
  {
    tokenAddress: MOCK_TOKEN_ADDRESS_2,
    amountString: '300',
  },
];

const MOCK_TOKEN_AMOUNT_RECIPIENTS_INVALID: RailgunWalletTokenAmountRecipient[] =
  MOCK_TOKEN_AMOUNTS.map(tokenAmount => ({
    ...tokenAmount,
    recipientAddress: MOCK_ETH_WALLET_ADDRESS,
  }));

const MOCK_TOKEN_AMOUNT_RECIPIENTS: RailgunWalletTokenAmountRecipient[] =
  MOCK_TOKEN_AMOUNTS.map(tokenAmount => ({
    ...tokenAmount,
    recipientAddress: MOCK_RAILGUN_WALLET_ADDRESS,
  }));

const MOCK_TOKEN_AMOUNT_RECIPIENTS_DIFFERENT: RailgunWalletTokenAmountRecipient[] =
  MOCK_TOKEN_AMOUNTS_DIFFERENT.map(tokenAmount => ({
    ...tokenAmount,
    recipientAddress: MOCK_ETH_WALLET_ADDRESS,
  }));

const stubGasEstimateSuccess = () => {
  gasEstimateStub = Sinon.stub(
    FallbackProvider.prototype,
    'estimateGas',
  ).resolves(BigNumber.from('200'));
};

const stubGasEstimateFailure = () => {
  gasEstimateStub = Sinon.stub(
    FallbackProvider.prototype,
    'estimateGas',
  ).rejects(new Error('test rejection - gas estimate'));
};

const spyOnERC20Note = () => {
  erc20NoteSpy = Sinon.spy(txErc20Notes, 'erc20NoteFromTokenAmount');
};

describe('tx-withdraw-transfer', () => {
  before(async () => {
    initTestEngine();
    await initTestEngineNetwork();
    const { railgunWalletInfo } = await createRailgunWallet(
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MNEMONIC,
      undefined, // creationBlockNumbers
    );
    if (!railgunWalletInfo) {
      throw new Error('Expected railgunWalletInfo');
    }
    railgunWallet = fullWalletForID(railgunWalletInfo.id);

    const { railgunWalletInfo: relayerWalletInfo } = await createRailgunWallet(
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MNEMONIC,
      undefined, // creationBlockNumbers
    );
    if (!relayerWalletInfo) {
      throw new Error('Expected relayerWalletInfo');
    }

    const relayerRailgunAddress = relayerWalletInfo.railgunAddress;

    relayerFeeTokenAmountRecipient = {
      ...MOCK_TOKEN_FEE,
      recipientAddress: relayerRailgunAddress,
    };

    railProveStub = Sinon.stub(
      TransactionBatch.prototype,
      'generateSerializedTransactions',
    ).resolves([{}] as SerializedTransaction[]);
    railDummyProveStub = Sinon.stub(
      TransactionBatch.prototype,
      'generateDummySerializedTransactions',
    ).resolves([
      {
        commitments: [BigInt(2)],
        nullifiers: [BigInt(1), BigInt(2)],
      },
    ] as SerializedTransaction[]);
    railTransactStub = Sinon.stub(
      RailgunProxyContract.prototype,
      'transact',
    ).resolves({ data: '0x0123' } as PopulatedTransaction);
    relayAdaptPopulateWithdrawBaseToken = Sinon.stub(
      RelayAdaptContract.prototype,
      'populateWithdrawBaseToken',
    ).resolves({ data: '0x0123' } as PopulatedTransaction);
  });
  afterEach(() => {
    gasEstimateStub?.restore();
    setWithdrawSpy?.restore();
    erc20NoteSpy?.restore();
  });
  after(() => {
    railProveStub.restore();
    railDummyProveStub.restore();
    railTransactStub.restore();
    relayAdaptPopulateWithdrawBaseToken.restore();
  });

  // TRANSFER - GAS ESTIMATE

  it('Should get gas estimates for valid transfer', async () => {
    stubGasEstimateSuccess();
    spyOnERC20Note();
    const rsp = await gasEstimateForUnprovenTransfer(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      MOCK_TRANSACTION_GAS_DETAILS_SERIALIZED_TYPE_2,
      MOCK_FEE_TOKEN_DETAILS,
      false, // sendWithPublicWallet
    );
    expect(erc20NoteSpy.called).to.be.true;
    expect(erc20NoteSpy.args.length).to.equal(6); // Number of calls - 3 for each of 2 relayer fee iterations
    expect(erc20NoteSpy.args[0][0].amountString).to.equal('0x00'); // original relayer fee
    expect(erc20NoteSpy.args[1][0].amountString).to.equal('0x100'); // token1
    expect(erc20NoteSpy.args[2][0].amountString).to.equal('0x200'); // token2
    expect(erc20NoteSpy.args[3][0].amountString).to.equal('0x0275a8919e7f2d2e'); // New estimated Relayer Fee
    expect(erc20NoteSpy.args[4][0].amountString).to.equal('0x100'); // token1
    expect(erc20NoteSpy.args[5][0].amountString).to.equal('0x200'); // token2
    expect(rsp.error).to.be.undefined;
    expect(rsp.gasEstimateString).to.equal(decimalToHexString(200));
  });

  it('Should get gas estimates for valid transfer: public wallet', async () => {
    stubGasEstimateSuccess();
    spyOnERC20Note();
    const rsp = await gasEstimateForUnprovenTransfer(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      MOCK_TRANSACTION_GAS_DETAILS_SERIALIZED_TYPE_2,
      MOCK_FEE_TOKEN_DETAILS,
      true, // sendWithPublicWallet
    );
    expect(erc20NoteSpy.called).to.be.true;
    expect(erc20NoteSpy.args.length).to.equal(2); // Number of calls (without relayer fees)
    expect(erc20NoteSpy.args[0][0].amountString).to.equal('0x100'); // token1
    expect(erc20NoteSpy.args[1][0].amountString).to.equal('0x200'); // token2
    expect(rsp.error).to.be.undefined;
    expect(rsp.gasEstimateString).to.equal(decimalToHexString(200));
  });

  it('Should error on gas estimates for invalid transfer', async () => {
    stubGasEstimateSuccess();
    const rsp = await gasEstimateForUnprovenTransfer(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS_INVALID,
      MOCK_TRANSACTION_GAS_DETAILS_SERIALIZED_TYPE_2,
      MOCK_FEE_TOKEN_DETAILS,
      false, // sendWithPublicWallet
    );
    expect(rsp.error).to.equal('Invalid RAILGUN address.');
  });

  it('Should error on transfer gas estimate for ethers rejections', async () => {
    stubGasEstimateFailure();
    const rsp = await gasEstimateForUnprovenTransfer(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      MOCK_TRANSACTION_GAS_DETAILS_SERIALIZED_TYPE_2,
      MOCK_FEE_TOKEN_DETAILS,
      false, // sendWithPublicWallet
    );
    expect(rsp.error).to.equal('test rejection - gas estimate');
  });

  // TRANSFER - PROVE AND SEND

  it('Should populate tx for valid transfer', async () => {
    stubGasEstimateSuccess();
    setCachedProvedTransaction(undefined);
    spyOnERC20Note();
    const proofResponse = await generateTransferProof(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      () => {}, // progressCallback
    );
    expect(erc20NoteSpy.called).to.be.true;
    expect(erc20NoteSpy.args[0][0].amountString).to.equal(
      MOCK_TOKEN_FEE.amountString,
    );
    expect(proofResponse.error).to.be.undefined;
    const populateResponse = await populateProvedTransfer(
      railgunWallet.id,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      undefined, // gasDetailsSerialized
    );
    expect(populateResponse.error).to.be.undefined;
    expect(populateResponse.serializedTransaction).to.equal(
      '0xc88080808080820123',
    );
    const deserialized = deserializeTransaction(
      populateResponse.serializedTransaction as string,
      2,
      1,
    );

    expect(deserialized.nonce).to.equal(2);
    expect(deserialized.gasPrice?.toString()).to.equal('0');
    expect(deserialized.gasLimit?.toString()).to.equal('0');
    expect(deserialized.value?.toString()).to.equal('0');
    expect(deserialized.data).to.equal('0x0123');
    expect(deserialized.to).to.equal(null);
    expect(deserialized.chainId).to.equal(1);
    expect(deserialized.type).to.equal(undefined);
    expect(Object.keys(deserialized).length).to.equal(8);
  });

  it('Should error on populate tx for invalid transfer', async () => {
    stubGasEstimateSuccess();
    const rsp = await populateProvedTransfer(
      railgunWallet.id,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS_INVALID,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      undefined, // gasDetailsSerialized
    );
    expect(rsp.error).to.equal(
      'Invalid proof for this transaction. Mismatch: tokenAmountRecipients.',
    );
  });

  it('Should error on populate transfer tx for unproved transaction', async () => {
    stubGasEstimateSuccess();
    setCachedProvedTransaction(undefined);
    const rsp = await populateProvedTransfer(
      railgunWallet.id,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      undefined, // gasDetailsSerialized
    );
    expect(rsp.error).to.equal(
      'Invalid proof for this transaction. No proof found.',
    );
  });

  it('Should error on populate transfer tx when params changed (invalid cached proof)', async () => {
    stubGasEstimateSuccess();
    const proofResponse = await generateTransferProof(
      NetworkName.Polygon,
      railgunWallet.id,
      MOCK_DB_ENCRYPTION_KEY,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      () => {}, // progressCallback
    );
    expect(proofResponse.error).to.be.undefined;
    const rsp = await populateProvedTransfer(
      railgunWallet.id,
      MOCK_MEMO,
      MOCK_TOKEN_AMOUNT_RECIPIENTS_DIFFERENT,
      relayerFeeTokenAmountRecipient,
      false, // sendWithPublicWallet
      undefined, // gasDetailsSerialized
    );
    expect(rsp.error).to.equal(
      'Invalid proof for this transaction. Mismatch: tokenAmountRecipients.',
    );
  });
});
