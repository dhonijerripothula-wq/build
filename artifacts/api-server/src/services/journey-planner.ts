import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  routeResultsTable,
  routeSearchesTable,
  routeSegmentsTable,
  transitAgenciesTable,
  transitFeedStateTable,
  transitLinesTable,
  transitServiceExceptionsTable,
  transitServicesTable,
  transitStopTimesTable,
  transitStopsTable,
  transitTripsTable,
} from "@workspace/db";
import type { Priority } from "../algorithms/recommend";
import { buildRecommendationReasons, countTransfers, rankRoutes } from "../algorithms/recommend";
import { SearchRoutesResponse } from "@workspace/api-zod";

const MAX_TRANSFERS = 3;
const MAX_RESULTS = 20;
const MAX_EXPANSIONS = 6500;
const WALK_SPEED_METERS_PER_MINUTE = 78;
const NEARBY_STOP_RADIUS_METERS = 1500;
const MAX_WAIT_MINUTES = 100;
const TRANSFER_BUFFER_MINUTES = 3;

type Stop = {
  id: number;
  externalId: string;
  name: string;
  latitude: number;
  longitude: number;
  aliases: string[];
};

type ScheduledStop = Stop & {
  arrivalMinutes: number;
  departureMinutes: number;
  sequence: number;
};

type ScheduledTrip = {
  tripId: number;
  routeId: number;
  externalId: string;
  serviceId: number | null;
  routeName: string;
  mode: string;
  color: string;
  stops: ScheduledStop[];
};

type TransitSegment = {
  mode: string;
  lineName: string;
  routeId: string;
  fromStop: string;
  toStop: string;
  durationMinutes: number;
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
  departureMinute: number;
  arrivalMinute: number;
};

type SearchLocation = {
  name: string;
  latitude: number;
  longitude: number;
};

type SearchState = {
  stopId: number;
  initialStopId: number;
  initialWalkMinutes: number;
  arrivalMinute: number;
  lastRouteId: number | null;
  transfers: number;
  waitingMinutes: number;
  transitSegments: TransitSegment[];
  routeIds: string[];
  signature: string;
};

type JourneyOption = {
  id: string;
  durationMinutes: number;
  transfers: number;
  walkingMinutes: number;
  waitingMinutes: number;
  departureTime: string;
  arrivalTime: string;
  score: number;
  modes: string[];
  reason: string;
  segments: Array<{
    mode: string;
    lineName: string;
    fromStop: string;
    toStop: string;
    durationMinutes: number;
    fromLatitude: number;
    fromLongitude: number;
    toLatitude: number;
    toLongitude: number;
  }>;
};

type NetworkCache = {
  loadedAt: number;
  services: ServiceRow[];
  serviceExceptions: ServiceExceptionRow[];
  stops: Stop[];
  trips: ScheduledTrip[];
};

type ServiceRow = {
  id: number;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startDate: string | null;
  endDate: string | null;
};

type ServiceExceptionRow = {
  serviceId: number;
  serviceDate: string;
  exceptionType: number;
};

