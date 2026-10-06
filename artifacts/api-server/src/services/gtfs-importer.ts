import { inflateRawSync } from "node:zlib";
import { db } from "@workspace/db";
import {
  transitAgenciesTable,
  transitFeedStateTable,
  transitLinesTable,
  transitServiceExceptionsTable,
  transitServicesTable,
  transitStopTimesTable,
  transitStopsTable,
  transitTripsTable,
} from "@workspace/db";
import { invalidateNetworkCache } from "./journey-planner";

const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const REQUIRED_FILES = ["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt"];
const INTERESTING_FILES = new Set([
  ...REQUIRED_FILES,
  "calendar.txt",
  "calendar_dates.txt",
]);

export interface GtfsImportCounts {
  stops: number;
  routes: number;
  trips: number;
  stopTimes: number;
}

export class GtfsImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GtfsImportError";
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimum = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new GtfsImportError("The uploaded file is not a valid ZIP archive.");
}

export function extractGtfsFiles(zip: Buffer): Map<string, Buffer> {
  if (zip.length === 0 || zip.length > MAX_COMPRESSED_BYTES) {
    throw new GtfsImportError("GTFS ZIP files must be smaller than 20 MB.");
  }
  const eocd = findEndOfCentralDirectory(zip);
  const entries = zip.readUInt16LE(eocd + 10);
  let centralOffset = zip.readUInt32LE(eocd + 16);
  const result = new Map<string, Buffer>();
  let expandedBytes = 0;

  for (let entry = 0; entry < entries; entry += 1) {
    if (centralOffset + 46 > zip.length || zip.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new GtfsImportError("The ZIP archive has a damaged file index.");
    }
    const method = zip.readUInt16LE(centralOffset + 10);
    const compressedSize = zip.readUInt32LE(centralOffset + 20);
    const uncompressedSize = zip.readUInt32LE(centralOffset + 24);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    const fullName = zip.toString("utf8", centralOffset + 46, centralOffset + 46 + nameLength);
    const basename = fullName.split(/[\\/]/).at(-1) ?? fullName;
    centralOffset += 46 + nameLength + extraLength + commentLength;
    if (!INTERESTING_FILES.has(basename)) continue;
    if (result.has(basename)) {
      throw new GtfsImportError(`The ZIP contains more than one ${basename} file.`);
    }
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new GtfsImportError("The uncompressed GTFS data exceeds the 200 MB safety limit.");
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new GtfsImportError(`The ZIP entry ${basename} is damaged.`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new GtfsImportError(`The ZIP entry ${basename} is truncated.`);
    const compressed = zip.subarray(dataStart, dataEnd);
    let content: Buffer;
    try {
      if (method === 0) content = Buffer.from(compressed);
      else if (method === 8) content = inflateRawSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
      else throw new GtfsImportError(`Unsupported ZIP compression for ${basename}.`);
    } catch (error) {
      if (error instanceof GtfsImportError) throw error;
      throw new GtfsImportError(`Could not decompress ${basename}.`);
    }
    if (content.length !== uncompressedSize) {
      throw new GtfsImportError(`The ZIP entry ${basename} has an invalid size.`);
    }
    result.set(basename, content);
  }

  const missing = REQUIRED_FILES.filter((name) => !result.has(name));
  if (missing.length) {
    throw new GtfsImportError(`GTFS ZIP is missing required file${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }
  if (!result.has("calendar.txt") && !result.has("calendar_dates.txt")) {
    throw new GtfsImportError("GTFS must include calendar.txt or calendar_dates.txt.");
  }
  return result;
}

export function parseGtfsCsv(input: Buffer): Array<Record<string, string>> {
  const text = input.toString("utf8").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') inQuotes = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (inQuotes) throw new GtfsImportError("A GTFS CSV file contains an unterminated quoted value.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) throw new GtfsImportError("A GTFS CSV file is empty.");
  const headers = rows[0].map((header) => header.trim());
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw new GtfsImportError("A GTFS CSV file has missing or duplicate column headers.");
  }
  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, (values[index] ?? "").trim()]),
  ));
}

function required(row: Record<string, string>, key: string, file: string): string {
  const value = row[key]?.trim();
  if (!value) throw new GtfsImportError(`${file} has a row without ${key}.`);
  return value;
}

function numeric(row: Record<string, string>, key: string, file: string): number {
  const value = Number(required(row, key, file));
  if (!Number.isFinite(value)) throw new GtfsImportError(`${file} contains an invalid ${key} value.`);
  return value;
}

function minutesFromGtfsTime(value: string, filename: string): number {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new GtfsImportError(`${filename} contains an invalid GTFS time: ${value}.`);
  return Number(match[1]) * 60 + Number(match[2]) + (Number(match[3]) >= 30 ? 1 : 0);
}

function modeFromGtfsType(value: string): string {
  const types: Record<string, string> = {
    "0": "tram",
    "1": "metro",
    "2": "train",
    "3": "bus",
    "4": "ferry",
    "5": "tram",
    "6": "other",
    "7": "train",
    "11": "bus",
    "12": "metro",
  };
  return types[value] ?? "other";
}

function parseMultipartFile(contentType: string, body: Buffer): Buffer {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw new GtfsImportError("The upload must be a multipart form with a file field.");
  const delimiter = Buffer.from(`--${boundary}`);
  const headerEnd = Buffer.from("\r\n\r\n");
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === "--") break;
    const headersAt = afterDelimiter + 2;
    const dataAt = body.indexOf(headerEnd, headersAt);
    if (dataAt === -1) break;
    const headers = body.toString("utf8", headersAt, dataAt).toLowerCase();
    const nextBoundary = body.indexOf(delimiter, dataAt + headerEnd.length);
    if (nextBoundary === -1) break;
    const contentStart = dataAt + headerEnd.length;
    const contentEnd = nextBoundary >= 2 && body.subarray(nextBoundary - 2, nextBoundary).toString() === "\r\n"
      ? nextBoundary - 2
      : nextBoundary;
    if (/content-disposition:[^\r\n]*name="file"/i.test(headers) && /filename="/i.test(headers)) {
      return body.subarray(contentStart, contentEnd);
    }
    cursor = nextBoundary;
  }
  throw new GtfsImportError("Choose a GTFS ZIP file to upload.");
}

export function getMultipartGtfsFile(contentType: string, body: Buffer): Buffer {
  return parseMultipartFile(contentType, body);
}

export async function importGtfsZip(zip: Buffer): Promise<GtfsImportCounts> {
  const files = extractGtfsFiles(zip);
  const agencies = parseGtfsCsv(files.get("agency.txt")!);
  const sourceStops = parseGtfsCsv(files.get("stops.txt")!);
  const sourceRoutes = parseGtfsCsv(files.get("routes.txt")!);
  const sourceTrips = parseGtfsCsv(files.get("trips.txt")!);
  const sourceStopTimes = parseGtfsCsv(files.get("stop_times.txt")!);
  const sourceCalendar = files.has("calendar.txt") ? parseGtfsCsv(files.get("calendar.txt")!) : [];
  const sourceExceptions = files.has("calendar_dates.txt") ? parseGtfsCsv(files.get("calendar_dates.txt")!) : [];

  if (sourceStops.length === 0 || sourceRoutes.length === 0 || sourceTrips.length === 0 || sourceStopTimes.length === 0) {
    throw new GtfsImportError("GTFS needs at least one stop, route, trip, and stop-time record.");
  }
  const uniqueBy = (rows: Array<Record<string, string>>, key: string, filename: string) => {
    const unique = new Map<string, Record<string, string>>();
    for (const row of rows) unique.set(required(row, key, filename), row);
    return [...unique.values()];
  };
  const agenciesById = new Map<string, Record<string, string>>();
  for (const [index, row] of agencies.entries()) {
    const id = row.agency_id || (agencies.length === 1 ? "DEFAULT_AGENCY" : `AGENCY_${index + 1}`);
    agenciesById.set(id, row);
  }
  const uniqueAgencies = [...agenciesById.entries()].map(([id, row]) => ({ ...row, agency_id: id }));
  const uniqueStops = uniqueBy(sourceStops, "stop_id", "stops.txt");
  const uniqueRoutes = uniqueBy(sourceRoutes, "route_id", "routes.txt");
  const uniqueTrips = uniqueBy(sourceTrips, "trip_id", "trips.txt");
  const uniqueCalendars = sourceCalendar.length ? uniqueBy(sourceCalendar, "service_id", "calendar.txt") : [];
  const uniqueExceptions = sourceExceptions.length
    ? uniqueBy(sourceExceptions, "service_id", "calendar_dates.txt")
    : [];

  const validStops = new Set(uniqueStops.map((row) => required(row, "stop_id", "stops.txt")));
  const validRoutes = new Set(uniqueRoutes.map((row) => required(row, "route_id", "routes.txt")));
  const validServices = new Set([
    ...uniqueCalendars.map((row) => required(row, "service_id", "calendar.txt")),
    ...sourceExceptions.map((row) => required(row, "service_id", "calendar_dates.txt")),
  ]);
  for (const trip of uniqueTrips) {
    if (!validRoutes.has(required(trip, "route_id", "trips.txt"))) {
      throw new GtfsImportError(`Trip ${trip.trip_id} references an unknown route.`);
    }
    if (validServices.size && !validServices.has(required(trip, "service_id", "trips.txt"))) {
      throw new GtfsImportError(`Trip ${trip.trip_id} references an unknown service calendar.`);
    }
  }
  const tripIds = new Set(uniqueTrips.map((trip) => trip.trip_id));
  for (const stopTime of sourceStopTimes) {
    const tripId = required(stopTime, "trip_id", "stop_times.txt");
    if (!tripIds.has(tripId)) {
      throw new GtfsImportError(`Stop time references an unknown trip: ${tripId}.`);
    }
    const stopId = required(stopTime, "stop_id", "stop_times.txt");
    if (!validStops.has(stopId)) throw new GtfsImportError(`Stop time references an unknown stop: ${stopId}.`);
    if (stopTime.arrival_time) minutesFromGtfsTime(stopTime.arrival_time, "stop_times.txt");
    if (stopTime.departure_time) minutesFromGtfsTime(stopTime.departure_time, "stop_times.txt");
    numeric(stopTime, "stop_sequence", "stop_times.txt");
  }
  for (const row of uniqueExceptions) {
    const type = numeric(row, "exception_type", "calendar_dates.txt");
    if (type !== 1 && type !== 2) throw new GtfsImportError("calendar_dates.txt exception_type must be 1 or 2.");
  }
  for (const row of sourceExceptions) {
    const date = required(row, "date", "calendar_dates.txt");
    if (!/^\d{8}$/.test(date)) throw new GtfsImportError("calendar_dates.txt contains an invalid date.");
    const parsedDate = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10).replaceAll("-", "") !== date) {
      throw new GtfsImportError("calendar_dates.txt contains an invalid date.");
    }
  }
  for (const row of uniqueStops) {
    const latitude = numeric(row, "stop_lat", "stops.txt");
    const longitude = numeric(row, "stop_lon", "stops.txt");
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new GtfsImportError(`Stop ${row.stop_id} has coordinates outside the valid range.`);
    }
  }

  const counts = {
    stops: uniqueStops.length,
    routes: uniqueRoutes.length,
    trips: uniqueTrips.length,
    stopTimes: sourceStopTimes.length,
  };

  await db.transaction(async (tx) => {
    await tx.delete(transitLinesTable);
    await tx.delete(transitStopsTable);
    await tx.delete(transitServicesTable);
    await tx.delete(transitAgenciesTable);
    const agencyRows = uniqueAgencies.map((row, index) => ({
      externalId: row.agency_id || (uniqueAgencies.length === 1 ? "DEFAULT_AGENCY" : `AGENCY_${index + 1}`),
      name: required(row, "agency_name", "agency.txt"),
      url: row.agency_url || null,
      timezone: row.agency_timezone || "UTC",
    }));
    const insertedAgencies = agencyRows.length
      ? await tx.insert(transitAgenciesTable).values(agencyRows).returning()
      : [];
    const agencyIdByExternalId = new Map(insertedAgencies.map((row) => [row.externalId, row.id]));
    const defaultAgencyId = insertedAgencies[0]?.id ?? null;

    const insertedStops = await tx.insert(transitStopsTable).values(uniqueStops.map((row) => ({
      externalId: required(row, "stop_id", "stops.txt"),
      name: required(row, "stop_name", "stops.txt"),
      latitude: numeric(row, "stop_lat", "stops.txt"),
      longitude: numeric(row, "stop_lon", "stops.txt"),
      locationType: row.location_type ? numeric(row, "location_type", "stops.txt") : 0,
      parentStation: row.parent_station || null,
      aliases: [],
    }))).returning();
    const stopIdByExternalId = new Map(insertedStops.map((row) => [row.externalId, row.id]));

    const insertedLines = await tx.insert(transitLinesTable).values(uniqueRoutes.map((row) => {
      const agencyExternalId = row.agency_id || agencyRows[0]?.externalId;
      const color = row.route_color && /^[0-9a-f]{6}$/i.test(row.route_color)
        ? `#${row.route_color}`
        : "#2878D0";
      return {
        externalId: required(row, "route_id", "routes.txt"),
        agencyId: (agencyExternalId && agencyIdByExternalId.get(agencyExternalId)) || defaultAgencyId,
        shortName: row.route_short_name || null,
        longName: row.route_long_name || row.route_short_name || row.route_id,
        transportMode: modeFromGtfsType(row.route_type || "3"),
        color,
      };
    })).returning();
    const lineIdByExternalId = new Map(insertedLines.map((row) => [row.externalId, row.id]));

    const services = new Map<string, {
      externalId: string;
      monday: boolean;
      tuesday: boolean;
      wednesday: boolean;
      thursday: boolean;
      friday: boolean;
      saturday: boolean;
      sunday: boolean;
      startDate: string | null;
      endDate: string | null;
    }>();
    for (const row of uniqueCalendars) {
      const externalId = required(row, "service_id", "calendar.txt");
      const parseDate = (value: string) => value.length === 8
        ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
        : null;
      services.set(externalId, {
        externalId,
        monday: row.monday === "1",
        tuesday: row.tuesday === "1",
        wednesday: row.wednesday === "1",
        thursday: row.thursday === "1",
        friday: row.friday === "1",
        saturday: row.saturday === "1",
        sunday: row.sunday === "1",
        startDate: parseDate(row.start_date ?? ""),
        endDate: parseDate(row.end_date ?? ""),
      });
    }
    for (const row of sourceExceptions) {
      const externalId = required(row, "service_id", "calendar_dates.txt");
      if (!services.has(externalId)) services.set(externalId, {
        externalId,
        monday: false,
        tuesday: false,
        wednesday: false,
        thursday: false,
        friday: false,
        saturday: false,
        sunday: false,
        startDate: null,
        endDate: null,
      });
    }
    const insertedServices = services.size
      ? await tx.insert(transitServicesTable).values([...services.values()]).returning()
      : [];
    const serviceIdByExternalId = new Map(insertedServices.map((row) => [row.externalId, row.id]));
    if (sourceExceptions.length) {
      await tx.insert(transitServiceExceptionsTable).values(sourceExceptions.map((row) => ({
        serviceId: serviceIdByExternalId.get(required(row, "service_id", "calendar_dates.txt"))!,
        serviceDate: `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`,
        exceptionType: numeric(row, "exception_type", "calendar_dates.txt"),
      })));
    }

    const insertedTrips = await tx.insert(transitTripsTable).values(uniqueTrips.map((row) => ({
      externalId: required(row, "trip_id", "trips.txt"),
      routeId: lineIdByExternalId.get(required(row, "route_id", "trips.txt"))!,
      serviceId: serviceIdByExternalId.get(row.service_id) ?? null,
      headsign: row.trip_headsign || null,
      directionId: row.direction_id ? numeric(row, "direction_id", "trips.txt") : null,
    }))).returning();
    const tripIdByExternalId = new Map(insertedTrips.map((row) => [row.externalId, row.id]));
    const stopTimeRows = sourceStopTimes.map((row) => {
      const arrival = row.arrival_time || row.departure_time;
      const departure = row.departure_time || row.arrival_time;
      if (!arrival || !departure) throw new GtfsImportError("stop_times.txt rows need arrival_time or departure_time.");
      return {
        tripId: tripIdByExternalId.get(required(row, "trip_id", "stop_times.txt"))!,
        stopId: stopIdByExternalId.get(required(row, "stop_id", "stop_times.txt"))!,
        arrivalMinutes: minutesFromGtfsTime(arrival, "stop_times.txt"),
        departureMinutes: minutesFromGtfsTime(departure, "stop_times.txt"),
        stopSequence: numeric(row, "stop_sequence", "stop_times.txt"),
      };
    });
    for (let offset = 0; offset < stopTimeRows.length; offset += 1000) {
      await tx.insert(transitStopTimesTable).values(stopTimeRows.slice(offset, offset + 1000));
    }

    await tx.insert(transitFeedStateTable).values({
      id: 1,
      provider: "GTFS feed",
      isDemo: false,
      importedAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: transitFeedStateTable.id,
      set: {
        provider: "GTFS feed",
        isDemo: false,
        importedAt: new Date(),
        updatedAt: new Date(),
      },
    });
  });

  await invalidateNetworkCache();
  return counts;
}

export function checkGtfsFiles(zip: Buffer): void {
  extractGtfsFiles(zip);
}
