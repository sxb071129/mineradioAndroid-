import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_HOST = process.env.MINERADIO_HTTPS_HOST || "0.0.0.0";
const DEFAULT_HTTPS_PORT = Number(process.env.MINERADIO_HTTPS_PORT || 3443);
const DEFAULT_ENROLL_PORT = Number(process.env.MINERADIO_ENROLL_PORT || 3080);
const DEFAULT_WEB_PORT = Number(process.env.MINERADIO_WEB_PORT || 3000);
const DEFAULT_RELAY_PORT = Number(process.env.MINERADIO_SYNC_PORT || 8787);
const DEFAULT_MUSIC_PORT = Number(process.env.MINERADIO_MUSIC_PORT || 8790);
const DEFAULT_CERT_DIR =
  process.env.MINERADIO_TLS_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "Mineradio",
    "tls",
  );
const DEFAULT_PFX_PATH =
  process.env.MINERADIO_HTTPS_PFX || path.join(DEFAULT_CERT_DIR, "server.pfx");
const DEFAULT_PASSPHRASE_PATH =
  process.env.MINERADIO_HTTPS_PASSPHRASE_FILE ||
  path.join(DEFAULT_CERT_DIR, "server.pass");
const DEFAULT_CA_PATH =
  process.env.MINERADIO_HTTPS_CA || path.join(DEFAULT_CERT_DIR, "mineradio-root-ca.cer");
const DEFAULT_METADATA_PATH =
  process.env.MINERADIO_HTTPS_METADATA || path.join(DEFAULT_CERT_DIR, "metadata.json");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function boundedPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

function filteredHeaders(headers, overrides = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      result[name] = value;
    }
  }
  return { ...result, ...overrides };
}

export function classifyGatewayRoute(pathname) {
  const value = String(pathname || "/");
  if (value === "/health" || value === "/__mineradio/health") return "health";
  if (value === "/.well-known/mr-room/health/relay") return "relay-health";
  if (value === "/.well-known/mr-room/health/music") return "music-health";
  if (value === "/__mineradio/ca.cer") return "certificate";
  if (
    value === "/api/room/qr" ||
    /^\/api\/tracks(?:\/|$)/.test(value) ||
    /^\/api\/cloud(?:\/|$)/.test(value)
  ) {
    return "relay";
  }
  if (/^\/api(?:\/|$)/.test(value)) return "music";
  return "web";
}

export function safeRequestHost(hostHeader, fallback = "localhost") {
  const candidate = String(hostHeader || "").trim();
  if (!candidate || candidate.length > 255 || /[^\[\]A-Za-z0-9.:-]/.test(candidate)) {
    return fallback;
  }
  try {
    const url = new URL(`http://${candidate}`);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return hostname || fallback;
  } catch {
    return fallback;
  }
}

function requestHostParts(hostHeader) {
  const candidate = String(hostHeader || "").trim();
  if (!candidate || candidate.length > 255 || /[^\[\]A-Za-z0-9.:-]/.test(candidate)) {
    return null;
  }
  try {
    const url = new URL(`http://${candidate}`);
    return {
      hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port: url.port,
    };
  } catch {
    return null;
  }
}

export function isAllowedGatewayHost(hostHeader, allowedHosts, port) {
  const parsed = requestHostParts(hostHeader);
  if (!parsed) return false;
  const normalized = new Set(
    (Array.isArray(allowedHosts) ? allowedHosts : [])
      .map((value) => String(value || "").replace(/^\[|\]$/g, "").toLowerCase())
      .filter(Boolean),
  );
  if (!normalized.has(parsed.hostname)) return false;
  const expectedPort = String(port || "");
  return expectedPort === "443"
    ? !parsed.port || parsed.port === "443"
    : parsed.port === expectedPort;
}

export function isAllowedGatewayOrigin(originHeader, allowedHosts, port) {
  if (!originHeader) return true;
  try {
    const url = new URL(String(originHeader));
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return isAllowedGatewayHost(url.host, allowedHosts, port);
  } catch {
    return false;
  }
}

