// Wire limits from docs/bots/PROTOCOL.md#limits. Everything here is measured on the
// encoded frame unless the name says otherwise.

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_SEND_TEXT = 8_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_NOTICE_BYTES = 500;
export const MAX_MESSAGE_BYTES = 96 * 1024;
export const MAX_BOT_SUMMARY_BYTES = 1_200;
export const MAX_CATALOG = 200;
export const MAX_PENDING = 32;
export const MAX_INBOX = 32;
export const PAGE_MAX_MESSAGES = 200;
export const PAGE_MAX_BYTES = 192 * 1024;
export const DELTA_FLUSH_MS = 50;
export const DELTA_FLUSH_BYTES = 96 * 1024;
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const BOT_ID = /^[A-Za-z0-9_-]{1,80}$/;
