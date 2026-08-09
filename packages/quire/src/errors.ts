/**
 * quire fails loudly or not at all.
 *
 * Every refusal in this package throws a QuireError naming the thing that could
 * not be determined. Nothing here substitutes a default for a value it could
 * not work out — a wrong page number is worse than no page number, because a
 * wrong one is believed.
 */
export class QuireError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[quire/${code}] ${message}`);
    this.name = 'QuireError';
    this.code = code;
  }
}

export function quireFail(code: string, message: string): never {
  throw new QuireError(code, message);
}
