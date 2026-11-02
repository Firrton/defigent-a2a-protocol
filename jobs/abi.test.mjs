import { test } from "node:test";
import assert from "node:assert/strict";
import { toEventSelector, toFunctionSelector } from "viem";
import { ESCROW_ABI, IDENTITY_ABI, ERC20_ABI, JOB_STATUS, EVALUATION_GRACE_SECONDS } from "./abi.mjs";

test("getJob outputs follow the ERC8183 Job struct order", () => {
  const out = ESCROW_ABI.find((f) => f.name === "getJob").outputs[0].components.map((c) => `${c.type} ${c.name}`);
  assert.deepEqual(out, ["address client", "uint8 status", "address provider", "uint48 expiredAt", "address evaluator", "uint48 submittedAt",
    "uint256 budget", "address hook", "address paymentToken", "uint256 providerAgentId", "string description", "uint256 settledAmount", "address payoutReceiver"]);
});

test("write selectors match the contract signatures", () => {
  for (const sig of ["createJob(address,address,uint48,string,address,uint256)", "setBudget(uint256,address,uint256,bytes)", "fund(uint256,address,uint256,bytes)",
    "submit(uint256,bytes32,bytes)", "complete(uint256,bytes32,bytes)", "reject(uint256,bytes32,bytes)", "claimRefund(uint256)"])
    assert.ok(ESCROW_ABI.some((f) => f.type === "function" && toFunctionSelector(f) === toFunctionSelector(sig)), sig);
});

test("escrow views are present with their contract signatures", () => {
  for (const sig of ["getJob(uint256)", "jobCounter()", "allowedPaymentTokens(address)", "pendingClaimHash(uint256)", "whitelistedHooks(address)"])
    assert.ok(ESCROW_ABI.some((f) => f.type === "function" && f.stateMutability === "view" && toFunctionSelector(f) === toFunctionSelector(sig)), sig);
});

test("JobCreated and JobSubmitted match ERC8183.sol topics and indexing", () => {
  const ev = (name) => ESCROW_ABI.find((f) => f.type === "event" && f.name === name);
  assert.equal(toEventSelector(ev("JobCreated")), toEventSelector("JobCreated(uint256,address,address,address,uint48,address)"));
  assert.deepEqual(ev("JobCreated").inputs.map((i) => [i.name, !!i.indexed]),
    [["jobId", true], ["client", true], ["provider", true], ["evaluator", false], ["expiredAt", false], ["hook", false]]);
  assert.equal(toEventSelector(ev("JobSubmitted")), toEventSelector("JobSubmitted(uint256,address,bytes32)"));
  assert.deepEqual(ev("JobSubmitted").inputs.map((i) => [i.name, !!i.indexed]), [["jobId", true], ["provider", true], ["deliverable", false]]);
});

test("identity and ERC20 ABIs carry the selectors the server already uses", () => {
  const sel = (abi, name) => toFunctionSelector(abi.find((f) => f.name === name));
  assert.equal(sel(IDENTITY_ABI, "ownerOf"), "0x6352211e");
  assert.equal(sel(IDENTITY_ABI, "getAgentWallet"), "0x00339509");
  assert.equal(sel(ERC20_ABI, "approve"), toFunctionSelector("approve(address,uint256)"));
  assert.equal(sel(ERC20_ABI, "decimals"), toFunctionSelector("decimals()"));
});

test("status names follow the JobStatus enum and the grace period is one hour", () => {
  assert.deepEqual(JOB_STATUS, ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);
  assert.equal(EVALUATION_GRACE_SECONDS, 3600);
});
