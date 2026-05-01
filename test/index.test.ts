import { describe, it, expect, vi, beforeEach } from "vitest";
import worker, {
  type Env,
  getMailingList,
  getArchiveSenders,
  getArchiveAll,
  listArchivedEmails,
} from "../worker/index";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeR2Bucket(
  objects: Map<
    string,
    { body: ArrayBuffer; customMetadata?: Record<string, string>; uploaded?: Date }
  > = new Map()
): R2Bucket {
  return {
    put: vi.fn(async (key: string, value: ArrayBuffer | ReadableStream, opts?: R2PutOptions) => {
      const buf = value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer();
      objects.set(key, {
        body: buf,
        customMetadata: (opts as { customMetadata?: Record<string, string> })?.customMetadata,
        uploaded: new Date(),
      });
    }),
    get: vi.fn(async (key: string) => {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(obj.body));
            controller.close();
          },
        }),
        arrayBuffer: async () => obj.body,
        customMetadata: obj.customMetadata ?? {},
        key,
        size: obj.body.byteLength,
        uploaded: obj.uploaded ?? new Date(),
      };
    }),
    list: vi.fn(async () => ({
      objects: [...objects.entries()].map(([key, val]) => ({
        key,
        size: val.body.byteLength,
        uploaded: val.uploaded ?? new Date(),
        customMetadata: val.customMetadata ?? {},
      })),
      truncated: false,
      cursor: "",
    })),
    delete: vi.fn(),
    head: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    EMAIL_BUCKET: makeR2Bucket(),
    CONFIG_KV: makeKV({
      mailing_list: JSON.stringify(["alice@example.com", "bob@example.com"]),
    }),
    AUTH_PASSWORD: "test-password",
    ...overrides,
  };
}

function makeMessage(
  forwardFn = vi.fn().mockResolvedValue(undefined),
  from = "sender@example.com"
) {
  const rawBody = new TextEncoder().encode(
    `From: ${from}\r\nTo: list@example.com\r\nSubject: Test\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\n\r\nHello world`
  );
  return {
    from,
    to: "list@example.com",
    forward: forwardFn,
    setReject: vi.fn(),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(rawBody);
        controller.close();
      },
    }),
    rawSize: rawBody.byteLength,
    headers: new Headers({
      subject: "Test",
      date: "Mon, 01 Jan 2024 00:00:00 +0000",
    }),
  } as unknown as ForwardableEmailMessage;
}

// ---------------------------------------------------------------------------
// Email handler tests
// ---------------------------------------------------------------------------

describe("maillist email worker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards to all addresses from KV", async () => {
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn);
    const env = makeEnv();

    await worker.email(message, env);

    expect(forwardFn).toHaveBeenCalledTimes(2);
    expect(forwardFn).toHaveBeenCalledWith("alice@example.com");
    expect(forwardFn).toHaveBeenCalledWith("bob@example.com");
  });

  it("forwards to a single address", async () => {
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn);
    const env = makeEnv({
      CONFIG_KV: makeKV({
        mailing_list: JSON.stringify(["only@example.com"]),
      }),
    });

    await worker.email(message, env);

    expect(forwardFn).toHaveBeenCalledOnce();
    expect(forwardFn).toHaveBeenCalledWith("only@example.com");
  });

  it("throws when mailing list is empty", async () => {
    const message = makeMessage();
    const env = makeEnv({
      CONFIG_KV: makeKV({ mailing_list: JSON.stringify([]) }),
    });

    await expect(worker.email(message, env)).rejects.toThrow("Mailing list is empty.");
  });

  it("reads mailing list from KV", async () => {
    const kvStore = { mailing_list: JSON.stringify(["kv@example.com"]) };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn);
    const env = makeEnv({ CONFIG_KV: makeKV(kvStore) });

    await worker.email(message, env);

    expect(forwardFn).toHaveBeenCalledOnce();
    expect(forwardFn).toHaveBeenCalledWith("kv@example.com");
  });

  it("throws when all forwards fail", async () => {
    const forwardFn = vi.fn().mockRejectedValue(new Error("fail"));
    const message = makeMessage(forwardFn);
    const env = makeEnv();

    await expect(worker.email(message, env)).rejects.toThrow(
      "All forwards failed. Are any addresses verified?"
    );
  });
});

// ---------------------------------------------------------------------------
// Archival tests
// ---------------------------------------------------------------------------

describe("email archival", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("archives email when sender is in archive list", async () => {
    const r2Objects = new Map();
    const bucket = makeR2Bucket(r2Objects);
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_senders: JSON.stringify(["sender@example.com"]) };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "sender@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(bucket.put).toHaveBeenCalledOnce();
    expect(forwardFn).toHaveBeenCalled();
  });

  it("does not archive email when sender is not in archive list", async () => {
    const bucket = makeR2Bucket();
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_senders: JSON.stringify(["other@example.com"]) };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "sender@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(bucket.put).not.toHaveBeenCalled();
    expect(forwardFn).toHaveBeenCalled();
  });

  it("matches archive senders case-insensitively", async () => {
    const bucket = makeR2Bucket();
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_senders: JSON.stringify(["Sender@Example.COM"]) };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "sender@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(bucket.put).toHaveBeenCalledOnce();
  });

  it("continues forwarding when archival fails", async () => {
    const bucket = makeR2Bucket();
    (bucket.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("R2 down"));
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_senders: JSON.stringify(["sender@example.com"]) };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "sender@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(forwardFn).toHaveBeenCalled();
  });

  it("archives all emails when archive_all is enabled", async () => {
    const bucket = makeR2Bucket();
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_all: "true" };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "anyone@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(bucket.put).toHaveBeenCalledOnce();
    expect(forwardFn).toHaveBeenCalled();
  });

  it("does not archive when archive_all is disabled and sender not in list", async () => {
    const bucket = makeR2Bucket();
    const ml = JSON.stringify(["alice@example.com"]);
    const kvStore = { mailing_list: ml, archive_all: "false" };
    const forwardFn = vi.fn().mockResolvedValue(undefined);
    const message = makeMessage(forwardFn, "anyone@example.com");
    const env = makeEnv({
      EMAIL_BUCKET: bucket,
      CONFIG_KV: makeKV(kvStore),
    });

    await worker.email(message, env);

    expect(bucket.put).not.toHaveBeenCalled();
  });
});

