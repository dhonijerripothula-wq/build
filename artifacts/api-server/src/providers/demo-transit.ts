import { db } from "@workspace/db";
import {
  transitAgenciesTable,
  transitFeedStateTable,
  transitLinesTable,
  transitServicesTable,
  transitStopTimesTable,
  transitStopsTable,
  transitTripsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const stops = [
  { id: "HYD_RAIL", name: "Hyderabad Railway Station", latitude: 17.4331, longitude: 78.5011, aliases: ["Hyderabad Station", "Nampally Railway Station"] },
  { id: "SECUNDERABAD", name: "Secunderabad", latitude: 17.4344, longitude: 78.5013, aliases: ["Secunderabad Railway Station"] },
  { id: "PARADISE", name: "Paradise", latitude: 17.4414, longitude: 78.4867, aliases: [] },
  { id: "RASOOLPURA", name: "Rasoolpura", latitude: 17.4435, longitude: 78.4772, aliases: [] },
  { id: "PRAKASH_NAGAR", name: "Prakash Nagar", latitude: 17.443, longitude: 78.4664, aliases: [] },
  { id: "BEGUMPET", name: "Begumpet", latitude: 17.4375, longitude: 78.4564, aliases: [] },
  { id: "AMEERPET", name: "Ameerpet", latitude: 17.4375, longitude: 78.4483, aliases: [] },
  { id: "MADHURA_NAGAR", name: "Madhura Nagar", latitude: 17.4322, longitude: 78.4434, aliases: [] },
  { id: "YOUSUFGUDA", name: "Yousufguda", latitude: 17.4311, longitude: 78.4322, aliases: [] },
  { id: "JUBILEE_HILLS", name: "Jubilee Hills Check Post", latitude: 17.4313, longitude: 78.4154, aliases: ["Jubilee Hills"] },
  { id: "PEDDAMMA", name: "Peddamma Gudi", latitude: 17.4297, longitude: 78.409, aliases: ["Peddamma Temple"] },
  { id: "MADHAPUR", name: "Madhapur", latitude: 17.4483, longitude: 78.3915, aliases: ["HITEC City"] },
  { id: "DURGAM", name: "Durgam Cheruvu", latitude: 17.4425, longitude: 78.3864, aliases: [] },
  { id: "HITEC_CITY", name: "HITEC City", latitude: 17.4474, longitude: 78.3762, aliases: ["Hitech City", "HITEC City Metro Station"] },
  { id: "RAIDURG", name: "Raidurg", latitude: 17.4411, longitude: 78.3651, aliases: ["Raidurg Metro Station"] },
  { id: "MINDSPACE", name: "Mindspace", latitude: 17.435, longitude: 78.3808, aliases: [] },
  { id: "NAMPALLY", name: "Nampally", latitude: 17.3933, longitude: 78.4744, aliases: ["Hyderabad Deccan", "Nampally Metro Station"] },
  { id: "ASSEMBLY", name: "Assembly", latitude: 17.3994, longitude: 78.4768, aliases: [] },
  { id: "LAKDIKAPUL", name: "Lakdikapul", latitude: 17.405, longitude: 78.4652, aliases: [] },
  { id: "KHAIRATABAD", name: "Khairatabad", latitude: 17.4128, longitude: 78.4626, aliases: [] },
  { id: "HYDERGUDA", name: "Abids", latitude: 17.3907, longitude: 78.4761, aliases: ["Abids Bus Stop"] },
];

const lines = [
  { id: "HYD_METRO_RED", shortName: "Red Line", longName: "Hyderabad Metro Red Line", mode: "metro", color: "#d94b53", stops: ["NAMPALLY", "ASSEMBLY", "LAKDIKAPUL", "KHAIRATABAD", "AMEERPET", "MADHURA_NAGAR", "YOUSUFGUDA", "JUBILEE_HILLS", "PEDDAMMA", "MADHAPUR", "DURGAM", "HITEC_CITY"], segmentMinutes: [3, 3, 4, 5, 3, 3, 4, 3, 4, 4, 4] },
  { id: "HYD_METRO_BLUE", shortName: "Blue Line", longName: "Hyderabad Metro Blue Line", mode: "metro", color: "#2878d0", stops: ["SECUNDERABAD", "PARADISE", "RASOOLPURA", "PRAKASH_NAGAR", "BEGUMPET", "AMEERPET", "MADHURA_NAGAR", "YOUSUFGUDA", "JUBILEE_HILLS", "PEDDAMMA", "MADHAPUR", "DURGAM", "HITEC_CITY", "RAIDURG"], segmentMinutes: [3, 3, 3, 3, 4, 3, 3, 4, 3, 4, 4, 4, 4] },
  { id: "HYD_BUS_25", shortName: "25", longName: "H-25 City Express", mode: "bus", color: "#e08a30", stops: ["HYD_RAIL", "SECUNDERABAD", "BEGUMPET", "AMEERPET", "JUBILEE_HILLS", "MADHAPUR", "MINDSPACE", "HITEC_CITY"], segmentMinutes: [7, 8, 8, 8, 7, 7, 6] },
  { id: "HYD_BUS_127", shortName: "127", longName: "127 Ameerpet–HITEC City", mode: "bus", color: "#27a584", stops: ["AMEERPET", "MADHURA_NAGAR", "YOUSUFGUDA", "JUBILEE_HILLS", "MADHAPUR", "MINDSPACE", "HITEC_CITY"], segmentMinutes: [5, 4, 5, 5, 5, 5] },
  { id: "HYD_BUS_5K", shortName: "5K", longName: "5K Railway Station–Ameerpet", mode: "bus", color: "#9a70ce", stops: ["HYD_RAIL", "HYDERGUDA", "NAMPALLY", "ASSEMBLY", "AMEERPET"], segmentMinutes: [7, 7, 5, 13] },
];

function timeToMinutes(value: number): number {
  return value;
}

export async function ensureDemoTransitData(): Promise<void> {
  const [existing] = await db.select({ id: transitLinesTable.id }).from(transitLinesTable).limit(1);
  if (existing) return;

  await db.transaction(async (tx) => {
    const [agency] = await tx.insert(transitAgenciesTable).values({
      externalId: "HYD_DEMO_AGENCY",
      name: "Hyderabad Transit Demo",
      url: "https://ltmetro.com",
      timezone: "Asia/Kolkata",
    }).returning();

    const [service] = await tx.insert(transitServicesTable).values({
      externalId: "HYD_DEMO_DAILY",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: true,
      sunday: true,
      startDate: "2020-01-01",
      endDate: "2035-12-31",
    }).returning();

    const insertedStops = await tx.insert(transitStopsTable).values(stops.map((stop) => ({
      externalId: stop.id,
      name: stop.name,
      latitude: stop.latitude,
      longitude: stop.longitude,
      aliases: stop.aliases,
    }))).returning();
    const stopIds = new Map(insertedStops.map((stop) => [stop.externalId, stop.id]));

    const insertedLines = await tx.insert(transitLinesTable).values(lines.map((line) => ({
      externalId: line.id,
      agencyId: agency.id,
      shortName: line.shortName,
      longName: line.longName,
      transportMode: line.mode,
      color: line.color,
    }))).returning();
    const lineByExternalId = new Map(insertedLines.map((line) => [line.externalId, line]));

    const tripRows: Array<{
      externalId: string;
      routeId: number;
      serviceId: number;
      headsign: string;
      directionId: number;
    }> = [];
    const tripTimings: Array<{ externalId: string; routeIndex: number; timePoints: number[] }> = [];
    for (const [routeIndex, line] of lines.entries()) {
      let fullDuration = line.segmentMinutes.reduce((total, minutes) => total + minutes, 0);
      if (line.mode === "bus") fullDuration = Math.max(fullDuration, 38);
      for (let startMinute = 5 * 60 + 30; startMinute <= 22 * 60 + 30; startMinute += 20) {
        let cursor = timeToMinutes(startMinute);
        const timePoints = [cursor];
        line.segmentMinutes.forEach((minutes) => {
          cursor += minutes;
          timePoints.push(cursor);
        });
        const tripExternalId = `${line.id}_${String(startMinute).padStart(4, "0")}`;
        const route = lineByExternalId.get(line.id);
        if (!route) throw new Error(`Demo route ${line.id} was not inserted`);
        tripRows.push({
          externalId: tripExternalId,
          routeId: route.id,
          serviceId: service.id,
          headsign: stops.find((stop) => stop.id === line.stops[line.stops.length - 1])?.name ?? line.longName,
          directionId: 0,
        });
        tripTimings.push({ externalId: tripExternalId, routeIndex, timePoints });
      }
      if (fullDuration < 0) throw new Error("Invalid demo schedule");
    }

    const insertedTrips = await tx.insert(transitTripsTable).values(tripRows).returning();
    const tripIdByExternalId = new Map(insertedTrips.map((trip) => [trip.externalId, trip.id]));
    const stopTimeRows: Array<{
      tripId: number;
      stopId: number;
      arrivalMinutes: number;
      departureMinutes: number;
      stopSequence: number;
    }> = [];
    for (const timing of tripTimings) {
      const line = lines[timing.routeIndex];
      const tripId = tripIdByExternalId.get(timing.externalId);
      if (!tripId) throw new Error(`Demo trip ${timing.externalId} was not inserted`);
      line.stops.forEach((stopExternalId, stopSequence) => {
        const stopId = stopIds.get(stopExternalId);
        if (!stopId) throw new Error(`Demo stop ${stopExternalId} was not inserted`);
        const minute = timing.timePoints[stopSequence] ?? 0;
        stopTimeRows.push({
          tripId,
          stopId,
          arrivalMinutes: minute,
          departureMinutes: minute,
          stopSequence,
        });
      });
    }
    for (let offset = 0; offset < stopTimeRows.length; offset += 1000) {
      await tx.insert(transitStopTimesTable).values(stopTimeRows.slice(offset, offset + 1000));
    }

    await tx.insert(transitFeedStateTable).values({
      id: 1,
      provider: "Hyderabad demo feed",
      isDemo: true,
    }).onConflictDoNothing();
  });
}

export async function isDemoProvider(): Promise<boolean> {
  const [state] = await db.select({ isDemo: transitFeedStateTable.isDemo })
    .from(transitFeedStateTable)
    .where(eq(transitFeedStateTable.id, 1));
  return state?.isDemo ?? true;
}

export const demoNetworkCounts = {
  stops: stops.length,
  routes: lines.length,
};
