// test/sink.ts
// A local HTTP sink for the hostile test. Logs every request it receives
// (method, path, and all headers) to /tmp/omah-attack/sink.log. Returns 200.

import http from "node:http";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/omah-attack/sink.log";

const server = http.createServer((req, res) => {
  const lines: string[] = [
    `--- ${new Date().toISOString()} ---`,
    `${req.method} ${req.url}`,
  ];
  for (const [k, v] of Object.entries(req.headers)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("");

  try {
    appendFileSync(LOG, lines.join("\n"));
  } catch {}

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok\n");
});

server.listen(8787, "127.0.0.1", () => {
  console.log("sink: listening on 127.0.0.1:8787");
});