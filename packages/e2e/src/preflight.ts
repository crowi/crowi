import net from 'node:net';
import { MongoClient } from 'mongodb';
import { E2E_MAILPIT_API_URL, E2E_MONGO_URI } from './config';

async function assertTcpPort(name: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${name} is not reachable on localhost:${port}. Run 'docker compose up -d' before 'pnpm e2e'.`));
    }, 2_000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name} is not reachable on localhost:${port}: ${err.message}. Run 'docker compose up -d' before 'pnpm e2e'.`));
    });
  });
}

async function assertMongo(): Promise<void> {
  const client = new MongoClient(E2E_MONGO_URI, { serverSelectionTimeoutMS: 3_000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (err) {
    throw new Error(`MongoDB preflight failed for ${E2E_MONGO_URI}: ${(err as Error).message}. Run 'docker compose up -d'.`);
  } finally {
    await client.close();
  }
}

async function assertMailpitHttp(): Promise<void> {
  try {
    const infoResponse = await fetch(`${E2E_MAILPIT_API_URL}/info`);
    if (infoResponse.ok) return;

    const messagesResponse = await fetch(`${E2E_MAILPIT_API_URL}/messages`);
    if (!messagesResponse.ok) {
      throw new Error(`/info HTTP ${infoResponse.status}; /messages HTTP ${messagesResponse.status}`);
    }
  } catch (err) {
    throw new Error(`Mailpit HTTP API preflight failed at ${E2E_MAILPIT_API_URL}: ${(err as Error).message}. Run 'docker compose up -d'.`);
  }
}

/**
 * Every service a spec in this suite actually reaches out to — keep it that
 * way. This list is read as the suite's dependency contract (the CI job's
 * `services:` block was built from it), so a dependency that is exercised but
 * not asserted here fails far from its cause: PlantUML was missing, and the
 * result was `expect(plantumlFragment).toBeDefined()` failing two minutes into
 * a CI run rather than "PlantUML unreachable" at second zero.
 *
 * When a spec starts using a new service, add it here in the same change.
 */
export async function preflightDockerServices(): Promise<void> {
  await assertTcpPort('MongoDB', 27017);
  await assertTcpPort('Redis', 6379);
  await assertTcpPort('Mailpit SMTP', 1025);
  await assertTcpPort('Mailpit HTTP', 8025);
  await assertTcpPort('PlantUML', 8080);
  await assertMongo();
  await assertMailpitHttp();
}
