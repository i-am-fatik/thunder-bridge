import {
  GatewayCheatError,
  IDEMPOTENCY_KEY_REUSED,
  IdempotencyConflictError,
  isProblemType,
  NO_WALLET_AVAILABLE,
  NoWalletAvailableError,
  ProblemError,
  REQUEST_IN_FLIGHT,
} from "./errors.js";
import type {
  CreatePaymentParams,
  CreateQuoteParams,
  Payment,
  PaymentStatus,
  Quote,
  TriggerEvent,
  WalletFailure,
  WatchPaymentParams,
} from "./types.js";
import { preimageMatchesHash } from "../../core/bolt11.js";
import { sha256Hex } from "../../core/sha256.js";
import { isProvablyPaid, proveOrigin } from "./verify.js";
import {
  createRequestBody,
  paymentFromWire,
  quoteFromWire,
  quoteRequestBody,
  triggerEventFromWire,
  watchRequestBody,
} from "./wire.js";

const TERMINAL: ReadonlySet<PaymentStatus> = new Set(["paid", "expired"]);
const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_CAP_MS = 30_000;
const UNANSWERED_ATTEMPTS = 5;
const TRIGGER_MIN_CHARS = 16;
const STRANGER_PROBE = "is-this-gateway-yours";

function unguessable(trigger: string): string {
  if (trigger.length < TRIGGER_MIN_CHARS) {
    throw new Error(
      `a trigger secret is the only thing guarding its stream, and nothing rate limits a guess at it, so it has to be at least ${TRIGGER_MIN_CHARS} characters nobody can predict`,
    );
  }

  return trigger;
}

function backoffMs(firstDelay: number, attempt: number): number {
  const grown = Math.min(firstDelay * 2 ** (attempt - 1), RECONNECT_CAP_MS);

  return Math.round(grown * (0.5 + Math.random() / 2));
}

export interface ThunderBridgeOptions {
  /**
   * Prove every payment against the recipient's own server before handing it
   * back, and refuse a reported settlement whose preimage does not hash to the
   * payment hash, defaults to true
   */
  verify?: boolean;

  /**
   * Sent as `Authorization: Bearer`, which a gateway started with
   * `GATEWAY_TOKEN` requires on every call, the socket handshake included. No
   * browser WebSocket can carry a header, so setting this also puts every socket
   * through a ticket
   */
  token?: string;
}

export interface WaitOptions {
  /** Give up when this aborts, `AbortSignal.timeout(ms)` covers the usual case */
  signal?: AbortSignal;

  /**
   * Mint a short-lived ticket and put that in the socket URL instead of the
   * payment id. Implied by `token`. The id stays readable inside the ticket,
   * what changes is that a URL out of a log stops opening anything after a
   * minute
   */
  tickets?: boolean;
}

export interface CreateOptions {
  /**
   * Makes the POST safe to retry. A repeat of a finished request replays its
   * payment instead of asking a wallet for a second invoice, a repeat that
   * arrives while the first is still resolving throws
   * `IdempotencyConflictError`, and the key is held for 24 hours
   */
  idempotencyKey?: string;

  /**
   * Groups this payment with every other one carrying the same secret, so
   * `followTrigger` can watch the place rather than the payment. Registering
   * sends only its sha256, which is also all the gateway stores, so a stolen
   * ledger cannot subscribe. Following sends the secret itself, because the
   * gateway hashes what it is given to find the stream, so the operator of a
   * gateway you do not own learns it the first time you connect. Keep it apart
   * from any URL a payer sees
   */
  trigger?: string;
}

export interface FollowOptions {
  /** Called for the recent settlements replayed on connect, then for each new one */
  onPayment: (settled: TriggerEvent) => void;

  /** Called when a connection drops or a frame is refused, the follow keeps going */
  onError?: (error: unknown) => void;

  /** Reconnect after a drop, defaults to true */
  reconnect?: boolean;

  /**
   * The first wait after a drop, doubling up to 30 seconds and jittered so a
   * fleet does not come back in lockstep, defaults to 3000. A connection that
   * opens puts it back to the first wait
   */
  reconnectDelayMs?: number;

