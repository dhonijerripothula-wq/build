import express, { Router, type IRouter } from "express";
import { count, countDistinct, desc, eq, ilike, inArray } from "drizzle-orm";
import {
  db,
  routeSearchesTable,
  transitFeedStateTable,
  transitLinesTable,
  transitStopTimesTable,
  transitStopsTable,
  transitTripsTable,
} from "@workspace/db";
import {
  GetGtfsStatusResponse,
  GetRouteHistoryResponse,
  GetRouteParams,
  GetTransitLinesResponse,
  GetTransitStopsQueryParams,
  GetTransitStopsResponse,
  ImportGtfsBody,
  ImportGtfsResponse,
  SearchLocationsQueryParams,
  SearchLocationsResponse,
  SearchRoutesBody,
  SearchRoutesResponse,
} from "@workspace/api-zod";
import { timingSafeEqual } from "node:crypto";
import {
  getRouteSearch,
  saveRouteSearch,
  searchRouteOptions,
  suggestLocations,
} from "../services/journey-planner";
import { GtfsImportError, getMultipartGtfsFile, importGtfsZip } from "../services/gtfs-importer";
import { getVisitorId } from "../services/visitor-session";

const router: IRouter = Router();
const searchRate = new Map<string, { count: number; resetAt: number }>();
const SEARCH_LIMIT = 30;
const SEARCH_WINDOW_MS = 60_000;

function checkAdminPassword(supplied: string | undefined): boolean {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured || !supplied) return false;
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validateSearchRate(visitorId: string): boolean {
  const now = Date.now();
  const prior = searchRate.get(visitorId);
  if (!prior || prior.resetAt <= now) {
    searchRate.set(visitorId, { count: 1, resetAt: now + SEARCH_WINDOW_MS });
    return true;
  }
  prior.count += 1;
  return prior.count <= SEARCH_LIMIT;
}

router.post("/routes/search", async (req, res): Promise<void> => {
  const parsed = SearchRoutesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Add an origin, destination, and valid route preference." });
    return;
  }
  const visitorId = getVisitorId(req, res);
  if (!validateSearchRate(visitorId)) {
    res.status(429).json({ error: "Too many route searches. Please wait a minute and try again." });
    return;
  }
  const departureAt = parsed.data.departureTime ? new Date(parsed.data.departureTime) : new Date();
  if (!Number.isFinite(departureAt.getTime())) {
    res.status(400).json({ error: "Departure time is invalid." });
    return;
  }

  try {
    const result = await searchRouteOptions({
      ...parsed.data,
      departureTime: departureAt.toISOString(),
      preferences: { priority: parsed.data.preferences.priority as "balanced" | "fastest" | "fewest_transfers" | "least_walking" },
    });
    const response = SearchRoutesResponse.parse({
      requestId: result.id,
      origin: result.origin,
      destination: result.destination,
      provider: result.provider,
      recommendedRouteId: result.recommendedRouteId,
      routes: result.routes,
    });
    await saveRouteSearch(
      result,
      visitorId,
      parsed.data.origin,
      parsed.data.destination,
      departureAt,
      parsed.data.preferences.priority as "balanced" | "fastest" | "fewest_transfers" | "least_walking",
    );
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Route search failed.";
    if (message.startsWith("Location not found") || message.startsWith("No public transport route")) {
      res.status(404).json({ error: message });
      return;
    }
    if (message.startsWith("Choose two different locations") || message.startsWith("Departure time")) {
      res.status(400).json({ error: message });
      return;
    }
    req.log.error({ err: error }, "Route search failed");
    res.status(500).json({ error: "Route search is temporarily unavailable. Please try again." });
  }
});

router.get("/routes/history", async (req, res): Promise<void> => {
  const visitorId = getVisitorId(req, res);
  try {
    const searches = await db.select().from(routeSearchesTable)
      .where(eq(routeSearchesTable.visitorId, visitorId))
      .orderBy(desc(routeSearchesTable.createdAt))
      .limit(8);
    res.json(GetRouteHistoryResponse.parse(searches.map((search) => ({
      id: search.id,
      origin: search.originName,
      destination: search.destinationName,
      departureTime: search.departureAt.toISOString(),
      createdAt: search.createdAt,
    }))));
  } catch (error) {
    req.log.error({ err: error }, "Could not load recent searches");
    res.status(500).json({ error: "Recent searches are temporarily unavailable." });
  }
});

router.get("/routes/:id", async (req, res): Promise<void> => {
  const params = GetRouteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Search identifier is invalid." });
    return;
  }
  const visitorId = getVisitorId(req, res);
  try {
    const search = await getRouteSearch(params.data.id, visitorId);
    if (!search) {
      res.status(404).json({ error: "This saved route search could not be found." });
      return;
    }
    res.json(search);
  } catch (error) {
    req.log.error({ err: error }, "Could not load saved route search");
    res.status(500).json({ error: "This route search is temporarily unavailable." });
  }
});

router.get("/geocode", async (req, res): Promise<void> => {
  const parsed = SearchLocationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter at least two letters to search for a stop." });
    return;
  }
  try {
    const locations = await suggestLocations(parsed.data.q);
    res.json(SearchLocationsResponse.parse(locations));
  } catch (error) {
    req.log.error({ err: error }, "Location suggestions failed");
    res.status(500).json({ error: "Location search is temporarily unavailable." });
  }
});

