import type { WebSocket } from "ws";

/** Every socket a caller is holding open right now, by the key it speaks as */
export type Agents = Map<string, Set<WebSocket>>;

/**
 * Hold one caller's socket for as long as it lives. A caller answers from as
 * many devices as it has open, so the sockets are a set and the last one to
 * leave takes the entry with it
 */
export function attend(socket: WebSocket, caller: string, agents: Agents): void {
	const held = agents.get(caller) ?? new Set<WebSocket>();
	held.add(socket);
	agents.set(caller, held);

	const leave = (): void => {
		held.delete(socket);
		if (held.size === 0) {
			agents.delete(caller);
		}
	};

	socket.on("close", leave);
	socket.on("error", leave);
}

/** Whether anybody is there to answer for this caller */
export function attending(caller: string | null, agents: Agents): boolean {
	return caller !== null && (agents.get(caller)?.size ?? 0) > 0;
}
