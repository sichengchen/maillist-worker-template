# Maillist Worker Template

A Cloudflare Worker template for running a small mailing list with an authenticated admin UI and optional R2 email archival.

## What It Includes

- Cloudflare Email Routing handler that forwards incoming mail to addresses stored in KV.
- React admin UI served through Workers Static Assets.
- Password-protected settings page for recipients, archive senders, and archive-all mode.
- R2 archive browser that lists every archived email from newest to oldest.
- Raw `.eml` download and parsed email viewing.

## Cloudflare Resources

Create one R2 bucket and one KV namespace:

```sh
npx wrangler r2 bucket create maillist-email-archive
npx wrangler kv namespace create CONFIG_KV
```

Copy the generated KV namespace id into `wrangler.toml`, replacing the template placeholder:

```toml
[[kv_namespaces]]
binding = "CONFIG_KV"
id = "your-kv-namespace-id"
```

Set an admin password as a Worker secret:

```sh
npx wrangler secret put AUTH_PASSWORD
```

All destination addresses must be verified in Cloudflare Email Routing before the Worker can forward to them.

## Local Development

Install dependencies:

```sh
npm install
```

For local Worker auth, create a `.dev.vars` file:

```sh
AUTH_PASSWORD="local-password"
```

Run the Worker and static UI together:

```sh
npm run dev
```

For frontend-only iteration with the Vite proxy, run the Worker in one terminal and Vite in another:

```sh
npm run dev:worker
npm run dev:ui
```

## Deploy

Build and deploy the Worker plus the static React UI:

```sh
npm run deploy
```

After deploying, configure a Cloudflare Email Routing catch-all or custom address rule to send mail to this Worker.

## Checks

```sh
npm run typecheck
npm test
```
