// Browser geolocation wrapper. Only call from a user click handler.
// Dependencies are injectable so the error paths can be tested without a browser.

import { GEOLOCATION_OPTIONS } from '../config.js';

export const GEO_ERROR = Object.freeze({
  UNSUPPORTED: 'unsupported',
  INSECURE: 'insecure_origin',
  DENIED: 'permission_denied',
  UNAVAILABLE: 'position_unavailable',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
});

const MESSAGES = {
  [GEO_ERROR.UNSUPPORTED]: 'This browser does not support location. Search for your starting point or pick it on the map instead.',
  [GEO_ERROR.INSECURE]: 'Location only works on https:// pages (or localhost). Search for your starting point or pick it on the map instead.',
  [GEO_ERROR.DENIED]: 'Location permission was denied. You can still search for your starting point or pick it on the map.',
  [GEO_ERROR.UNAVAILABLE]: 'Your device could not determine its location. Search for your starting point or pick it on the map.',
  [GEO_ERROR.TIMEOUT]: 'Finding your location took too long. Try again, or search / pick your starting point on the map.',
  [GEO_ERROR.UNKNOWN]: 'Could not get your location. Search for your starting point or pick it on the map.',
};

const fromCode = (code) => ({ 1: GEO_ERROR.DENIED, 2: GEO_ERROR.UNAVAILABLE, 3: GEO_ERROR.TIMEOUT })[code] ?? GEO_ERROR.UNKNOWN;

/** @returns {Promise<{ok:true,coordinates:[number,number],accuracyMeters:number}|{ok:false,code:string,message:string}>} */
export function requestLocation({
  geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
  isSecureContext = typeof window !== 'undefined' ? window.isSecureContext : true,
  options = GEOLOCATION_OPTIONS,
} = {}) {
  const fail = (code) => ({ ok: false, code, message: MESSAGES[code] });
  if (!geolocation) return Promise.resolve(fail(GEO_ERROR.UNSUPPORTED));
  if (isSecureContext === false) return Promise.resolve(fail(GEO_ERROR.INSECURE));
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            ok: true,
            coordinates: [pos.coords.longitude, pos.coords.latitude],
            accuracyMeters: pos.coords.accuracy,
          }),
        (err) => resolve(fail(fromCode(err?.code))),
        options,
      );
    } catch {
      resolve(fail(GEO_ERROR.UNKNOWN));
    }
  });
}
