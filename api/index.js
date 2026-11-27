export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

const SECRET_TOKEN = "MY_TOKEN_123";

export default async function handler(request) {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Javxy-Token, X-Javxy-Principal, Range",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (url.pathname === "/api/trailers/proxy/status") {
    return jsonOut({ enabled: true }, 200, corsHeaders);
  }

  if (url.pathname === "/proxy") {
    if (url.searchParams.get("token") !== SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return new Response("Invalid URL", { status: 400 });
    }
    return proxyStream(request, url.origin, targetUrl, corsHeaders);
  }

  const segs = url.pathname.split("/").filter(Boolean);
  const p1 = segs.shift();
  const p2 = segs.shift();
  const p3 = segs.shift();

  if (p1 !== "api" || p2 !== "trailers" || !p3) {
    return jsonOut({ error: "Not Found" }, 404, corsHeaders);
  }

  if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
    return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const code = decodeURIComponent(p3).trim().toUpperCase();
  const rawVideoUrl = await fetchFromJavTrailers(code);

  if (!rawVideoUrl) {
    return jsonOut({ error: "Trailer not found", code: code }, 404, corsHeaders);
  }

  const proxiedUrl = url.origin + "/proxy?token=" + SECRET_TOKEN + "&url=" + encodeURIComponent(rawVideoUrl);
  const isHls = rawVideoUrl.indexOf(".m3u8") !== -1;

  return jsonOut({
    code: code,
    trailer: proxiedUrl,
    source: "JavTrailers",
    type: isHls ? "hls" : "video",
    quality: "720p",
    proxy: true,
    qualities: {
      "720p": proxiedUrl,
    },
  }, 200, corsHeaders);
}

async function proxyStream(request, serverOrigin, targetUrl, corsHeaders) {
  const reqHeaders = new Headers();
  reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
  reqHeaders.set("Referer", "https://" + "javtrailers.com" + "/");
  const range = request.headers.get("Range");
  if (range) reqHeaders.set("Range", range);

  const upstream = await fetch(targetUrl, { method: request.method, headers: reqHeaders });
  const outHeaders = new Headers(corsHeaders);
  const cType = upstream.headers.get("Content-Type") || "";
  if (cType) outHeaders.set("Content-Type", cType);

  if (targetUrl.indexOf(".m3u8") !== -1 && upstream.ok) {
    const m3u8Text = await upstream.text();
    const rewritten = m3u8Text.split("\n").map(function (line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const absUrl = new URL(trimmed, targetUrl).href;
      return serverOrigin + "/proxy?token=" + SECRET_TOKEN + "&url=" + encodeURIComponent(absUrl);
    }).join("\n");

    outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  const passHeaders = "Content-Length,Content-Range,Accept-Ranges".split(",");
  passHeaders.forEach(function (h) {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  });

  outHeaders.set("Cache-Control", "public, max-age=86400");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

async function fetchFromJavTrailers(code) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
  };
  const host = "https://" + "javtrailers.com";
  const sRes = await fetch(host + "/search/" + encodeURIComponent(code), { headers: headers });
  if (!sRes.ok) return null;

  const sHtml = await sRes.text();
  const idx = sHtml.indexOf("/video/");
  if (idx === -1) return null;

  let endIdx = idx + 7;
  while (endIdx < sHtml.length) {
    const ch = sHtml.charAt(endIdx);
    if (ch === '"' || ch === "'" || ch === "?" || ch === "#" || ch === " " || ch === ">") break;
    endIdx++;
  }
  const videoPath = sHtml.slice(idx, endIdx);

  const dRes = await fetch(host + videoPath, { headers: headers });
  if (!dRes.ok) return null;

  const dHtml = await dRes.text();
  const bs = String.fromCharCode(92);
  const cleanHtml = dHtml.split(bs + "/").join("/").split("&amp;").join("&");
  return extractMediaUrl(cleanHtml, ".m3u8") || extractMediaUrl(cleanHtml, ".mp4");
}

function extractMediaUrl(html, ext) {
  const extIdx = html.indexOf(ext);
  if (extIdx === -1) return "";
  const startIdx = html.lastIndexOf("http", extIdx);
  if (startIdx === -1) return "";
  const bs = String.fromCharCode(92);
  let endIdx = extIdx + ext.length;
  while (endIdx < html.length) {
    const ch = html.charAt(endIdx);
    if (ch === '"' || ch === "'" || ch === " " || ch === "<" || ch === ">" || ch === bs) break;
    endIdx++;
  }
  const url = html.slice(startIdx, endIdx);
  return url.startsWith("http") ? url : "";
}

function jsonOut(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
