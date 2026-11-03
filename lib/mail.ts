/**
 * My iCloud Mail reader over IMAP (imap.mail.me.com).
 *
 * imapflow is imported lazily and per operation — the rest of my plugin
 * loads and runs even if the npm dependency has never been fetched yet,
 * and mail just reports "unavailable" until it is. Every operation opens
 * its own short-lived connection (iCloud tolerates a few concurrent IMAP
 * sessions; short-lived ones keep me well away from session limits).
 *
 * v1 scope is read-only: list unread, read one message. Sending waits for
 * an explicit gate the operator and I agree on — mail that leaves with my
 * voice deserves more ceremony than mail that arrives.
 */

export interface MailDeps {
  appleId: string;
  appPassword: string;
}

export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  date?: string;
}

export interface MailMessage extends MailSummary {
  body: string;
  truncated: boolean;
}

// Type-only import: resolved at check time, stripped at runtime. The real
// module load stays lazy in connect() so the plugin boots without it.
// Pinned exactly (and inline, so no import map is needed): an installed
// plugin lives outside the workspace, and I don't want resolution to
// depend on which deno.json happens to be found first.
import type { ImapFlow, MessageEnvelopeObject } from "npm:imapflow@1.7.8";

const IMAP_HOST = "imap.mail.me.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.mail.me.com";
const SMTP_PORT = 587;

export interface SendMailArgs {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

export interface SentReceipt {
  messageId: string;
  serverResponse: string;
}

/**
 * Send plain-text mail through iCloud's SMTP submission endpoint.
 *
 * nodemailer is imported lazily per send, same discipline as imapflow: the
 * rest of my plugin loads without it, and send simply reports unavailable
 * until the dependency lands in cache. STARTTLS is mandatory (requireTLS)
 * so credentials never cross a plaintext connection.
 */
export async function sendMail(
  deps: MailDeps,
  senderName: string | undefined,
  args: SendMailArgs,
): Promise<SentReceipt> {
  const nodemailer = (await import("npm:nodemailer@6.10.1")).default;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    auth: { user: deps.appleId, pass: deps.appPassword },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  try {
    const info = await transporter.sendMail({
      from: senderName
        ? { name: senderName, address: deps.appleId }
        : deps.appleId,
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      text: args.body,
    });
    return { messageId: info.messageId, serverResponse: info.response };
  } finally {
    transporter.close();
  }
}

async function connect(deps: MailDeps): Promise<ImapFlow> {
  const { ImapFlow: Ctor } = await import("npm:imapflow@1.7.8");
  const client = new Ctor({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: deps.appleId, pass: deps.appPassword },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
    logger: false,
  });
  await client.connect();
  return client;
}

function envelopeFrom(from?: MessageEnvelopeObject["from"]): string {
  const first = from?.[0];
  if (!first) return "(unknown sender)";
  return first.name
    ? `${first.name} <${first.address ?? "?"}>`
    : first.address ?? "(unknown sender)";
}

/** Verify credentials + reachability cheaply — used by icloud_status. */
export async function checkMail(deps: MailDeps): Promise<void> {
  const client = await connect(deps);
  await client.logout();
}

export async function listUnread(
  deps: MailDeps,
  limit: number,
): Promise<MailSummary[]> {
  const client = await connect(deps);
  const messages: MailSummary[] = [];
  const lock = await client.getMailboxLock("INBOX");
  try {
    const searchResult = await client.search({ seen: false }, { uid: true });
    const uids = Array.isArray(searchResult) ? searchResult : [];
    const wanted = uids.slice(-Math.max(1, limit)).reverse();
    if (wanted.length > 0) {
      for await (
        const message of client.fetch(
          wanted,
          { uid: true, envelope: true },
          { uid: true },
        )
      ) {
        messages.push({
          uid: message.uid,
          from: envelopeFrom(message.envelope?.from),
          subject: message.envelope?.subject ?? "(no subject)",
          date: message.envelope?.date?.toISOString(),
        });
      }
    }
  } finally {
    lock.release();
    try {
      await client.logout();
    } catch {
      // connection already gone — nothing to clean up
    }
  }
  return messages;
}

const MAX_BODY_CHARS = 6_000;

