import { callerKey, paymentNamedBy, signedAs } from "../../core/caller.js";
import type { SigningKey } from "../../core/ed25519.js";
import { sha256Hex } from "../../core/sha256.js";
import { priced } from "./charge.js";
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
import { Rails } from "./rail.js";
import { type PaymentRequest, type PaymentRequestInit, paymentRequestOf } from "./request.js";
import { Serve } from "./serving.js";
import type {
  Charge,
  Handover,
  MintedPayment,
  Payment,
  PaymentStatus,
  Quote,
  SocketTicket,
  WalletFailure,
} from "./types.js";
import { carriesProof, proveOrigin } from "./verify.js";
import {
  createRequestBody,
  mintedFromWire,
  paymentFromWire,
  quoteFromWire,
  quoteRequestBody,
  socketTicketFromWire,
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

/** How this instance talks to one gateway, and how much of what it says to check */
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

  /**
   * The same long lived server side secret your rail derives its preimages from.
   * Given here, every call carries a signature the gateway reads as your identity,
   * so a payment you create is handed back to you and to nobody else. Withheld,
   * you are anonymous and any holder of an id can read what it names
   */
  secret?: string;
}

/** How long to wait on a payment, and what the socket URL is allowed to carry */
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

/** What a socket ticket opens beyond the trigger it names */
export interface TicketOptions {
  /**
   * How many of this trigger's settlements the socket replays on connect, up to
   * the ceiling the gateway's operator set
   */
  replay?: number;
}

/** What a mint carries beyond the charge: a retry key, and which trigger it joins */
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
   * `follow` can watch the place rather than the payment. Registering
   * sends only its sha256, which is also all the gateway stores, so a stolen
   * ledger cannot subscribe. Following sends the secret itself, because the
   * gateway hashes what it is given to find the stream, so the operator of a
   * gateway you do not own learns it the first time you connect. Keep it apart
   * from any URL a payer sees
   */
  trigger?: string;

  /**
   * How many of the trigger's settlements the gateway keeps replayable past the
   * hour it would otherwise forget them in, up to the ceiling its operator set.
   * Needs `trigger`, defaults to none
   */
  replay?: number;
}

/** What to do with a trigger's settlements, and how hard to try to keep hearing them */
export interface FollowOptions {
  /** Called for the recent settlements replayed on connect, then for each new one */
  onPayment: (settled: Payment) => void;

  /**
   * How many settlements to ask for on connect, defaults to the gateway's ten.
   * It hands back what it still holds, which is the last hour unless the
   * payments were minted with `replay`
   */
  replay?: number;

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

/** How this caller holds a socket open and what it answers on it */
export interface AttendOptions {
  /**
   * What this caller answers when the gateway asks about one of its payments.
   * The preimage when the money is there, null while it is not, and the gateway
   * checks the preimage against the hash either way
   */
  answer: (paymentHash: string) => Promise<string | null> | string | null;

  /** Called when a connection drops or a frame is refused, the socket keeps going */
  onError?: (error: unknown) => void;

  /** Reconnect after a drop, defaults to true */
  reconnect?: boolean;

  /** The first wait after a drop, doubling and jittered, defaults to 3000 */
  reconnectDelayMs?: number;
}

function askFromWire(raw: string): { ask: string; paymentHash: string } | null {
  let said: unknown;
  try {
    said = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof said !== "object" || said === null) {
    return null;
  }

  const fields = said as Record<string, unknown>;
  const ask = fields["ask"];
  const paymentHash = fields["payment_hash"];

  return typeof ask === "string" && typeof paymentHash === "string" ? { ask, paymentHash } : null;
}

function gatewayAt(baseUrl: string): string {
  const at = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  if (at === null || (at.protocol !== "http:" && at.protocol !== "https:")) {
    throw new Error(`${baseUrl} is not an http or https gateway url`);
  }

  return baseUrl.replace(/\/+$/, "");
}

/** Talks to a Thunder Bridge gateway and trusts it for nothing it can check itself */
export class ThunderBridge {
  private readonly baseUrl: string;
  private readonly verify: boolean;
  private readonly token: string | null;
  private readonly secret: string | null;
  private strangers: Promise<boolean> | null = null;
  private speaks: Promise<SigningKey> | null = null;
  private published: Promise<string> | null = null;

  /** Everything this gateway lets you mount, from an LNURL endpoint to a webhook route */
  readonly serve: Serve;

  /** One call per sale, whatever the rail moves */
  readonly rails: Rails;

