// ---------------------------------------------------------------------------
// Business logic — plain TypeScript functions, no framework decorators
// ---------------------------------------------------------------------------
//
// Compare to Inngest:
//   export const processOrder = inngest.createFunction(
//     { id: "process-order", retries: 5 },
//     { event: "order/created" },
//     async ({ event, step }) => { ... }
//   );
//
// With Resonate, your business logic stays plain TypeScript.
// No platform wrapper, no event schema, no function discovery protocol.

export interface Order {
  id: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  customer: { id: string; email: string };
}

export interface OrderResult {
  orderId: string;
  inventoryReserved: boolean;
  paymentCharged: boolean;
  confirmationSent: boolean;
  total: number;
}

// Track inventory reservation attempts per order ID.
// Resonate retries in the same process, so on attempt 2 this counter is 2
// and the simulated crash is skipped.
const inventoryAttempts = new Map<string, number>();

// Step 1: Validate the order structure
export function validateOrder(_ctx: unknown, order: Order): boolean {
  if (!order.id || !order.customer.id || order.items.length === 0) {
    throw new Error(`Order ${order.id}: invalid order data`);
  }
  const total = order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  console.log(
    `[validate]   order ${order.id} — ${order.items.length} item(s), total $${(total / 100).toFixed(2)}`,
  );
  return true;
}

// Step 2: Reserve inventory
// On crash mode, times out on the first attempt — Resonate retries.
// Validate does NOT re-run. Only this step retries.
export function reserveInventory(
  _ctx: unknown,
  order: Order,
  simulateCrash: boolean,
): boolean {
  const attempt = (inventoryAttempts.get(order.id) ?? 0) + 1;
  inventoryAttempts.set(order.id, attempt);

  if (simulateCrash && attempt === 1) {
    console.log(`[inventory]  order ${order.id} — warehouse API timeout (attempt 1)`);
    throw new Error("Warehouse API timeout");
  }

  console.log(
    `[inventory]  order ${order.id} — reserved ${order.items.length} item(s)${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
  );
  return true;
}

// Step 3: Charge payment
export function chargePayment(_ctx: unknown, order: Order): string {
  const total = order.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const chargeId = `ch_${order.id.slice(-6)}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(
    `[payment]    order ${order.id} — charged $${(total / 100).toFixed(2)} → ${chargeId}`,
  );
  return chargeId;
}

// Step 4: Send confirmation email
export function sendConfirmation(_ctx: unknown, order: Order, chargeId: string): boolean {
  console.log(
    `[email]      order ${order.id} — confirmation sent to ${order.customer.email} (charge: ${chargeId})`,
  );
  return true;
}
