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
- `@mastra/server` **1.55.0** (source of the reserved-key writes)

## Run

```bash
npm install
npm start
```

## Expected output (bug present)

```
=== Exported span.requestContext (exactly what an exporter persists) ===
{
  "mastra__authToken": "eyJhbGciOiJIUzI1NiJ9.FAKE_SESSION_JWT_DO_NOT_USE.fake_signature",
  "mastra__user": { "email": "admin@example.com", "sub": "user-123" },
  "user": { "email": "admin@example.com", "sub": "user-123" }
}

=== Result ===
mastra__authToken present in plaintext: true
user object present:                    true
```

The process exits `1` when the leak is present.

> The default `SensitiveDataFilter` is **auto-applied** here: `src/reproduce.ts`
> passes a plain config object (not a pre-instantiated instance), which is the
> secure-by-default path. The token still leaks.

## What the reproduction does

`src/reproduce.ts` uses only the public API:

1. Builds an `Observability` with a capturing `TestExporter` (stands in for any
   real exporter) and the auto-applied default `SensitiveDataFilter`.
2. Populates a `RequestContext` **exactly** as `@mastra/server`'s built-in auth
   middleware does per request:
   ```ts
   requestContext.set(MASTRA_AUTH_TOKEN_KEY, rawBearerToken); // "mastra__authToken"
   requestContext.set("mastra__user", user);
   requestContext.set("user", user);
   ```
3. Starts and ends a normal `AGENT_RUN` span carrying that `RequestContext`.
4. Reads back the exported span and shows the raw token/user survived to export.

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
