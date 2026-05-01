import PostalMime from "postal-mime";

export interface Env {
  EMAIL_BUCKET: R2Bucket;
  CONFIG_KV: KVNamespace;
  AUTH_PASSWORD: string;
  ASSETS?: Fetcher;
}

interface ArchivedEmail {
  key: string;
  size: number;
  uploaded: string;
  from: string;
  to: string;
  subject: string;
  date: string;
}

// ---------------------------------------------------------------------------
// KV helpers — read/write mailing list and archive settings.
// ---------------------------------------------------------------------------

export async function getMailingList(env: Env): Promise<string[]> {
  const kv = await env.CONFIG_KV.get("mailing_list");
  if (kv) return JSON.parse(kv);
  return [];
}

export async function getArchiveSenders(env: Env): Promise<string[]> {
  const kv = await env.CONFIG_KV.get("archive_senders");
  if (kv) return JSON.parse(kv);
  return [];
}

export async function setMailingList(env: Env, list: string[]): Promise<void> {
  await env.CONFIG_KV.put("mailing_list", JSON.stringify(list));
}

export async function setArchiveSenders(env: Env, list: string[]): Promise<void> {
  await env.CONFIG_KV.put("archive_senders", JSON.stringify(list));
}

export async function getArchiveAll(env: Env): Promise<boolean> {
  const val = await env.CONFIG_KV.get("archive_all");
  return val === "true";
}

export async function setArchiveAll(env: Env, enabled: boolean): Promise<void> {
  await env.CONFIG_KV.put("archive_all", String(enabled));
}

function archivedEmailFromObject(obj: R2Object): ArchivedEmail {
  return {
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    from: obj.customMetadata?.from ?? "",
    to: obj.customMetadata?.to ?? "",
    subject: obj.customMetadata?.subject ?? "",
    date: obj.customMetadata?.date ?? "",
  };
}

function archivedAt(email: ArchivedEmail): number {
  const uploaded = Date.parse(email.uploaded);
  if (!Number.isNaN(uploaded)) return uploaded;

  const headerDate = Date.parse(email.date);
  if (!Number.isNaN(headerDate)) return headerDate;

  const keyTimestamp = Number(email.key.match(/\/(\d+)-[^/]+\.eml$/)?.[1]);
  return Number.isNaN(keyTimestamp) ? 0 : keyTimestamp;
}

export async function listArchivedEmails(env: Env): Promise<ArchivedEmail[]> {
  const emails: ArchivedEmail[] = [];
  let cursor: string | undefined;

  do {
    const options: R2ListOptions & { include: ("httpMetadata" | "customMetadata")[] } = {
      limit: 1000,
      cursor,
      prefix: "",
      include: ["customMetadata"],
    };
    const listed = await env.EMAIL_BUCKET.list(options);

    emails.push(...listed.objects.map(archivedEmailFromObject));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return emails.sort((a, b) => archivedAt(b) - archivedAt(a));
}

// ---------------------------------------------------------------------------
// Auth helpers — HMAC-SHA256 session cookie
// ---------------------------------------------------------------------------

async function deriveToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("session"));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  return match ? match[1] : null;
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.AUTH_PASSWORD) return false;
  const token = getSessionToken(request);
  if (!token) return false;
  const expected = await deriveToken(env.AUTH_PASSWORD);
  return token === expected;
}