describe("archive listing", () => {
  it("returns all archived emails newest first", async () => {
    const bytes = new TextEncoder().encode("message").buffer;
    const objects = new Map([
      [
        "2024/01/01/1704067200000-old.eml",
        {
          body: bytes,
          uploaded: new Date("2024-01-01T00:00:00.000Z"),
          customMetadata: { subject: "Old" },
        },
      ],
      [
        "2024/01/03/1704240000000-new.eml",
        {
          body: bytes,
          uploaded: new Date("2024-01-03T00:00:00.000Z"),
          customMetadata: { subject: "New" },
        },
      ],
      [
        "2024/01/02/1704153600000-middle.eml",
        {
          body: bytes,
          uploaded: new Date("2024-01-02T00:00:00.000Z"),
          customMetadata: { subject: "Middle" },
        },
      ],
    ]);
    const env = makeEnv({ EMAIL_BUCKET: makeR2Bucket(objects) });

    const emails = await listArchivedEmails(env);

    expect(emails.map((email) => email.subject)).toEqual(["New", "Middle", "Old"]);
  });
});

// ---------------------------------------------------------------------------
// KV helper tests
// ---------------------------------------------------------------------------

describe("KV helpers", () => {
  it("getMailingList reads from KV", async () => {
    const env = makeEnv();
    const list = await getMailingList(env);
    expect(list).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("getMailingList returns empty array when KV is empty", async () => {
    const env = makeEnv({ CONFIG_KV: makeKV() });
    const list = await getMailingList(env);
    expect(list).toEqual([]);
  });

  it("getArchiveSenders returns empty array when KV is empty", async () => {
    const env = makeEnv({ CONFIG_KV: makeKV() });
    const list = await getArchiveSenders(env);
    expect(list).toEqual([]);
  });

  it("getArchiveSenders reads from KV", async () => {
    const env = makeEnv({
      CONFIG_KV: makeKV({
        archive_senders: JSON.stringify(["arc@example.com"]),
      }),
    });
    const list = await getArchiveSenders(env);
    expect(list).toEqual(["arc@example.com"]);
  });

  it("getArchiveAll returns false by default", async () => {
    const env = makeEnv();
    expect(await getArchiveAll(env)).toBe(false);
  });

  it("getArchiveAll returns true when set", async () => {
    const env = makeEnv({ CONFIG_KV: makeKV({ archive_all: "true" }) });
    expect(await getArchiveAll(env)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// API tests
// ---------------------------------------------------------------------------

describe("API routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function loginAndGetCookie(env: Env): Promise<string> {
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const res = await worker.fetch(req, env);
    return res.headers.get("Set-Cookie") ?? "";
  }

  it("POST /api/auth/login succeeds with correct password", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test-password" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("session=");
  });

  it("POST /api/auth/login fails with wrong password", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/check returns authenticated status", async () => {
    const env = makeEnv();
    const cookie = await loginAndGetCookie(env);

    const req = new Request("http://localhost/api/auth/check", {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    const data = await res.json();
    expect(data.authenticated).toBe(true);
  });

  it("GET /api/auth/check returns false without cookie", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/api/auth/check");
    const res = await worker.fetch(req, env);
    const data = await res.json();
    expect(data.authenticated).toBe(false);
  });

  it("GET /api/settings returns lists", async () => {
    const env = makeEnv();
    const cookie = await loginAndGetCookie(env);

    const req = new Request("http://localhost/api/settings", {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.mailingList)).toBe(true);
    expect(Array.isArray(data.archiveSenders)).toBe(true);
  });

  it("PUT /api/settings updates KV", async () => {
    const kvStore: Record<string, string> = {};
    const env = makeEnv({ CONFIG_KV: makeKV(kvStore) });
    const cookie = await loginAndGetCookie(env);

    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        mailingList: ["new@example.com"],
        archiveSenders: ["arc@example.com"],
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(kvStore.mailing_list).toBe(JSON.stringify(["new@example.com"]));
    expect(kvStore.archive_senders).toBe(JSON.stringify(["arc@example.com"]));
  });

  it("GET /api/emails returns email list", async () => {
    const env = makeEnv();
    const cookie = await loginAndGetCookie(env);

    const req = new Request("http://localhost/api/emails", {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.emails)).toBe(true);
  });

  it("protected routes return 401 without auth", async () => {
    const env = makeEnv();
    const req = new Request("http://localhost/api/settings");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });
});
