export type ApiSuccess<T> = { success: true; data: T };
export type ApiFailure = {
  success: false;
  error: { code: string; message: string; details?: unknown };
};

export function apiOk<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

export function apiErr(code: string, message: string, details?: unknown): ApiFailure {
  return { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}
