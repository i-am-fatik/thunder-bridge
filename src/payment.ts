export type Status = "pending" | "paid" | "expired";

export type Webhook = { url: string };

export type Delivery = {
	origin: string;
	seq: number;
	id: string;
	url: string;
	body: string;
};

export type Payment = {
	id: string;
	lnAddress: string | null;
	amountMsat: number | null;
	status: Status;
	paymentHash: string;
	bolt11: string | null;
	preimage: string | null;
	expiresAt: number;
	createdAt: number;
	verifyUrl: string;
	trigger: string | null;
	sealed: string | null;
	caller: string | null;
	webhooks: Webhook[];
};

export type UnsavedPayment = Omit<Payment, "id">;

export type PublicPayment = Omit<Payment, "webhooks">;

export function withoutSecrets(payment: Payment): PublicPayment {
	const { webhooks, ...visible } = payment;
	return visible;
}
