import { local } from './env';

export default function setup(): void {
  // Fails fast (and refuses non-local targets) before any test touches a database.
  const { API_URL } = local();
  process.stdout.write(`db tests against ${API_URL}\n`);
}