function hostForUrl(hostname) {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function enrollmentHtml(hostname, httpsPort) {
  const safeHost = safeRequestHost(hostname);
  const secureUrl = `https://${hostForUrl(safeHost)}:${boundedPort(httpsPort, 3443)}`;
  const escapedUrl = escapeHtml(secureUrl);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>MR//ROOM 安全局域网连接</title>
  <style>
    :root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#f7f8ff;background:#090b12}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 0,#282d63 0,transparent 42%),#090b12}
    main{width:min(680px,100%);padding:30px;border:1px solid #ffffff24;border-radius:24px;background:#111520e8;box-shadow:0 28px 80px #0008}
    h1{margin:0 0 12px;font-size:clamp(28px,7vw,46px)}
    p,li{color:#c9cee8;line-height:1.7}
    ol{padding-left:22px}
    a{display:inline-flex;margin:8px 8px 0 0;padding:13px 18px;border-radius:999px;color:#0a0c14;background:#dce1ff;text-decoration:none;font-weight:800}
    a.secondary{color:#f7f8ff;background:#ffffff14;border:1px solid #ffffff24}
    code{padding:2px 7px;border-radius:8px;background:#ffffff12;color:#fff}
    small{display:block;margin-top:20px;color:#8e96ba}
  </style>
</head>
<body>
  <main>
    <p>MR//ROOM · 仅用于你的可信局域网</p>
    <h1>启用安全连接</h1>
    <ol>
      <li>下载并安装 MR//ROOM 本地根证书。只安装到你自己的设备。</li>
      <li>iPhone/iPad 安装后，还需在“设置 → 通用 → 关于本机 → 证书信任设置”中启用完全信任。</li>
      <li>Android 在“安全/加密与凭据 → 安装 CA 证书”中导入；Windows 请选择“当前用户 → 受信任的根证书颁发机构”。</li>
      <li>安装完成后重新打开安全播放器地址。</li>
    </ol>
    <a href="/__mineradio/ca.cer" download="mineradio-root-ca.cer">下载根证书</a>
    <a class="secondary" href="${escapedUrl}">打开安全播放器</a>
    <small>安全播放器：<code>${escapedUrl}</code>。请勿把证书或端口暴露到公网。</small>
  </main>
</body>
</html>`;
}

function json(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function proxyRequest(req, res, port, requestPath, { preserveHost = false } = {}) {
  const headers = filteredHeaders(req.headers, {
    host: preserveHost ? req.headers.host : `127.0.0.1:${port}`,
    "x-forwarded-proto": "https",
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-for": req.socket.remoteAddress || "",
  });
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = filteredHeaders(upstreamResponse.headers);
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
      upstreamResponse.on("error", () => res.destroy());
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      json(res, 502, {
        ok: false,
        error: "upstream_unavailable",
        detail: error.code || "proxy_error",
      });
    } else {
      res.destroy();
    }
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function writeUpgradeResponse(socket, response) {
  socket.write(
    `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\n`,
  );
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const lowerName = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "connection" ||
      lowerName === "upgrade"
    ) {
      socket.write(`${name}: ${response.rawHeaders[index + 1]}\r\n`);
    }
  }
  socket.write("\r\n");
}

function proxyUpgrade(req, socket, head, port, requestPath, { preserveHost = false } = {}) {
  const headers = {
    ...req.headers,
    host: preserveHost ? req.headers.host : `127.0.0.1:${port}`,
    "x-forwarded-proto": "https",
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-for": req.socket.remoteAddress || "",
  };
  const upstreamRequest = http.request({
    hostname: "127.0.0.1",
    port,
    path: requestPath,
    method: req.method || "GET",
    headers,
  });

  upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    writeUpgradeResponse(socket, response);
    if (head?.length) upstreamSocket.write(head);
    if (upstreamHead?.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
  });
  upstreamRequest.on("response", (response) => {
    writeUpgradeResponse(socket, response);
    response.pipe(socket);
  });
  upstreamRequest.on("error", () => socket.destroy());
  upstreamRequest.end();
}

async function probe(port, pathname = "/health") {
  return new Promise((resolve) => {
    const request = http.get(
      { hostname: "127.0.0.1", port, path: pathname, timeout: 2000 },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve({
            ok: (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 400,
            status: response.statusCode || 0,
          });
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => resolve({ ok: false, status: 0 }));
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function createLanGateway(options = {}) {
  const insecureTestMode = options.insecureTestMode === true;
  const host = options.host || DEFAULT_HOST;
  const httpsPort = boundedPort(options.httpsPort, DEFAULT_HTTPS_PORT);
  const enrollPort = boundedPort(options.enrollPort, DEFAULT_ENROLL_PORT);
  const webPort = boundedPort(options.webPort, DEFAULT_WEB_PORT);
  const relayPort = boundedPort(options.relayPort, DEFAULT_RELAY_PORT);
  const musicPort = boundedPort(options.musicPort, DEFAULT_MUSIC_PORT);
  const pfxPath = options.pfxPath || DEFAULT_PFX_PATH;
  const passphrasePath = options.passphrasePath || DEFAULT_PASSPHRASE_PATH;
  const caPath = options.caPath || DEFAULT_CA_PATH;
  const metadataPath = options.metadataPath || DEFAULT_METADATA_PATH;
  const [pfx, passphrase, metadata] = await Promise.all([
    insecureTestMode
      ? Promise.resolve(null)
      : options.pfx
        ? Promise.resolve(options.pfx)
        : readFile(pfxPath),
    insecureTestMode
      ? Promise.resolve("")
      : options.passphrase !== undefined
        ? Promise.resolve(String(options.passphrase))
        : readFile(passphrasePath, "utf8").then((value) => value.trim()),
    options.allowedHosts
      ? Promise.resolve({ hosts: options.allowedHosts })
      : readFile(metadataPath, "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => ({ hosts: ["localhost", "127.0.0.1", "::1"] })),
  ]);
  const allowedHosts = Array.from(
    new Set(
      ["localhost", "127.0.0.1", "::1", ...(Array.isArray(metadata.hosts) ? metadata.hosts : [])]
        .map((value) => String(value || "").replace(/^\[|\]$/g, "").toLowerCase())
        .filter(Boolean),
    ),
  );

  const requestHandler = async (req, res) => {
    const url = new URL(req.url || "/", "https://gateway.local");
    const route = classifyGatewayRoute(url.pathname);
    const actualPort = secureServer.address()?.port || httpsPort;
    if (!isAllowedGatewayHost(req.headers.host, allowedHosts, actualPort)) {
      json(res, 421, { ok: false, error: "host_not_allowed" });
      return;
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase());
    if (
      mutation &&
      !isAllowedGatewayOrigin(req.headers.origin, allowedHosts, actualPort)
    ) {
      json(res, 403, { ok: false, error: "origin_not_allowed" });
      return;
    }
    if (route === "health") {
      const [web, relay, music] = await Promise.all([
        probe(webPort, "/"),
        probe(relayPort),
        probe(musicPort),
      ]);
      json(res, web.ok && relay.ok && music.ok ? 200 : 503, {
        ok: web.ok && relay.ok && music.ok,
        service: "mineradio-lan-gateway",
        secure: true,
        services: { web, relay, music },
      });
      return;
    }
    if (route === "relay-health") {
      proxyRequest(req, res, relayPort, "/health", { preserveHost: false });
      return;
    }
    if (route === "music-health") {
      proxyRequest(req, res, musicPort, "/health", { preserveHost: false });
      return;
    }
    if (route === "certificate") {
      try {
        const certificate = await readFile(caPath);
        res.writeHead(200, {
          "Content-Type": "application/pkix-cert",
          "Content-Disposition": 'attachment; filename="mineradio-root-ca.cer"',
          "Content-Length": certificate.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(certificate);
      } catch {
        json(res, 404, { ok: false, error: "certificate_not_found" });
      }
      return;
    }
    if (route === "relay") {
      proxyRequest(req, res, relayPort, req.url || "/", { preserveHost: false });
      return;
    }
    if (route === "music") {
      proxyRequest(req, res, musicPort, req.url || "/", { preserveHost: false });
      return;
    }
    proxyRequest(req, res, webPort, req.url || "/", { preserveHost: true });
  };
  const secureServer = insecureTestMode
    ? http.createServer(requestHandler)
    : https.createServer({ pfx, passphrase }, requestHandler);

  secureServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "https://gateway.local");
    const actualPort = secureServer.address()?.port || httpsPort;
    if (
      !isAllowedGatewayHost(req.headers.host, allowedHosts, actualPort) ||
      !isAllowedGatewayOrigin(req.headers.origin, allowedHosts, actualPort)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/sync" || url.pathname === "/sync/") {
      proxyUpgrade(req, socket, head, relayPort, "/ws", { preserveHost: false });
      return;
    }
    proxyUpgrade(req, socket, head, webPort, req.url || "/", { preserveHost: true });
  });

  const enrollmentServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://enroll.local");
    if (url.pathname === "/__mineradio/ca.cer") {
      try {
        const certificate = await readFile(caPath);
        res.writeHead(200, {
          "Content-Type": "application/pkix-cert",
          "Content-Disposition": 'attachment; filename="mineradio-root-ca.cer"',
          "Content-Length": certificate.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(certificate);
      } catch {
        json(res, 404, { ok: false, error: "certificate_not_found" });
      }
      return;
    }
    if (url.pathname === "/health" || url.pathname === "/__mineradio/health") {
      json(res, 200, {
        ok: true,
        service: "mineradio-certificate-enrollment",
        securePlayerPort: secureServer.address()?.port || httpsPort,
      });
      return;
    }
    const hostname = safeRequestHost(req.headers.host);
    const body = Buffer.from(
      enrollmentHtml(hostname, secureServer.address()?.port || httpsPort),
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  });

  const secureAddress = await listen(secureServer, httpsPort, host);
  try {
    await listen(enrollmentServer, enrollPort, host);
  } catch (error) {
    await closeServer(secureServer);
    throw error;
  }

  return {
    secureServer,
    enrollmentServer,
    httpsPort: secureAddress.port,
    enrollPort: enrollmentServer.address().port,
    async close() {
      await Promise.all([closeServer(enrollmentServer), closeServer(secureServer)]);
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  path.resolve(currentFile) === path.resolve(fileURLToPath(pathToFileURL(process.argv[1])));

if (isMain) {
  try {
    const gateway = await createLanGateway();
    console.log(`MR//ROOM secure gateway: https://localhost:${gateway.httpsPort}`);
    console.log(`Certificate setup page: http://localhost:${gateway.enrollPort}`);
  } catch (error) {
    console.error(`MR//ROOM secure gateway failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