let networkCache: NetworkCache | undefined;

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-IN").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function haversineMeters(a: Pick<SearchLocation, "latitude" | "longitude">, b: Pick<SearchLocation, "latitude" | "longitude">): number {
  const earthRadius = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const latA = toRadians(a.latitude);
  const latB = toRadians(b.latitude);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function minutesForDate(date: Date): { dateString: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return {
    dateString: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function localTime(date: Date, extraMinutes = 0): string {
  const shifted = new Date(date.getTime() + extraMinutes * 60_000);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(shifted);
}

function activeServiceIds(
  dateString: string,
  dayNumber: number,
  services: ServiceRow[],
  exceptions: ServiceExceptionRow[],
): Set<number> {
  const active = new Set<number>();
  const dayKeys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
  const key = dayKeys[dayNumber];
  for (const service of services) {
    const withinDates =
      (!service.startDate || service.startDate <= dateString) &&
      (!service.endDate || service.endDate >= dateString);
    if (withinDates && service[key]) active.add(service.id);
  }
  for (const exception of exceptions) {
    if (exception.serviceDate !== dateString) continue;
    if (exception.exceptionType === 1) active.add(exception.serviceId);
    if (exception.exceptionType === 2) active.delete(exception.serviceId);
  }
  return active;
}

async function loadNetwork(fromMinute: number): Promise<NetworkCache> {
  const now = Date.now();
  if (networkCache && now - networkCache.loadedAt < 30_000) return networkCache;

  const [stops, services, serviceExceptions, feedState] = await Promise.all([
    db.select().from(transitStopsTable),
    db.select().from(transitServicesTable),
    db.select({
      serviceId: transitServiceExceptionsTable.serviceId,
      serviceDate: transitServiceExceptionsTable.serviceDate,
      exceptionType: transitServiceExceptionsTable.exceptionType,
    }).from(transitServiceExceptionsTable),
    db.select({ id: transitFeedStateTable.id }).from(transitFeedStateTable).limit(1),
  ]);
  if (!feedState[0]) throw new Error("Transit data has not been initialized.");

  const stopMap = new Map<number, Stop>(stops.map((stop) => [stop.id, {
    id: stop.id,
    externalId: stop.externalId,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
    aliases: stop.aliases ?? [],
  }]));

  // Feed schedules are cached briefly. The query is constrained to the remaining service day.
  const timings = await db
    .select({
      tripId: transitTripsTable.id,
      tripExternalId: transitTripsTable.externalId,
      routeId: transitLinesTable.id,
      routeExternalId: transitLinesTable.externalId,
      routeName: transitLinesTable.longName,
      mode: transitLinesTable.transportMode,
      color: transitLinesTable.color,
      serviceId: transitTripsTable.serviceId,
      stopId: transitStopTimesTable.stopId,
      arrivalMinutes: transitStopTimesTable.arrivalMinutes,
      departureMinutes: transitStopTimesTable.departureMinutes,
      sequence: transitStopTimesTable.stopSequence,
    })
    .from(transitStopTimesTable)
    .innerJoin(transitTripsTable, eq(transitStopTimesTable.tripId, transitTripsTable.id))
    .innerJoin(transitLinesTable, eq(transitTripsTable.routeId, transitLinesTable.id))
    .where(gte(transitStopTimesTable.departureMinutes, Math.max(0, fromMinute - 2)))
    .orderBy(transitStopTimesTable.tripId, transitStopTimesTable.stopSequence);

  const tripsById = new Map<number, ScheduledTrip>();
  for (const timing of timings) {
    const stop = stopMap.get(timing.stopId);
    if (!stop) continue;
    let trip = tripsById.get(timing.tripId);
    if (!trip) {
      trip = {
        tripId: timing.tripId,
        routeId: timing.routeId,
        externalId: timing.routeExternalId,
        routeName: timing.routeName,
        mode: timing.mode,
        color: timing.color,
        serviceId: timing.serviceId,
        stops: [],
      };
      tripsById.set(timing.tripId, trip);
    }
    trip.stops.push({
      ...stop,
      arrivalMinutes: timing.arrivalMinutes,
      departureMinutes: timing.departureMinutes,
      sequence: timing.sequence,
    });
  }

  networkCache = {
    loadedAt: now,
    services,
    serviceExceptions,
    stops: [...stopMap.values()],
    trips: [...tripsById.values()],
  };
  return networkCache;
}

function matchLocation(query: string, stops: Stop[]): Stop | null {
  const normalized = normalize(query);
  if (!normalized) return null;
  const exact = stops.find((stop) =>
    [stop.name, ...stop.aliases].some((name) => normalize(name) === normalized),
  );
  if (exact) return exact;
  const contains = stops.find((stop) =>
    [stop.name, ...stop.aliases].some((name) => {
      const candidate = normalize(name);
      return candidate.includes(normalized) || normalized.includes(candidate);
    }),
  );
  return contains ?? null;
}

function nearbyStops(location: Stop, stops: Stop[]): Array<{ stop: Stop; walkMinutes: number }> {
  return stops
    .map((stop) => ({
      stop,
      meters: haversineMeters(location, stop),
    }))
    .filter(({ meters }) => meters <= NEARBY_STOP_RADIUS_METERS)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 3)
    .map(({ stop, meters }) => ({
      stop,
      walkMinutes: Math.ceil(meters / WALK_SPEED_METERS_PER_MINUTE),
    }));
}

function dayForDate(dateString: string): number {
  return new Date(`${dateString}T12:00:00.000Z`).getUTCDay();
}

function addWalkSegment(from: SearchLocation, to: SearchLocation, minutes: number) {
  return {
    mode: "walk",
    lineName: "Walk",
    fromStop: from.name,
    toStop: to.name,
    durationMinutes: minutes,
    fromLatitude: from.latitude,
    fromLongitude: from.longitude,
    toLatitude: to.latitude,
    toLongitude: to.longitude,
  };
}

function journeySignature(routeIds: string[], segments: TransitSegment[]): string {
  return `${routeIds.join(">")}|${segments.map((segment) => `${segment.fromStop}>${segment.toStop}`).join("|")}`;
}

function constructCandidates(
  origin: Stop,
  destination: Stop,
  stops: Stop[],
  trips: ScheduledTrip[],
  departureMinute: number,
  serviceIds: Set<number>,
): JourneyOption[] {
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const tripsForDay = trips.filter((trip) => trip.serviceId == null || serviceIds.has(trip.serviceId));
  const boardings = new Map<number, Array<{ trip: ScheduledTrip; sequence: number }>>();
  for (const trip of tripsForDay) {
    trip.stops.forEach((stop, sequence) => {
      const options = boardings.get(stop.id) ?? [];
      options.push({ trip, sequence });
      boardings.set(stop.id, options);
    });
  }
  for (const options of boardings.values()) {
    options.sort((a, b) => a.trip.stops[a.sequence].departureMinutes - b.trip.stops[b.sequence].departureMinutes);
  }

  const starts = nearbyStops(origin, stops);
  const ends = nearbyStops(destination, stops);
  const endIds = new Set(ends.map(({ stop }) => stop.id));
  const heap: SearchState[] = starts.map(({ stop, walkMinutes }) => ({
    stopId: stop.id,
    initialStopId: stop.id,
    initialWalkMinutes: walkMinutes,
    arrivalMinute: departureMinute + walkMinutes,
    lastRouteId: null,
    transfers: 0,
    waitingMinutes: 0,
    transitSegments: [],
    routeIds: [],
    signature: `${stop.id}`,
  }));
  const bestStates = new Map<string, Set<string>>();
  const candidateBySignature = new Map<string, JourneyOption>();
  let expansions = 0;

  while (heap.length > 0 && expansions < MAX_EXPANSIONS && candidateBySignature.size < MAX_RESULTS * 3) {
    heap.sort((a, b) => b.arrivalMinute - a.arrivalMinute);
    const state = heap.pop();
    if (!state) break;
    expansions += 1;

    if (endIds.has(state.stopId) && state.transitSegments.length > 0) {
      const endStop = stopById.get(state.stopId);
      if (!endStop) continue;
      const endWalk = ends.find(({ stop }) => stop.id === state.stopId);
      const lineIds = state.transitSegments.map((segment) => segment.routeId);
      const transfers = countTransfers(lineIds);
      const transitSegments = state.transitSegments.map(
        ({ routeId: _routeId, departureMinute: _departureMinute, arrivalMinute: _arrivalMinute, ...segment }) => segment,
      );
      const journey: JourneyOption = {
        id: randomUUID(),
        durationMinutes: Math.max(1, state.arrivalMinute - departureMinute - state.initialWalkMinutes),
        transfers,
        walkingMinutes: 0,
        waitingMinutes: state.waitingMinutes,
        departureTime: "",
        arrivalTime: "",
        score: 0,
        modes: [...new Set(state.transitSegments.map((segment) => segment.mode))],
        reason: "",
        segments: transitSegments,
      };
      const signature = journeySignature(state.routeIds, state.transitSegments);
      if (!candidateBySignature.has(signature)) candidateBySignature.set(signature, journey);
      continue;
    }

    const options = boardings.get(state.stopId) ?? [];
    for (const option of options) {
      const trip = option.trip;
      const boardStop = trip.stops[option.sequence];
      if (!boardStop) continue;
      const changesLine = state.lastRouteId !== null && state.lastRouteId !== trip.routeId;
      const transfers = state.transfers + (changesLine ? 1 : 0);
      if (transfers > MAX_TRANSFERS) continue;
      if (state.lastRouteId === trip.routeId && state.transitSegments.length > 0) continue;
      const wait = boardStop.departureMinutes - state.arrivalMinute;
      if (wait < (changesLine ? TRANSFER_BUFFER_MINUTES : 0) || wait > MAX_WAIT_MINUTES) continue;

      for (let nextIndex = option.sequence + 1; nextIndex < trip.stops.length; nextIndex += 1) {
        const destinationStop = trip.stops[nextIndex];
        const rideMinutes = destinationStop.arrivalMinutes - boardStop.departureMinutes;
        if (rideMinutes < 1) continue;
        const segment: TransitSegment = {
          mode: trip.mode,
          lineName: trip.routeName,
          routeId: trip.externalId,
          fromStop: boardStop.name,
          toStop: destinationStop.name,
          durationMinutes: rideMinutes,
          fromLatitude: boardStop.latitude,
          fromLongitude: boardStop.longitude,
          toLatitude: destinationStop.latitude,
          toLongitude: destinationStop.longitude,
          departureMinute: boardStop.departureMinutes,
          arrivalMinute: destinationStop.arrivalMinutes,
        };
        const nextRouteIds = state.routeIds.at(-1) === trip.externalId
          ? state.routeIds
          : [...state.routeIds, trip.externalId];
        const nextSegments = [...state.transitSegments, segment];
        const signature = journeySignature(nextRouteIds, nextSegments);
        const key = `${destinationStop.id}:${trip.routeId}:${transfers}`;
        const known = bestStates.get(key) ?? new Set<string>();
        if (known.has(signature) || known.size >= 3) continue;
        known.add(signature);
        bestStates.set(key, known);
        heap.push({
          stopId: destinationStop.id,
          initialStopId: state.initialStopId,
          initialWalkMinutes: state.initialWalkMinutes,
          arrivalMinute: destinationStop.arrivalMinutes,
          lastRouteId: trip.routeId,
          transfers,
          waitingMinutes: state.waitingMinutes + wait,
          transitSegments: nextSegments,
          routeIds: nextRouteIds,
          signature,
        });
      }
    }
  }

  return [...candidateBySignature.values()];
}

function setFirstLastWalks(
  routes: JourneyOption[],
  origin: Stop,
  destination: Stop,
  starts: Array<{ stop: Stop; walkMinutes: number }>,
  ends: Array<{ stop: Stop; walkMinutes: number }>,
  departureAt: Date,
): JourneyOption[] {
  for (const route of routes) {
    const firstTransit = route.segments.find((segment) => segment.mode !== "walk");
    const lastTransit = [...route.segments].reverse().find((segment) => segment.mode !== "walk");
    const start = firstTransit ? starts.find(({ stop }) => stop.name === firstTransit.fromStop) : undefined;
    const end = lastTransit ? ends.find(({ stop }) => stop.name === lastTransit.toStop) : undefined;
    const segments = route.segments.filter((segment) => segment.mode !== "walk");
    if (start && start.walkMinutes > 0) segments.unshift(addWalkSegment(origin, start.stop, start.walkMinutes));
    if (end && end.walkMinutes > 0) segments.push(addWalkSegment(end.stop, destination, end.walkMinutes));
    route.segments = segments;
    route.walkingMinutes = (start?.walkMinutes ?? 0) + (end?.walkMinutes ?? 0);
    route.durationMinutes += route.walkingMinutes;
    route.departureTime = localTime(departureAt);
    route.arrivalTime = localTime(departureAt, route.durationMinutes);
  }
  return routes;
}

function compactRoutes(routes: JourneyOption[]): JourneyOption[] {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const signature = route.segments
      .filter((segment) => segment.mode !== "walk")
      .map((segment) => `${segment.lineName}:${segment.fromStop}:${segment.toStop}`)
      .join("|");
    if (!signature || seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export async function findLocation(query: string): Promise<Stop | null> {
  const rows = await db.select().from(transitStopsTable).orderBy(transitStopsTable.name).limit(500);
  const stops: Stop[] = rows.map((stop) => ({
    id: stop.id,
    externalId: stop.externalId,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
    aliases: stop.aliases ?? [],
  }));
  return matchLocation(query, stops);
}

export async function suggestLocations(query: string): Promise<SearchLocation[]> {
  const normalized = normalize(query);
  if (normalized.length < 2) return [];
  const rows = await db.select().from(transitStopsTable).orderBy(transitStopsTable.name).limit(500);
  return rows
    .map((stop) => ({
      stop,
      rank: [stop.name, ...(stop.aliases ?? [])].reduce((best, label) => {
        const candidate = normalize(label);
        if (candidate === normalized) return Math.max(best, 3);
        if (candidate.startsWith(normalized)) return Math.max(best, 2);
        if (candidate.includes(normalized) || normalized.includes(candidate)) return Math.max(best, 1);
        return best;
      }, 0),
    }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank || a.stop.name.localeCompare(b.stop.name))
    .slice(0, 8)
    .map(({ stop }) => ({
      name: stop.name,
      latitude: stop.latitude,
      longitude: stop.longitude,
    }));
}

export async function searchRouteOptions(input: {
  origin: string;
  destination: string;
  departureTime?: string;
  preferences: { priority: Priority };
}): Promise<{
  id: string;
  origin: SearchLocation;
  destination: SearchLocation;
  provider: string;
  recommendedRouteId: string;
  routes: JourneyOption[];
}> {
  const departureAt = input.departureTime ? new Date(input.departureTime) : new Date();
  if (!Number.isFinite(departureAt.getTime())) throw new Error("Departure time is invalid.");
  const { dateString, minutes } = minutesForDate(departureAt);
  const network = await loadNetwork(Math.max(0, minutes));
  const originStop = matchLocation(input.origin, network.stops);
  const destinationStop = matchLocation(input.destination, network.stops);
  if (!originStop || !destinationStop) {
    throw new Error("Location not found. Choose a stop from the location suggestions.");
  }
  if (originStop.id === destinationStop.id) {
    throw new Error("Choose two different locations.");
  }

  const day = dayForDate(dateString);
  const serviceIds = activeServiceIds(dateString, day, network.services, network.serviceExceptions);
  const tripsForDate = network.trips.filter((trip) => trip.serviceId == null || serviceIds.has(trip.serviceId));
  const candidateRoutes = constructCandidates(
    originStop,
    destinationStop,
    network.stops,
    tripsForDate,
    minutes,
    serviceIds,
  );
  if (candidateRoutes.length === 0) throw new Error("No public transport route was found between these locations. Try nearby stops or a different departure time.");

  const starts = nearbyStops(originStop, network.stops);
  const ends = nearbyStops(destinationStop, network.stops);
  const adjusted = compactRoutes(setFirstLastWalks(
    candidateRoutes,
    originStop,
    destinationStop,
    starts,
    ends,
    departureAt,
  ));
  const ranked = buildRecommendationReasons(rankRoutes(adjusted, input.preferences.priority), input.preferences.priority)
    .slice(0, MAX_RESULTS)
    .map((route) => ({
      ...route,
      id: randomUUID(),
    }));
  const [feed] = await db.select({ provider: transitFeedStateTable.provider })
    .from(transitFeedStateTable)
    .where(eq(transitFeedStateTable.id, 1));

  return {
    id: randomUUID(),
    origin: { name: originStop.name, latitude: originStop.latitude, longitude: originStop.longitude },
    destination: { name: destinationStop.name, latitude: destinationStop.latitude, longitude: destinationStop.longitude },
    provider: feed?.provider ?? "Transit feed",
    recommendedRouteId: ranked[0].id,
    routes: ranked,
  };
}

export async function saveRouteSearch(
  result: Awaited<ReturnType<typeof searchRouteOptions>>,
  visitorId: string,
  originQuery: string,
  destinationQuery: string,
  departureAt: Date,
  priority: Priority,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(routeSearchesTable).values({
      id: result.id,
      visitorId,
      originName: originQuery,
      originLatitude: result.origin.latitude,
      originLongitude: result.origin.longitude,
      destinationName: destinationQuery,
      destinationLatitude: result.destination.latitude,
      destinationLongitude: result.destination.longitude,
      departureAt,
      priority,
      recommendedRouteId: result.recommendedRouteId,
      provider: result.provider,
    });

    for (const [rank, route] of result.routes.entries()) {
      await tx.insert(routeResultsTable).values({
        id: route.id,
        searchId: result.id,
        rank,
        durationMinutes: route.durationMinutes,
        transfers: route.transfers,
        walkingMinutes: route.walkingMinutes,
        waitingMinutes: route.waitingMinutes,
        departureTime: route.departureTime,
        arrivalTime: route.arrivalTime,
        score: route.score,
        modes: route.modes,
        reason: route.reason,
      });
      if (route.segments.length) {
        await tx.insert(routeSegmentsTable).values(route.segments.map((segment, sequence) => ({
          routeResultId: route.id,
          sequence,
          mode: segment.mode,
          lineName: segment.lineName,
          fromStop: segment.fromStop,
          toStop: segment.toStop,
          durationMinutes: segment.durationMinutes,
          fromLatitude: segment.fromLatitude,
          fromLongitude: segment.fromLongitude,
          toLatitude: segment.toLatitude,
          toLongitude: segment.toLongitude,
        })));
      }
    }
  });
}

export async function getRouteSearch(id: string, visitorId: string) {
  const [search] = await db.select().from(routeSearchesTable)
    .where(and(eq(routeSearchesTable.id, id), eq(routeSearchesTable.visitorId, visitorId)));
  if (!search) return null;
  const routes = await db.select().from(routeResultsTable)
    .where(eq(routeResultsTable.searchId, id))
    .orderBy(routeResultsTable.rank);
  const routeIds = routes.map((route) => route.id);
  const segments = routeIds.length
    ? await db.select().from(routeSegmentsTable)
      .where(inArray(routeSegmentsTable.routeResultId, routeIds))
      .orderBy(routeSegmentsTable.sequence)
    : [];
  return SearchRoutesResponse.parse({
    requestId: search.id,
    origin: { name: search.originName, latitude: search.originLatitude, longitude: search.originLongitude },
    destination: { name: search.destinationName, latitude: search.destinationLatitude, longitude: search.destinationLongitude },
    provider: search.provider,
    recommendedRouteId: search.recommendedRouteId,
    routes: routes.map((route) => ({
      id: route.id,
      durationMinutes: route.durationMinutes,
      transfers: route.transfers,
      walkingMinutes: route.walkingMinutes,
      waitingMinutes: route.waitingMinutes,
      departureTime: route.departureTime,
      arrivalTime: route.arrivalTime,
      score: route.score,
      modes: route.modes,
      reason: route.reason,
      segments: segments.filter((segment) => segment.routeResultId === route.id).map((segment) => ({
        mode: segment.mode,
        lineName: segment.lineName,
        fromStop: segment.fromStop,
        toStop: segment.toStop,
        durationMinutes: segment.durationMinutes,
        fromLatitude: segment.fromLatitude,
        fromLongitude: segment.fromLongitude,
        toLatitude: segment.toLatitude,
        toLongitude: segment.toLongitude,
      })),
    })),
  });
}

export async function invalidateNetworkCache(): Promise<void> {
  networkCache = undefined;
}
