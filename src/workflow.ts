import type { Context } from "@resonatehq/sdk";
import {
  validateOrder,
  reserveInventory,
  chargePayment,
  sendConfirmation,
  type Order,
  type OrderResult,
} from "./handlers.js";

// ---------------------------------------------------------------------------
// Order Processing Workflow
// ---------------------------------------------------------------------------
//
// This is the durable backbone behind a POST /orders endpoint.
//
// Steps run in sequence. If any step fails, Resonate retries from that step —
// the steps before it do NOT re-run. If the process crashes mid-workflow,
// it resumes from the last checkpoint on restart.
//
// The promise ID is `order/${order.id}`. If the same order ID is submitted
// twice (client retry, double-click), the second call finds the existing
// promise and returns the cached result — no double-charge, no double-ship.

export function* processOrder(
  ctx: Context,
  order: Order,
  simulateCrash: boolean,
): Generator<any, OrderResult, any> {
  // Step 1: Validate — runs once and is checkpointed
  yield* ctx.run(validateOrder, order);

  // Step 2: Reserve inventory — checkpointed. Crash here → retries step 2 only.
  // validate() does NOT re-run.
  yield* ctx.run(reserveInventory, order, simulateCrash);

  // Step 3: Charge payment — only runs after inventory is confirmed
  const chargeId = yield* ctx.run(chargePayment, order);

  // Step 4: Send confirmation — only runs after charge succeeds
  yield* ctx.run(sendConfirmation, order, chargeId);

  const total = order.items.reduce((sum, i) => sum + i.price * i.qty, 0);

  return {
    orderId: order.id,
    inventoryReserved: true,
    paymentCharged: true,
    confirmationSent: true,
    total,
  };
}
