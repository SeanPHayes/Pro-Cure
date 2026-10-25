import { AfterShipTrackingProvider } from './aftership.js';
import type { TrackingProvider } from './provider.js';
import { SimulatedTrackingProvider } from './simulated.js';

export * from './provider.js';
export { AfterShipTrackingProvider, SimulatedTrackingProvider };

let override: TrackingProvider | undefined;
/** Tests: force a provider. */
export const setTrackingProvider = (p: TrackingProvider | undefined) => {
  override = p;
};

export function trackingProvider(): TrackingProvider {
  if (override) return override;
  return (process.env.TRACKING_PROVIDER ?? 'simulated') === 'aftership'
    ? new AfterShipTrackingProvider()
    : new SimulatedTrackingProvider();
}
