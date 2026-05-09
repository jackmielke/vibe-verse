// Mapbox public access token (pk.* tokens are publishable/safe for client-side)
// Update this with your Mapbox token from https://account.mapbox.com/
export const MAPBOX_TOKEN = "pk.eyJ1IjoiamFja21pZWxrZSIsImEiOiJjbWpnYnNhNzcwbjRrM3FvYmk3c2themdnIn0.mhNvSeN1-d4dhNwRfA3gkg";

// Edge Esmeralda village center — pinned to the real Healdsburg
// Plaza (the green block bounded by Plaza St / Center St / Matheson
// St / Healdsburg Ave). All venue beacons + fictional locations are
// positioned relative to this anchor.
export const VILLAGE_CENTER = {
  lng: -122.86990,
  lat: 38.61030,
  zoom: 16,
} as const;
