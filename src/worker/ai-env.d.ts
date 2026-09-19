interface Env {
  /** Transient decrypted credential. Never persisted or returned to the browser. */
  AI_API_KEY?: string;
  /** Worker secret wrapping the UI-managed credential in the directory DO. */
  AI_ENCRYPTION_KEY?: string;
}
