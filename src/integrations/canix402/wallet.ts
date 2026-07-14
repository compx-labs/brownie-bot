import algosdk from "algosdk";

export interface TreasuryWallet {
  address: string;
  secretKey: Uint8Array;
}

export function walletFromMnemonic(mnemonic: string): TreasuryWallet {
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  return {
    address: account.addr.toString(),
    secretKey: account.sk,
  };
}
