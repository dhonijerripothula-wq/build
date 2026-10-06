import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const transitAgenciesTable = pgTable(
  "transit_agencies",
  {
    id: serial("id").primaryKey(),
    externalId: varchar("external_id", { length: 180 }).notNull(),
    name: text("name").notNull(),
    url: text("url"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("transit_agencies_external_id_uq").on(table.externalId)],
);

export const transitStopsTable = pgTable(
  "transit_stops",
  {
    id: serial("id").primaryKey(),
    externalId: varchar("external_id", { length: 180 }).notNull(),
    name: text("name").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    locationType: integer("location_type").notNull().default(0),
    parentStation: text("parent_station"),
    aliases: text("aliases").array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transit_stops_external_id_uq").on(table.externalId),
    index("transit_stops_coordinates_idx").on(table.latitude, table.longitude),
    index("transit_stops_name_idx").on(table.name),
  ],
);

export const transitLinesTable = pgTable(
  "transit_lines",
  {
    id: serial("id").primaryKey(),
    externalId: varchar("external_id", { length: 180 }).notNull(),
    agencyId: integer("agency_id").references(() => transitAgenciesTable.id, {
      onDelete: "set null",
    }),
    shortName: text("short_name"),
    longName: text("long_name").notNull(),
    transportMode: text("transport_mode").notNull(),
    color: varchar("color", { length: 12 }).notNull().default("#2878D0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("transit_lines_external_id_uq").on(table.externalId),
    index("transit_lines_mode_idx").on(table.transportMode),
  ],
);

export const transitServicesTable = pgTable(
  "transit_services",
  {
    id: serial("id").primaryKey(),
    externalId: varchar("external_id", { length: 180 }).notNull(),
    monday: boolean("monday").notNull().default(true),
    tuesday: boolean("tuesday").notNull().default(true),
    wednesday: boolean("wednesday").notNull().default(true),
    thursday: boolean("thursday").notNull().default(true),
    friday: boolean("friday").notNull().default(true),
    saturday: boolean("saturday").notNull().default(true),
    sunday: boolean("sunday").notNull().default(true),
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
  },
  (table) => [uniqueIndex("transit_services_external_id_uq").on(table.externalId)],
);

export const transitServiceExceptionsTable = pgTable(
  "transit_service_exceptions",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => transitServicesTable.id, { onDelete: "cascade" }),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    exceptionType: integer("exception_type").notNull(),
  },
  (table) => [
    uniqueIndex("transit_service_exception_date_uq").on(table.serviceId, table.serviceDate),
  ],
);

export const transitTripsTable = pgTable(
  "transit_trips",
  {
    id: serial("id").primaryKey(),
    externalId: varchar("external_id", { length: 180 }).notNull(),
    routeId: integer("route_id")
      .notNull()
      .references(() => transitLinesTable.id, { onDelete: "cascade" }),
    serviceId: integer("service_id").references(() => transitServicesTable.id, {
      onDelete: "set null",
    }),
    headsign: text("headsign"),
    directionId: integer("direction_id"),
  },
  (table) => [
    uniqueIndex("transit_trips_external_id_uq").on(table.externalId),
    index("transit_trips_route_idx").on(table.routeId),
  ],
);

export const transitStopTimesTable = pgTable(
  "transit_stop_times",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => transitTripsTable.id, { onDelete: "cascade" }),
    stopId: integer("stop_id")
      .notNull()
      .references(() => transitStopsTable.id, { onDelete: "cascade" }),
    arrivalMinutes: integer("arrival_minutes").notNull(),
    departureMinutes: integer("departure_minutes").notNull(),
    stopSequence: integer("stop_sequence").notNull(),
  },
  (table) => [
    uniqueIndex("transit_stop_times_trip_sequence_uq").on(table.tripId, table.stopSequence),
    index("transit_stop_times_stop_idx").on(table.stopId, table.departureMinutes),
  ],
);

export const transitFeedStateTable = pgTable("transit_feed_state", {
  id: integer("id").primaryKey().default(1),
  provider: text("provider").notNull().default("demo"),
  isDemo: boolean("is_demo").notNull().default(true),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const routeSearchesTable = pgTable(
  "route_searches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    visitorId: varchar("visitor_id", { length: 64 }).notNull(),
    originName: text("origin_name").notNull(),
    originLatitude: real("origin_latitude").notNull(),
    originLongitude: real("origin_longitude").notNull(),
    destinationName: text("destination_name").notNull(),
    destinationLatitude: real("destination_latitude").notNull(),
    destinationLongitude: real("destination_longitude").notNull(),
    departureAt: timestamp("departure_at", { withTimezone: true }).notNull(),
    priority: text("priority").notNull(),
    recommendedRouteId: varchar("recommended_route_id", { length: 36 }).notNull(),
    provider: text("provider").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("route_searches_visitor_created_idx").on(table.visitorId, table.createdAt),
  ],
);

export const routeResultsTable = pgTable(
  "route_results",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    searchId: varchar("search_id", { length: 36 })
      .notNull()
      .references(() => routeSearchesTable.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    transfers: integer("transfers").notNull(),
    walkingMinutes: integer("walking_minutes").notNull(),
    waitingMinutes: integer("waiting_minutes").notNull(),
    departureTime: text("departure_time").notNull(),
    arrivalTime: text("arrival_time").notNull(),
    score: real("score").notNull(),
    modes: text("modes").array().notNull().default(sql`ARRAY[]::text[]`),
    reason: text("reason").notNull(),
  },
  (table) => [index("route_results_search_rank_idx").on(table.searchId, table.rank)],
);

export const routeSegmentsTable = pgTable(
  "route_segments",
  {
    id: serial("id").primaryKey(),
    routeResultId: varchar("route_result_id", { length: 36 })
      .notNull()
      .references(() => routeResultsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    mode: text("mode").notNull(),
    lineName: text("line_name").notNull(),
    fromStop: text("from_stop").notNull(),
    toStop: text("to_stop").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    fromLatitude: real("from_latitude").notNull(),
    fromLongitude: real("from_longitude").notNull(),
    toLatitude: real("to_latitude").notNull(),
    toLongitude: real("to_longitude").notNull(),
  },
  (table) => [
    uniqueIndex("route_segments_result_sequence_uq").on(
      table.routeResultId,
      table.sequence,
    ),
  ],
);

export const insertTransitStopSchema = createInsertSchema(transitStopsTable);
export type TransitStop = typeof transitStopsTable.$inferSelect;
export type TransitLine = typeof transitLinesTable.$inferSelect;
export type TransitTrip = typeof transitTripsTable.$inferSelect;
