/**
 * Seller-side helpers for selling on Stellar with x402.
 *
 * Two jobs: make discovery metadata correct by construction, and catch the setup mistakes that
 * otherwise only surface when a real buyer's payment fails.
 *
 * @module
 */
export {
  describeEndpoint,
  describeTool,
  type ParamSpec,
  type DescribeEndpointConfig,
  type DescribeToolConfig,
  type DiscoveryExtensions,
} from "./declare.js";

export {
  preflight,
  preflightAndReport,
  type PreflightConfig,
  type PreflightResult,
  type PreflightFinding,
} from "./preflight.js";
