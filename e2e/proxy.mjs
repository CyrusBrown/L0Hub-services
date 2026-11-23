#!/usr/bin/env node
// The end-to-end test's stand-in for Cloudflare's routing: one port for the whole hub domain, each request sent on by its
// Host header, the way a more specific route sends `board.<hub>` to the board Worker and everything else to the hub.
//
//   node proxy.mjs --port 8790 --route board.hub.localhost=127.0.0.1:8801 --route spaces.hub.localhost=127.0.0.1:8802 --default 127.0.0.1:8787
//
// Per request (keep-alive connections may carry several hosts), WebSocket upgrades (the hub's tunnel) included.
import http from "node:http";
import net from "node:net";

const args = process.argv.slice(2);
const routes = new Map();
let port = 0;
let fallback = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[++i];
  if (a === "--port") port = Number(v);
  else if (a === "--default") fallback = v;
  else if (a === "--route") {
    const [host, addr] = v.split("=");
    routes.set(host.toLowerCase(), addr);
  } else throw new Error(`unexpected ${a}`);
}

const target = (hostHeader) => {
  const host = String(hostHeader || "").toLowerCase().replace(/:\d+$/, "");
  const [h, p] = (routes.get(host) ?? fallback).split(":");
  return { host: h, port: Number(p) };
};

const server = http.createServer((req, res) => {
  const t = target(req.headers.host);
  const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.rawHeaders);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`proxy: ${e.message}`);
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const t = target(req.headers.host);
  const up = net.connect(t.port, t.host, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => {
    socket.destroy();
    up.destroy();
  };
  up.on("error", end);
  socket.on("error", end);
});

server.keepAliveTimeout = 60_000;
server.listen(port, "127.0.0.1", () => console.log(`proxy on 127.0.0.1:${port}`));