router.get("/transit/stops", async (req, res): Promise<void> => {
  const parsed = GetTransitStopsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Stop search is invalid." });
    return;
  }
  try {
    const filter = parsed.data.q?.trim();
    const stops = await db.select().from(transitStopsTable)
      .where(filter ? ilike(transitStopsTable.name, `%${filter}%`) : undefined)
      .orderBy(transitStopsTable.name)
      .limit(200);
    if (!stops.length) {
      res.json([]);
      return;
    }
    const stopIds = stops.map((stop) => stop.id);
    const assignments = await db.selectDistinct({
      stopId: transitStopTimesTable.stopId,
      shortName: transitLinesTable.shortName,
      longName: transitLinesTable.longName,
    }).from(transitStopTimesTable)
      .innerJoin(transitTripsTable, eq(transitStopTimesTable.tripId, transitTripsTable.id))
      .innerJoin(transitLinesTable, eq(transitTripsTable.routeId, transitLinesTable.id))
      .where(inArray(transitStopTimesTable.stopId, stopIds));
    const lineNamesByStop = new Map<number, string[]>();
    for (const assignment of assignments) {
      const names = lineNamesByStop.get(assignment.stopId) ?? [];
      const name = assignment.shortName || assignment.longName;
      if (!names.includes(name)) names.push(name);
      lineNamesByStop.set(assignment.stopId, names);
    }
    res.json(GetTransitStopsResponse.parse(stops.map((stop) => ({
      id: stop.externalId,
      name: stop.name,
      latitude: stop.latitude,
      longitude: stop.longitude,
      lines: lineNamesByStop.get(stop.id) ?? [],
    }))));
  } catch (error) {
    req.log.error({ err: error }, "Could not list transit stops");
    res.status(500).json({ error: "Transit stops are temporarily unavailable." });
  }
});

router.get("/transit/lines", async (req, res): Promise<void> => {
  try {
    const lines = await db.select({
      id: transitLinesTable.externalId,
      name: transitLinesTable.shortName,
      longName: transitLinesTable.longName,
      mode: transitLinesTable.transportMode,
      color: transitLinesTable.color,
      stopCount: countDistinct(transitStopTimesTable.stopId),
    }).from(transitLinesTable)
      .leftJoin(transitTripsTable, eq(transitTripsTable.routeId, transitLinesTable.id))
      .leftJoin(transitStopTimesTable, eq(transitStopTimesTable.tripId, transitTripsTable.id))
      .groupBy(transitLinesTable.id)
      .orderBy(transitLinesTable.longName);
    res.json(GetTransitLinesResponse.parse(lines.map((line) => ({
      id: line.id,
      name: line.name || line.longName,
      mode: line.mode,
      color: line.color,
      stopCount: line.stopCount,
    }))));
  } catch (error) {
    req.log.error({ err: error }, "Could not list transit lines");
    res.status(500).json({ error: "Transit lines are temporarily unavailable." });
  }
});

router.get("/admin/gtfs/status", async (req, res): Promise<void> => {
  try {
    const [[stops], [routes], [trips], [feed]] = await Promise.all([
      db.select({ value: count() }).from(transitStopsTable),
      db.select({ value: count() }).from(transitLinesTable),
      db.select({ value: count() }).from(transitTripsTable),
      db.select().from(transitFeedStateTable).where(eq(transitFeedStateTable.id, 1)),
    ]);
    res.json(GetGtfsStatusResponse.parse({
      provider: feed?.provider ?? "Not configured",
      isDemo: feed?.isDemo ?? true,
      stops: stops?.value ?? 0,
      routes: routes?.value ?? 0,
      trips: trips?.value ?? 0,
      importedAt: feed?.importedAt?.toISOString() ?? null,
      importEnabled: Boolean(process.env.ADMIN_PASSWORD),
    }));
  } catch (error) {
    req.log.error({ err: error }, "Could not read transit data status");
    res.status(500).json({ error: "Transit data status is temporarily unavailable." });
  }
});

router.post("/admin/gtfs/import", express.raw({ type: "multipart/form-data", limit: "20mb" }), async (req, res, next): Promise<void> => {
  if (!checkAdminPassword(req.get("x-admin-password"))) {
    const status = process.env.ADMIN_PASSWORD ? 401 : 503;
    res.status(status).json({
      error: process.env.ADMIN_PASSWORD
        ? "Admin password is not correct."
        : "GTFS import is disabled until ADMIN_PASSWORD is configured.",
    });
    return;
  }
  next();
}, async (req, res): Promise<void> => {
  try {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Upload a GTFS ZIP file using the file field." });
      return;
    }
    const contentType = req.get("content-type") ?? "";
    const zip = getMultipartGtfsFile(contentType, req.body);
    const parsed = ImportGtfsBody.safeParse({
      file: new Blob([zip.toString("base64")], { type: "application/zip" }),
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Upload a valid GTFS ZIP file." });
      return;
    }
    const imported = await importGtfsZip(zip);
    res.json(ImportGtfsResponse.parse({
      success: true,
      provider: "GTFS feed",
      imported,
    }));
  } catch (error) {
    if (error instanceof GtfsImportError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "GTFS import failed");
    res.status(500).json({ error: "GTFS import failed. The current network data was not changed." });
  }
});

export default router;
