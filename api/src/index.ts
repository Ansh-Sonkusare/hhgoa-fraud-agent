import { env } from "./env.js";
import { buildServer } from "./server.js";

const app = buildServer();

app
  .listen({ port: env.API_PORT, host: "0.0.0.0" })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on http://localhost:${env.API_PORT} (fixture replay backend)`);
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[api] failed to start", err);
    process.exit(1);
  });
