import { checkSettled } from "../../core/lnurl.js";
import { seal, unseal } from "../../core/sealed.js";
import { answerVerifyChallengeRequest } from "./webhook.js";

const DEFAULT_POLL_EVERY_SECS = 5;
const WALLET = "w";

/** The wallet's own LUD-21 URL and the hash its preimage has to match */
export interface Relayed {
  url: string;
  hash: string;
}

export interface LightningVerifyConfig {
  /** The secret the sealed wallet URL was made with, and nothing else uses it */
  secret: string;

  /**
   * How often you want the gateway to ask, in seconds. It goes out as
   * `Cache-Control: max-age`, so the pace is yours rather than the operator's.
   * Five by default, which is what a Lightning checkout wants
   */
  pollEverySecs?: number;
}

/**
 * A verify endpoint of your own that asks the recipient's wallet for you, so the
 * gateway polls you and never the wallet.
 *
 * `relayedVerifyUrl` seals the wallet's own LUD-21 URL into the query with your
 * secret, so what the gateway stores and replicates is opaque: not the wallet's
 * host, not which provider the recipient uses, nothing but a blob it cannot read.
 * This handler unseals it, asks the wallet, and answers the same LUD-21 shape.
 *
 * It relays rather than decides. The preimage still comes from the recipient's
 * own server and still has to hash to the payment hash, so standing between the
 * two buys privacy and pacing without becoming something anyone has to trust.
 *
 * A wallet it cannot reach answers `502` rather than "not settled", because those
 * are different claims and only one of them is true. The gateway logs a failed
 * poll and asks again, which is what a broken relay should look like.
 */
export function lightningVerifyEndpoint(
  config: LightningVerifyConfig,
): (request: Request) => Promise<Response> {
  const paced = {
    "cache-control": `max-age=${config.pollEverySecs ?? DEFAULT_POLL_EVERY_SECS}`,
  };

  return async (request: Request) => {
    const consented = await answerVerifyChallengeRequest(request);
    if (consented !== null) return consented;

    const sealed = new URL(request.url).searchParams.get(WALLET);
    if (sealed === null) return Response.json({ settled: false }, { status: 400 });

    const opened = await unseal(config.secret, sealed);
    if (opened === null) return Response.json({ settled: false }, { status: 403 });

    const wallet = JSON.parse(opened) as Relayed;
    const asked = await checkSettled(wallet.url, wallet.hash).catch(() => null);
    if (asked === null) return Response.json({ settled: false }, { status: 502 });

    return Response.json(
      { settled: asked.preimage !== null, preimage: asked.preimage },
      { headers: paced },
    );
  };
}

/**
 * The URL to hand the gateway instead of the wallet's own, with the wallet's
 * sealed inside it. Point it at wherever `lightningVerifyEndpoint` is mounted
 */
export async function relayedVerifyUrl(
  endpoint: string,
  wallet: Relayed,
  secret: string,
): Promise<string> {
  const relayed = new URL(endpoint);
  relayed.searchParams.set(WALLET, await seal(secret, JSON.stringify(wallet)));

  return relayed.toString();
}
