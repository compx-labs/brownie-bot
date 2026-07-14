---
name: use-canix402-mcp
description: Interact with canix402 MCP paid tools by handling x402 preflight responses, validating payment requirements, creating and signing Algorand USDC payment transactions, retrying with paymentSignature, and signing executable quote groups locally. Use when calling canix_* paid tools or handling PAYMENT_REQUIRED, PAYMENT-SIGNATURE, paymentGroup, or encodedTransactions.
---

# Use the canix402 MCP

Use this workflow for canix402 MCP paid tools. The MCP server is walletless: it
forwards a signed x402 payment but never receives a mnemonic, private key, or
wallet session.

## Keep the two signatures separate

1. **x402 payment signature** pays for the API response. Pass its base64
   envelope back to the same MCP tool as `paymentSignature`.
2. **Execution signature** authorizes transactions returned by
   `canix_get_execution_quote`. Sign and submit those transactions only after
   receiving and reviewing the paid response.

Paying for a quote does not execute the quote. Canix neither signs nor submits
the returned execution group.

## Paid MCP workflow

1. Call the paid `canix_*` tool without `paymentSignature`.
2. Expect a result containing:
   - `error: "PAYMENT_REQUIRED"`
   - `mcpPayment.paymentRequired`
   - `mcpPayment.paymentRequiredHeader`
   - `request`, containing the request that must be retried
3. Select an Algorand accept option from
   `mcpPayment.paymentRequired.accepts`.
4. Validate the requirement before signing:
   - `scheme` is `exact`
   - `network` is the intended Algorand network
   - `asset` is the asset the user approved paying
   - `payTo` is a valid Algorand address
   - `maxAmountRequired ?? amount` is present and within the user's budget
   - `resource.url`, when present, is the expected canix402 gateway resource
5. Build and sign the payment locally.
6. Retry the same MCP tool with the same arguments plus `paymentSignature`.
   Do not change query/body arguments between preflight and retry.
7. Require a successful tool result. Record
   `mcpPayment.paymentResponseHeader` when present.

Treat amounts without a decimal point as base units. USDC has six decimals, so
`10000` is 0.01 USDC. Never substitute a documented price for the live
`PAYMENT_REQUIRED` amount.

## Remote signing model

Do not assume the remote MCP exposes an npm package or has access to a wallet.
The agent must use a signer available in its own environment, such as:

- a connected wallet or wallet SDK
- Algorand signing tools exposed by a separate, trusted MCP server
- a local script using `algosdk`

If using another MCP server for wallet operations, inspect its live tool
schemas before calling it. Do not invent tool names or assume it can construct
the complete x402 envelope. It may only be able to sign transaction bytes.

The local workflow is:

1. Get fresh suggested transaction parameters from an Algod provider.
2. Construct the transaction group from the live accept option.
3. Present the transaction details for approval when required.
4. Sign only transactions owned by the payer.
5. Construct and base64-encode the x402 envelope below.
6. Pass only that `paymentSignature` string to the remote canix402 MCP.

The payment transaction is not submitted directly. The paid MCP retry forwards
the signed group to the facilitator for verification and settlement.

## Constructing the payment

### Direct payment

1. Build an ASA transfer:
   - sender: payer address
   - receiver: `accepted.payTo`
   - asset id: `accepted.asset`
   - amount: `BigInt(accepted.maxAmountRequired ?? accepted.amount)`
   - flat fee: 1,000 microAlgos
   - note: UTF-8 `x402-payment-v2`
2. Sign it with the payer wallet.
3. Set `paymentGroup` to an array containing the base64 signed-transaction
   blob and set `paymentIndex` to `0`.

### Facilitator fee payer

When and only when `accepted.extra.feePayer` is present:

1. Build transaction 0 as a zero-ALGO self-payment from the fee-payer address,
   with a 2,000 microAlgo flat fee and note `x402-fee-payer`.
2. Build transaction 1 as the payer's ASA transfer, with fee `0` and note
   `x402-payment-v2`.
3. Assign one group ID to both transactions.
4. Keep transaction 0 unsigned and sign transaction 1 with the payer wallet.
5. Base64-encode the unsigned bytes for transaction 0 and the signed blob for
   transaction 1. Set `paymentIndex` to `1`.

Wrap either variant in this JSON shape, then base64-encode the UTF-8 JSON:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "<accepted.network>",
  "resource": "<paymentRequest.resource>",
  "accepted": "<selected accept object with normalized amount>",
  "extensions": {},
  "outputSchema": null,
  "payload": {
    "paymentGroup": ["<base64 transaction bytes>"],
    "paymentIndex": 0
  },
  "paymentRequired": "<complete decoded PAYMENT_REQUIRED object>"
}
```

Preserve the complete live `paymentRequired` and selected accept object. Do not
invent, omit, or rewrite facilitator fields.

## Signing an execution quote

For `canix_get_execution_quote`:

1. Use `canix_list_execution_shapes` first and supply the shape's required
   inputs in base units.
2. Complete the x402 payment workflow above.
3. Require `meta.executionSubmitted === false`.
4. Before signing, review:
   - `data.expiresAt` has not passed
   - every warning in `data.warnings`
   - every sender, receiver, amount, asset ID, app ID, fee, and group member in
     `data.transactions`
   - the group still matches the user's stated intent and spending limits
5. Decode each item in `data.encodedTransactions` as an unsigned Algorand
   transaction and sign it with the key for that transaction's sender.
6. Preserve order and group IDs. Do not rebuild, regroup, or modify quoted
   transactions after validation.
7. Submit all signed blobs atomically before expiry. If expired, request and
   pay for a fresh quote unless the service explicitly supports refreshing it
   without another payment.

Example for a single user signer:

```typescript
const signed = quote.data.encodedTransactions.map((encoded: string) => {
  const txn = algosdk.decodeUnsignedTransaction(
    Buffer.from(encoded, "base64"),
  );
  if (txn.sender.toString() !== account.addr.toString()) {
    throw new Error(`Unexpected signer ${txn.sender.toString()}`);
  }
  return algosdk.signTransaction(txn, account.sk).blob;
});

await algod.sendRawTransaction(signed).do();
```

Some shapes require multiple signers. Resolve keys by decoded transaction
sender; never sign every group member blindly with one key. Follow the
shape-specific documentation and treat any returned private key as sensitive.

## Secret and spend guardrails

- Never ask the user to paste a mnemonic or private key into chat.
- Read secrets only from an approved local wallet, signer, or environment
  variable, and never print them or place them in MCP arguments.
- Do not add a mnemonic to the canix402 MCP server environment.
- Obtain explicit approval before a real spend when the user has not already
  specified the endpoint, maximum payment, network, and payer.
- Refuse mismatched networks, assets, recipients, excessive amounts, stale
  quotes, unknown senders, or malformed transaction groups.
- Signing is authorization. Do not sign merely because a tool returned bytes.

## Failure handling

- A second `PAYMENT_REQUIRED` usually means the signature is stale, malformed,
  for a different request, or does not match network/asset/payTo/amount.
- A facilitator rejection with a fee payer usually means group order,
  signatures, fees, or `paymentIndex` are wrong.
- If the agent cannot access a trusted local signer, stop after validation and
  provide the unsigned transaction to the wallet owner. Do not request key
  material.
- If a paid POST is retried, preserve the exact body and content type from the
  preflight.
