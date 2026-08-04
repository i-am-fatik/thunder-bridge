declare module "compact-encoding" {
	const encodings: { json: unknown; string: unknown };
	export default encodings;
}

declare module "protomux" {
	export type Message<T> = { send(value: T): void };

	export type Channel = {
		addMessage<T>(options: { encoding: unknown; onmessage: (value: T) => void }): Message<T>;
		open(handshake: unknown): void;
		close(): void;
	};

	export default class Protomux {
		static from(stream: unknown): Protomux;
		createChannel<H>(options: {
			protocol: string;
			handshake?: unknown;
			onopen?: (handshake: H) => void;
			onclose?: () => void;
		}): Channel | null;
		destroy(): void;
	}
}

declare module "@hyperswarm/secret-stream" {
	import type { Duplex } from "node:stream";

	export default class SecretStream extends Duplex {
		constructor(isInitiator: boolean, rawStream?: unknown);
		readonly publicKey: Buffer;
		readonly remotePublicKey: Buffer | null;
	}
}

declare module "hyperswarm" {
	export default class Hyperswarm {
		join(topic: Uint8Array, options?: { server?: boolean; client?: boolean }): unknown;
		on(event: "connection", listener: (connection: unknown) => void): void;
		flush(): Promise<void>;
		destroy(): Promise<void>;
	}
}
