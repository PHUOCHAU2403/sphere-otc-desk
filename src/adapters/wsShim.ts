/**
 * Force the `ws` package as the global WebSocket before the SDK loads.
 *
 * Node's built-in (undici) global WebSocket fails to connect to the Unicity
 * testnet Nostr relay (`Failed to connect … Unknown error`), while the `ws`
 * package connects fine. The Nostr transport reads `globalThis.WebSocket`, so
 * this must run *before* the SDK is imported — keep it as the first import in
 * the live entry point.
 */

import WS from 'ws';

(globalThis as { WebSocket?: unknown }).WebSocket = WS as unknown;
