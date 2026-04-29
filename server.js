const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 65536 });

app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);
app.use(express.json({ limit: "16kb" }));
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(express.static(path.join(__dirname, "public")));

const boards = new Map();
const BOARD_TTL = 24 * 60 * 60 * 1000;
const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_WEATHER_POINT = {
  latitude: 35.3394,
  longitude: -97.35,
};
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_PERIOD_COUNT = 4;
const OBSERVATION_STATION_COUNT = 5;
const weatherCache = new Map();
const weatherPointCache = new Map();

function genBoardId() {
  let id;
  do {
    id = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
  } while (boards.has(id));
  return id;
}

function genSecret() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

async function fetchWeatherGovJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/json",
      "User-Agent": "splitflap.org weather proxy",
    },
  });
  if (!res.ok) {
    throw new Error(`Weather API ${res.status}`);
  }
  return res.json();
}

function normalizeWeatherPoint(rawLatitude, rawLongitude) {
  const latitude =
    rawLatitude === undefined ? DEFAULT_WEATHER_POINT.latitude : Number(rawLatitude);
  const longitude =
    rawLongitude === undefined ? DEFAULT_WEATHER_POINT.longitude : Number(rawLongitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
  };
}

function weatherPointKey(point) {
  return `${point.latitude},${point.longitude}`;
}

