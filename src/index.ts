import express from "express";
import { Resonate } from "@resonatehq/sdk";
import { processOrder } from "./workflow.js";
import type { Order, OrderResult } from "./handlers.js";

// ---------------------------------------------------------------------------
// Resonate setup
// ---------------------------------------------------------------------------
//
// Compare to Inngest:
//
//   app.use("/api/inngest", serve({ client: inngest, functions: [processOrder] }));
//
// With Resonate, you mount nothing. Register your workflow once and call
// resonate.run() from any route handler. No separate serve endpoint.
// No event schema. No function discovery protocol.

const resonate = new Resonate();
resonate.register(processOrder);

// ---------------------------------------------------------------------------
// Express server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

const simulateCrash = process.argv.includes("--crash");

// ---------------------------------------------------------------------------
// POST /orders
// ---------------------------------------------------------------------------
// Accepts an order, starts a durable processing workflow in the background,
// and returns immediately with a 202 Accepted + the order ID for polling.
//
// The order.id is the idempotency key. Submit the same order twice →
// same workflow execution, guaranteed. No double-charge.

app.post("/orders", (req, res) => {
  const order = req.body as Order;

  if (!order.id || !order.customer || !order.items?.length) {
    res.status(400).json({ error: "Missing required order fields" });
    return;
  }

  console.log(`\n[api]       POST /orders — order ${order.id}`);

  // Fire-and-forget: workflow runs in background, survives crashes
  resonate.run(`order/${order.id}`, processOrder, order, simulateCrash).catch(console.error);

  // Return 202 immediately — Stripe-style async acknowledgement
  res.status(202).json({
    status: "accepted",
    orderId: order.id,
    statusUrl: `/orders/${order.id}/status`,
  });
});

// ---------------------------------------------------------------------------
// GET /orders/:id/status
// ---------------------------------------------------------------------------
// Poll for the workflow result. Returns:
//   { status: "processing" }  — still running
//   { status: "done", result } — complete
//   404                        — unknown order

app.get("/orders/:id/status", async (req, res) => {
  try {
    const handle = await resonate.get(`order/${req.params["id"]}`);
    const done = await handle.done();

    if (!done) {
      res.json({ status: "processing" });
      return;
    }

    const result = (await handle.result()) as OrderResult;
    res.json({ status: "done", result });
  } catch {
    res.status(404).json({ status: "not_found" });
  }
});

// ---------------------------------------------------------------------------
// Start server + run demo
// ---------------------------------------------------------------------------

const PORT = 3000;
const server = app.listen(PORT);

// Give the server a moment to bind
await new Promise((r) => setTimeout(r, 100));

const order: Order = {
  id: `ord_${Date.now()}`,
  items: [
    { sku: "widget-pro", qty: 2, price: 2999 },
    { sku: "widget-cable", qty: 1, price: 999 },
  ],
  customer: { id: "cus_alice", email: "alice@example.com" },
};

if (simulateCrash) {
  // ---------------------------------------------------------------------------
  // Crash demo: inventory service times out on first attempt, retries.
  // validate() runs once. reserveInventory() fails → retries → succeeds.
  // chargePayment() and sendConfirmation() only run after inventory confirmed.
  // ---------------------------------------------------------------------------
  console.log("=== Express + Resonate Integration Demo ===");
  console.log("Mode: CRASH (inventory API times out on first attempt, retries)\n");

  console.log(`[demo]      Submitting order ${order.id}`);
  const submitRes = await fetch(`http://localhost:${PORT}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
  const accepted = await submitRes.json();
  console.log(`[demo]      Response: ${JSON.stringify(accepted)}`);

  // Wait for retry to complete (~2s with default retry)
  await new Promise((r) => setTimeout(r, 3000));
} else {
  // ---------------------------------------------------------------------------
  // Happy path + idempotency demo: same order submitted twice.
  // Second submission returns the cached result — workflow runs exactly once.
  // ---------------------------------------------------------------------------
  console.log("=== Express + Resonate Integration Demo ===");
  console.log("Mode: IDEMPOTENCY (same order submitted twice, processed once)\n");

  console.log(`[demo]      First submission of order ${order.id}`);
  await fetch(`http://localhost:${PORT}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });

  // Wait for the workflow to finish
  await new Promise((r) => setTimeout(r, 500));

  console.log(`\n[demo]      Client retries same order ${order.id} (network blip)`);
  await fetch(`http://localhost:${PORT}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });

  // No new logs — the second submission finds the existing promise
  await new Promise((r) => setTimeout(r, 300));
}

// Poll for result
const statusRes = await fetch(`http://localhost:${PORT}/orders/${order.id}/status`);
const status = (await statusRes.json()) as { status: string; result?: OrderResult };

console.log("\n=== Result ===");
console.log(JSON.stringify(status.result ?? status, null, 2));

if (simulateCrash) {
  console.log(
    "\nNotice: validate ran once. Inventory timed out → retried → succeeded.",
    "\nPayment and email only ran after inventory confirmed.",
    "\nThe customer was charged exactly once.",
  );
} else {
  console.log(
    "\nNotice: each step logged exactly ONCE despite two submissions.",
    "\nThe second POST found the existing promise — no duplicate processing.",
  );
}

server.close();