  /**
   * Mint a short-lived ticket and put that in the socket URL instead of the
   * secret, one per connection. Keeps the secret out of access logs, at the cost
   * of a POST before each connect. Implied by `token`. Leave it off for a
   * microcontroller, where one hardcoded URL and a dumb reconnect loop is the
   * whole point
   */
  tickets?: boolean;
}

/** Talks to a Thunder Bridge gateway and trusts it for nothing it can check itself */
export class ThunderBridge {
  private readonly baseUrl: string;
  private readonly verify: boolean;
  private readonly token: string | null;
  private strangers: Promise<boolean> | null = null;

  constructor(baseUrl: string, options?: ThunderBridgeOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.verify = options?.verify ?? true;
    this.token = options?.token ?? null;
  }

  /**
   * Whether a token was given, which is what makes an instance yours: a gateway
   * started with `GATEWAY_TOKEN` answers nobody else, so anything you hand it
   * stays between you and it
   */
  get isPrivate(): boolean {
    return this.token !== null;
  }

  /**
   * Whether the gateway turns away a caller carrying no token, asked by making
   * one unauthenticated read it would have to refuse. `isPrivate` answers only
   * whether you configured a token, which is your side of the arrangement and
   * says nothing about the gateway's, so a made-up token against a public
   * instance reads as private and is not. Asked once and remembered, because an
   * instance does not change its mind. Anything other than a refusal counts as
   * open, so an unreachable gateway fails closed
   */
  async refusesStrangers(): Promise<boolean> {
    this.strangers ??= fetch(`${this.baseUrl}/incoming-payments/${STRANGER_PROBE}`, {
      headers: { accept: "application/json" },
    })
      .then((answer) => answer.status === 401)
      .catch(() => false);

    return await this.strangers;
  }

