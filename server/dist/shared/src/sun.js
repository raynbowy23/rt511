/** Where the sun is, so that a dark camera can be told apart from a camera looking at night.
 *
 * The low-precision almanac formula: about a hundredth of a degree over this century, which is far finer than anything here needs. Shared because the server uses it to keep dusk from reading as weather and the map uses it to label the sunset wave. */
const RAD = Math.PI / 180;
/** Degrees of the sun above the horizon at a place and a moment in seconds since the epoch. Negative is below the horizon. */
export function solarElevation(lat, lon, ts) {
    // Days since noon on 1 January 2000, the epoch the coefficients are written against.
    const d = ts / 86400 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const eclipticLon = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    const obliquity = (23.439 - 0.00000036 * d) * RAD;
    const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon), Math.cos(eclipticLon));
    const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
    const siderealDeg = (18.697374558 + 24.06570982441908 * d) * 15 + lon;
    const hourAngle = siderealDeg * RAD - rightAscension;
    const phi = lat * RAD;
    return Math.asin(Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)) / RAD;
}
//# sourceMappingURL=sun.js.map