  constructor(baseUrl: string, options?: ThunderBridgeOptions) {
    this.baseUrl = gatewayAt(baseUrl);
    this.verify = options?.verify ?? true;
    this.token = options?.token ?? null;
    this.secret = options?.secret ?? null;
    this.serve = new Serve(this);
    this.rails = new Rails(this);
  }

  /**
   * Whether a token was given to this instance, which is your side of the
   * arrangement and says nothing about the gateway's. `refusesStrangers` is the
   * one that asks the gateway, and it is the one to guard anything with
   */
  get hasToken(): boolean {
    return this.token !== null;
  }

  /**
   * Whether the gateway turns away a caller carrying no token, asked by making
   * one unauthenticated read it would have to refuse. `hasToken` answers only
   * whether you configured one, so a made-up token against a public instance
   * reads as yours and is not. Asked once and remembered, because an instance
   * does not change its mind. Anything other than a refusal counts as open, so
   * an unreachable gateway fails closed
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
   * Ask to be paid for one thing. It mints the invoice, proves it came from the
   * address you asked for, draws the QR and hands back one object with a way to
   * wait for the money. This is `mint` plus the two things every caller does next
   */
  async requestPayment(asked: PaymentRequestInit): Promise<PaymentRequest> {
    return paymentRequestOf(this, await this.mint(asked, asked), asked);
  }

  /**
   * Ask the gateway for an invoice payable to the first address on your list
   * that can issue a provable one, throws `NoWalletAvailableError` when none can
   * and `GatewayCheatError` when what comes back is not what you asked for
   */
  async mint(charge: Charge, options?: CreateOptions): Promise<MintedPayment> {
    const asked = await priced(charge);
    const sent = createRequestBody(
      asked,
      charge.webhookUrl,
      options?.trigger ? sha256Hex(unguessable(options.trigger)) : null,
      options?.replay,
    );
    const headers = await this.sending("/incoming-payments", sent);
    if (options?.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const response = await fetch(`${this.baseUrl}/incoming-payments`, {
      method: "POST",
      headers,
      body: sent,
    });
    if (!response.ok) {
      throw await problemFrom(response);
    }

    const payment = await mintedFrom(response);
    if (this.verify) {
      await proveOrigin(payment, asked);
    }

    return payment;
  }

  /**
   * Ask which address would serve an amount without minting anything, throws
   * `NoWalletAvailableError` when none would. A quote is a probe and not a
   * promise: the address it names can still be refused at create time, because
   * whether a wallet returns a provable invoice cannot be known without asking
   * it for one, and asking mints it
   */
  async quote(charge: Charge): Promise<Quote> {
    const sent = quoteRequestBody(await priced(charge));
    const response = await fetch(`${this.baseUrl}/quotes`, {
      method: "POST",
      headers: await this.sending("/quotes", sent),
      body: sent,
    });
    if (!response.ok) {
      throw await problemFrom(response);
    }

    const quote = quoteFromWire(await response.json().catch(() => null));
    if (quote === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a quote",
      });
    }
    return quote;
  }

  /**
   * The key this gateway signs webhooks with when you registered none of your own.
   * `serve.webhook` reads it for you. Asked once and kept, because it is the same
   * for every instance in the cluster
   */
  async webhookKey(): Promise<string> {
    this.published ??= this.publishedKey().catch((refused: unknown) => {
      this.published = null;
      throw refused;
    });

    return await this.published;
  }

  private async publishedKey(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/webhook-key`);
    if (!response.ok) {
      throw await problemFrom(response);
    }

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

  /**
   * Read a payment back, null when the gateway has never heard of it. One method
   * for both sorts: `kind` says whether the gateway minted it or was handed it,
   * and the address, amount and invoice are null on one it was never told
   */
  async payment(id: string): Promise<Payment | null> {
    const path = `/incoming-payments/${encodeURIComponent(id)}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: await this.reading("GET", path),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await problemFrom(response);
    }

