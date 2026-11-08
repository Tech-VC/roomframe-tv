const malformedMessages = new Set([
  'Unexpected end of multipart data',
  'Part terminated early due to unexpected end of multipart data',
  'Multipart: Boundary not found',
]);

export const isMalformedMultipartError = (error) => (
  malformedMessages.has(error?.message)
);
