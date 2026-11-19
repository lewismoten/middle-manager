// Shared by the e2e server and tests. 6100-6199 is the range for test servers.
// MM_E2E_PORT lets parallel checkouts run their e2e suites at the same time.
export const E2E_PORT = Number(process.env.MM_E2E_PORT ?? 6147);
export const E2E_TOKEN = 'mm_e2e-only-token-not-a-secret';
