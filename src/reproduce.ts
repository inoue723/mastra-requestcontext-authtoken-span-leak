import { Mastra } from "@mastra/core/mastra";
import { SpanType } from "@mastra/core/observability";
import {
  MASTRA_AUTH_TOKEN_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import {
  Observability,
  SamplingStrategyType,
  TestExporter,
} from "@mastra/observability";

// A fake bearer token, standing in for the real session JWT that Mastra's
// built-in auth middleware (@mastra/server) stores under `mastra__authToken`
// on every authenticated request.
const FAKE_BEARER_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.FAKE_SESSION_JWT_DO_NOT_USE.fake_signature";

const FAKE_USER = { email: "admin@example.com", sub: "user-123" };

async function main() {
  // A capturing exporter, standing in for any real exporter
  // (MastraStorageExporter, Braintrust, OTLP, ...). It records the exact
  // ExportedSpan objects the framework hands to exporters for persistence.
  const testExporter = new TestExporter();

  // Out-of-the-box observability config. Because we pass a plain config object
  // (not a pre-instantiated instance), Mastra AUTO-APPLIES its default
  // `SensitiveDataFilter`. This is the secure-by-default setup a normal app gets.
  const observability = new Observability({
    configs: {
      default: {
        serviceName: "repro",
        sampling: { type: SamplingStrategyType.ALWAYS },
        exporters: [testExporter],
      },
    },
  });

  // Wiring Observability into a Mastra instance initializes the exporters.
  new Mastra({ observability });

  const instance = observability.getDefaultInstance();
  if (!instance) throw new Error("no default observability instance");

  // Reproduce exactly what @mastra/server's built-in auth middleware does on
  // every authenticated request (see helpers-*.js in @mastra/server):
  //   requestContext.set(MASTRA_USER_KEY, user);            // "mastra__user"
  //   requestContext.set("user", user);
  //   requestContext.set(MASTRA_AUTH_TOKEN_KEY, effectiveToken); // raw bearer
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_AUTH_TOKEN_KEY, FAKE_BEARER_TOKEN);
  requestContext.set("mastra__user", FAKE_USER);
  requestContext.set("user", FAKE_USER);

  // Any span created during a request carries that request's RequestContext.
  const span = instance.startSpan({
    type: SpanType.AGENT_RUN,
    name: "agent run",
    input: { messages: ["hello"] },
    requestContext,
  });
  span?.end({ output: { text: "hi" } });

  // Flush exporters.
  await observability.shutdown();

  const spans = testExporter.getCompletedSpans();
  const exported = spans[0];
  const exportedRequestContext = exported?.requestContext;

  console.log(
    "\n=== Exported span.requestContext (exactly what an exporter persists) ===",
  );
  console.log(JSON.stringify(exportedRequestContext, null, 2));

  const leakedToken = exportedRequestContext?.[MASTRA_AUTH_TOKEN_KEY];
  const tokenLeaked = leakedToken === FAKE_BEARER_TOKEN;
  const userLeaked =
    exportedRequestContext?.mastra__user != null ||
    exportedRequestContext?.user != null;

  console.log("\n=== Result ===");
  console.log(`mastra__authToken present in plaintext: ${tokenLeaked}`);
  console.log(`user object present:                    ${userLeaked}`);

  if (tokenLeaked || userLeaked) {
    console.error(
      [
        "",
        "BUG REPRODUCED: the raw bearer token and/or user object reached the",
        "exporter on span.requestContext, despite the default SensitiveDataFilter",
        "being active.",
        "",
        "Root cause:",
        "  - SensitiveDataFilter.process() only scrubs attributes/metadata/input/",
        "    output/errorInfo -- never span.requestContext.",
        "  - BaseSpan captures `options.requestContext.all` (raw plain object) instead",
        "    of routing the RequestContext instance through its own",
        "    RequestContext.serializeForSpan() (which would redact mastra__authToken).",
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
