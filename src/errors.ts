export type ErrorCode =
  | 'ARRAY_NOT_FOUND'
  | 'ARRAY_ALREADY_EXISTS'
  | 'EMPTY_ARRAY'
  | 'LENGTH_OUT_OF_RANGE'
  | 'INVALID_INTEGER'
  | 'INVALID_INDEX'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'L_GT_R'
  | 'EMPTY_INTERVAL_UPDATE'
  | 'EMPTY_INTERVAL_QUERY'
  | 'VERSION_MISMATCH'
  | 'OP_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'BATCH_REJECTED'
  | 'VALIDATION_ERROR'
  | 'VERIFY_FAILED';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const MIN_LEN = 1;
export const MAX_LEN = 100_000;

const INTEGER_RE = /^[+-]?\d+$/;

/** 严格十进制整数解析：拒绝小数、科学计数法、空串与非法字符。 */
export function parseBigInt(raw: unknown, field = 'value'): bigint {
  if (typeof raw !== 'string' || raw.trim() !== raw || !INTEGER_RE.test(raw)) {
    throw new AppError('INVALID_INTEGER', `字段 ${field} 必须是不带空格的十进制整数字符串`, { received: String(raw) });
  }
  try {
    return BigInt(raw);
  } catch {
    throw new AppError('INVALID_INTEGER', `字段 ${field} 不是合法整数`, { received: raw });
  }
}

/** 下标必须是 [0,length) 内的安全范围内非负整数；拒绝小数与负数。 */
export function checkBound(raw: unknown, length: number, field: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    throw new AppError('INVALID_INDEX', `字段 ${field} 必须是整数下标`, { received: String(raw) });
  }
  if (raw < 0 || raw > length) {
    throw new AppError('INDEX_OUT_OF_BOUNDS', `字段 ${field}=${raw} 越界，允许范围 [0,${length}]`, {
      index: raw,
      length,
    });
  }
  return raw;
}

export function checkInterval(lRaw: unknown, rRaw: unknown, length: number): { l: number; r: number } {
  const l = checkBound(lRaw, length, 'l');
  const r = checkBound(rRaw, length, 'r');
  if (l > r) {
    throw new AppError('L_GT_R', `区间左右颠倒：l=${l} 大于 r=${r}（半开区间 [l,r)）`, { l, r });
  }
  return { l, r };
}
