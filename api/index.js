export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

const SECRET_TOKEN = "MY_TOKEN_123";
const UPSTREAM_SCRIPT_URL = "https://greasyfork.org";

// 記憶體快取：自動從腳本 4 同步最新網域與 Token（每 1 小時更新一次）
let cachedUpstream = { host: "", token: "", ts: 0 };

async function getDynamicUpstreamConfig() {
  const now = Date.now();
  if (cachedUpstream.host && cachedUpstream.token && now - cachedUpstream.ts < 3600000) {
    return cachedUpstream;
  }

  try {
    const res = await fetch(UPSTREAM_SCRIPT_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (res.ok) {
      const code = await res.text();
      // 提取腳本 4 裡的 host 陣列與 token 陣列（XOR 37 編碼）
      const hostMatch = code.match(/host:String\.fromCharCode\.apply\(null,\[([\d,\s]+)\]\)/);
      const tokenMatch = code.match(/token\(\)\{return\[([\d,\s]+)\]\.map/);

      if (hostMatch && tokenMatch) {
        const decodeXor37 = (csv) =>
          csv
            .split(",")
            .map((n) => String.fromCharCode(Number(n.trim()) ^ 37))
            .join("");

        const host = hostMatch.at(1)
          .split(",")
          .map((n) => String.fromCharCode(Number(n.trim())))
          .join("");
        const token = decodeXor37(tokenMatch.at(1));

        if (host && token) {
          cachedUpstream = { host, token, ts: now };
          return cachedUpstream;
        }
      }
    }
  } catch (e) {}

  // 若 GreasyFork 暫時無法連線，回退至目前已知有效設定
  return {
    host: cachedUpstream.host || "javxy.cc.cd",
    token: cachedUpstream.token || "AmdNGl8XOlAFBB6B7cL36aT3U+560/12F4j83eZ",
    ts: now,
  };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Javxy-Token, X-Javxy-Principal, Range",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. 演員三圍資料介面（自動同步腳本 4 最新 API 轉發）
  if (url.pathname === "/api/actors") {
    if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
      return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
    }

    const bodyText = await request.text();
    const upstream = await getDynamicUpstreamConfig();
    const principal = request.headers.get("X-Javxy-Principal") || `anon_${Date.now().toString(36)}`;

    try {
      const upRes = await fetch(`https://${upstream.host}/api/actors?client=laosiji-new`, {
        method: "POST",
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/json",
          "X-Javxy-Token": upstream.token,
          "X-Javxy-Principal": principal,
        },
        body: bodyText,
      });

      if (upRes.ok) {
        const data = await upRes.text();
        return new Response(data, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
            ...corsHeaders,
          },
        });
      }
    } catch (e) {}

    return jsonOut({ profiles: [] }, 200, corsHeaders);
  }

  // 2. 中轉狀態檢查
  if (url.pathname === "/api/trailers/proxy/status") {
    return jsonOut({ enabled: true }, 200, corsHeaders);
  }

  // 3. 串流反向代理（支援動態 Referer 與 HLS 加密金鑰轉發）
  if (url.pathname === "/proxy") {
    const qToken = url.searchParams.get("token");
    const hToken = request.headers.get("X-Javxy-Token");
    if (qToken !== SECRET_TOKEN && hToken !== SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return new Response("Invalid URL", { status: 400 });
    }
    return proxyStream(request, url.origin, targetUrl, corsHeaders);
  }

  // 4. 預告片查詢（優先轉發腳本 4 最新聚合源，失敗時自動回退 JavTrailers）
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.at(0) !== "api" || segs.at(1) !== "trailers" || !segs.at(2)) {
    return jsonOut({ error: "Not Found" }, 404, corsHeaders);
  }

  if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
    return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const code = decodeURIComponent(segs.at(2)).trim().toUpperCase();
  const upstream = await getDynamicUpstreamConfig();
  const principal = request.headers.get("X-Javxy-Principal") || `anon_${Date.now().toString(36)}`;

  try {
    const upUrl = new URL(`https://${upstream.host}/api/trailers/${encodeURIComponent(code)}`);
    url.searchParams.forEach((v, k) => upUrl.searchParams.set(k, v));
    upUrl.searchParams.set("client", "laosiji-new");

    const upRes = await fetch(upUrl.href, {
      headers: {
        "Accept": "application/json,text/plain,*/*",
        "X-Javxy-Token": upstream.token,
        "X-Javxy-Principal": principal,
      },
    });

    if (upRes.ok) {
      const data = await upRes.text();
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      });
    }
  } catch (e) {}

  // 備援：若上游無結果，改用本地 JavTrailers 抓取
  const rawVideoUrl = await fetchFromJavTrailers(code);
  if (!rawVideoUrl) {
    return jsonOut({ error: "Trailer not found", code }, 404, corsHeaders);
  }

  const proxiedUrl = `${url.origin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(rawVideoUrl)}`;
  const isHls = rawVideoUrl.includes(".m3u8");

  return jsonOut(
    {
      code,
      trailer: proxiedUrl,
      source: "JavTrailers",
      type: isHls ? "hls" : "video",
      quality: "720p",
      proxy: true,
      qualities: { "720p": proxiedUrl },
    },
    200,
    corsHeaders
  );
}

