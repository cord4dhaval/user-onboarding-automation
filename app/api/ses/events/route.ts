import { createVerify } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { applySesEvent } from "@/engine/sesEvents.js";

export const dynamic = "force-dynamic";

/**
 * Bounce, complaint and delivery reports from SES, delivered over SNS.
 *
 * This endpoint suppresses addresses, so it is authenticated properly rather than by a
 * shared secret in a query string. Anyone able to post here unchecked could suppress a
 * customer's entire list — every send to those addresses refused afterwards, permanently,
 * with no error anybody would think to look for. Every message is checked three ways: it
 * carries a signature over its own fields, that signature verifies against a certificate,
 * and the certificate is one Amazon served.
 *
 * SNS also has a handshake: the first thing a new subscription receives is a
 * SubscriptionConfirmation carrying a URL that has to be fetched before anything else is
 * ever delivered. Confirming it automatically is what lets the topic be pointed here from
 * the AWS console without a second deploy — but only after the signature check, or an
 * attacker could subscribe this endpoint to a topic of their own.
 */
export async function POST(request: NextRequest) {
  const body = await request.text();

  let message: SnsMessage;
  try {
    message = JSON.parse(body) as SnsMessage;
  } catch {
    return NextResponse.json({ error: "body was not JSON" }, { status: 400 });
  }

  const expectedTopic = process.env.SES_EVENT_TOPIC_ARN;
  if (expectedTopic && message.TopicArn !== expectedTopic) {
    return NextResponse.json({ error: "unexpected topic" }, { status: 403 });
  }

  if (!(await verifySignature(message))) {
    return NextResponse.json({ error: "signature did not verify" }, { status: 403 });
  }

  if (message.Type === "SubscriptionConfirmation") {
    if (!message.SubscribeURL || !isAmazonUrl(message.SubscribeURL)) {
      return NextResponse.json({ error: "bad SubscribeURL" }, { status: 400 });
    }
    // Fetching the URL is the confirmation; SNS delivers nothing until it is fetched.
    const res = await fetch(message.SubscribeURL, { signal: AbortSignal.timeout(15_000) });
    return NextResponse.json({ confirmed: res.ok, topic: message.TopicArn });
  }

  if (message.Type === "UnsubscribeConfirmation") {
    // Somebody detached the topic. Not an error here, but it means event reporting has
    // silently stopped, which is worth finding in a log rather than in a bounce rate.
    console.warn(`SES event topic unsubscribed: ${message.TopicArn}`);
    return NextResponse.json({ ok: true });
  }

  if (message.Type !== "Notification" || !message.Message) {
    return NextResponse.json({ error: "unsupported message type" }, { status: 400 });
  }

  const summary = await applySesEvent(message.Message);
  // 200 even when nothing was applied. SNS retries anything else, and an event for a
  // message this deployment did not send is not going to succeed on the fourth attempt.
  return NextResponse.json(summary);
}

interface SnsMessage {
  Type?: string;
  MessageId?: string;
  Token?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
}

/**
 * The fields SNS signs, in the order it signs them.
 *
 * Order and membership are both part of the signature — this is not a hash of the body — so
 * the canonical string has to be rebuilt exactly. Which fields belong depends on the message
 * type: a confirmation signs its Token and SubscribeURL, a notification signs neither.
 */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

async function verifySignature(message: SnsMessage): Promise<boolean> {
  const fields = SIGNED_FIELDS[String(message.Type)];
  if (!fields || !message.Signature || !message.SigningCertURL) return false;

  // The certificate URL comes from the message, so it is attacker-controlled until this
  // check. Without it, a forged message could name a certificate on a host of its own and
  // verify against its own key perfectly.
  if (!isAmazonUrl(message.SigningCertURL)) return false;

  const canonical = fields
    .filter((field) => message[field as keyof SnsMessage] !== undefined)
    .map((field) => `${field}\n${String(message[field as keyof SnsMessage])}\n`)
    .join("");

  try {
    const certificate = await fetchCertificate(message.SigningCertURL);
    // SignatureVersion 1 is SHA1, 2 is SHA256. Both are in use; the message says which.
    const algorithm = message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
    const verifier = createVerify(algorithm);
    verifier.update(canonical, "utf8");
    return verifier.verify(certificate, message.Signature, "base64");
  } catch {
    return false;
  }
}

/** Amazon rotates signing certificates, so they are fetched rather than pinned — but only
 * ever from Amazon, and only over https. */
function isAmazonUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && /(^|\.)amazonaws\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

// One certificate signs many messages, and a fetch per event would add a round trip to
// every bounce. Cached by URL, which is how Amazon versions them: a rotated certificate has
// a new URL and misses the cache on its own.
const certificates = new Map<string, string>();

async function fetchCertificate(url: string): Promise<string> {
  const cached = certificates.get(url);
  if (cached) return cached;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
  const pem = await res.text();
  certificates.set(url, pem);
  return pem;
}
