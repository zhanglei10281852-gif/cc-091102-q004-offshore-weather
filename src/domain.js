export const requestStates = ['submitted', 'window-held', 'approved', 'weather-review', 'cancelled'];

export function splitProtection(forecast) {
  const start = new Date(forecast.validFrom);
  const end = new Date(forecast.validUntil);
  if (start.getDate() === end.getDate()) return [[start, end]];
  const midnight = new Date(start); midnight.setHours(24, 0, 0, 0);
  const nextStart = new Date(end); nextStart.setHours(0, 30, 0, 0);
  return [[start, midnight], [nextStart, end]];
}

export function acceptForecast(state, incoming) {
  state.forecast = incoming;
  return splitProtection(incoming);
}