// 串流反向代理
async function proxyStream(request, serverOrigin, targetUrl, corsHeaders) {
  const targetObj = new URL(targetUrl);
  const reqHeaders = new Headers();
  reqHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  if (targetObj.hostname.includes("dmm.co.jp")) {
    reqHeaders.set("Referer", "https://dmm.co.jp");
  } else {
    reqHeaders.set("Referer", `${targetObj.origin}/`);
  }

  const range = request.headers.get("Range");
  if (range) reqHeaders.set("Range", range);

  const upstream = await fetch(targetUrl, { method: request.method, headers: reqHeaders });
  const outHeaders = new Headers(corsHeaders);
  const cType = upstream.headers.get("Content-Type") || "";
  if (cType) outHeaders.set("Content-Type", cType);

  if (targetUrl.includes(".m3u8") && upstream.ok) {
    const m3u8Text = await upstream.text();
    const toProxy = (rawPath) => {
      const absUrl = new URL(rawPath, targetUrl).href;
      return `${serverOrigin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(absUrl)}`;
    };

    const rewritten = m3u8Text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/gi, (_, uri) => `URI="${toProxy(uri)}"`);
        }
        return toProxy(trimmed);
      })
      .join("\n");

    outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  ["Content-Length", "Content-Range", "Accept-Ranges"].forEach((h) => {
    const val = upstream.headers.get(h);
    if (val) outHeaders.set(h, val);
  });

  outHeaders.set("Cache-Control", "public, max-age=86400");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// 備援抓取 JavTrailers 預告片
async function fetchFromJavTrailers(code) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
  };
  const host = "https://javtrailers.com";
  const sRes = await fetch(`${host}/search/${encodeURIComponent(code)}`, { headers });
  if (!sRes.ok) return null;

  const sHtml = await sRes.text();
  const idx = sHtml.indexOf("/video/");
  if (idx === -1) return null;

  let endIdx = idx + 7;
  while (endIdx < sHtml.length && !"\"'?# >".includes(sHtml[endIdx])) {
    endIdx++;
  }
  const videoPath = sHtml.slice(idx, endIdx);

  const dRes = await fetch(host + videoPath, { headers });
  if (!dRes.ok) return null;

  const dHtml = await dRes.text();
  const cleanHtml = dHtml.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  return extractMediaUrl(cleanHtml, ".m3u8") || extractMediaUrl(cleanHtml, ".mp4");
}

function extractMediaUrl(html, ext) {
  const extIdx = html.indexOf(ext);
  if (extIdx === -1) return "";
  const startIdx = html.lastIndexOf("http", extIdx);
  if (startIdx === -1) return "";

  let endIdx = extIdx + ext.length;
  while (endIdx < html.length && !"\"' <>\\".includes(html[endIdx])) {
    endIdx++;
  }
  const url = html.slice(startIdx, endIdx);
  return url.startsWith("http") ? url : "";
}

function jsonOut(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
