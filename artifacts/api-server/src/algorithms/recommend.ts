export type Priority = "balanced" | "fastest" | "fewest_transfers" | "least_walking";

export interface RankableRoute {
  durationMinutes: number;
  transfers: number;
  walkingMinutes: number;
  waitingMinutes: number;
}

const weights: Record<Priority, [number, number, number, number]> = {
  balanced: [0.6, 0.25, 0.1, 0.05],
  fastest: [0.82, 0.08, 0.05, 0.05],
  fewest_transfers: [0.2, 0.65, 0.1, 0.05],
  least_walking: [0.2, 0.1, 0.65, 0.05],
};

function normalize(value: number, min: number, max: number): number {
  return max === min ? 0 : (value - min) / (max - min);
}

export function countTransfers(lineIds: string[]): number {
  const services = lineIds.filter((lineId, index) => index === 0 || lineId !== lineIds[index - 1]);
  return Math.max(0, services.length - 1);
}

export function rankRoutes<T extends RankableRoute>(
  routes: T[],
  priority: Priority,
): Array<T & { score: number }> {
  if (routes.length === 0) return [];
  const dimensions: Array<keyof RankableRoute> = [
    "durationMinutes",
    "transfers",
    "walkingMinutes",
    "waitingMinutes",
  ];
  const bounds = Object.fromEntries(dimensions.map((dimension) => {
    const values = routes.map((route) => route[dimension]);
    return [dimension, [Math.min(...values), Math.max(...values)] as const];
  })) as Record<keyof RankableRoute, readonly [number, number]>;
  const selectedWeights = weights[priority];

  return routes
    .map((route) => {
      const cost = dimensions.reduce((total, dimension, index) => {
        const [min, max] = bounds[dimension];
        return total + normalize(route[dimension], min, max) * selectedWeights[index];
      }, 0);
      return { ...route, score: Math.round((1 - cost) * 100) };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.durationMinutes !== right.durationMinutes) {
        return left.durationMinutes - right.durationMinutes;
      }
      return left.transfers - right.transfers;
    });
}

export function buildRecommendationReasons<T extends RankableRoute & { score: number }>(
  routes: T[],
  priority: Priority,
): T[] {
  return routes.map((route, index) => {
    if (index === 0 && routes.length > 1) {
      const next = routes[1];
      const fasterBy = next.durationMinutes - route.durationMinutes;
      if (priority === "fastest" && fasterBy > 0) {
        return { ...route, reason: `${fasterBy} min faster than the next option.` } as T & { reason: string };
      }
      if (route.transfers < next.transfers) {
        return { ...route, reason: `Recommended for fewer transfers (${route.transfers} vs ${next.transfers}).` } as T & { reason: string };
      }
      if (route.walkingMinutes < next.walkingMinutes) {
        return { ...route, reason: `Recommended for less walking (${route.walkingMinutes} vs ${next.walkingMinutes} min).` } as T & { reason: string };
      }
      return { ...route, reason: "Best overall match for your selected preferences." } as T & { reason: string };
    }
    return { ...route, reason: "Alternative route ranked by your selected preferences." } as T & { reason: string };
  });
}
