import type { Send } from "../../core/outbound.js";

export const throughFetch: Send = (url, sent, signal) =>
  fetch(url, {
    method: sent.method ?? "GET",
    headers: sent.headers ?? {},
    body: sent.body,
    redirect: "manual",
    signal,
  });