  /**
   * Ask the gateway for an invoice payable to the first address on your list
   * that can issue a provable one, throws `NoWalletAvailableError` when none can
   * and `GatewayCheatError` when what comes back is not what you asked for
   */
  async createPayment(params: CreatePaymentParams, options?: CreateOptions): Promise<Payment> {
    const headers = this.sending();
    if (options?.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const response = await fetch(`${this.baseUrl}/incoming-payments`, {
      method: "POST",
      headers,
      body: createRequestBody(
        params,
        options?.trigger ? sha256Hex(unguessable(options.trigger)) : null,
      ),
    });
    if (!response.ok) throw await problemFrom(response);

    const payment = await paymentFrom(response);
    if (this.verify) await proveOrigin(payment, params);
    return payment;
  }

  /**
   * Ask which address would serve an amount without minting anything, throws
   * `NoWalletAvailableError` when none would. A quote is a probe and not a
   * promise: the address it names can still be refused at create time, because
   * whether a wallet returns a provable invoice cannot be known without asking
   * it for one, and asking mints it
   */
  async createQuote(params: CreateQuoteParams): Promise<Quote> {
    const response = await fetch(`${this.baseUrl}/quotes`, {
      method: "POST",
      headers: this.sending(),
      body: quoteRequestBody(params),
    });
    if (!response.ok) throw await problemFrom(response);

    const quote = quoteFromWire(await response.json().catch(() => null));
    if (quote === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a quote",
      });
    }
    return quote;
  }

  /** Read a payment back, null when the gateway has never heard of it */
  /**
   * The key this gateway signs webhooks with when you registered none of your own,
   * ready to hand to `parseWebhookRequest` as `{ publicKey }`. Fetch it once and
   * keep it: it is the same for every instance in the cluster
   */
  async webhookKey(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/webhook-key`);
    if (!response.ok) throw await problemFrom(response);

    const body = (await response.json().catch(() => null)) as {
      algorithm?: unknown;
      public_key?: unknown;
    } | null;
    if (body?.algorithm !== "ed25519" || typeof body.public_key !== "string") {
      throw new ProblemError({
        status: response.status,
        title: "The gateway published no ed25519 webhook key",
      });
    }

    return body.public_key;
  }

  async getPayment(id: string): Promise<Payment | null> {
    const response = await fetch(`${this.baseUrl}/incoming-payments/${encodeURIComponent(id)}`, {
      headers: this.reading(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await problemFrom(response);
    return this.checked(await paymentFrom(response));
  }

  /**
   * Read back a payment the gateway is only watching, null when it has never
   * heard of it. A watched payment carries no address, amount or invoice, so
   * `getPayment` refuses it and this reads the shape both rails share
   */
  async getWatched(id: string): Promise<TriggerEvent | null> {
    const response = await fetch(`${this.baseUrl}/incoming-payments/${encodeURIComponent(id)}`, {
      headers: this.reading(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await problemFrom(response);

    const watched = triggerEventFromWire(await response.json().catch(() => null));
    if (watched === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a payment",
      });
    }

    return this.proven(watched);
  }

  /**
   * List what this gateway is watching, newest first. Only a gateway started
   * with `GATEWAY_TOKEN` serves this, because on a shared one it would hand
   * every caller everyone else's payments, so a public gateway answers 404.
   *
   * `scanned` says how many settled records were looked at to build the page.
   * Anything older than that window is not in the answer, and the list does not
   * pretend otherwise
   */
  async listPayments(limit?: number): Promise<{ payments: TriggerEvent[]; scanned: number }> {
    const query = limit === undefined ? "" : `?limit=${limit}`;
    const response = await fetch(`${this.baseUrl}/incoming-payments${query}`, {
      headers: this.reading(),
    });
    if (!response.ok) throw await problemFrom(response);

    const body = (await response.json().catch(() => null)) as {
      payments?: unknown;
      settled_scanned?: unknown;
    } | null;
    const listed = Array.isArray(body?.payments)
      ? body.payments.map(triggerEventFromWire).filter((one): one is TriggerEvent => one !== null)
      : null;
    if (listed === null || typeof body?.settled_scanned !== "number") {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a payment list",
      });
    }

    return { payments: listed, scanned: body.settled_scanned };
  }

  /**
   * Follow a payment over WebSocket until it is paid or expired, reconnecting
   * through a drop. A payment that never answers gives up after a few tries, and
   * one that has answered is followed until its own expiry, so the wait always
   * ends by itself
   */
  async waitForPayment(id: string, options?: WaitOptions): Promise<Payment> {
    const payment = paymentFromWire(await this.followed(id, options));
    if (payment === null) {
      throw new ProblemError({
        status: 200,
        title: `payment ${id} is watched rather than minted here, read it with waitForWatched`,
      });
    }

    return this.checked(payment);
  }

  /**
   * Follow a payment the gateway is only watching, one it did not mint, until it
   * is paid or expired.
   *
   * A watched payment carries no address, no amount and no invoice, because the
   * gateway was told none of them, so it reads back as the shape a trigger
   * streams rather than as a `Payment`. That is every bank transfer, and every
   * Lightning invoice registered with `watchPayment` instead of `createPayment`.
   */
  async waitForWatched(id: string, options?: WaitOptions): Promise<TriggerEvent> {
    const watched = triggerEventFromWire(await this.followed(id, options));
    if (watched === null) {
      throw new ProblemError({
        status: 200,
        title: "The gateway answered with something that is not a payment",
      });
    }

    return this.proven(watched);
  }

  private followed(id: string, options?: WaitOptions): Promise<unknown> {
    const base = this.baseUrl.replace(/^http/, "ws");
    const direct = `${base}/ws/incoming-payments/${encodeURIComponent(id)}`;

    return new Promise<unknown>((resolve, reject) => {
      const aborted = () => new Error(`waiting for payment ${id} was aborted`);
      if (options?.signal?.aborted) {
        reject(aborted());
        return;
      }

      let socket: WebSocket | null = null;
      let settled = false;
      let attempt = 0;
      let expiresAt: number | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;

      const abort = () => settle(() => reject(aborted()));
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        clearTimeout(retry);
        finish();
        socket?.close();
      };

      const again = () => {
        if (settled) return;
        if (expiresAt === null && attempt >= UNANSWERED_ATTEMPTS) {
          settle(() => reject(new Error(`no gateway answered for payment ${id}`)));
          return;
        }
        if (expiresAt !== null && Date.now() >= expiresAt * 1000) {
          settle(() => reject(new Error(`payment ${id} went unreported past its expiry`)));
          return;
        }
        retry = setTimeout(() => void connect(), backoffMs(RECONNECT_DELAY_MS, attempt));
      };

      const connect = async () => {
        if (settled) return;
        attempt += 1;

        let url = direct;
        if (this.needsTicket(options?.tickets)) {
          try {
            url = `${base}/ws/tickets/${await this.wsTicket({ payment_id: id })}`;
          } catch (refused: unknown) {
            if (refused instanceof ProblemError) settle(() => reject(refused));
            else again();
            return;
          }
        }
        if (settled) return;

        const opened = new WebSocket(url);
        socket = opened;
        opened.onmessage = (event: MessageEvent) => {
          try {
            const frame: unknown = JSON.parse(String(event.data));
            const watched = triggerEventFromWire(frame);
            if (watched === null) return;

            expiresAt = watched.expiresAt;
            attempt = 1;
            if (!TERMINAL.has(watched.status)) return;
            settle(() => resolve(frame));
          } catch (refused: unknown) {
            settle(() => reject(refused));
          }
        };
        opened.onclose = again;
      };

      options?.signal?.addEventListener("abort", abort, { once: true });
      void connect();
    });
  }

  /**
   * Wait on several payments and keep the first one that is really paid, then stop
   * waiting on the losers, which closes their sockets.
   *
   * This is how one order offers two rails. A Lightning invoice and a bank
   * transfer for the same thing are two payments here, and the payer picks one, so
   * what you want is the one that arrives and nothing further from the other.
   *
   * A leg that expires is a loser, not a winner, which is the whole reason this is
   * not a race: `waitForPayment` ends on `paid` and on `expired` alike, and a
   * Lightning invoice expires in an hour while a bank transfer takes days. `null`
   * means every leg ended without being paid.
   *
   * Stopping the wait is not revoking the invoice. Nobody can revoke one, because
   * the recipient's own wallet minted it, so a payer who pays the loser afterwards
   * really does pay twice and that shows up on `followTrigger` as a second
   * settlement to refund.
   */
  async firstToSettle(ids: string[], options?: WaitOptions): Promise<TriggerEvent | null> {
    if (ids.length === 0) return null;

    const stopLosers = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([stopLosers.signal, options.signal])
      : stopLosers.signal;
    let refused: unknown = null;

    try {
      const winner = await new Promise<TriggerEvent | null>((resolve) => {
        let waiting = ids.length;
        const lost = () => {
          waiting -= 1;
          if (waiting === 0) resolve(null);
        };
        for (const id of ids) {
          this.waitForWatched(id, { ...options, signal })
            .then((watched) => (watched.status === "paid" ? resolve(watched) : lost()))
            .catch((failure: unknown) => {
              refused ??= failure;
              lost();
            });
        }
      });
      if (winner === null && refused !== null) throw refused;

      return winner;
    } finally {
      stopLosers.abort();
    }
  }

  /**
   * Hand over an invoice you obtained yourself so the gateway watches it without
   * being told the address or the amount. It can then only refuse everyone
   * rather than one recipient, which is what makes leaving it cheap. Anything
   * the watcher needs goes in `sealed`, which the gateway cannot read
   */
  async watchPayment(params: WatchPaymentParams): Promise<TriggerEvent> {
    const response = await fetch(`${this.baseUrl}/watched-payments`, {
      method: "POST",
      headers: this.sending(),
      body: watchRequestBody(
        params,
        params.trigger ? sha256Hex(unguessable(params.trigger)) : null,
      ),
    });
    if (!response.ok) throw await problemFrom(response);

    const watched = triggerEventFromWire(await response.json().catch(() => null));
    if (watched === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a watched payment",
      });
    }
    return watched;
  }

  /**
   * Follow every payment made to one trigger, replayed from the recent ones on
   * connect and then live, reconnecting on its own until the returned function
   * is called. A trigger has no terminal state, so this never resolves
   */
  followTrigger(secret: string, options: FollowOptions): () => void {
    const base = this.baseUrl.replace(/^http/, "ws");
    const direct = `${base}/ws/triggers/${encodeURIComponent(unguessable(secret))}`;
    const firstDelay = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;

    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    const again = () => {
      if (stopped || options.reconnect === false) return;
      retry = setTimeout(() => void connect(), backoffMs(firstDelay, attempt));
    };

    const connect = async () => {
      attempt += 1;
      let url = direct;
      if (this.needsTicket(options.tickets)) {
        try {
          url = `${base}/ws/tickets/${await this.wsTicket({ trigger_secret: secret })}`;
        } catch (refused: unknown) {
          options.onError?.(refused);
          again();
          return;
        }
      }
      if (stopped) return;

      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 1;
      };
      socket.onmessage = (event: MessageEvent) => {
        try {
          const settled = triggerEventFromWire(JSON.parse(String(event.data)));
          if (settled !== null) options.onPayment(this.proven(settled));
        } catch (refused: unknown) {
          options.onError?.(refused);
        }
      };
      socket.onerror = () => options.onError?.(new Error(`could not follow trigger at ${base}`));
      socket.onclose = again;
    };
    void connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }

  private needsTicket(asked?: boolean): boolean {
    return asked === true || this.token !== null;
  }

  private async wsTicket(body: Record<string, string>): Promise<string> {
    const response = await fetch(`${this.baseUrl}/ws-tickets`, {
      method: "POST",
      headers: this.sending(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await problemFrom(response);

    const minted = (await response.json().catch(() => null)) as { ticket?: unknown } | null;
    if (typeof minted?.ticket !== "string") {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a ticket",
      });
    }
    return encodeURIComponent(minted.ticket);
  }

  private sending(): Record<string, string> {
    return { "content-type": "application/json", ...this.reading() };
  }

  private reading(): Record<string, string> {
    return this.token === null ? {} : { authorization: `Bearer ${this.token}` };
  }

  private proven(settled: TriggerEvent): TriggerEvent {
    const unproven =
      settled.status === "paid" &&
      (settled.preimage === null || !preimageMatchesHash(settled.preimage, settled.paymentHash));
    if (this.verify && unproven) throw new GatewayCheatError("preimage_mismatch", settled.id);

    return settled;
  }

  private checked(payment: Payment): Payment {
    if (this.verify && payment.status === "paid" && !isProvablyPaid(payment)) {
      throw new GatewayCheatError("preimage_mismatch", payment.id);
    }
    return payment;
  }
}

async function paymentFrom(response: Response): Promise<Payment> {
  const payment = paymentFromWire(await response.json().catch(() => null));
  if (payment === null) {
    throw new ProblemError({
      status: response.status,
      title: "The gateway answered with something that is not a payment",
    });
  }
  return payment;
}

async function problemFrom(response: Response): Promise<Error> {
  const problem = (await response.json().catch(() => ({}))) as {
    type?: string;
    title?: string;
    detail?: string;
    wallets?: unknown;
  };
  const document = { ...problem, status: response.status };
  if (isProblemType(problem, NO_WALLET_AVAILABLE)) {
    return new NoWalletAvailableError(document, refusals(problem.wallets));
  }
  if (isProblemType(problem, REQUEST_IN_FLIGHT)) {
    return new IdempotencyConflictError(document, "request-in-flight");
  }
  if (isProblemType(problem, IDEMPOTENCY_KEY_REUSED)) {
    return new IdempotencyConflictError(document, "key-reused");
  }
  return new ProblemError(document);
}

function refusals(wallets: unknown): WalletFailure[] {
  if (!Array.isArray(wallets)) return [];
  return wallets.filter((wallet: unknown): wallet is WalletFailure => {
    return typeof wallet === "object" && wallet !== null && "address" in wallet;
  });
}
