export const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

export const isObjectId = (s: string): boolean => OBJECT_ID_PATTERN.test(s);
