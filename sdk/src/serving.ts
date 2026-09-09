import { type BankVerifyConfig, bankVerifyEndpoint } from "./bank.js";
import type { ThunderBridge } from "./client.js";
import {
  type LightningVerifyConfig,
  lightningVerifyEndpoint,
  type Relayed,
  relayedVerifyUrl,
} from "./relay.js";
import {
  lnurlPayEndpoint,
  publicWatchTicketEndpoint,
  type TriggerConfig,
  type WatchTicketConfig,
  watchTicketEndpoint,
} from "./trigger.js";
import type { Payment, Settlement } from "./types.js";
import { carriesProof } from "./verify.js";
import {
  answerVerifyChallenge,
  answerWebhookChallenge,
  readPayment,
  readSettlement,
  type WebhookCredential,
  type WebhookOptions,
} from "./webhook.js";

/** A Fetch handler, which is what every runtime this targets mounts */
export type Handler = (request: Request) => Promise<Response>;

/** What to do with what the gateway delivers, and what to believe it with */
export interface WebhookHandlers {
  /**
   * A settlement that proves itself: it says paid and its preimage hashes to the
   * payment hash it names. This is the only callback a shop needs
   */
  onSettled?: (settlement: Settlement) => void | Promise<void>;

  /**
   * A delivery that carries no proof, so an expiry or a paid claim with no
   * preimage behind it. Left unset, the handler answers `202` and does nothing,
   * because acting on an unproven claim is the one thing this refuses to do
   */
  onUnproven?: (settlement: Settlement) => void | Promise<void>;

  /** A whole payment rather than a settlement, which is what an older gateway posts */
  onPayment?: (payment: Payment) => void | Promise<void>;

  /**
   * The key that checks the signature, fetched from the gateway once and kept
   * when you do not pass one. Pass it to pin the key you already read
   */
  credential?: WebhookCredential;

  /** How far the gateway's clock may drift from yours, five minutes by default */
  toleranceSecs?: number;
}

/**
 * Everything one gateway lets you mount. Each of these was a free function that
 * took the gateway as a config field, and reaching them through the gateway is
 * what deleted that field
 */
export class Serve {
  constructor(private readonly gateway: ThunderBridge) {}

  /**
   * An LNURL-pay endpoint of your own, standing in front of a priority list of
   * addresses, so a printed QR points at your domain and never expires
   */
  lnurlPay(config: TriggerConfig): Handler {
    return lnurlPayEndpoint(this.gateway, config);
  }

  /** Trades the watch secret for a one minute socket ticket, refusing anyone without it */
  watchTicket(config: WatchTicketConfig): Handler {
    return watchTicketEndpoint(this.gateway, config);
  }

  /**
   * Mints a socket ticket for anybody who asks, which makes the trigger's whole
   * stream public, preimages included. Only for a board where that is the point
   */
  publicWatchTicket(config: WatchTicketConfig): Handler {
    return publicWatchTicketEndpoint(this.gateway, config);
  }

  /**
   * A verify endpoint of your own that asks the recipient's wallet for you, so
   * the gateway polls you and never the wallet
   */
  verify(config: LightningVerifyConfig): Handler {
    return lightningVerifyEndpoint(config);
  }

  /** The verify endpoint a bank rail is polled at, answering off your own statement */
  bankVerify(config: BankVerifyConfig): Handler {
    return bankVerifyEndpoint(config);
  }

  /**
   * The URL to hand the gateway instead of the wallet's own, with the wallet's
   * sealed inside it. Point it at wherever `verify` is mounted
   */
  verifyUrl(endpoint: string, wallet: Relayed, secret: string): Promise<string> {
    return relayedVerifyUrl(endpoint, wallet, secret);
  }

  /**
   * The whole webhook route: it answers the gateway's challenge, checks the
   * signature against the key the gateway publishes, refuses a settlement that
   * proves nothing, and calls you for the one that does.
   *
   * `export const POST = gateway.serve.webhook({ onSettled: fulfil })` is the
   * entire integration
   */
  webhook(handlers: WebhookHandlers): Handler {
    const options: WebhookOptions = { toleranceSecs: handlers.toleranceSecs };

    return async (request: Request) => {
      const credential = await this.credential(handlers);

      const challenge = await answerWebhookChallenge(request, credential, options);
      if (challenge !== null) {
        return challenge;
      }

      const settlement = await readSettlement(request, credential, options);
      if (settlement !== null) {
        return await acted(settlement, handlers);
      }

      const payment = await readPayment(request, credential, options);
      if (payment !== null) {
        await handlers.onPayment?.(payment);

        return new Response("ok");
      }

      return new Response("bad signature", { status: 401 });
    };
  }

  /** Verify a delivery and read the settlement out of it, null when it is not believable */
  async readSettlement(request: Request, options?: WebhookOptions): Promise<Settlement | null> {
    return await readSettlement(request, await this.credential({}), options);
  }

  /** Verify a delivery and read the payment out of it, null when it is not believable */
  async readPayment(request: Request, options?: WebhookOptions): Promise<Payment | null> {
    return await readPayment(request, await this.credential({}), options);
  }

  /** Answer the challenge the gateway sends before it will post to a webhook of yours */
  async answerWebhookChallenge(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response | null> {
    return await answerWebhookChallenge(request, await this.credential({}), options);
  }

  /** Answer the challenge the gateway sends a verify URL before it will poll it */
  answerVerifyChallenge(request: Request): Promise<Response | null> {
    return answerVerifyChallenge(request);
  }

  private async credential(handlers: WebhookHandlers): Promise<WebhookCredential> {
    return handlers.credential ?? { publicKey: await this.gateway.webhookKey() };
  }
}

async function acted(settlement: Settlement, handlers: WebhookHandlers): Promise<Response> {
  if (carriesProof(settlement)) {
    await handlers.onSettled?.(settlement);

    return new Response("ok");
  }
  if (handlers.onUnproven === undefined) {
    return new Response("the recipient released no preimage", { status: 202 });
  }
  await handlers.onUnproven(settlement);

  return new Response("ok");
}