function sessionCookie(token: string, maxAge: number): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// API route handler
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // --- Auth routes (no auth required) ---
  if (path === "/api/auth/login" && method === "POST") {
    const body = (await request.json()) as { password?: string };
    if (!body.password || !env.AUTH_PASSWORD) {
      return jsonResponse({ error: "Invalid password" }, 401);
    }
    if (body.password !== env.AUTH_PASSWORD) {
      return jsonResponse({ error: "Invalid password" }, 401);
    }
    const token = await deriveToken(env.AUTH_PASSWORD);
    return jsonResponse(
      { ok: true },
      200,
      { "Set-Cookie": sessionCookie(token, 60 * 60 * 24 * 7) }
    );
  }

  if (path === "/api/auth/check" && method === "GET") {
    const authed = await isAuthenticated(request, env);
    return jsonResponse({ authenticated: authed });
  }

  // --- All routes below require auth ---
  if (!(await isAuthenticated(request, env))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return jsonResponse({ ok: true }, 200, {
      "Set-Cookie": sessionCookie("", 0),
    });
  }

  // --- Email routes ---
  if (path === "/api/emails" && method === "GET") {
    return jsonResponse({ emails: await listArchivedEmails(env) });
  }

  // Match /api/emails/<key>/raw or /api/emails/<key>/parsed
  const emailMatch = path.match(/^\/api\/emails\/(.+)\/(raw|parsed)$/);
  if (emailMatch && method === "GET") {
    const key = decodeURIComponent(emailMatch[1]);
    const mode = emailMatch[2];
    const obj = await env.EMAIL_BUCKET.get(key);
    if (!obj) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (mode === "raw") {
      return new Response(obj.body, {
        headers: {
          "Content-Type": "message/rfc822",
          "Content-Disposition": `attachment; filename="email.eml"`,
        },
      });
    }

    // parsed
    const arrayBuf = await obj.arrayBuffer();
    const parsed = await PostalMime.parse(arrayBuf);
    return jsonResponse({
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      attachments: (parsed.attachments ?? []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: typeof a.content === "string" ? a.content.length : a.content?.byteLength ?? 0,
      })),
    });
  }

  // --- Settings routes ---
  if (path === "/api/settings" && method === "GET") {
    const [mailingList, archiveSenders, archiveAll] = await Promise.all([
      getMailingList(env),
      getArchiveSenders(env),
      getArchiveAll(env),
    ]);
    return jsonResponse({ mailingList, archiveSenders, archiveAll });
  }

  if (path === "/api/settings" && method === "PUT") {
    const body = (await request.json()) as {
      mailingList?: string[];
      archiveSenders?: string[];
      archiveAll?: boolean;
    };
    const ops: Promise<void>[] = [];
    if (body.mailingList) ops.push(setMailingList(env, body.mailingList));
    if (body.archiveSenders) ops.push(setArchiveSenders(env, body.archiveSenders));
    if (body.archiveAll !== undefined) ops.push(setArchiveAll(env, body.archiveAll));
    await Promise.all(ops);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Non-API routes are served by Workers Static Assets binding.
    // Return a simple fallback for SPA routing — the assets binding
    // will intercept requests for actual files before this runs.
    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("Not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    console.log(`Incoming email from ${message.from} to ${message.to}`);

    // --- Archival ---
    try {
      const [archiveSenders, archiveAll] = await Promise.all([
        getArchiveSenders(env),
        getArchiveAll(env),
      ]);
      const senderLower = message.from.toLowerCase();
      const shouldArchive =
        archiveAll ||
        archiveSenders.some((s) => senderLower === s.toLowerCase());

      if (shouldArchive) {
        const now = new Date();
        const yyyy = now.getUTCFullYear();
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const hash = crypto.randomUUID().slice(0, 8);
        const key = `${yyyy}/${mm}/${dd}/${now.getTime()}-${hash}.eml`;

        const rawBytes = await new Response(message.raw).arrayBuffer();

        await env.EMAIL_BUCKET.put(key, rawBytes, {
          customMetadata: {
            from: message.from,
            to: message.to,
            subject: message.headers.get("subject") ?? "(no subject)",
            date: message.headers.get("date") ?? now.toISOString(),
            rawSize: String(message.rawSize),
          },
        });

        console.log(`Archived email to R2: ${key}`);
      }
    } catch (e) {
      // Archival failure is non-fatal — log and continue forwarding
      console.error(`Archival failed: ${e}`);
    }

    // --- Forwarding ---
    let addresses: string[];
    try {
      addresses = await getMailingList(env);
    } catch {
      console.error("Failed to read mailing list.");
      throw new Error("Failed to read mailing list.");
    }

    if (addresses.length === 0) {
      console.error("Mailing list is empty.");
      throw new Error("Mailing list is empty.");
    }

    console.log(`Forwarding to ${addresses.length} addresses: ${addresses.join(", ")}`);

    const succeeded: string[] = [];
    const failed: string[] = [];

    for (const addr of addresses) {
      try {
        await message.forward(addr);
        succeeded.push(addr);
        console.log(`Forwarded to ${addr}`);
      } catch (e) {
        failed.push(addr);
        console.warn(`Failed to forward to ${addr}: ${e}`);
      }
    }

    console.log(
      `Result: ${succeeded.length} succeeded, ${failed.length} failed out of ${addresses.length}`
    );

    if (succeeded.length === 0) {
      throw new Error("All forwards failed. Are any addresses verified?");
    }
  },
} satisfies ExportedHandler<Env>;
