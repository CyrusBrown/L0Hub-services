// Errors a service's code throws (and the framework's own).

/** Thrown by a method handler: the caller gets `service-reply` `{ok: false, error: {code, detail, ...extra}}`.
 * Codes every service uses where they fit: `unknown_method`, `bad_args`, `not_allowed`, `rate_limited`, `unavailable`;
 * anything else is the service's own. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly detail = "",
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail || code);
  }
  /** The `error` object of a reply. `code` and `detail` always win over `extra`. */
  toJSON(): Record<string, unknown> {
    return { ...this.extra, code: this.code, detail: this.detail };
  }
}

/** The hub (or a member's instance) can't be asked right now. The inbox answers 503, so the sender's outbox retries. */
export class HubUnavailable extends Error {}

/** The service is configured wrongly (a missing secret, bad JSON in `ROLES`). Every request answers 500 `misconfigured`. */
export class ConfigError extends Error {}
