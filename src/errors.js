export class TunnelError extends Error {
  constructor(message, { code = "E_TUNNEL", hint } = {}) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
    this.hint = hint;
  }
}

export function asTunnelError(error, prefix = "operation failed") {
  if (error instanceof TunnelError) return error;
  return new TunnelError(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}
