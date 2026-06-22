export class RemoteShellError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RemoteShellError";
  }
}

export function toSerializableError(error: unknown): Record<string, unknown> {
  if (error instanceof RemoteShellError) {
    return {
      error: error.message,
      code: error.code,
      details: error.details ?? {},
    };
  }

  if (error instanceof Error) {
    return {
      error: error.message,
      code: "ERR_UNKNOWN",
    };
  }

  return {
    error: String(error),
    code: "ERR_UNKNOWN",
  };
}