function normalizeWeatherStation(rawStation) {
  if (typeof rawStation !== "string") return "";
  return rawStation.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function weatherDataKey(point, stationId) {
  return `${weatherPointKey(point)}:${stationId || ""}`;
}

function distanceMilesBetween(a, b) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getStationDistanceMiles(point, feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const longitude = Number(coords[0]);
  const latitude = Number(coords[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return Number(
    distanceMilesBetween(point, { latitude, longitude }).toFixed(1),
  );
}

function clearWeatherPointCaches(point) {
  const key = weatherPointKey(point);
  for (const cacheKey of weatherCache.keys()) {
    if (cacheKey === key || cacheKey.startsWith(`${key}:`)) weatherCache.delete(cacheKey);
  }
  weatherPointCache.delete(key);
}

function convertTemperature(value, unitCode) {
  if (typeof value !== "number") return null;
  if (String(unitCode).toLowerCase().includes("degc")) {
    return Math.round((value * 9) / 5 + 32);
  }
  return Math.round(value);
}

function convertWindSpeed(value, unitCode) {
  if (typeof value !== "number") return null;
  const unit = String(unitCode).toLowerCase();
  if (unit.includes("m_s-1")) return Math.round(value * 2.23694);
  if (unit.includes("km_h-1")) return Math.round(value * 0.621371);
  return Math.round(value);
}

function convertPressure(value, unitCode) {
  if (typeof value !== "number") return null;
  if (String(unitCode).toLowerCase().includes("pa")) {
    return Number((value / 3386.389).toFixed(2));
  }
  return Number(value.toFixed(2));
}

function buildCurrentObservation(observation, station) {
  const props = observation?.properties || {};
  const temperature = props.temperature || {};
  const windSpeed = props.windSpeed || {};
  const windGust = props.windGust || {};
  const pressure = props.barometricPressure || {};
  const humidity = props.relativeHumidity || {};
  return {
    station: station.id,
    stationName: station.name || station.id,
    stationDistanceMiles: station.distanceMiles,
    text: props.textDescription || "",
    temperature: convertTemperature(temperature.value, temperature.unitCode),
    temperatureUnit: "F",
    windDirection: typeof props.windDirection?.value === "number"
      ? Math.round(props.windDirection.value)
      : null,
    windSpeed: convertWindSpeed(windSpeed.value, windSpeed.unitCode),
    windGust: convertWindSpeed(windGust.value, windGust.unitCode),
    pressure: convertPressure(pressure.value, pressure.unitCode),
    humidity: typeof humidity.value === "number" ? Math.round(humidity.value) : null,
    timestamp: props.timestamp || null,
  };
}

async function getWeatherPointData(weatherPoint) {
  const key = weatherPointKey(weatherPoint);
  if (weatherPointCache.has(key)) return weatherPointCache.get(key);

  const { latitude, longitude } = weatherPoint;
  const pointResponse = await fetchWeatherGovJson(
    `https://api.weather.gov/points/${latitude},${longitude}`,
  );
  const forecastBaseUrl = pointResponse?.properties?.forecast;
  if (!forecastBaseUrl) throw new Error("Forecast URL missing");

  const stationsUrl = pointResponse?.properties?.observationStations;
  if (!stationsUrl) throw new Error("Observation stations URL missing");

  const stationsResponse = await fetchWeatherGovJson(stationsUrl);
  // get the first 5 stations with valid IDs
  const observationStations = (stationsResponse?.features || [])
    .map((feature) => ({
      id: normalizeWeatherStation(feature.properties?.stationIdentifier),
      name: feature.properties?.name || "",
      distanceMiles: getStationDistanceMiles(weatherPoint, feature),
    }))
    .filter((station) => station.id)
    .slice(0, OBSERVATION_STATION_COUNT);

  const pointData = {
    latitude,
    longitude,
    gridId: pointResponse?.properties?.gridId || "",
    gridX: pointResponse?.properties?.gridX ?? null,
    gridY: pointResponse?.properties?.gridY ?? null,
    forecastUrl: `${forecastBaseUrl}?units=us`,
    observationStations,
  };
  weatherPointCache.set(key, pointData);
  return pointData;
}

async function getCurrentWeather(station) {
  if (!station?.id) return null;
  const observation = await fetchWeatherGovJson(
    `https://api.weather.gov/stations/${encodeURIComponent(station.id)}/observations/latest`,
  );
  return buildCurrentObservation(observation, station);
}

async function getWeatherData(point, requestedStationId) {
  const now = Date.now();
  const stationId = normalizeWeatherStation(requestedStationId);
  const key = weatherDataKey(point, stationId);
  const cached = weatherCache.get(key);
  if (cached?.data && cached.expiresAt > now) return cached.data;

  const pointData = await getWeatherPointData(point);
  const { latitude, longitude } = pointData;
  const selectedStation = pointData.observationStations.find(
    (station) => station.id === stationId,
  );

  const alertsResult = await fetchWeatherGovJson(`https://api.weather.gov/alerts/active?status=actual,exercise,system,test,draft&message_type=cancel&point=${latitude}%2C${longitude}`);
  const alerts = (alertsResult?.features || []).map((feature) => ({
    id: feature.id || "",
    area: feature.properties?.areaDesc || "",
    title: feature.properties?.headline || "",
    severity: feature.properties?.severity || "",
    certainty: feature.properties?.certainty || "",
    urgency: feature.properties?.urgency || "",
    event: feature.properties?.event || "",
    effective: feature.properties?.effective || null,
    expires: feature.properties?.expires || null,
  }));

  const forecast = await fetchWeatherGovJson(pointData.forecastUrl);

  const periods = (forecast?.properties?.periods || [])
    .slice(0, WEATHER_PERIOD_COUNT)
    .map((period) => ({
      name: period.name || "Now",
      isDaytime: !!period.isDaytime,
      temperature: period.temperature ?? null,
      temperatureUnit: period.temperatureUnit || "F",
      shortForecast: period.shortForecast || "",
      windSpeed: period.windSpeed || "",
      windDirection: period.windDirection || "",
      probabilityOfPrecipitation:
        period?.probabilityOfPrecipitation?.value ?? null,
      startTime: period.startTime || null,
      endTime: period.endTime || null,
    }));
  if (!periods.length) throw new Error("Forecast period missing");

  const data = {
    fetchedAt: new Date().toISOString(),
    location: {
      latitude,
      longitude,
      gridId: pointData.gridId,
      gridX: pointData.gridX,
      gridY: pointData.gridY,
    },
    observationStations: pointData.observationStations,
    weatherStation: selectedStation?.id || "",
    updatedAt:
      forecast?.properties?.updateTime || forecast?.properties?.generatedAt || null,
    alerts,
    current: selectedStation ? await getCurrentWeather(selectedStation) : null,
    periods,
  };

  weatherCache.set(key, {
    data,
    expiresAt: now + WEATHER_CACHE_MS,
  });
  return data;
}

setInterval(
  () => {
    const now = Date.now();
    for (const [id, b] of boards) {
      if (now - b.lastActive > BOARD_TTL) {
        try {
          if (b.boardWs) b.boardWs.close();
        } catch (_) {}
        try {
          if (b.companionWs) b.companionWs.close();
        } catch (_) {}
        boards.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

app.get("/api/health", (_, res) => res.json({ ok: true, boards: boards.size }));

app.get("/api/weather", async (req, res) => {
  try {
    const point = normalizeWeatherPoint(req.query.lat, req.query.lon);
    if (!point) {
      res.status(400).json({ ok: false, error: "Invalid weather coordinates" });
      return;
    }
    if (req.query.refresh === "1") clearWeatherPointCaches(point);
    const data = await getWeatherData(point, req.query.station);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "Weather unavailable",
    });
  }
});

app.get("/api/weather/point", async (req, res) => {
  try {
    const point = normalizeWeatherPoint(req.query.lat, req.query.lon);
    if (!point) {
      res.status(400).json({ ok: false, error: "Invalid weather coordinates" });
      return;
    }
    if (req.query.refresh === "1") clearWeatherPointCaches(point);
    const pointData = await getWeatherPointData(point);
    res.json({
      ok: true,
      location: {
        latitude: pointData.latitude,
        longitude: pointData.longitude,
        gridId: pointData.gridId,
        gridX: pointData.gridX,
        gridY: pointData.gridY,
      },
      observationStations: pointData.observationStations,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "Weather point unavailable",
    });
  }
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();
  ws.role = null;
  ws.boardId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    const now = Date.now();
    if (now - ws.msgWindow > 60000) {
      ws.msgCount = 0;
      ws.msgWindow = now;
    }
    if (++ws.msgCount > 120) {
      safeSend(ws, { type: "error", message: "Rate limited" });
      return;
    }
    let msg;
    try {
      const str = raw.toString();
      if (str.length > 65536) return;
      msg = JSON.parse(str);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== "string" || msg.type.length > 64) return;
    handleMsg(ws, msg);
  });

  ws.on("close", () => {
    if (!ws.boardId) return;
    const b = boards.get(ws.boardId);
    if (!b) return;

    if (b.boardWs === ws) {
      b.boardWs = null;
      safeSend(b.companionWs, { type: "board_disconnected" });
    }
    if (b.companionWs === ws) {
      b.companionWs = null;
      safeSend(b.boardWs, { type: "companion_disconnected" });
    }
    // Clear pending if the pending companion disconnected
    if (b.pendingWs === ws) {
      b.pendingWs = null;
    }
  });
  ws.on("error", () => {});
});

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1)
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
}

function handleMsg(ws, msg) {
  switch (msg.type) {
    // ── Board registers ──
    case "register_board": {
      const boardId = genBoardId();
      const secret = genSecret();
      boards.set(boardId, {
        boardWs: ws,
        companionWs: null,
        pendingWs: null,
        secret,
        settings: null,
        messages: null,
        mode: "messages",
        weatherPoint: DEFAULT_WEATHER_POINT,
        weatherStation: "",
        locked: false, // true when companion is connected
        createdAt: Date.now(),
        lastActive: Date.now(),
      });
      ws.boardId = boardId;
      ws.role = "board";
      safeSend(ws, { type: "registered", boardId, secret });
      console.log(`Board created: ${boardId}`);
      break;
    }

    // ── Companion requests pairing ──
    case "pair": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";
      const secret =
        typeof msg.secret === "string"
          ? msg.secret
              .replace(/[^a-f0-9]/gi, "")
              .slice(0, 32)
              .toLowerCase()
          : "";
      if (id.length !== 6) {
        safeSend(ws, { type: "error", message: "Invalid code" });
        return;
      }

      const b = boards.get(id);
      if (!b) {
        safeSend(ws, { type: "error", message: "Board not found" });
        return;
      }
      if (!b.boardWs || b.boardWs.readyState !== 1) {
        safeSend(ws, { type: "error", message: "Board is offline" });
        return;
      }

      // If board is locked (already has a companion), reject
      if (b.locked && b.companionWs && b.companionWs.readyState === 1) {
        safeSend(ws, {
          type: "error",
          message: "Board is locked. Disconnect current companion first.",
        });
        return;
      }

      // Check if secret matches (QR code path) → auto-approve
      if (secret.length === 32 && secret === b.secret) {
        completePairing(b, ws, id);
        return;
      }

      // Manual code path → require board-side approval
      // Store as pending, ask board to approve
      if (b.pendingWs) {
        safeSend(b.pendingWs, {
          type: "error",
          message: "Another device is waiting for approval",
        });
      }
      b.pendingWs = ws;
      ws.boardId = id; // tentative
      safeSend(ws, {
        type: "waiting_approval",
        message: "Waiting for TV to approve...",
      });
      safeSend(b.boardWs, { type: "pair_request" });
      console.log(`Pair request pending: ${id}`);
      break;
    }

    // ── Board approves pending companion ──
    case "approve_pair": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b || !b.pendingWs) return;
      completePairing(b, b.pendingWs, ws.boardId);
      b.pendingWs = null;
      break;
    }

    // ── Board rejects pending companion ──
    case "reject_pair": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b || !b.pendingWs) return;
      safeSend(b.pendingWs, {
        type: "error",
        message: "Connection rejected by TV",
      });
      b.pendingWs.boardId = null;
      b.pendingWs = null;
      safeSend(ws, { type: "pair_rejected" });
      console.log(`Pair rejected: ${ws.boardId}`);
      break;
    }

    // ── Companion disconnects cleanly ──
    case "companion_disconnect": {
      if (ws.role !== "companion" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.companionWs = null;
      b.locked = false;
      // Generate new code+secret for next pairing
      boards.delete(ws.boardId);
      const newId = genBoardId();
      const newSecret = genSecret();
      boards.set(newId, {
        ...b,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });
      if (b.boardWs) {
        b.boardWs.boardId = newId;
      }
      safeSend(b.boardWs, {
        type: "companion_disconnected_new_code",
        boardId: newId,
        secret: newSecret,
      });
      ws.boardId = null;
      ws.role = null;
      safeSend(ws, { type: "disconnected" });
      break;
    }

    // ── Board kicks companion ──
    case "kick_companion": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      if (b.companionWs) {
        safeSend(b.companionWs, { type: "kicked" });
        b.companionWs.boardId = null;
        b.companionWs.role = null;
        b.companionWs = null;
      }
      b.locked = false;
      // New code+secret
      boards.delete(ws.boardId);
      const newId = genBoardId();
      const newSecret = genSecret();
      boards.set(newId, {
        ...b,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });
      ws.boardId = newId;
      safeSend(ws, { type: "new_code", boardId: newId, secret: newSecret });
      console.log(`Board kicked, new code: ${newId}`);
      break;
    }

    // ── Board reconnects ──
    case "reconnect_board": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";
      const b = boards.get(id);
      if (!b) {
        safeSend(ws, { type: "error", message: "Board expired" });
        return;
      }
      b.boardWs = ws;
      b.lastActive = Date.now();
      ws.boardId = id;
      ws.role = "board";
      safeSend(ws, {
        type: "reconnected",
        boardId: id,
        secret: b.secret,
        settings: b.settings,
        messages: b.messages,
        mode: b.mode,
        weatherPoint: b.weatherPoint,
        weatherStation: b.weatherStation,
        locked: b.locked,
      });
      safeSend(b.companionWs, { type: "board_reconnected" });
      console.log(`Board reconnected: ${id}`);
      break;
    }

    // ── Forward companion → board commands ──
    case "update_settings":
    case "update_messages":
    case "play_sequence":
    case "next_message":
    case "reset_board":
    case "flip_message":
    case "set_mode": {
      if (ws.role !== "companion" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.lastActive = Date.now();
      if (
        msg.type === "update_settings" &&
        msg.settings &&
        typeof msg.settings === "object"
      )
        b.settings = msg.settings;
      if (msg.type === "update_messages" && typeof msg.messages === "string")
        b.messages = msg.messages.slice(0, 10000);
      if (msg.type === "set_mode" && typeof msg.mode === "string") {
        b.mode = msg.mode;
        if (msg.weatherPoint && typeof msg.weatherPoint === "object") {
          const point = normalizeWeatherPoint(
            msg.weatherPoint.latitude,
            msg.weatherPoint.longitude,
          );
          if (point) {
            b.weatherPoint = point;
            msg.weatherPoint = point;
          } else {
            delete msg.weatherPoint;
          }
        }
        if (typeof msg.weatherStation === "string") {
          b.weatherStation = normalizeWeatherStation(msg.weatherStation);
          msg.weatherStation = b.weatherStation;
        }
      }
      safeSend(b.boardWs, msg);
      break;
    }

    case "board_state": {
      if (ws.role !== "board" || !ws.boardId) return;
      const b = boards.get(ws.boardId);
      if (!b) return;
      b.lastActive = Date.now();
      safeSend(b.companionWs, msg);
      break;
    }
  }
}

function completePairing(b, companionWs, boardId) {
  // Replace existing companion if any
  if (b.companionWs && b.companionWs !== companionWs) {
    safeSend(b.companionWs, { type: "replaced" });
    b.companionWs.boardId = null;
    b.companionWs.role = null;
  }
  b.companionWs = companionWs;
  b.locked = true;
  b.lastActive = Date.now();
  b.pendingWs = null;
  companionWs.boardId = boardId;
  companionWs.role = "companion";
  safeSend(companionWs, {
    type: "paired",
    boardId,
    settings: b.settings,
    messages: b.messages,
    mode: b.mode,
    weatherPoint: b.weatherPoint,
    weatherStation: b.weatherStation,
  });
  safeSend(b.boardWs, { type: "companion_joined" });
  console.log(`Paired: ${boardId} (locked)`);
}

const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(hb));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  splitflap.org server on http://localhost:${PORT}\n`);
  console.log(`  Board:     http://localhost:${PORT}/board.html`);
  console.log(`  Companion: http://localhost:${PORT}/companion.html\n`);
});
