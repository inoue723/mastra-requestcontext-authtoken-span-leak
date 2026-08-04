import { Agent, type MastraLanguageModel } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MASTRA_AUTH_TOKEN_KEY } from "@mastra/core/request-context";
import { MastraAuthProvider } from "@mastra/core/server";
import { createHonoServer } from "@mastra/deployer/server";
import {
  Observability,
  SamplingStrategyType,
  TestExporter,
} from "@mastra/observability";

// A minimal mock model (AI SDK v2 spec, the spec @mastra/core speaks) so the
// agent runs with no API key, no network, and no test-lib deps. Nothing about
// the leak depends on the model.
const MOCK_USAGE = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
const MOCK_TEXT = "Hello from the mock model.";
const mockModel = {
  specificationVersion: "v2",
  provider: "mock",
  modelId: "mock-model",
  supportedUrls: {},
  doGenerate: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    finishReason: "stop",
    usage: MOCK_USAGE,
    content: [{ type: "text", text: MOCK_TEXT }],
    warnings: [],
  }),
  doStream: async () => ({
    rawCall: { rawPrompt: null, rawSettings: {} },
    warnings: [],
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "text-1" });
        controller.enqueue({ type: "text-delta", id: "text-1", delta: MOCK_TEXT });
        controller.enqueue({ type: "text-end", id: "text-1" });
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: MOCK_USAGE,
        });
        controller.close();
      },
    }),
  }),
} as unknown as MastraLanguageModel;

// The real session bearer token a client sends in `Authorization: Bearer ...`.
// This is the value that ends up in the observability store, in plaintext.
const RAW_BEARER_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.FAKE_SESSION_JWT_DO_NOT_USE.fake_signature";

type DemoUser = { id: string; email: string };

// A real built-in auth provider. Mastra's auth middleware calls
// `authenticateToken` for every request; on success the SAME middleware stores
// the raw bearer token in the request's RequestContext under `mastra__authToken`
// (plus the user under `mastra__user` / `user`). We never do that manually.
class DemoAuth extends MastraAuthProvider<DemoUser> {
  constructor() {
    super({ name: "demo-auth" });
  }

  async authenticateToken(token: string): Promise<DemoUser | null> {
    // Production verifies a JWT signature here; we accept our demo token.
    return token === RAW_BEARER_TOKEN
      ? { id: "user-123", email: "admin@example.com" }
      : null;
  }

  authorizeUser(): boolean {
    return true;
  }
}

async function main() {
  // A capturing exporter, standing in for any real exporter
  // (MastraStorageExporter, Braintrust, OTLP, ...).
  const testExporter = new TestExporter();

  // Out-of-the-box observability: passing a plain config object AUTO-APPLIES the
  // default SensitiveDataFilter (the secure-by-default path).
  const observability = new Observability({
    configs: {
      default: {
        serviceName: "repro",
        sampling: { type: SamplingStrategyType.ALWAYS },
        exporters: [testExporter],
      },
    },
  });

  const mastra = new Mastra({
    agents: {
      demoAgent: new Agent({
        id: "demoAgent",
        name: "demoAgent",
        instructions: "You are a demo agent.",
        model: mockModel,
      }),
    },
    observability,
    server: {
      // Built-in auth protects the built-in /api/agents/* routes.
      auth: new DemoAuth(),
    },
  });

  // The same Hono app Mastra serves in production.
  const app = await createHonoServer(mastra);

  // A normal authenticated request to the built-in agent endpoint. The agent run
  // AUTO-GENERATES the observability spans — this script never touches
  // RequestContext or spans directly.
  const res = await app.request("/api/agents/demoAgent/generate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RAW_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });

  console.log(`\nPOST /api/agents/demoAgent/generate -> HTTP ${res.status}`);
  if (res.status !== 200) {
    console.error("Unexpected status. Body:", await res.text());
    process.exit(2);
  }

  // Flush exporters.
  await observability.shutdown();

  const spans = testExporter.getCompletedSpans();
  const leakingSpans = spans.filter(
    (s) => s.requestContext?.[MASTRA_AUTH_TOKEN_KEY] != null,
  );

  console.log(
    `\nAuto-generated spans: ${spans.length} (types: ${spans
      .map((s) => s.type)
      .join(", ")})`,
  );
  console.log(
    `Spans whose requestContext carries the raw bearer token: ${leakingSpans.length}`,
  );

  const sample = leakingSpans[0];
  if (sample) {
    console.log(
      `\n=== "${sample.type}" span.requestContext (exactly what an exporter persists) ===`,
    );
    console.log(JSON.stringify(sample.requestContext, null, 2));
  }

  const tokenLeaked = leakingSpans.some(
    (s) => s.requestContext?.[MASTRA_AUTH_TOKEN_KEY] === RAW_BEARER_TOKEN,
  );

  console.log("\n=== Result ===");
  console.log(`Raw bearer token reached the exporter in plaintext: ${tokenLeaked}`);

  if (tokenLeaked) {
    console.error(
      [
        "",
        "BUG REPRODUCED: a normal authenticated agent request auto-generated spans",
        "whose requestContext carries the raw session bearer token in plaintext,",
        "despite the default SensitiveDataFilter being active.",
        "",
        "Root cause:",
        "  - Built-in auth stores the raw token under `mastra__authToken` in RequestContext.",
        "  - BaseSpan captures `requestContext.all` (raw) instead of routing it through",
        "    RequestContext.serializeForSpan() (which would redact `mastra__authToken`).",
        "  - SensitiveDataFilter.process() never scrubs span.requestContext.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("\nNo leak: requestContext was redacted before export.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
