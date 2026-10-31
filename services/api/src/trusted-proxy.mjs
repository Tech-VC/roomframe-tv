import proxyAddress from '@fastify/proxy-addr';

export const createTrustedProxy = (configured = 'loopback,uniquelocal') => {
  const ranges = Array.isArray(configured)
    ? configured
    : String(configured).split(',').map((range) => range.trim()).filter(Boolean);
  const trustedAddress = proxyAddress.compile(ranges);
  // Check both the immediate peer's address and its position. Trusting every
  // private address at every hop would also trust a forged earlier XFF entry.
  return (address, hop) => {
    if (hop !== 0 || typeof address !== 'string') return false;
    try {
      return trustedAddress(address, hop);
    } catch {
      return false;
    }
  };
};
