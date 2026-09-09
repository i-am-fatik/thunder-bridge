import { millisatoshi } from "./amount.js";
import type { Charge, Priced } from "./types.js";

/**
 * Settle what was asked for: one address becomes a list of one, and the amount
 * becomes the millisatoshi it comes to right now. Asked once per payment, because
 * a fiat price asked twice is two different numbers and the proof has to compare
 * against the one that was actually used
 */
export async function priced(charge: Charge): Promise<Priced> {
  const to = typeof charge.to === "string" ? [charge.to] : [...charge.to];
  if (to.length === 0) {
    throw new Error("name at least one lightning address to pay");
  }

  return { to, amountMsat: await millisatoshi(charge.amount) };
}