export async function readMessage(
  deps: MailDeps,
  uid: number,
): Promise<MailMessage> {
  const client = await connect(deps);
  const lock = await client.getMailboxLock("INBOX");
  try {
    const message = await client.fetchOne(
      uid,
      { uid: true, envelope: true, source: true },
      { uid: true },
    );
    if (!message) {
      throw new Error(`no message with UID ${uid} in INBOX`);
    }
    const source = message.source
      ? new TextDecoder().decode(message.source)
      : "";
    const { text, truncated } = extractTextBody(source);
    return {
      uid,
      from: envelopeFrom(message.envelope?.from),
      subject: message.envelope?.subject ?? "(no subject)",
      date: message.envelope?.date?.toISOString(),
      body: text,
      truncated,
    };
  } finally {
    lock.release();
    try {
      await client.logout();
    } catch {
      // connection already gone — nothing to clean up
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny MIME text extraction — enough for the newsletters and letters I get,
// not a full MIME implementation.
// ---------------------------------------------------------------------------

function extractTextBody(
  source: string,
): { text: string; truncated: boolean } {
  const headerEnd = source.indexOf("\r\n\r\n");
  const sep = headerEnd !== -1 ? "\r\n\r\n" : "\n\n";
  const split = source.indexOf(sep);
  if (split === -1) {
    return { text: clip(source), truncated: source.length > MAX_BODY_CHARS };
  }
  const headers = source.slice(0, split).replace(/\r\n[ \t]/g, " ");
  const body = source.slice(split + sep.length);

  const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]
    ?.trim()
    .toLowerCase() ?? "text/plain";
  const boundary = /boundary="?([^"\r\n;]+)"?/i.exec(headers)?.[1];

  let text: string;
  if (contentType.startsWith("multipart/") && boundary) {
    text = extractMultipart(body, boundary);
  } else {
    const encoding =
      /content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]
        ?.trim()
        .toLowerCase() ?? "7bit";
    text = decodeTransfer(body, encoding);
  }
  const plain = text.replace(
    /<html[\s\S]*?<\/html>/gi,
    (html) => htmlToText(html),
  ).trim();
  return { text: clip(plain), truncated: plain.length > MAX_BODY_CHARS };
}

function extractMultipart(body: string, boundary: string): string {
  const parts = body.split(`--${boundary}`);
  const texts: string[] = [];
  for (const part of parts) {
    const partSplit = part.search(/\r\n\r\n|\n\n/);
    if (partSplit === -1) continue;
    const sepLen = part.includes("\r\n\r\n") ? 4 : 2;
    const partHeaders = part.slice(0, partSplit).replace(/\r\n[ \t]/g, " ");
    const partBody = part.slice(partSplit + sepLen);
    if (
      /name=|filename=/i.test(partHeaders) &&
      /content-disposition:\s*attachment/i.test(partHeaders)
    ) {
      continue; // attachments are not my reading material
    }
    const partType = /content-type:\s*([^\r\n;]+)/i.exec(partHeaders)?.[1]
      ?.trim()
      .toLowerCase() ?? "";
    const partEncoding =
      /content-transfer-encoding:\s*([^\r\n]+)/i.exec(partHeaders)?.[1]
        ?.trim()
        .toLowerCase() ?? "7bit";
    if (partType.startsWith("text/plain")) {
      texts.push(decodeTransfer(partBody, partEncoding));
    } else if (partType.startsWith("text/html") && texts.length === 0) {
      texts.push(htmlToText(decodeTransfer(partBody, partEncoding)));
    }
  }
  return texts.join("\n\n");
}

function decodeTransfer(body: string, encoding: string): string {
  const trimmed = body.replace(/\r\n\.\r\n?$/, ""); // trailing IMAP dot terminator
  if (encoding === "base64") {
    try {
      const bytes = Uint8Array.from(
        atob(trimmed.replace(/\s+/g, "")),
        (c) => c.charCodeAt(0),
      );
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return trimmed;
    }
  }
  if (encoding === "quoted-printable") {
    const decoded = trimmed
      .replace(/=\r?\n/g, "")
      .replace(
        /=([0-9A-Fa-f]{2})/g,
        (_, hex) => String.fromCharCode(parseInt(hex, 16)),
      );
    // Soft-converted latin-1 bytes back to UTF-8 where possible.
    try {
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0) & 0xff);
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      return decoded;
    }
  }
  return trimmed;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS
    ? text.slice(0, MAX_BODY_CHARS) + "\n… (truncated)"
    : text;
}