    return this.proven(await paymentFrom(response));
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
  async payments(limit?: number): Promise<{ payments: Payment[]; scanned: number }> {
    const path = `/incoming-payments${limit === undefined ? "" : `?limit=${limit}`}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: await this.reading("GET", path),
    });
    if (!response.ok) {
      throw await problemFrom(response);
    }

    const body = (await response.json().catch(() => null)) as {
      payments?: unknown;
      settled_scanned?: unknown;
    } | null;
    const listed = Array.isArray(body?.payments)
      ? body.payments.map(paymentFromWire).filter((one): one is Payment => one !== null)
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
  async settled(id: string, options?: WaitOptions): Promise<Payment> {
    const ended = paymentFromWire(await this.followed(id, options));
    if (ended === null) {
      throw new ProblemError({
        status: 200,
        title: "The gateway answered with something that is not a payment",
      });
    }

    return this.proven(ended);
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
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        clearTimeout(retry);
        finish();
        socket?.close();
      };

      const again = () => {
        if (settled) {
          return;
        }
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
        if (settled) {
          return;
        }
        attempt += 1;

        let url = direct;
        if (this.needsTicket(options?.tickets)) {
          try {
            url = `${base}/ws/tickets/${await this.wsTicket({ payment_id: id })}`;
          } catch (refused: unknown) {
            if (refused instanceof ProblemError) {
              settle(() => reject(refused));
            } else {
              again();
            }
            return;
          }
        }
        if (settled) {
          return;
        }

        const opened = new WebSocket(url);
        socket = opened;
        opened.onmessage = (event: MessageEvent) => {
          try {
            const frame: unknown = JSON.parse(String(event.data));
            const watched = paymentFromWire(frame);
            if (watched === null) {
              return;
            }

            expiresAt = watched.expiresAt;
            attempt = 1;
            if (!TERMINAL.has(watched.status)) {
              return;
            }
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
   * not a race: `settled` ends on `paid` and on `expired` alike, and a
   * Lightning invoice expires in an hour while a bank transfer takes days. `null`
   * means every leg ended without being paid.
   *
   * Stopping the wait is not revoking the invoice. Nobody can revoke one, because
   * the recipient's own wallet minted it, so a payer who pays the loser afterwards
   * really does pay twice and that shows up on `follow` as a second settlement to
   * refund.
   */
  async firstSettled(ids: string[], options?: WaitOptions): Promise<Payment | null> {
    if (ids.length === 0) {
      return null;
    }

    const stopLosers = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([stopLosers.signal, options.signal])
      : stopLosers.signal;
    let refused: unknown = null;

    try {
      const winner = await new Promise<Payment | null>((resolve) => {
        let waiting = ids.length;
        const lost = () => {
          waiting -= 1;
          if (waiting === 0) {
            resolve(null);
          }
        };
        for (const id of ids) {
          this.settled(id, { ...options, signal })
            .then((watched) => (watched.status === "paid" ? resolve(watched) : lost()))
            .catch((failure: unknown) => {
              refused ??= failure;
              lost();
            });
        }
      });
      if (winner === null && refused !== null) {
        throw refused;
      }

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
  async watch(handover: Handover): Promise<Payment> {
    const sent = watchRequestBody(
      handover,
      handover.trigger ? sha256Hex(unguessable(handover.trigger)) : null,
    );
    const response = await fetch(`${this.baseUrl}/watched-payments`, {
      method: "POST",
      headers: await this.sending("/watched-payments", sent),
      body: sent,
    });
    if (!response.ok) {
      throw await problemFrom(response);
    }

    const watched = paymentFromWire(await response.json().catch(() => null));
    if (watched === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a watched payment",
      });
    }
    const named = await this.nameFor(handover.paymentHash);
    if (named !== null && watched.id !== named) {
      throw new GatewayCheatError("id_not_mine", watched.id);
    }
    return watched;
  }

  /**
   * What this payment is called, which you can work out before any gateway has
   * heard of it. Every gateway you hand the same invoice to answers with the same
   * name, so watching at several of them adds up to one payment rather than
   * several, and no gateway's key is in the answer. Null when no secret was given,
   * because then the gateway names the payment and only it can
   */
  async nameFor(paymentHash: string): Promise<string | null> {
    return this.secret === null
      ? null
      : paymentNamedBy((await this.speaking()).publicKeyHex, paymentHash);
  }

  /**
   * Hold a socket open and answer what the gateway asks about this caller's own
   * payments, so a watch addressed to this caller settles without anybody
   * hosting a URL. Reconnects on its own until the returned function is called
   */
  attend(options: AttendOptions): () => void {
    const base = this.baseUrl.replace(/^http/, "ws");
    const firstDelay = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;

    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    const again = () => {
      if (stopped || options.reconnect === false) {
        return;
      }
      retry = setTimeout(() => void connect(), backoffMs(firstDelay, attempt));
    };

    const answered = async (opened: WebSocket, raw: string): Promise<void> => {
      const asked = askFromWire(raw);
      if (asked === null) {
        return;
      }

      const preimage = await options.answer(asked.paymentHash);
      opened.send(
        JSON.stringify(
          preimage === null
            ? { ask: asked.ask, settled: false }
            : { ask: asked.ask, settled: true, preimage },
        ),
      );
    };

    const connect = async () => {
      attempt += 1;
      let url: string;
      try {
        url = `${base}/ws/tickets/${await this.wsTicket({ agent: true })}`;
      } catch (refused: unknown) {
        options.onError?.(refused);
        again();
        return;
      }
      if (stopped) {
        return;
      }

      const opened = new WebSocket(url);
      socket = opened;
      opened.onopen = () => {
        attempt = 1;
      };
      opened.onmessage = (event: MessageEvent) => {
        void answered(opened, String(event.data)).catch((refused: unknown) =>
          options.onError?.(refused),
        );
      };
      opened.onerror = () => options.onError?.(new Error(`could not attend ${base}`));
      opened.onclose = again;
    };
    void connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }

  /**
   * Follow every payment made to one trigger, replayed from the recent ones on
   * connect and then live, reconnecting on its own until the returned function
   * is called. A trigger has no terminal state, so this never resolves
   */
  follow(secret: string, options: FollowOptions): () => void {
    const base = this.baseUrl.replace(/^http/, "ws");
    const asked = options.replay === undefined ? "" : `?replay=${options.replay}`;
    const direct = `${base}/ws/triggers/${encodeURIComponent(unguessable(secret))}${asked}`;
    const firstDelay = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;

    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    const again = () => {
      if (stopped || options.reconnect === false) {
        return;
      }
      retry = setTimeout(() => void connect(), backoffMs(firstDelay, attempt));
    };

    const connect = async () => {
      attempt += 1;
      let url = direct;
      if (this.needsTicket(options.tickets)) {
        try {
          url = `${base}/ws/tickets/${await this.wsTicket({
            trigger_secret: secret,
            replay: options.replay,
          })}`;
        } catch (refused: unknown) {
          options.onError?.(refused);
          again();
          return;
        }
      }
      if (stopped) {
        return;
      }

      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 1;
      };
      socket.onmessage = (event: MessageEvent) => {
        try {
          const settled = paymentFromWire(JSON.parse(String(event.data)));
          if (settled !== null) {
            options.onPayment(this.proven(settled));
          }
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

  /**
   * A one minute pass onto one trigger's stream, for something that must hold
   * neither the token nor the trigger secret. Mint it in a handler and answer
   * with the ticket alone, because that is all a browser needs to connect and
   * all it can do anything with. `serve.watchTicket` is this method already
   * wrapped in a route
   */
  async ticket(trigger: string, options?: TicketOptions): Promise<SocketTicket> {
    return await this.mintedTicket({
      trigger_secret: unguessable(trigger),
      replay: options?.replay,
    });
  }

  private needsTicket(asked?: boolean): boolean {
    return asked === true || this.token !== null;
  }

  private async wsTicket(
    body: Record<string, string | number | boolean | undefined>,
  ): Promise<string> {
    return encodeURIComponent((await this.mintedTicket(body)).ticket);
  }

  private async mintedTicket(
    body: Record<string, string | number | boolean | undefined>,
  ): Promise<SocketTicket> {
    const sent = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}/ws-tickets`, {
      method: "POST",
      headers: await this.sending("/ws-tickets", sent),
      body: sent,
    });
    if (!response.ok) {
      throw await problemFrom(response);
    }

