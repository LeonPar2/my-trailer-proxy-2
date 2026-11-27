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
    const names = Array.isArray(body.names) ? body.names.slice(0, 15) : [];
    const profiles = await Promise.all(
      names.map(async (rawName) => {
        const name = String(rawName || "").trim();
        if (!name) return { name: rawName, error: "empty" };
        const profile = await fetchActorProfile(name);
        return profile ? { name, profile } : { name, error: "not_found" };
      })
    );
    return jsonOut({ profiles }, 200, {
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

  // 4. 預告片查詢：/api/trailers/:code
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.at(0) !== "api" || segs.at(1) !== "trailers" || !segs.at(2)) {
    return jsonOut({ error: "Not Found" }, 404, corsHeaders);
  }

  if (request.headers.get("X-Javxy-Token") !== SECRET_TOKEN) {
    return jsonOut({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const code = decodeURIComponent(segs.at(2)).trim().toUpperCase();
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

// 演員資料查詢：JAVDatabase & AVWikiDB WordPress JSON API
async function fetchActorProfile(name) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "ja,zh-TW;q=0.9,en-US;q=0.8",
  };

  const toJpKanji = (s) => {
    const map = {
      "亞": "亜", "澤": "沢", "櫻": "桜", "遙": "遥", "凜": "凛",
      "惠": "恵", "眞": "真", "實": "実", "廣": "広", "瀨": "瀬",
      "邊": "辺", "齋": "斎", "齊": "斉", "筱": "篠", "繪": "絵",
      "戀": "恋", "黑": "黒", "濱": "浜", "淺": "浅"
    };
    return String(s || "").split("").map((ch) => map[ch] || ch).join("");
  };

  const aliasMap = {
    "河北彩花": "河北彩伽",
    "橋本有菜": "新ありな",
    "橋本ありな": "新ありな",
    "深田詠美": "深田えいみ",
    "明日花綺羅": "明日花キララ",
    "桃乃木香奈": "桃乃木かな",
    "相澤南": "相沢みなみ",
    "明里紬": "明里つむぎ",
    "楓可憐": "楓カレン",
    "田中檸檬": "楓カレン",
    "涼森玲夢": "涼森れむ",
    "八掛海": "八掛うみ",
    "七澤米亞": "七沢みあ",
  };

  const jpName = toJpKanji(name);
  const namesToTry = [...new Set([name, jpName, aliasMap[name], aliasMap[jpName]].filter(Boolean))];

  const extractProfileFromText = (rawHtml) => {
    const text = String(rawHtml || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#8211;|&#8212;/g, " ")
      .replace(/\s+/g, " ");

    const profile = { name };

    const bMatch =
      text.match(/(?:DOB|Birthday|生年月日|誕生日)\s*[:：]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/i) ||
      text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (bMatch) {
      profile.birthday = `${bMatch.at(1)}-${bMatch.at(2).padStart(2, "0")}-${bMatch.at(3).padStart(2, "0")}`;
    }

    const hMatch =
      text.match(/(?:Height|身長|T)\s*[:：]?\s*(1[4-8]\d)\s*cm/i) ||
      text.match(/\b(1[4-8]\d)\s*cm\b/i);
    if (hMatch) profile.heightCm = hMatch.at(1);

    const wMatch = text.match(/(?:Weight|体重|W)\s*[:：]?\s*(\d{2,3})\s*kg/i);
    if (wMatch) profile.weightKg = wMatch.at(1);

    const bwhMatch =
      text.match(/(?:Measurements|スリーサイズ)\s*[:：]?\s*(\d{2,3})\s*[-/／]\s*(\d{2,3})\s*[-/／]\s*(\d{2,3})/i) ||
      text.match(/B\s*(\d{2,3})\s*(?:[（(]([A-Z])[）)])?\s*[-/／・\s]+W\s*(\d{2,3})\s*[-/／・\s]+H\s*(\d{2,3})/i);
    if (bwhMatch) {
      if (bwhMatch.length >= 5 && bwhMatch.at(2) && /^[A-Z]$/i.test(bwhMatch.at(2))) {
        profile.bustCm = bwhMatch.at(1);
        profile.cup = bwhMatch.at(2).toUpperCase();
        profile.waistCm = bwhMatch.at(3);
        profile.hipCm = bwhMatch.at(4);
      } else {
        profile.bustCm = bwhMatch.at(1);
        profile.waistCm = bwhMatch.at(2);
        profile.hipCm = bwhMatch.at(3);
      }
    }

    if (!profile.cup) {
      const cMatch =
        text.match(/Cup\s*[:：]?\s*([A-Z])\b/i) ||
        text.match(/[（(]([A-Z])\s*カップ[）)]|([A-Z])\s*カップ/i);
      if (cMatch) profile.cup = (cMatch.at(1) || cMatch.at(2) || "").toUpperCase();
    }

    const bloodMatch = text.match(/(?:Blood\s*Type|血液型)\s*[:：]?\s*(AB|A|B|O)\s*型?/i);
    if (bloodMatch) profile.bloodType = bloodMatch.at(1).toUpperCase();

    return profile.birthday || profile.heightCm || profile.bustCm ? profile : null;
  };
    for (const kw of namesToTry) {
    // 來源 1：JAVDatabase WordPress JSON API
    try {
      const res = await fetch(
        `https://javdatabase.com{encodeURIComponent(kw)}&per_page=5`,
        { headers }
      );
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          for (const item of list) {
            const hit = extractProfileFromText(JSON.stringify(item));
            if (hit) return hit;
            if (item?.link) {
              const dRes = await fetch(item.link, { headers });
              if (dRes.ok) {
                const dHit = extractProfileFromText(await dRes.text());
                if (dHit) return dHit;
              }
            }
          }
        }
      }
    } catch {}

    // 來源 2：AVWikiDB WordPress JSON API
    try {
      const res = await fetch(
        `https://avwikidb.com{encodeURIComponent(kw)}&per_page=5`,
        { headers }
      );
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length > 0) {
          for (const item of list) {
            const htmlContent = item?.content?.rendered || JSON.stringify(item);
            const hit = extractProfileFromText(htmlContent);
            if (hit) return hit;
          }
        }
      }
    } catch {}
  }

  return null;
}

// 串流反向代理
async function proxyStream(request, serverOrigin, targetUrl, corsHeaders) {
  const reqHeaders = new Headers();
  reqHeaders.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  reqHeaders.set("Referer", "https://javtrailers.com");
  const range = request.headers.get("Range");
  if (range) reqHeaders.set("Range", range);

  const upstream = await fetch(targetUrl, { method: request.method, headers: reqHeaders });
  const outHeaders = new Headers(corsHeaders);
  const cType = upstream.headers.get("Content-Type") || "";
  if (cType) outHeaders.set("Content-Type", cType);

  if (targetUrl.includes(".m3u8") && upstream.ok) {
    const m3u8Text = await upstream.text();
    const rewritten = m3u8Text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const absUrl = new URL(trimmed, targetUrl).href;
        return `${serverOrigin}/proxy?token=${SECRET_TOKEN}&url=${encodeURIComponent(absUrl)}`;
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

// 抓取 JavTrailers 預告片
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

