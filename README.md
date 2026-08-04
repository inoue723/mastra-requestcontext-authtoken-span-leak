# Minimal reproduction: `mastra__authToken` (raw bearer) leaks onto every span's `requestContext`

Mastra's built-in auth middleware stores the **raw session bearer token** and the
full user object into the request's `RequestContext` under reserved keys
(`mastra__authToken`, `mastra__user`, `user`). Every span created during that
request then serializes the **entire** `RequestContext` onto its `requestContext`
field, and the default `SensitiveDataFilter` never scrubs it — so the plaintext
JWT is handed to whatever exporter is configured (storage, Braintrust, OTLP, ...).

## Versions

- `@mastra/core` **1.55.0**
- `@mastra/observability` **1.16.3**
- `@mastra/deployer` **1.55.0** (serves the built-in routes; bundles `@mastra/server`,
  the source of the reserved-key writes)

## Run

```bash
npm install
npm start            # end-to-end: real built-in auth + auto-generated spans
npm run start:minimal  # isolated: the same leak at the observability layer
```

Both scripts exit `1` when the leak is present.

## `npm start` — end-to-end (recommended)

`src/reproduce-server.ts` is a realistic use case. It uses only the public API
and **never touches `RequestContext` or spans directly**:

1. A `Mastra` instance with a built-in auth provider (`server.auth`), one agent
   (backed by a tiny mock model so there's no API key / network), and
   observability using a capturing `TestExporter` + the **auto-applied default
   `SensitiveDataFilter`**.
2. Serves the real Hono app via `createHonoServer(mastra)`.
3. Makes one **authenticated** request to the built-in endpoint:
   ```
   POST /api/agents/demoAgent/generate
   Authorization: Bearer <token>
   ```
4. Mastra's auth middleware validates the token and — on its own — stores it in
   the request's `RequestContext` under `mastra__authToken` (plus the user under
   `mastra__user` / `user`). The agent run then **auto-generates** the spans.
5. The script reads the exported spans back and shows the raw token survived.

### Expected output (bug present)

```
POST /api/agents/demoAgent/generate -> HTTP 200
Auto-generated spans: 5 (types: agent_run, model_generation, model_step, model_inference, model_chunk)
Spans whose requestContext carries the raw bearer token: 2

=== "agent_run" span.requestContext (exactly what an exporter persists) ===
{
  "mastra__authMode": "server",
  "mastra__user": { "id": "user-123", "email": "admin@example.com" },
  "user": { "id": "user-123", "email": "admin@example.com" },
  "mastra__authToken": "eyJhbGciOiJIUzI1NiJ9.FAKE_SESSION_JWT_DO_NOT_USE.fake_signature",
  "mastra__versions": { "defaultStatus": "published" }
}

=== Result ===
Raw bearer token reached the exporter in plaintext: true
```

## `npm run start:minimal` — isolated

`src/reproduce.ts` strips the HTTP/auth/agent layers and reproduces the same leak
directly at the observability layer: it populates a `RequestContext` exactly as
the auth middleware does and starts/ends one span, then inspects the exported
`requestContext`. Useful for pinpointing the defect without any server setup.

## Root cause

1. **Built-in auth stores secrets under reserved keys** — `@mastra/server`
   (`dist/helpers-*.js`):
   ```js
   requestContext.set(MASTRA_USER_KEY, user);                 // "mastra__user"
   requestContext.set("user", user);
   if (effectiveToken) requestContext.set(MASTRA_AUTH_TOKEN_KEY, effectiveToken); // raw bearer
   ```

2. **A safe serializer exists but is bypassed.** `@mastra/core`'s `RequestContext`
   implements `serializeForSpan()`, which redacts `mastra__authToken` and drops
   non-primitive values (`request-context-*.js`):
   ```js
   serializeForSpan() {
     const safe = {};
     for (const [key, value] of this.registry.entries())
       if (key === "mastra__authToken") safe[key] = "[REDACTED]";
       else if (value == null || ["string","number","boolean"].includes(typeof value)) safe[key] = value;
       else safe[key] = `[${typeof value}]`;
     return safe;
   }
   ```
   `deepClean` in `@mastra/observability` even honors it — *if* the value it
   receives is the `RequestContext` instance:
   ```js
   if (typeof serializeForSpan === "function")
     return helper(serializeForSpan.call(val), depth);
   ```

3. **But `BaseSpan` passes `.all`, not the instance** — `@mastra/observability`
   (`dist/index.js`, `BaseSpan` constructor):
   ```js
   if (options.requestContext && options.requestContext.size() > 0)
     this.requestContext = deepClean(options.requestContext.all, this.deepCleanOptions);
   ```
   `RequestContext.all` is `Object.fromEntries(registry)` — a **raw** plain object
   with no `serializeForSpan` method, so `deepClean` skips the safe path and keeps
   the raw token and user object. `exportSpan()` then emits
   `requestContext: this.requestContext`.

4. **`SensitiveDataFilter` doesn't cover `requestContext`** — its `process()` only
   walks `attributes / metadata / input / output / errorInfo`. Even if it did,
   `mastra__authToken` normalizes to `mastraauthtoken`, matching no default
   sensitive field (`token`, `auth`, `bearer`, `jwt`, ...) under exact-normalized
   matching.

## Suggested fix

Route the capture through the safe serializer, e.g. in `BaseSpan`:

```js
// pass the instance so deepClean invokes serializeForSpan()
this.requestContext = deepClean(options.requestContext, this.deepCleanOptions);
// or explicitly:
this.requestContext = deepClean(options.requestContext.serializeForSpan(), this.deepCleanOptions);
```

As defense-in-depth, `SensitiveDataFilter.process()` could also filter
`span.requestContext`.

## Relation to #18775

[#18775](https://github.com/mastra-ai/mastra/issues/18775) fixed the *scorer_run*
path (a `RequestContext` instance embedded in span **input**) and introduced
`serializeForSpan()`. The general span-capture path here is a **different** call
site that pre-unwraps with `.all` and therefore bypasses that fix.
