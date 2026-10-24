import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { HealthController } from './health.controller.js';

function controllerWith(query: () => Promise<unknown>): HealthController {
  const dataSource = { query } as unknown as DataSource;
  return new HealthController(dataSource);
}

describe('HealthController', () => {
  it('reports the database as up when SELECT 1 succeeds', async () => {
    const controller = controllerWith(() =>
      Promise.resolve([{ '?column?': 1 }]),
    );

    await expect(controller.check()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
  });

  it('answers 503 when the database query fails', async () => {
    const controller = controllerWith(() =>
      Promise.reject(new Error('connection refused')),
    );

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
