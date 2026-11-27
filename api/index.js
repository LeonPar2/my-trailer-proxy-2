export const config = {
  runtime: "edge",
  regions: ["hnd1"],
};

const SECRET_TOKEN = "MY_TOKEN_123";

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

  // 1. 演員三圍資料介面：POST /api/actors
  if (url.pathname === "/api/actors") {
    if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
      return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const names = Array.isArray(body.names) ? body.names.slice(0, 10) : [];
    const profiles = await Promise.all(names.map(async function (rawName) {
      const name = String(rawName || "").trim();
      if (!name) return { name: rawName, error: "empty" };
      const profile = await fetchActorFromSeesaa(name);
      return profile ? { name: name, profile: profile } : { name: name, error: "not_found" };
    }));
    return jsonOut({ profiles: profiles }, 200, {
      ...corsHeaders,
      "Cache-Control": "public, max-age=86400",
    });
  }

  // 2. 中轉狀態檢查
  if (url.pathname === "/api/trailers/proxy/status") {
    return jsonOut({ enabled: true }, 200, corsHeaders);
  }

  // 3. 串流反向代理：/proxy?token=MY_TOKEN_123&url=...
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

  // 4. 預告片查詢：/api/trailers/番号
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

// 從 SeesaaWiki 抓取演員生日、身高、三圍與罩杯
async function fetchActorFromSeesaa(name) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
  };
  const wikiHost = "https://" + "seesaawiki.jp";
  try {
    const sRes = await fetch(wikiHost + "/w/sougouwiki/search?keywords=" + encodeURIComponent(name), { headers: headers });
    if (!sRes.ok) return null;
    const sHtml = await sRes.text();

    const idx = sHtml.indexOf("/w/sougouwiki/d/");
    if (idx === -1) return null;

    let endIdx = idx + 16;
    while (endIdx < sHtml.length) {
      const ch = sHtml.charAt(endIdx);
      if (ch === '"' || ch === "'" || ch === "?" || ch === "#" || ch === " " || ch === ">") break;
      endIdx++;
    }
    const detailPath = sHtml.slice(idx, endIdx);
    const dRes = await fetch(wikiHost + detailPath, { headers: headers });
    if (!dRes.ok) return null;

    const dHtml = await dRes.text();
    const text = dHtml.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const profile = { name: name };

    const bMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (bMatch) {
      profile.birthday = bMatch.at(1) + "-" + bMatch.at(2).padStart(2, "0") + "-" + bMatch.at(3).padStart(2, "0");
    }

    const hMatch = text.match(/(\d{3})\s*cm/i);
    if (hMatch) profile.heightCm = hMatch.at(1);

    const wMatch = text.match(/(\d{2,3})\s*kg/i);
    if (wMatch) profile.weightKg = wMatch.at(1);

    const bwhMatch = text.match(/B(\d{2,3})\s*(?:[（(]([A-Z])[）)])?\s*[-/／]\s*W(\d{2,3})\s*[-/／]\s*H(\d{2,3})/i);
    if (bwhMatch) {
      profile.bustCm = bwhMatch.at(1);
      if (bwhMatch.at(2)) profile.cup = bwhMatch.at(2).toUpperCase();
      profile.waistCm = bwhMatch.at(3);
      profile.hipCm = bwhMatch.at(4);
    }

    if (!profile.cup) {
      const cMatch = text.match(/[（(]([A-Z])カップ[）)]|([A-Z])カップ/i);
      if (cMatch) profile.cup = (cMatch.at(1) || cMatch.at(2) || "").toUpperCase();
    }

    const bloodMatch = text.match(/血液型\s*[:：]?\s*(AB|A|B|O)型?/i);
    if (bloodMatch) profile.bloodType = bloodMatch.at(1).toUpperCase();

    return (profile.birthday || profile.heightCm || profile.bustCm) ? profile : null;
  } catch (e) {
    return null;
  }
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
