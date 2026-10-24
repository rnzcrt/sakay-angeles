// SYNTHETIC TEST DATA — placed near 0°,0° on purpose. None of this is real
// Angeles City data; it only exercises the planner and validator.

export const stop = (id, lng, lat = 0, verificationStatus = 'verified') => ({
  id, name: `Stop ${id}`, coordinates: [lng, lat], verificationStatus,
  ...(verificationStatus === 'verified' ? { source: 'synthetic fixture' } : {}),
});

export const direction = (id, orderedStopIds, verificationStatus = 'verified') => ({
  id, label: `Dir ${id}`, orderedStopIds, geometryId: `geo-${id}`, verificationStatus,
  ...(verificationStatus === 'verified' ? { evidence: { source: 'synthetic fixture', method: 'automated test fixture', checkedAt: '2026-01-01' } } : {}),
});

export const route = (id, directions, extra = {}) => ({
  id,
  name: `Route ${id}`,
  sourceLabel: `ROUTE ${id}`,
  jeepneyColorName: `Color-${id}`,
  displayColor: '#123456',
  geometryStatus: 'verified',
  geometryEvidence: { source: 'synthetic fixture', method: 'automated test fixture', checkedAt: '2026-01-01' },
  directions,
  ...extra,
});

// Stops are ~1.1 km apart (0.01° at the equator) so the 500 m walk radius never links them by accident.
export function makeData() {
  return {
    stops: [
      stop('A', 0.00), stop('B', 0.01), stop('C', 0.02), stop('D', 0.03),
      stop('E', 0.02, 0.015), stop('F', 0.02, 0.03),
      // X1/X2 sit ~60 m from stop D but share no stop id with any other route.
      stop('X1', 0.0305, 0.0002), stop('X2', 0.0305, 0.02),
      stop('U1', 0.05), stop('U2', 0.06, 0, 'unverified'),
    ],
    routes: [
      route('R1', [direction('R1-out', ['A', 'B', 'C', 'D'])]),
      route('R2', [direction('R2-out', ['C', 'E', 'F'])]),
      route('R4', [direction('R4-out', ['X1', 'X2'])]),
      route('RU', [direction('RU-out', ['B', 'F'], 'unverified')], { geometryStatus: 'unverified' }),
    ],
    transfers: [],
  };
}

export const near = (stopObj, dLng = 0.0001, dLat = 0.0001) => [stopObj.coordinates[0] + dLng, stopObj.coordinates[1] + dLat];
export const stopOf = (data, id) => data.stops.find((s) => s.id === id);
