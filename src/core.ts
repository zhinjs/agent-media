/**
 * Storage and capture without the MCP server, CLI or harness hooks.
 * Importing this entry never loads `@modelcontextprotocol/sdk`, so libraries and agent frameworks
 * can depend on it without pulling the MCP runtime into their process.
 */
export { captureMedia, DEFAULT_MAX_BYTES } from './capture.js';
export type { CaptureOptions, CapturePolicy, CaptureResult, CapturedMedia } from './capture.js';
export { LocalMediaStore, MediaUnavailableError } from './stores/local.js';
export type { LocalMediaStoreOptions } from './stores/local.js';
export { S3PublicStore, inferS3Defaults } from './stores/s3.js';
export type { S3PublicStoreOptions, S3EndpointDefaults } from './stores/s3.js';
export { InspectionQueue } from './inspect.js';
export type { InspectedImage } from './inspect.js';
export { storesFromEnv } from './config.js';
export { sniffMime, decodeBase64, isImageMime, MEDIA_EXTENSIONS } from './sniff.js';
export type * from './types.js';
