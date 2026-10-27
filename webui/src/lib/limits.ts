export const MIB = 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 200 * MIB;
export const MAX_MESSAGE_BYTES = 500 * MIB;
export const MAX_IMAGE_BYTES = 5 * MIB;

export function mib(bytes: number): number {
  return Math.round(bytes / MIB);
}
