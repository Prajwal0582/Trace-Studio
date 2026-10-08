// Tiny static server for the demo prototype: `npm run demo` → http://localhost:4321
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "demo-prototype");
const campaigns = [
  { name: "Spring launch", audience: "All customers · 48,210", status: "Live" },
  { name: "Win-back Q3", audience: "Lapsed 90 days · 6,904", status: "Draft" },
  { name: "VIP preview", audience: "Top tier · 1,288", status: "Scheduled" },
];
const port = Number(process.env.PORT || 4321);
http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/campaigns")) {
      res.writeHead(200, { "content-type": "application/json" });
      return setTimeout(() => res.end(JSON.stringify(campaigns)), 150);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(dir, "index.html")));
  })
  .listen(port, () => console.log(`Demo prototype on http://localhost:${port}`));
