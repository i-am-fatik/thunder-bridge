import { ThunderBridge, type ThunderBridgeOptions, type WaitOptions } from "./client.js";
import type { TriggerEvent, WatchPaymentParams } from "./types.js";

export interface GatewaysOptions extends ThunderBridgeOptions {
  /**
   * Called for each gateway that would not take the watch, with the url and what
   * it said. Registering at three and having one refuse still leaves you watched,
   * so this is how you find out you are less covered than you asked to be, rather
   * than finding out when the one that took it goes away
   */
  onRefused?: (baseUrl: string, refusal: unknown) => void;
}

/**
 * The same payment watched at several gateways at once, which is what makes any
 * one of them replaceable. They all answer with the same name for it, because a
 * payment is named after the caller and not after any gateway, so the first
 * delivery to arrive is the answer and the rest are the same news twice.
 *
 * For watching only. Two gateways asked to mint would fetch two different invoices
 * from the wallet and only one of them could ever be paid
 */
export class Gateways {
  readonly each: readonly ThunderBridge[];

  private readonly urls: readonly string[];
  private readonly onRefused: (baseUrl: string, refusal: unknown) => void;

  constructor(baseUrls: string[], options?: GatewaysOptions) {
    if (baseUrls.length === 0) throw new Error("name at least one gateway to watch at");

    this.urls = [...baseUrls];
    this.each = baseUrls.map((baseUrl) => new ThunderBridge(baseUrl, options));
    this.onRefused = options?.onRefused ?? (() => {});
  }

  /** What this payment is called, which every gateway here will agree on */
  async nameFor(paymentHash: string): Promise<string | null> {
    return await this.each[0]!.nameFor(paymentHash);
  }

  /**
   * Hand the same invoice to every gateway. Throws only when none of them took it,
   * carrying the first refusal, because one gateway that agreed is enough to be
   * watched
   */
  async watchPayment(params: WatchPaymentParams): Promise<TriggerEvent> {
    const asked = await Promise.allSettled(this.each.map((gateway) => gateway.watchPayment(params)));
    const taken: TriggerEvent[] = [];

    for (const [at, answer] of asked.entries()) {
      if (answer.status === "fulfilled") taken.push(answer.value);
      else this.onRefused(this.urls[at]!, answer.reason);
    }
    if (taken.length === 0) {
      throw (asked.find((answer) => answer.status === "rejected") as PromiseRejectedResult).reason;
    }

    return taken[0]!;
  }

  /**
   * Wait for whichever gateway speaks first. A settlement from any of them is the
   * settlement, and each has already proved the preimage against the hash before
   * saying so. When they all end without a payment, the first ending is the answer,
   * and when they all fail, the first failure is thrown
   */
  async waitForWatched(id: string, options?: WaitOptions): Promise<TriggerEvent> {
    const stopLosers = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([stopLosers.signal, options.signal])
      : stopLosers.signal;
    const unpaid: TriggerEvent[] = [];
    let refused: unknown = null;

    try {
      const settled = await new Promise<TriggerEvent | null>((resolve) => {
        let waiting = this.each.length;
        const lost = () => {
          waiting -= 1;
          if (waiting === 0) resolve(null);
        };
        for (const gateway of this.each) {
          gateway
            .waitForWatched(id, { ...options, signal })
            .then((watched) => {
              if (watched.status === "paid") return resolve(watched);
              unpaid.push(watched);
              lost();
            })
            .catch((failure: unknown) => {
              refused ??= failure;
              lost();
            });
        }
      });
      if (settled !== null) return settled;
      if (unpaid.length > 0) return unpaid[0]!;

      throw refused;
    } finally {
      stopLosers.abort();
    }
  }
}