    const ticket = socketTicketFromWire(await response.json().catch(() => null));
    if (ticket === null) {
      throw new ProblemError({
        status: response.status,
        title: "The gateway answered with something that is not a ticket",
      });
    }
    return ticket;
  }

  private async sending(path: string, body: string): Promise<Record<string, string>> {
    return { "content-type": "application/json", ...(await this.reading("POST", path, body)) };
  }

  private async reading(method: string, path: string, body = ""): Promise<Record<string, string>> {
    return {
      ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
      ...(this.secret === null ? {} : await signedAs(await this.speaking(), method, path, body)),
    };
  }

  private async speaking(): Promise<SigningKey> {
    this.speaks ??= callerKey(this.secret ?? "");

    return await this.speaks;
  }

  private proven<T extends Payment>(payment: T): T {
    if (this.verify && payment.status === "paid" && !carriesProof(payment)) {
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

async function mintedFrom(response: Response): Promise<MintedPayment> {
  const payment = mintedFromWire(await response.json().catch(() => null));
  if (payment === null) {
    throw new ProblemError({
      status: response.status,
      title: "The gateway answered with something that is not a minted payment",
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
  if (!Array.isArray(wallets)) {
    return [];
  }
  return wallets.filter((wallet: unknown): wallet is WalletFailure => {
    return typeof wallet === "object" && wallet !== null && "address" in wallet;
  });
}
